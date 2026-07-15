# NORI: Additive file. Browser-catcher spool — the lelab half of remote-session
# dataset capture (the "browser catcher").
#
# During a REMOTE teleop session the browser already receives everything a
# dataset needs: the composite video track (SDK videoStream()), ~15 Hz joint
# telemetry (onTelemetry), and it is the SENDER of every control frame. The
# robot itself persists nothing (R5) and its LAN taps are loopback-bound on
# customer units, so the browser is the only catcher that works with zero
# robot-side changes, over WAN included.
#
# The browser cannot assemble a LeRobotDataset (no parquet/mp4 tooling, no HF
# token by design), so it streams raw capture material here and lelab does the
# heavy lifting:
#
#   browser ──POST──▶ spool dir (this module) ──export──▶ LeRobotDataset in the
#   lerobot cache (capture_export.py) ──existing /nori/datasets/upload──▶ the
#   customer's assigned HF repo (backend-mediated, private).
#
# Spool layout (one dir per capture, under the lerobot cache so everything
# dataset-shaped lives in one place; the leading underscore keeps it out of
# dataset_browser listings which require meta/info.json anyway):
#
#   ~/.cache/huggingface/lerobot/_nori_captures/<capture_id>/
#     meta.json          # room, joints, camera layout, mime, created_at
#     telemetry.ndjson   # {"t_ms": <browser wall ms>, "state": {...}}
#     controls.ndjson    # {"t_ms": ..., "frame": {type:"control", ...}} (raw,
#                        #  kept for future true-action labeling; v1 training
#                        #  uses state[t+1] as action — see capture_export.py)
#     episodes.ndjson    # {"index": N, "event": "start"|"stop", "t_ms": ...,
#                        #  "task": "..."} (start carries the task string)
#     video_ep<N>.webm   # MediaRecorder output, one container per episode
#
# All timestamps are BROWSER wall-clock ms (Date.now()) — one clock for video
# anchor, telemetry and controls, so export alignment is subtraction. The Pi's
# monotonic ts_ns never reaches the browser view (TelemetryView drops it).
#
# Endpoints are same-origin only in practice (the page is served by this
# process); they carry no auth beyond that, matching every other /nori route
# here — the JWT lives in the browser and is only needed for the upload step.

import json
import logging
import re
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .datasets import _lerobot_cache_root

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nori/capture")

CAPTURES_DIRNAME = "_nori_captures"

# Guard rails: a runaway recorder must not fill the disk silently. 4 GB per
# capture ≈ 45 min of 1 Mbps webm + sidecars, far beyond a normal session.
MAX_CAPTURE_BYTES = 4 * 1024 * 1024 * 1024

_SAFE_ID = re.compile(r"^[a-f0-9]{32}$")

# Export bookkeeping: capture_id -> {"status": "exporting"|"done"|"error",
# "repo_id": str|None, "error": str|None}. In-memory only — an export lost to
# a lelab restart is re-runnable from the spool (finish is idempotent-ish:
# re-POST /finish re-exports into a fresh repo_id).
_exports: dict[str, dict] = {}
_exports_lock = threading.Lock()


def _captures_root() -> Path:
    return _lerobot_cache_root() / CAPTURES_DIRNAME


def _capture_dir(capture_id: str) -> Path:
    # capture_id is server-minted (uuid4 hex); reject anything else so the id
    # can never traverse out of the spool root.
    if not _SAFE_ID.match(capture_id):
        raise HTTPException(status_code=400, detail="malformed capture_id")
    d = _captures_root() / capture_id
    if not d.is_dir():
        raise HTTPException(status_code=404, detail="unknown capture_id")
    return d


def _append_ndjson(path: Path, rows: list[dict]) -> None:
    with open(path, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")


def _dir_bytes(d: Path) -> int:
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


# ---------------------------------------------------------------- start
class CaptureStartBody(BaseModel):
    room: str = ""
    # tile roles of the composite feed, in layout order (SDK cameraLayoutInfo);
    # empty when single-camera / layout unknown. Recorded for a future
    # per-camera-crop exporter; v1 exports the composite as one view.
    layout: list[str] = []
    video_mime: str = ""


@router.post("/start")
def capture_start(body: CaptureStartBody):
    capture_id = uuid.uuid4().hex
    d = _captures_root() / capture_id
    d.mkdir(parents=True, exist_ok=False)
    meta = {
        "capture_id": capture_id,
        "room": body.room,
        "layout": body.layout,
        "video_mime": body.video_mime,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=2))
    logger.info("[CAPTURE] started %s (room=%s)", capture_id, body.room or "?")
    return {"capture_id": capture_id}


# ---------------------------------------------------------------- ping
@router.get("/ping")
def capture_ping():
    # Feature detection for the frontend: the capture card renders only when
    # this answers — i.e. only when the page is served by a local lelab (the
    # hosted Vercel app has no lelab and must not show the card).
    return {"ok": True}


# ---------------------------------------------------------------- datasets
# Local dataset management for the capture card: list what exists (so the
# operator can append new episodes to a previous session's dataset) and
# rename. Identity of a cache dataset IS its directory name — info.json
# carries no repo_id — so rename is a directory move.

_SAFE_REPO_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _dataset_info(d: Path) -> dict | None:
    info_path = d / "meta" / "info.json"
    if not info_path.is_file():
        return None
    try:
        info = json.loads(info_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    features = info.get("features") or {}
    return {
        "repo_id": d.name,
        "episodes": info.get("total_episodes", 0),
        "frames": info.get("total_frames", 0),
        "fps": info.get("fps"),
        "robot_type": info.get("robot_type"),
        "modified_at": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(info_path.stat().st_mtime)
        ),
        # Appendable by THIS capture pipeline = same feature surface the
        # exporter produces (the composite remote view). The exporter still
        # re-validates joints/fps at append time; this just filters the picker.
        "appendable": "observation.images.remote" in features,
    }


# Directories that are backups / temp copies of a dataset, not datasets a user
# should see in the list or pick as an append target (e.g. "foo.bak125",
# "foo.tmp", "foo~"). One canonical folder per dataset — a rename replaces the
# folder, so backups only ever come from recovery/tooling, never normal use.
_BACKUP_DIR = re.compile(r"(\.bak\d*|\.tmp|~)$", re.IGNORECASE)


def _is_backup_dir(name: str) -> bool:
    return bool(_BACKUP_DIR.search(name))


@router.get("/datasets")
def capture_list_datasets():
    """Local lerobot-cache datasets (anything with meta/info.json), newest
    first. `appendable` marks capture-shaped ones for the append picker."""
    root = _lerobot_cache_root()
    out = []
    if root.is_dir():
        for d in sorted(root.iterdir()):
            if d.is_dir() and not d.name.startswith("_") and not _is_backup_dir(d.name):
                info = _dataset_info(d)
                if info:
                    out.append(info)
    out.sort(key=lambda r: r["modified_at"], reverse=True)
    return {"datasets": out}


class RenameBody(BaseModel):
    repo_id: str
    new_repo_id: str


@router.post("/datasets/rename")
def capture_rename_dataset(body: RenameBody):
    new_id = body.new_repo_id.strip()
    if not _SAFE_REPO_ID.match(new_id):
        raise HTTPException(
            status_code=422,
            detail="name must be letters/digits/._- and not start with . or -",
        )
    root = _lerobot_cache_root()
    src = root / body.repo_id
    if not _SAFE_REPO_ID.match(body.repo_id) or not (src / "meta" / "info.json").is_file():
        raise HTTPException(status_code=404, detail=f"no dataset named {body.repo_id!r}")
    if new_id == body.repo_id:
        return {"ok": True, "repo_id": new_id}
    dst = root / new_id
    if dst.exists():
        raise HTTPException(status_code=409, detail=f"a dataset named {new_id!r} already exists")
    with _exports_lock:
        if any(st["status"] == "exporting" for st in _exports.values()):
            # Coarse but safe: an export may be writing into src right now.
            raise HTTPException(status_code=409, detail="an export is running — retry when it finishes")
    src.rename(dst)
    logger.info("[CAPTURE] renamed dataset %s -> %s", body.repo_id, new_id)
    return {"ok": True, "repo_id": new_id}


# ---------------------------------------------------------------- sidecars
class RowsBody(BaseModel):
    rows: list[dict]


@router.post("/{capture_id}/telemetry")
def capture_telemetry(capture_id: str, body: RowsBody):
    d = _capture_dir(capture_id)
    _append_ndjson(d / "telemetry.ndjson", body.rows)
    return {"ok": True, "n": len(body.rows)}


@router.post("/{capture_id}/controls")
def capture_controls(capture_id: str, body: RowsBody):
    d = _capture_dir(capture_id)
    _append_ndjson(d / "controls.ndjson", body.rows)
    return {"ok": True, "n": len(body.rows)}


class EpisodeEventBody(BaseModel):
    index: int
    event: str  # "start" | "stop"
    t_ms: float
    task: str = ""


@router.post("/{capture_id}/episode")
def capture_episode(capture_id: str, body: EpisodeEventBody):
    if body.event not in ("start", "stop"):
        raise HTTPException(status_code=422, detail="event must be start|stop")
    d = _capture_dir(capture_id)
    _append_ndjson(d / "episodes.ndjson", [body.model_dump()])
    return {"ok": True}


# ---------------------------------------------------------------- video chunks
@router.post("/{capture_id}/video/{episode_index}")
async def capture_video_chunk(capture_id: str, episode_index: int, request: Request):
    """Append one MediaRecorder blob to the episode's webm. MediaRecorder with
    a timeslice emits a valid stream only when chunks are concatenated in
    order; the browser sends them sequentially (awaits each POST)."""
    d = _capture_dir(capture_id)
    chunk = await request.body()
    if not chunk:
        return {"ok": True, "n": 0}
    if _dir_bytes(d) + len(chunk) > MAX_CAPTURE_BYTES:
        raise HTTPException(status_code=413, detail="capture exceeds size cap")
    with open(d / f"video_ep{episode_index}.webm", "ab") as f:
        f.write(chunk)
    return {"ok": True, "n": len(chunk)}


# ---------------------------------------------------------------- finish/export
class FinishBody(BaseModel):
    fps: int = 15
    name: str = ""       # NEW dataset: explicit name (used verbatim), or "" for
                         # the timestamped default stem
    append_to: str = ""  # or: append episodes to this existing cache dataset
                         # (mutually exclusive with name; grid runs at ITS fps)


@router.post("/{capture_id}/finish")
def capture_finish(capture_id: str, body: FinishBody):
    """Kick the spool→LeRobotDataset export in a background thread. Poll
    GET /{capture_id} for status; on "done" the repo_id feeds the existing
    POST /nori/datasets/upload."""
    d = _capture_dir(capture_id)
    if not (d / "episodes.ndjson").exists():
        raise HTTPException(status_code=422, detail="no episodes recorded")
    if not 1 <= body.fps <= 60:
        raise HTTPException(status_code=422, detail="fps must be 1..60")
    if body.append_to:
        if body.name:
            raise HTTPException(status_code=422, detail="name and append_to are mutually exclusive")
        target = _lerobot_cache_root() / body.append_to
        if not _SAFE_REPO_ID.match(body.append_to) or not (target / "meta" / "info.json").is_file():
            raise HTTPException(status_code=422, detail=f"no dataset named {body.append_to!r} to append to")

    with _exports_lock:
        st = _exports.get(capture_id)
        if st and st["status"] == "exporting":
            return {"status": "exporting"}
        _exports[capture_id] = {"status": "exporting", "repo_id": None, "error": None}

    def run():
        from .capture_export import export_capture

        try:
            repo_id = export_capture(
                d, fps=body.fps, name=body.name or None, append_to=body.append_to or None
            )
            with _exports_lock:
                _exports[capture_id] = {"status": "done", "repo_id": repo_id, "error": None}
            logger.info("[CAPTURE] %s exported -> %s", capture_id, repo_id)
        except Exception as e:  # surfaced via status poll; spool kept for retry
            logger.exception("[CAPTURE] export failed for %s", capture_id)
            with _exports_lock:
                _exports[capture_id] = {"status": "error", "repo_id": None, "error": str(e)}

    threading.Thread(target=run, name=f"capture-export-{capture_id[:8]}", daemon=True).start()
    return {"status": "exporting"}


@router.get("/{capture_id}")
def capture_status(capture_id: str):
    d = _capture_dir(capture_id)
    with _exports_lock:
        st = _exports.get(capture_id)
    episodes = 0
    ep_path = d / "episodes.ndjson"
    if ep_path.exists():
        with open(ep_path) as f:
            episodes = sum(1 for line in f if '"stop"' in line)
    return {
        "capture_id": capture_id,
        "bytes": _dir_bytes(d),
        "episodes": episodes,
        "export": st or {"status": "idle", "repo_id": None, "error": None},
    }
