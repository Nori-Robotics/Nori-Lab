# NORI: Additive file. Laptop-side policy execution for REMOTE robots — the
# architecture the NoriTeleop docs prescribe (full_nori_plan.md §"Robot push":
# "after download lands locally, the user can run lelab rollout against the
# downloaded policy"; §Video-sink: decoded session frames are the "inference
# tap" feeding local model loops).
#
# THE PI NEVER RECEIVES OR EXECUTES A POLICY. The flow is:
#
#   marketplace install (bundle -> NORI_POLICY_CACHE/<ref>/, existing)
#     -> POST /nori/rollout/load {ref, joints}   (policy into laptop memory)
#     -> browser loop: session observations (video frame + joint state)
#          -> POST /nori/rollout/act -> {action}
#          -> teleop.sendAction(action)  == {type:"control", action:{...}}
#     -> POST /nori/rollout/unload
#
# The only thing that crosses to the robot is the standard control frame —
# pure motor targets, identical to a teleop keypress. Every safety layer
# (normalize, IK, clamp, slew, watchdog, E-STOP) applies unchanged because
# the daemon cannot tell a policy from a human. This replaces the
# delivery-grant "install onto the robot" flow, which contradicted the
# documented Pi contract (the Pi is a safety daemon, not a compute host).
#
# Joint-order contract: the caller supplies `joints` — the sorted joint-key
# list derived from live telemetry EXACTLY the way capture_export.py derives
# it for training (sorted, lifts/velocities excluded). A policy trained on a
# Nori browser capture therefore sees vectors in the same order it was
# trained on. Dimension mismatches are refused at /load with both numbers.
#
# Mirrors upstream LeLab's rollout.py in spirit (single session, explicit
# lifecycle) but runs IN-PROCESS: the subprocess-per-rollout model exists for
# serial-bus cleanup, which doesn't apply here — no bus is opened.

import base64
import logging
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .utils import config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nori/rollout")

# Suggested browser loop rate. ACT inference on Apple Silicon (mps) runs a
# forward pass in tens of ms; 10 Hz leaves headroom for JPEG encode + POST.
DEFAULT_FPS = 10

_lock = threading.Lock()  # single-flight inference + load/unload mutex
_session: dict[str, Any] = {}  # ref, policy, pre, post, device, joints, image_shapes


def _load_bundle(ref: str, joints: list[str]) -> dict[str, Any]:
    import torch
    from lerobot.configs.policies import PreTrainedConfig
    from lerobot.policies.factory import get_policy_class, make_pre_post_processors

    bundle = Path(config.NORI_POLICY_CACHE) / ref
    if not (bundle / "model.safetensors").is_file():
        raise HTTPException(
            status_code=404,
            detail=f"policy {ref!r} is not installed locally — install it from the marketplace first.",
        )

    cfg = PreTrainedConfig.from_pretrained(str(bundle))
    policy_cls = get_policy_class(cfg.type)
    policy = policy_cls.from_pretrained(str(bundle), config=cfg)

    device = "mps" if torch.backends.mps.is_available() else (
        "cuda" if torch.cuda.is_available() else "cpu"
    )
    policy.to(device)
    policy.eval()
    policy.reset()

    # Newer bundles ship the fitted processor files (policy_pre/postprocessor
    # .json + .safetensors); bundles promoted before the real-training merge
    # have only config+model. Fall back to config-derived default processors
    # for those — same behavior lerobot itself uses for a bare checkpoint.
    try:
        pre, post = make_pre_post_processors(cfg, pretrained_path=str(bundle))
    except Exception as e:
        logger.warning("[ROLLOUT] no fitted processors in %s (%s) — using config defaults", ref, e)
        pre, post = make_pre_post_processors(cfg)

    # Feature contract from the policy's own config.
    image_shapes: dict[str, tuple] = {}
    state_dim = None
    for key, feat in (cfg.input_features or {}).items():
        if "image" in key:
            image_shapes[key] = tuple(feat.shape)  # (C, H, W)
        elif key == "observation.state":
            state_dim = feat.shape[0]
    action_dim = None
    for key, feat in (cfg.output_features or {}).items():
        if key == "action":
            action_dim = feat.shape[0]

    if state_dim is not None and len(joints) != state_dim:
        raise HTTPException(
            status_code=422,
            detail=(
                f"policy expects a {state_dim}-dim state but this robot session "
                f"has {len(joints)} joints ({joints}). This policy was likely "
                "trained on a different robot configuration."
            ),
        )
    if action_dim is not None and state_dim is not None and action_dim != state_dim:
        # Unusual but possible; we can only name outputs we have names for.
        raise HTTPException(
            status_code=422,
            detail=f"policy action dim ({action_dim}) != state dim ({state_dim}); unsupported in v1.",
        )

    return {
        "ref": ref,
        "policy": policy,
        "pre": pre,
        "post": post,
        "device": device,
        "joints": list(joints),
        "image_shapes": image_shapes,
    }


def _decode_image(data: str, chw: tuple):
    """base64 (optionally dataURL) JPEG/PNG -> float32 CHW tensor in [0,1],
    resized to the policy's expected shape."""
    import cv2
    import numpy as np
    import torch

    if "," in data[:64] and data.lstrip().startswith("data:"):
        data = data.split(",", 1)[1]
    raw = np.frombuffer(base64.b64decode(data), np.uint8)
    img = cv2.imdecode(raw, cv2.IMREAD_COLOR)  # BGR
    if img is None:
        raise HTTPException(status_code=422, detail="undecodable image payload")
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    c, h, w = chw
    if img.shape[:2] != (h, w):
        img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
    t = torch.from_numpy(img).float().permute(2, 0, 1) / 255.0
    return t.unsqueeze(0)  # [1, C, H, W]


# ---------------------------------------------------------------- endpoints
class LoadBody(BaseModel):
    ref: str
    # Joint order for state/action vectors — derived by the CLIENT from live
    # telemetry with the same filter/sort the dataset exporter uses.
    joints: list[str]


@router.post("/load")
def rollout_load(body: LoadBody):
    if not body.joints:
        raise HTTPException(status_code=422, detail="joints list is empty — is telemetry flowing?")
    with _lock:
        _session.clear()
        sess = _load_bundle(body.ref, body.joints)
        _session.update(sess)
        logger.info("[ROLLOUT] loaded %s on %s (%d joints, images: %s)",
                    body.ref, sess["device"], len(body.joints), list(sess["image_shapes"]))
        return {
            "ref": body.ref,
            "device": sess["device"],
            "joints": sess["joints"],
            "image_keys": {k: list(v) for k, v in sess["image_shapes"].items()},
            "fps": DEFAULT_FPS,
        }


class ActBody(BaseModel):
    state: dict[str, float]
    images: dict[str, str] = {}


@router.post("/act")
def rollout_act(body: ActBody):
    import torch

    with _lock:
        if not _session:
            raise HTTPException(status_code=409, detail="no policy loaded")
        policy = _session["policy"]
        joints = _session["joints"]
        device = _session["device"]

        missing = [k for k in _session["image_shapes"] if k not in body.images]
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"policy needs image feature(s) {missing} — not supplied by the client.",
            )

        obs: dict[str, Any] = {
            "observation.state": torch.tensor(
                [[float(body.state.get(j, 0.0)) for j in joints]], dtype=torch.float32
            ).to(device),
        }
        for key, chw in _session["image_shapes"].items():
            obs[key] = _decode_image(body.images[key], chw).to(device)

        with torch.no_grad():
            processed = _session["pre"](obs)
            action = policy.select_action(processed)
            action = _session["post"](action)

        vec = action.squeeze(0).detach().float().cpu().tolist()
        if len(vec) != len(joints):
            raise HTTPException(
                status_code=500,
                detail=f"policy produced {len(vec)} outputs for {len(joints)} joints",
            )
        return {"action": {j: v for j, v in zip(joints, vec)}}


@router.post("/unload")
def rollout_unload():
    with _lock:
        had = _session.get("ref")
        _session.clear()
    return {"unloaded": had}


@router.get("/status")
def rollout_status():
    with _lock:
        if not _session:
            return {"loaded": None}
        return {
            "loaded": _session["ref"],
            "device": _session["device"],
            "joints": _session["joints"],
            "image_keys": list(_session["image_shapes"]),
        }
