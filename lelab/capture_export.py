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


def export_capture(capture_dir: Path, fps: int = 15, name: str | None = None) -> str:
    """Assemble the spool at `capture_dir` into a LeRobotDataset in the
    lerobot cache. Returns the created repo_id (cache-relative name the
    existing /nori/datasets/upload endpoint accepts)."""
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

    stem = name or "nori_remote_capture"
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", stem)
    repo_id = f"{stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    features = {
        "observation.state": {"dtype": "float32", "shape": (len(joints),), "names": joints},
        "action": {"dtype": "float32", "shape": (len(joints),), "names": joints},
        # One composite view (the robot's single H.264 mosaic). Per-tile crops
        # are a follow-up — meta.json carries the layout for it.
        "observation.images.remote": {
            "dtype": "video",
            "shape": (h, w, 3),
            "names": ["height", "width", "channels"],
        },
    }

    dataset = LeRobotDataset.create(
        repo_id,
        fps,
        features=features,
        robot_type=meta.get("room") or "nori_remote",
        use_videos=True,
    )

    tick_ms = 1000.0 / fps
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
                dataset.add_frame({
                    "observation.images.remote": img,
                    "observation.state": states[i],
                    "action": states[i + 1],
                    "task": ep["task"],
                })
                added += 1
            if added:
                dataset.save_episode()
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
