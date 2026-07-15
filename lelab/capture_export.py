# NORI: Additive file. Spool → LeRobotDataset exporter for browser captures
# (see browser_capture.py for the spool contract and the pipeline overview).
#
# Everything is aligned on ONE clock: browser wall-clock ms. Each episode's
# video anchor is its "start" event t_ms (the browser starts a fresh
# MediaRecorder at that instant), so a video frame's absolute time is
# anchor + PTS. Telemetry/control rows carry their own t_ms.
#
# Resampling: a fixed grid at `fps` per episode. For each tick we take the
# latest video frame and the latest telemetry state at-or-before the tick
# (zero-order hold — both streams are "current state" signals).
#
# ACTION LABELS (v1 deliberate approximation): action[i] = state[i+1] — the
# standard next-observation proxy for teleop IL. The raw outbound control
# frames ARE spooled (controls.ndjson) but they're heterogeneous (jog rates,
# absolute targets, leader degrees) and mapping them onto follower joint
# targets needs the daemon's IK/normalization — revisit when the daemon
# exposes commanded targets in telemetry (additive protocol field, designed
# but not requested). The last grid tick is dropped (it has no successor).
#
# Output: a standard LeRobotDataset in the lerobot cache, created through the
# SAME pinned lerobot APIs record.py uses — so whatever format/codebase
# version the local recorder produces, we produce, and the backend
# finalize-validation + training container (same pin) accept it.

import json
import logging
import re
from datetime import datetime
from pathlib import Path

import numpy as np

from .datasets import _lerobot_cache_root as _cache_root

logger = logging.getLogger(__name__)

# Lift keys are startup-relative mm and may be absent per-tick ("height
# unknown"); base x/theta are velocities. All are excluded from v1 state so
# the vector is a stable, always-present joint-position vector — matching
# what an ACT policy consumes. Revisit when lift homing lands Pi-side.
_EXCLUDE_STATE_KEYS = re.compile(r"^(left_lift|right_lift)\.pos$|^(x|theta)\.vel$")


def _read_ndjson(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _episode_windows(events: list[dict]) -> list[dict]:
    """Pair start/stop events by index; unmatched starts are dropped (the
    browser crashed mid-episode — there's no clean video tail to trust)."""
    starts = {e["index"]: e for e in events if e["event"] == "start"}
    stops = {e["index"]: e for e in events if e["event"] == "stop"}
    out = []
    for idx in sorted(starts):
        if idx in stops and stops[idx]["t_ms"] > starts[idx]["t_ms"]:
            out.append({
                "index": idx,
                "t0": float(starts[idx]["t_ms"]),
                "t1": float(stops[idx]["t_ms"]),
                "task": starts[idx].get("task") or "teleop session",
            })
    return out


def _iter_video_frames(path: Path):
    """Yield (pts_ms, rgb_ndarray) sequentially from a MediaRecorder webm.
    PyAV; frames may carry no PTS in degenerate containers — those are skipped
    (we need timestamps to align)."""
    import av

    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            pts_ms = float(frame.pts * stream.time_base * 1000.0)
            yield pts_ms, frame.to_ndarray(format="rgb24")


def _state_vector(state: dict, joints: list[str]) -> np.ndarray:
    return np.array([float(state.get(j, 0.0)) for j in joints], dtype=np.float32)


def _views_from_layout(meta, w, h):
    """[(feature_key, (y0,y1,x0,x1))] slicing a composite into per-camera views.
    A grid layout {cols,rows,tiles} -> one observation.images.<role> per named
    tile (empty cells skipped, row-major to match the SDK's cameraTileRect). No
    usable layout -> the whole frame as observation.images.remote (legacy)."""
    layout = meta.get("layout")
    if isinstance(layout, dict):
        cols = int(layout.get("cols") or 0)
        rows = int(layout.get("rows") or 0)
        tiles = list(layout.get("tiles") or [])
        if cols >= 1 and rows >= 1 and tiles:
            tw, th = w // cols, h // rows
            views = []
            for i, role in enumerate(tiles):
                if not role:
                    continue
                key = "observation.images." + (re.sub(r"[^a-z0-9_]+", "_", str(role).lower()).strip("_") or f"cam{i}")
                x0, y0 = (i % cols) * tw, (i // cols) * th
                views.append((key, (y0, y0 + th, x0, x0 + tw)))
            if views:
                return views
    return [("observation.images.remote", (0, h, 0, w))]


def _open_previews(preview_dir, ep_idx, views, fps):
    """One low-bitrate H.264 writer per view -> previews/<role>/ep<idx>.mp4.
    Phase 1 sidecar: a browser-playable preview made once at export, so cloud
    viewing is a static serve (no per-view transcode). Best-effort; the caller
    guards so a preview failure never breaks the dataset export."""
    import av

    ws = {}
    for key, (y0, y1, x0, x1) in views:
        role = key.rsplit(".", 1)[-1]
        out = preview_dir / role
        out.mkdir(parents=True, exist_ok=True)
        tmp = out / f"ep{ep_idx}.part"
        c = av.open(str(tmp), "w", format="mp4")
        st = c.add_stream("libx264", rate=fps)
        st.width, st.height, st.pix_fmt = (x1 - x0), (y1 - y0), "yuv420p"
        st.options = {"crf": "30", "preset": "veryfast"}
        ws[key] = {"c": c, "st": st, "tmp": tmp, "final": out / f"ep{ep_idx}.mp4", "n": 0}
    return ws


def _preview_add(ws, key, img, fps):
    from fractions import Fraction
    import av

    w = ws.get(key)
    if not w:
        return
    fr = av.VideoFrame.from_ndarray(np.ascontiguousarray(img), format="rgb24")
    fr.pts = w["n"]
    fr.time_base = Fraction(1, fps)
    for pkt in w["st"].encode(fr):
        w["c"].mux(pkt)
    w["n"] += 1


def _close_previews(ws, keep):
    for w in ws.values():
        try:
            for pkt in w["st"].encode():
                w["c"].mux(pkt)
            w["c"].close()
        except Exception:
            pass
        try:
            if keep and w["n"] > 0:
                w["tmp"].rename(w["final"])
            else:
                w["tmp"].unlink(missing_ok=True)
        except Exception:
            pass


def export_capture(
    capture_dir: Path,
    fps: int = 15,
    name: str | None = None,
    append_to: str | None = None,
) -> str:
    """Assemble the spool at `capture_dir` into a LeRobotDataset in the
    lerobot cache. Returns the repo_id (cache-relative name the existing
    /nori/datasets/upload endpoint accepts).

    Three destinations:
      * append_to  — append episodes to that existing dataset (resume). The
        grid runs at ITS fps and its joint list is the contract; a capture
        whose joints differ fails loudly rather than silently zero-filling.
      * name       — create a new dataset with exactly this name (fails if
        taken — the caller should append instead).
      * neither    — create a new timestamp-suffixed nori_remote_capture_*.
    """
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    meta = json.loads((capture_dir / "meta.json").read_text())
    telemetry = _read_ndjson(capture_dir / "telemetry.ndjson")
    episodes = _episode_windows(_read_ndjson(capture_dir / "episodes.ndjson"))
    if not episodes:
        raise ValueError("no complete episodes in capture")
    telemetry = [r for r in telemetry if r.get("state")]
    if not telemetry:
        raise ValueError("no telemetry with joint state in capture")
    telemetry.sort(key=lambda r: r["t_ms"])

    # Joint order: sorted union of state keys across the capture, minus
    # velocities/lifts. Sorted => deterministic and independent of dict order.
    keys: set[str] = set()
    for r in telemetry:
        keys.update(r["state"].keys())
    joints = sorted(k for k in keys if not _EXCLUDE_STATE_KEYS.match(k))
    if not joints:
        raise ValueError("telemetry contains no joint position keys")

    # Probe first episode's video for frame geometry.
    first_video = capture_dir / f"video_ep{episodes[0]['index']}.webm"
    if not first_video.exists():
        raise ValueError(f"missing {first_video.name}")
    probe = next(_iter_video_frames(first_video), None)
    if probe is None:
        raise ValueError("could not decode any video frame from first episode")
    h, w, _ = probe[1].shape

    if append_to:
        # resume() demands an explicit root (root=None means the revision-safe
        # Hub snapshot cache, which a writer would corrupt). Our datasets live
        # at the cache root under their repo_id — same place create() puts them.
        dataset = LeRobotDataset.resume(append_to, root=_cache_root() / append_to)
        # The existing dataset owns the contract; this capture must match it.
        existing = dataset.features.get("observation.state", {})
        existing_joints = list(existing.get("names") or [])
        if existing_joints != joints:
            missing = sorted(set(existing_joints) - set(joints))
            extra = sorted(set(joints) - set(existing_joints))
            raise ValueError(
                f"capture joints don't match dataset {append_to!r}"
                + (f" (dataset-only: {missing})" if missing else "")
                + (f" (capture-only: {extra})" if extra else "")
                + " — record it into a new dataset instead"
            )
        if int(dataset.fps) != int(fps):
            logger.info(
                "[EXPORT] appending at dataset fps %s (requested %s)", dataset.fps, fps
            )
            fps = int(dataset.fps)
        # Frame geometry contract comes from the dataset, not this capture's
        # probe — the resize path below normalizes any drift.
        img_keys = sorted(k for k in dataset.features if k.startswith("observation.images."))
        if not img_keys:
            raise ValueError(f"dataset {append_to!r} has no camera views — not a capture dataset")
        if img_keys == ["observation.images.remote"]:
            vid = dataset.features["observation.images.remote"]
            h, w = int(vid["shape"][0]), int(vid["shape"][1])
            views = [("observation.images.remote", (0, h, 0, w))]
        else:
            cap_keys = sorted(k for k, _ in _views_from_layout(meta, 2, 2))
            if cap_keys != img_keys:
                raise ValueError(
                    f"capture cameras {cap_keys} don't match dataset {append_to!r} cameras {img_keys}"
                )
            lay = meta.get("layout") or {}
            th = int(dataset.features[img_keys[0]]["shape"][0])
            tw = int(dataset.features[img_keys[0]]["shape"][1])
            h, w = int(lay.get("rows") or 1) * th, int(lay.get("cols") or 1) * tw
            views = _views_from_layout(meta, w, h)
        repo_id = append_to
    else:
        if name:
            repo_id = re.sub(r"[^A-Za-z0-9._-]", "_", name)
            if (_cache_root() / repo_id).exists():
                raise ValueError(
                    f"a dataset named {repo_id!r} already exists — append to it, or pick another name"
                )
        else:
            stem = "nori_remote_capture"
            repo_id = f"{stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

        # Per-camera views cropped from the composite when the layout is a grid
        # (else a single observation.images.remote). Feeds a policy real per-cam
        # images instead of one mosaic it must sub-attend to.
        views = _views_from_layout(meta, w, h)
        features = {
            "observation.state": {"dtype": "float32", "shape": (len(joints),), "names": joints},
            "action": {"dtype": "float32", "shape": (len(joints),), "names": joints},
        }
        for _key, (_y0, _y1, _x0, _x1) in views:
            features[_key] = {
                "dtype": "video",
                "shape": (_y1 - _y0, _x1 - _x0, 3),
                "names": ["height", "width", "channels"],
            }

        dataset = LeRobotDataset.create(
            repo_id,
            fps,
            features=features,
            robot_type=meta.get("room") or "nori_remote",
            use_videos=True,
        )

    tick_ms = 1000.0 / fps
    preview_dir = _cache_root() / repo_id / "previews"
    total_frames = 0
    try:
        for ep in episodes:
            video_path = capture_dir / f"video_ep{ep['index']}.webm"
            if not video_path.exists():
                logger.warning("[EXPORT] %s missing, skipping episode %d", video_path.name, ep["index"])
                continue

            n_ticks = int((ep["t1"] - ep["t0"]) / tick_ms)
            if n_ticks < 2:
                logger.warning("[EXPORT] episode %d shorter than 2 ticks, skipping", ep["index"])
                continue

            # Preview sidecar clips for THIS episode (dataset index = episodes
            # saved so far). Best-effort — disabled for the episode on any error.
            ep_ds_idx = int(dataset.meta.total_episodes)
            try:
                previews = _open_previews(preview_dir, ep_ds_idx, views, fps)
            except Exception as pe:
                logger.warning("[EXPORT] preview writers failed for ep %d: %s", ep_ds_idx, pe)
                previews = None

            # Zero-order-hold state per tick. Telemetry before the episode's
            # first sample holds the first sample (leading edge).
            states: list[np.ndarray] = []
            ti = 0
            current = None
            for i in range(n_ticks):
                t = ep["t0"] + i * tick_ms
                while ti < len(telemetry) and telemetry[ti]["t_ms"] <= t:
                    current = telemetry[ti]["state"]
                    ti += 1
                if current is None:
                    current = telemetry[0]["state"]
                states.append(_state_vector(current, joints))
            # Rewind for the next episode (episodes share the telemetry list).
            ti = 0
            current = None

            # Stream video frames once, holding the latest frame per tick.
            frames = _iter_video_frames(video_path)
            pending = next(frames, None)
            last_img = pending[1] if pending else probe[1]
            added = 0
            for i in range(n_ticks - 1):  # -1: action needs a successor state
                t_rel = i * tick_ms  # PTS clock: 0 == recorder start == ep t0
                while pending is not None and pending[0] <= t_rel:
                    last_img = pending[1]
                    pending = next(frames, None)
                img = last_img
                if img.shape[:2] != (h, w):
                    # Mid-session encode-resolution change: normalize by letterbox-free
                    # nearest resize (rare; keeps the feature shape contract).
                    import cv2

                    img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
                frame_out = {
                    "observation.state": states[i],
                    "action": states[i + 1],
                    "task": ep["task"],
                }
                for _key, (_y0, _y1, _x0, _x1) in views:
                    frame_out[_key] = (
                        img if len(views) == 1
                        else np.ascontiguousarray(img[_y0:_y1, _x0:_x1])
                    )
                dataset.add_frame(frame_out)
                if previews is not None:
                    try:
                        for _key, _ in views:
                            _preview_add(previews, _key, frame_out[_key], fps)
                    except Exception as pe:
                        logger.warning("[EXPORT] preview frame failed: %s", pe)
                        _close_previews(previews, keep=False)
                        previews = None
                added += 1
            if previews is not None:
                _close_previews(previews, keep=bool(added))
            if added:
                dataset.save_episode(parallel_encoding=False)
                total_frames += added
                logger.info("[EXPORT] episode %d: %d frames @ %dfps", ep["index"], added, fps)
    finally:
        # v3 writer: finalize flushes buffers + writes meta; without it the
        # dataset is unreadable. Failure inside the loop still finalizes what
        # saved cleanly; the raised error reaches the status poll either way.
        if total_frames:
            dataset.finalize()

    if not total_frames:
        raise ValueError("no frames exported (episodes too short or video undecodable)")

    logger.info("[EXPORT] %s: %d frames across %d episode(s)", repo_id, total_frames, len(episodes))
    return repo_id
