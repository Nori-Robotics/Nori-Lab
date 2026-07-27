"""LeRobotDataset adapter for Patch Policy training.

Produces, per sample:
  images:  {camera: (T, 3, 224, 224) float in [0,1]}
  actions: (T, chunk, action_dim) — for every observation frame, the chunk of
           actions starting AT that frame (the paper supervises every frame's
           chunk, not just the last frame's)
  pad:     (T, chunk) bool — True where the chunk ran past the episode end
           (LeRobot's *_is_pad), excluded from the loss.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch.utils.data import Dataset

from .model import PatchPolicyConfig


def camera_key(camera: str) -> str:
    return camera if camera.startswith("observation.images.") else f"observation.images.{camera}"


class PatchPolicyDataset(Dataset):
    def __init__(
        self,
        cfg: PatchPolicyConfig,
        repo_id: str,
        root: str | None = None,
        # pyav by default: torchcodec's dylibs are broken on some machines (macOS
        # FFmpeg linkage) and pyav works everywhere lelab does.
        video_backend: str | None = "pyav",
    ):
        from lerobot.datasets.lerobot_dataset import LeRobotDataset

        self.cfg = cfg
        t, chunk = cfg.obs_window, cfg.chunk_size
        fps_probe = LeRobotDataset(repo_id, root=root, video_backend=video_backend)
        fps = fps_probe.fps
        obs_deltas = [-(t - 1 - i) / fps for i in range(t)]
        action_deltas = [i / fps for i in range(-(t - 1), chunk)]
        delta_timestamps = {camera_key(c): obs_deltas for c in cfg.cameras}
        delta_timestamps["action"] = action_deltas
        self.ds = LeRobotDataset(
            repo_id, root=root, delta_timestamps=delta_timestamps, video_backend=video_backend
        )

    def __len__(self) -> int:
        return len(self.ds)

    def action_stats(self) -> tuple[list[float], list[float]]:
        stats = self.ds.meta.stats["action"]
        return (
            torch.as_tensor(stats["mean"]).flatten().tolist(),
            torch.as_tensor(stats["std"]).flatten().tolist(),
        )

    def __getitem__(self, index: int) -> dict:
        cfg = self.cfg
        t, chunk = cfg.obs_window, cfg.chunk_size
        item = self.ds[index]

        images: dict[str, torch.Tensor] = {}
        for camera in cfg.cameras:
            frames = item[camera_key(camera)].to(torch.float32)  # (T, 3, H, W) in [0,1]
            if frames.shape[-2:] != (cfg.image_size, cfg.image_size):
                frames = F.interpolate(
                    frames, size=(cfg.image_size, cfg.image_size),
                    mode="bilinear", align_corners=False, antialias=True,
                )
            images[camera] = frames

        actions = item["action"].to(torch.float32)  # (T-1+chunk, action_dim)
        pad = item.get("action_is_pad")
        pad = pad.bool() if pad is not None else torch.zeros(actions.shape[0], dtype=torch.bool)
        # Frame f's chunk = rows [f, f+chunk) of the delta-stamped action window.
        frame_chunks = torch.stack([actions[f : f + chunk] for f in range(t)])
        frame_pad = torch.stack([pad[f : f + chunk] for f in range(t)])
        return {"images": images, "actions": frame_chunks, "pad": frame_pad}
