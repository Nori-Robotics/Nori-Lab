"""GR00T N1.7 adapter — serves a groot checkpoint behind the frozen /act contract.

The intended payload is a NORI FINETUNE (a LeRobot groot checkpoint from the
groot training lane, lerobot==0.6.0 policy format). GrootPolicy.from_pretrained
itself distinguishes the two loadable shapes, and this adapter follows it:
  * finetuned LeRobot checkpoint (has model.safetensors + lerobot config.json
    with type=groot) -> fitted pre/post processors from the checkpoint
    (make_pre_post_processors with pretrained_path — the pi05 pattern);
  * raw NVIDIA checkpoint (sharded safetensors, no lerobot config — e.g. the
    smoke default nvidia/SO_ARM_Starter_Gr00tN17, NVIDIA's own SO-ARM starter:
    wrong robot, right plumbing) -> fresh processors built from the
    checkpoint's own baked modality assets (make_groot_pre_post_processors
    resolves stats/tokenizer from base_model_path).

lerobot 0.6.0 is N1.7-ONLY (N1.5 support removed upstream; noncommercial N1.5
weights never load here) and defaults use_flash_attention=False, so this image
needs no flash-attn build. The Qwen3-VL tokenizer loads with trust_remote_code
from the checkpoint repo — the endpoint/Space needs an HF_TOKEN with repo
access (verified for nvidia/GR00T-N1.7-3B + the SO_ARM starter, 2026-07-28).

CHUNK SEMANTICS DIFFER FROM BOTH OTHER KINDS — the client must read meta():
  - horizon = the checkpoint's n_action_steps (groot default 40, NOT 30/50)
  - chunk_hz = the TRAINING DATASET's control rate (Nori fleet: ~15) — not in
    the checkpoint config, so it MUST come from NORI_CHUNK_HZ.
  - cameras = the checkpoint's image feature keys in order. A RAW checkpoint
    carries only a placeholder camera feature — fine for the smoke, but a
    production endpoint must serve a finetune, which names the real views.

LICENSE: serve N1.7 derivatives ONLY. Marketplace redistribution of finetuned
checkpoints needs the NVIDIA Open Model License attribution review first.
"""

from __future__ import annotations

import os
from typing import Optional

import numpy as np
from fastapi import HTTPException

from adapters.base import declared_joints, resolve_source

# Smoke default; production endpoints point MODEL_PATH/repository at the finetune.
FALLBACK_REPO = os.environ.get("NORI_GROOT_CHECKPOINT", "nvidia/SO_ARM_Starter_Gr00tN17")
# Control rate of the chunk. Config carries no fps; default to the Nori fleet's
# achieved ~15 (raw-bundle finding). Endpoints for other data MUST set this.
CHUNK_HZ = float(os.environ.get("NORI_CHUNK_HZ", "15"))
MAX_IMAGES = 6
# Flash attention for the Qwen3-VL backbone. Default ON: eager attention
# measured 13.5s/chunk on L4 (2026-07-28) — far past any refill budget. The
# image ships a prebuilt wheel (requirements-groot.txt); if the import fails
# (wheel/torch mismatch) we fall back to eager with a loud warning instead of
# refusing to serve.
FLASH_ATTN = os.environ.get("NORI_GROOT_FLASH_ATTN", "1") == "1"


class GrootAdapter:
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
        self._horizon: int = 40

    def load(self) -> None:
        import torch
        from lerobot.configs.policies import PreTrainedConfig
        from lerobot.policies.factory import get_policy_class, make_pre_post_processors

        self._source = resolve_source(self._probe_path, FALLBACK_REPO)
        print(f"[groot] loading from {self._source}", flush=True)

        # A finetune carries a lerobot config.json (type=groot); a raw NVIDIA
        # checkpoint does not — from_pretrained(config=None) then builds the
        # default N1.7 config around base_model_path=<source> itself.
        cfg = None
        try:
            cfg = PreTrainedConfig.from_pretrained(self._source)
        except Exception:
            print(f"[groot] no lerobot policy config at {self._source} — "
                  f"loading as a raw N1.7 checkpoint", flush=True)
        if cfg is not None and cfg.type != "groot":
            raise RuntimeError(f"checkpoint is policy type {cfg.type!r}, expected groot")

        use_flash = FLASH_ATTN
        if use_flash:
            try:
                import flash_attn  # noqa: F401
            except Exception as e:
                print(f"[groot] WARNING: flash_attn import failed ({e}) — serving "
                      f"with EAGER attention (measured ~13.5s/chunk on L4; fine "
                      f"for smoke, unusable for a live control loop)", flush=True)
                use_flash = False
        if cfg is not None:
            cfg.use_flash_attention = use_flash

        policy_cls = get_policy_class("groot")
        # For a raw checkpoint (cfg None) from_pretrained builds the default
        # config itself and applies kwargs onto it (hasattr-guarded upstream).
        policy = (policy_cls.from_pretrained(self._source, config=cfg)
                  if cfg is not None else
                  policy_cls.from_pretrained(self._source, use_flash_attention=use_flash))
        self._device = "cuda" if torch.cuda.is_available() else "cpu"
        policy.to(self._device)
        policy.eval()
        policy.reset()

        # Processors: fitted from the finetune when one exists (training-time
        # normalization stats — the pi05 lesson); else fresh ones built from
        # the raw checkpoint's own modality assets. Same device override as
        # pi05 (fitted device_processor bakes in the training device).
        dev = {"device_processor": {"device": self._device}}
        if cfg is not None:
            self._pre, self._post = make_pre_post_processors(
                cfg, pretrained_path=self._source,
                preprocessor_overrides=dev, postprocessor_overrides=dev)
        else:
            self._pre, self._post = make_pre_post_processors(
                policy.config,
                preprocessor_overrides=dev, postprocessor_overrides=dev)

        conf = policy.config
        for key, feat in (conf.input_features or {}).items():
            if "image" in key:
                self._image_keys.append(key)
            elif key == "observation.state":
                self._state_dim = feat.shape[0]
        for key, feat in (conf.output_features or {}).items():
            if key == "action":
                self._action_dim = feat.shape[0]
        self._horizon = int(getattr(conf, "n_action_steps", 40) or 40)
        self._policy = policy
        print(f"[groot] cameras={self._image_keys} state_dim={self._state_dim} "
              f"action_dim={self._action_dim} horizon={self._horizon}", flush=True)

    def meta(self) -> dict:
        return {"kind": "groot", "chunk_hz": CHUNK_HZ, "horizon": self._horizon,
                "dof": self._action_dim, "state_dim": self._state_dim,
                "cameras": list(self._image_keys), "max_images": MAX_IMAGES,
                "source": self._source, "joints": declared_joints(), "supports_point": False,
                "supports_rtc": False}

    def act(self, *, images, state, instruction, num_steps, extras):
        import torch

        n_expected = len(self._image_keys) or 1
        if len(images) != n_expected:
            raise HTTPException(
                status_code=422,
                detail=f"groot checkpoint expects exactly {n_expected} "
                       f"images in this order: {self._image_keys} (got {len(images)})")
        rtc_note = ({"skipped": "unsupported for policy kind groot"}
                    if extras.get("rtc") is not None else None)

        st = np.asarray(state, dtype=np.float32)
        if self._state_dim and st.shape[0] != self._state_dim:
            # The groot preprocessor pads to its 132-dim table internally, but a
            # FINETUNE's declared dim is a hard contract — reject mismatches.
            raise HTTPException(
                status_code=422,
                detail=f"state must have {self._state_dim} dims (got {st.shape[0]})")
        obs: dict = {
            "observation.state": torch.from_numpy(st).unsqueeze(0).to(self._device),
            "task": [instruction],
        }
        keys = self._image_keys or ["observation.images.camera"]
        for key, img in zip(keys, images):
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
