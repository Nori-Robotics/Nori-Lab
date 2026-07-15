# NORI: Additive file. Local dataset episode review + curation — view your
# recordings and delete bad episodes WITHOUT HuggingFace (the org-owned repos
# have no end-user HF login, so the HF-Space viewer is unusable for them).
#
# Everything here operates on the on-disk lerobot cache:
#   GET  /nori/capture/datasets/{repo_id}/episodes            — list episodes
#   GET  /nori/capture/datasets/{repo_id}/episode/{i}/clip.mp4 — one episode,
#        transcoded AV1→H.264 so a browser <video> can play it
#   POST /nori/capture/datasets/{repo_id}/delete-episodes     — drop bad episodes
#
# Clips are extracted on demand (pyav) and cached under a temp dir keyed by the
# dataset's mtime, so a second view is instant and an edit invalidates the cache.

import logging
import re
import shutil
import tempfile
from fractions import Fraction
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .datasets import _lerobot_cache_root

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nori/capture")

_SAFE_REPO = re.compile(r"^[A-Za-z0-9._-]+$")
_BACKUP = re.compile(r"(\.bak\d*|\.tmp|~)$", re.IGNORECASE)
_CLIP_CACHE = Path(tempfile.gettempdir()) / "nori_episode_clips"


def _dataset_dir(repo_id: str) -> Path:
    """Validated local dataset dir. Rejects traversal / backups / non-datasets."""
    if not _SAFE_REPO.match(repo_id) or _BACKUP.search(repo_id):
        raise HTTPException(status_code=400, detail="invalid dataset id")
    d = _lerobot_cache_root() / repo_id
    if not (d / "meta" / "info.json").is_file():
        raise HTTPException(status_code=404, detail=f"no local dataset {repo_id!r}")
    return d


def _video_keys(d: Path) -> list[str]:
    """All video feature keys, in info.json order (observation.images.<role>)."""
    import json
    info = json.loads((d / "meta" / "info.json").read_text())
    return [k for k, feat in (info.get("features") or {}).items()
            if isinstance(feat, dict) and feat.get("dtype") == "video"]


def _first_video_key(d: Path) -> str | None:
    keys = _video_keys(d)
    return keys[0] if keys else None


def _role(vkey: str) -> str:
    """'observation.images.left_wrist' -> 'left_wrist'."""
    return vkey.rsplit(".", 1)[-1] if "." in vkey else vkey


def _resolve_vkey(d: Path, camera: str | None) -> str:
    keys = _video_keys(d)
    if not keys:
        raise HTTPException(status_code=422, detail="dataset has no video to view")
    if camera:
        for k in keys:
            if _role(k) == camera or k == camera:
                return k
        raise HTTPException(status_code=404, detail=f"no camera {camera!r} in this dataset")
    return keys[0]


def _episodes_table(d: Path):
    import pyarrow.parquet as pq
    import pyarrow as pa
    files = sorted((d / "meta" / "episodes").rglob("*.parquet"))
    if not files:
        raise HTTPException(status_code=422, detail="dataset has no episode metadata")
    return pa.concat_tables([pq.read_table(f) for f in files])


class EpisodeInfo(BaseModel):
    index: int
    length: int
    task: str
    duration_s: float


@router.get("/datasets/{repo_id}/episodes")
def list_episodes(repo_id: str):
    """Every episode with its length, task, and duration — the review list."""
    d = _dataset_dir(repo_id)
    t = _episodes_table(d)
    cameras = [_role(k) for k in _video_keys(d)]
    vkey = _first_video_key(d)
    cols = t.column_names
    from_c = f"videos/{vkey}/from_timestamp" if vkey else None
    to_c = f"videos/{vkey}/to_timestamp" if vkey else None
    out: list[EpisodeInfo] = []
    for i in range(t.num_rows):
        idx = t.column("episode_index")[i].as_py()
        length = t.column("length")[i].as_py() if "length" in cols else 0
        tasks = t.column("tasks")[i].as_py() if "tasks" in cols else None
        task = (tasks[0] if isinstance(tasks, list) and tasks else tasks) or ""
        dur = 0.0
        if from_c in cols and to_c in cols:
            dur = round(float(t.column(to_c)[i].as_py()) - float(t.column(from_c)[i].as_py()), 1)
        out.append(EpisodeInfo(index=int(idx), length=int(length), task=str(task), duration_s=dur))
    out.sort(key=lambda e: e.index)
    return {"repo_id": repo_id, "cameras": cameras, "episodes": out}


def _extract_clip(d: Path, repo_id: str, idx: int, camera: str | None = None) -> Path:
    """Serve episode `idx` for `camera`: a preview sidecar clip if the exporter
    made one (previews/<role>/ep<idx>.mp4, Phase 1 — no transcode), else
    transcode the AV1 on demand (H.264, cached by dataset mtime)."""
    import av

    vkey = _resolve_vkey(d, camera)
    sidecar = d / "previews" / _role(vkey) / f"ep{idx}.mp4"
    if sidecar.is_file():
        return sidecar
    t = _episodes_table(d)
    cols = t.column_names
    row = None
    for i in range(t.num_rows):
        if int(t.column("episode_index")[i].as_py()) == idx:
            row = i
            break
    if row is None:
        raise HTTPException(status_code=404, detail=f"episode {idx} not found")

    chunk = int(t.column(f"videos/{vkey}/chunk_index")[row].as_py())
    file_i = int(t.column(f"videos/{vkey}/file_index")[row].as_py())
    frm = float(t.column(f"videos/{vkey}/from_timestamp")[row].as_py())
    to = float(t.column(f"videos/{vkey}/to_timestamp")[row].as_py())
    src = d / "videos" / vkey / f"chunk-{chunk:03d}" / f"file-{file_i:03d}.mp4"
    if not src.is_file():
        raise HTTPException(status_code=404, detail="episode video file missing")

    mtime = int(src.stat().st_mtime)
    cache_dir = _CLIP_CACHE / repo_id
    cache_dir.mkdir(parents=True, exist_ok=True)
    dst = cache_dir / f"ep{idx}_{_role(vkey)}_{mtime}.mp4"
    if dst.exists():
        return dst

    import json
    fps = int(round(float(json.loads((d / "meta" / "info.json").read_text()).get("fps") or 30)))
    tmp = dst.with_suffix(".part")
    inp = av.open(str(src))
    ivs = inp.streams.video[0]
    out = av.open(str(tmp), "w", format="mp4")
    ovs = out.add_stream("libx264", rate=fps)
    ovs.width, ovs.height, ovs.pix_fmt = ivs.width, ivs.height, "yuv420p"
    ovs.options = {"crf": "26", "preset": "veryfast"}
    j = 0
    try:
        for f in inp.decode(ivs):
            ts = float(f.pts * ivs.time_base)
            if ts < frm:
                continue
            if ts > to:
                break
            nf = av.VideoFrame.from_ndarray(f.to_ndarray(format="rgb24"), format="rgb24")
            nf.pts = j
            nf.time_base = Fraction(1, fps)
            for p in ovs.encode(nf):
                out.mux(p)
            j += 1
        for p in ovs.encode():
            out.mux(p)
    finally:
        out.close()
        inp.close()
    tmp.rename(dst)
    return dst


@router.get("/datasets/{repo_id}/episode/{idx}/clip.mp4")
def episode_clip(repo_id: str, idx: int, camera: str | None = None):
    d = _dataset_dir(repo_id)
    clip = _extract_clip(d, repo_id, idx, camera)
    return FileResponse(clip, media_type="video/mp4")


class DeleteEpisodesBody(BaseModel):
    indices: list[int]


@router.post("/datasets/{repo_id}/delete-episodes")
def delete_episodes_route(repo_id: str, body: DeleteEpisodesBody):
    """Drop the given episodes from the dataset in place (re-indexed, stats
    recomputed by lerobot). Returns the new episode count."""
    d = _dataset_dir(repo_id)
    if not body.indices:
        raise HTTPException(status_code=422, detail="no episodes selected")
    from lerobot.datasets.lerobot_dataset import LeRobotDataset
    from lerobot.datasets.dataset_tools import delete_episodes

    root = _lerobot_cache_root()
    ds = LeRobotDataset(repo_id, root=root / repo_id)
    total = ds.meta.total_episodes
    keep = total - len(set(body.indices))
    if keep <= 0:
        raise HTTPException(status_code=422, detail="can't delete every episode; delete the dataset instead")

    # Write the edited dataset to a temp repo, then atomically swap it in — a
    # failed edit never corrupts the original.
    tmp_id = f"_editing_{repo_id}"
    tmp_path = root / tmp_id
    shutil.rmtree(tmp_path, ignore_errors=True)
    try:
        delete_episodes(ds, episode_indices=list(body.indices), output_dir=tmp_path, repo_id=repo_id)
    except Exception as e:
        shutil.rmtree(tmp_path, ignore_errors=True)
        logger.exception("[EPISODES] delete failed for %s", repo_id)
        raise HTTPException(status_code=500, detail=f"delete failed: {e}")

    backup = root / f"_{repo_id}.replacing"
    shutil.rmtree(backup, ignore_errors=True)
    (root / repo_id).rename(backup)          # move original aside
    tmp_path.rename(root / repo_id)          # swap edited in
    shutil.rmtree(backup, ignore_errors=True)  # drop original
    shutil.rmtree(_CLIP_CACHE / repo_id, ignore_errors=True)  # invalidate clip cache
    logger.info("[EPISODES] %s: deleted %d episodes -> %d remain", repo_id, len(set(body.indices)), keep)
    return {"repo_id": repo_id, "deleted": len(set(body.indices)), "remaining": keep}
