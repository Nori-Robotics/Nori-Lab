"""pi05 adapter — serves a LeRobot pi05 checkpoint behind the frozen /act contract.

The intended payload is a NORI FINETUNE (lerobot/pi05_base has NO normalization
stats and cannot run zero-shot — Gate B). For adapter smoke-tests the only
public stats-bearing PyTorch checkpoint is the community DROID conversion
(jcoholich/pi05_droid_converted) — wrong embodiment for a robot, fine for
proving the serving path end-to-end.

Load + inference mirror the PROVEN local path in lelab/nori_rollout.py at our
pinned lerobot commit: PreTrainedConfig -> get_policy_class -> from_pretrained
-> make_pre_post_processors (with the device_processor override — fitted
processors bake in the training device), then a select_action DRAIN LOOP: the
policy's internal queue does ONE forward for a chunk of n_action_steps and pops
per call, so `horizon` calls = one chunk with per-action postprocessing —
identical semantics to local inference, no reliance on chunk-level
postprocessor broadcasting.

CHUNK SEMANTICS DIFFER FROM MOLMOACT2 — the client must read meta():
  - horizon = the checkpoint's n_action_steps (pi05 default 50, NOT 30)
  - chunk_hz = the TRAINING DATASET's control rate (Nori fleet: ~15) — not
    stored in the checkpoint config, so it MUST come from NORI_CHUNK_HZ.
  - cameras = the checkpoint's image feature keys, in the order /act images
    must be sent.
"""

from __future__ import annotations

import os
from typing import Optional

import numpy as np
from fastapi import HTTPException

from adapters.base import resolve_source

# Smoke default; production endpoints point MODEL_PATH/repository at the finetune.
FALLBACK_REPO = os.environ.get("NORI_PI05_CHECKPOINT", "jcoholich/pi05_droid_converted")
# Control rate of the chunk. Config carries no fps; default to the Nori fleet's
# achieved ~15 (raw-bundle finding). Endpoints for other data MUST set this.
CHUNK_HZ = float(os.environ.get("NORI_CHUNK_HZ", "15"))
MAX_IMAGES = 6


class Pi05Adapter:
    def __init__(self, model_path: str):
        self._probe_path = model_path
        self._source: Optional[str] = None
        self._policy = None
        self._pre = None
        self._post = None
        self._device = None
        self._image_keys: list[str] = []
        self._state_dim: Optional[int] = None
        self._action_dim: Optional[int] = None
        self._horizon: int = 50

    def load(self) -> None:
        import torch
        from lerobot.configs.policies import PreTrainedConfig
        from lerobot.policies.factory import get_policy_class, make_pre_post_processors

        self._source = resolve_source(self._probe_path, FALLBACK_REPO)
        print(f"[pi05] loading from {self._source}", flush=True)
        cfg = PreTrainedConfig.from_pretrained(self._source)
        if cfg.type != "pi05":
            raise RuntimeError(f"checkpoint is policy type {cfg.type!r}, expected pi05")
        policy_cls = get_policy_class(cfg.type)
        policy = policy_cls.from_pretrained(self._source, config=cfg)
        self._device = "cuda" if torch.cuda.is_available() else "cpu"
        policy.to(self._device)
        policy.eval()
        policy.reset()

        # Fitted processors carry the training-time normalization stats — the
        # whole reason a base checkpoint can't serve. Same device override as
        # lelab (fitted device_processor bakes in 'cuda'; harmless here, but a
        # CPU dev box would silently drop stats without it — the "driving but
        # not moving" incident class).
        dev = {"device_processor": {"device": self._device}}
        try:
            self._pre, self._post = make_pre_post_processors(
                cfg, pretrained_path=self._source,
                preprocessor_overrides=dev, postprocessor_overrides=dev)
        except Exception as e:
            raise RuntimeError(
                f"no fitted pre/post processors in {self._source} ({e}) — a pi05 "
                f"checkpoint without stats cannot serve (Gate B: use a finetune, "
                f"not pi05_base)") from e

        # Feature contract from the checkpoint itself, not assumptions.
        for key, feat in (cfg.input_features or {}).items():
            if "image" in key:
                self._image_keys.append(key)
            elif key == "observation.state":
                self._state_dim = feat.shape[0]
        for key, feat in (cfg.output_features or {}).items():
            if key == "action":
                self._action_dim = feat.shape[0]
        self._horizon = int(getattr(cfg, "n_action_steps", 50) or 50)
        self._policy = policy
        print(f"[pi05] cameras={self._image_keys} state_dim={self._state_dim} "
              f"action_dim={self._action_dim} horizon={self._horizon}", flush=True)

    def meta(self) -> dict:
        return {"kind": "pi05", "chunk_hz": CHUNK_HZ, "horizon": self._horizon,
                "dof": self._action_dim, "state_dim": self._state_dim,
                "cameras": list(self._image_keys), "max_images": MAX_IMAGES,
                "source": self._source, "supports_point": False,
                "supports_rtc": False}

    def act(self, *, images, state, instruction, num_steps, extras):
        import torch

        if len(images) != len(self._image_keys):
            raise HTTPException(
                status_code=422,
                detail=f"pi05 checkpoint expects exactly {len(self._image_keys)} "
                       f"images in this order: {self._image_keys} (got {len(images)})")
        rtc_note = ({"skipped": "unsupported for policy kind pi05"}
                    if extras.get("rtc") is not None else None)

        # State: robot scale in, processors normalize + pad (max_state_dim 32).
        st = np.zeros((self._state_dim or len(state),), dtype=np.float32)
        n = min(len(state), st.shape[0])
        st[:n] = state[:n]
        obs: dict = {
            "observation.state": torch.from_numpy(st).unsqueeze(0).to(self._device),
            "task": [instruction],
        }
        for key, img in zip(self._image_keys, images):
            # HxWx3 uint8 -> 1x3xHxW float in [0,1] (lerobot image convention).
            t = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1)
            obs[key] = (t.float() / 255.0).unsqueeze(0).to(self._device)

        try:
            with torch.no_grad():
                self._policy.reset()          # fresh chunk per /act observation
                processed = self._pre(obs)
                chunk = []
                for _ in range(self._horizon):  # 1 forward + horizon-1 queue pops
                    a = self._policy.select_action(processed)
                    a = self._post(a)
                    chunk.append(a.squeeze(0).detach().float().cpu().numpy())
        except torch.cuda.OutOfMemoryError as e:
            torch.cuda.empty_cache()
            raise HTTPException(status_code=507, detail=f"CUDA OOM: {e}") from e
        acts = np.stack(chunk).astype(np.float32)
        if self._action_dim and acts.shape[-1] > self._action_dim:
            acts = acts[..., : self._action_dim]   # strip pad dims if post kept them
        return acts, {"rtc": rtc_note}
