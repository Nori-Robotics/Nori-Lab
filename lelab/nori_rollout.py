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
import json
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
_act_dbg_counter = 0  # throttles the per-tick rollout debug line to ~1/sec

_lock = threading.Lock()  # single-flight inference + load/unload mutex
_session: dict[str, Any] = {}  # ref, policy, pre, post, device, joints, image_shapes


def _apply_act_execution(cfg, temporal_ensemble_coeff, n_action_steps) -> dict[str, Any]:
    """INFERENCE-ONLY execution overrides for ACT — how the trained policy is
    *executed*, never how it was trained (see the training-vs-inference split:
    only chunk_size is a training param; these two are read solely by
    select_action). Mutating cfg before the policy is built reconfigures the
    action queue / temporal ensembler with no retrain.

    - temporal_ensemble_coeff set  → re-plan every step, blend overlapping chunk
      predictions (smooth, closed-loop). lerobot REQUIRES n_action_steps == 1 here.
    - else n_action_steps set       → fixed open-loop execution horizon (1..chunk_size).
    - neither                       → leave the checkpoint's saved values as-is.

    Returns the effective {temporal_ensemble_coeff, n_action_steps} for the client.
    No-op for non-ACT policies (they don't expose these knobs today).
    """
    if getattr(cfg, "type", None) != "act":
        return {
            "temporal_ensemble_coeff": getattr(cfg, "temporal_ensemble_coeff", None),
            "n_action_steps": getattr(cfg, "n_action_steps", None),
        }
    chunk = int(getattr(cfg, "chunk_size", 100))
    if temporal_ensemble_coeff is not None:
        cfg.temporal_ensemble_coeff = float(temporal_ensemble_coeff)
        cfg.n_action_steps = 1  # enforced by ACTConfig.__post_init__
    elif n_action_steps is not None:
        cfg.temporal_ensemble_coeff = None
        cfg.n_action_steps = max(1, min(int(n_action_steps), chunk))
    return {
        "temporal_ensemble_coeff": cfg.temporal_ensemble_coeff,
        "n_action_steps": cfg.n_action_steps,
    }


def _resolve_fps(bundle: Path, override: int | None) -> int:
    """Control-loop rate for the rollout. Priority: explicit override → the
    training fps stamped into the bundle (nori_meta.json, written at promotion)
    → the conservative default. Running the loop at the TRAINING fps matters for
    ACT — especially temporal ensembling — which assumes execution at the rate
    the policy was trained on (e.g. 15 Hz for move_red_cup_split, not 10)."""
    if override and override > 0:
        return int(override)
    meta = bundle / "nori_meta.json"
    if meta.is_file():
        try:
            with open(meta) as f:
                fps = json.load(f).get("fps")
            if isinstance(fps, (int, float)) and fps > 0:
                return int(round(fps))
        except Exception:
            logger.warning("[ROLLOUT] unreadable nori_meta.json in %s — using default fps", bundle)
    return DEFAULT_FPS


def _read_scope(bundle: Path) -> dict | None:
    """The camera/arm scope stamped into nori_meta.json at promotion, or None for
    a whole-robot policy. When present, {state_joints, action_joints, cameras}
    name the exact joints the scoped policy reads/commands — the rollout selects
    these out of the robot's full joint set so the client stays scope-agnostic."""
    meta = bundle / "nori_meta.json"
    if not meta.is_file():
        return None
    try:
        with open(meta) as f:
            scope = json.load(f).get("scope")
        if isinstance(scope, dict) and scope.get("action_joints"):
            return scope
    except Exception:
        logger.warning("[ROLLOUT] unreadable scope in nori_meta.json (%s)", bundle)
    return None


def _load_bundle(
    ref: str,
    joints: list[str],
    temporal_ensemble_coeff: float | None = None,
    n_action_steps: int | None = None,
    fps: int | None = None,
) -> dict[str, Any]:
    import torch
    from lerobot.configs.policies import PreTrainedConfig
    from lerobot.policies.factory import get_policy_class, make_pre_post_processors

    bundle = Path(config.NORI_POLICY_CACHE) / ref
    if not (bundle / "model.safetensors").is_file():
        raise HTTPException(
            status_code=404,
            detail=f"policy {ref!r} is not installed locally — install it from the marketplace first.",
        )

    resolved_fps = _resolve_fps(bundle, fps)
    cfg = PreTrainedConfig.from_pretrained(str(bundle))
    # Apply inference-time execution overrides BEFORE building the policy so the
    # action queue / temporal ensembler are constructed from the chosen values.
    execution = _apply_act_execution(cfg, temporal_ensemble_coeff, n_action_steps)
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
    #
    # The fitted processors are saved with the TRAINING device baked into the
    # `device_processor` step (always 'cuda' — training runs on the GPU
    # container). On a non-CUDA host (e.g. an Apple-Silicon Mac → mps) that step
    # fails to instantiate and we'd silently fall back to config-default
    # processors — which DROPS the fitted normalization stats, so the policy
    # sees un-normalized observations and just holds its pose ("driving but not
    # moving"). Override the device to THIS host's device so the fitted stats
    # actually load. (2026-07-15 incident: bbf7ff17 on mps.)
    _dev_override = {"device_processor": {"device": device}}
    try:
        pre, post = make_pre_post_processors(
            cfg,
            pretrained_path=str(bundle),
            preprocessor_overrides=_dev_override,
            postprocessor_overrides=_dev_override,
        )
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

    # Scoped policies (camera/arm subset) name their own joints in nori_meta.json.
    # The client always passes the FULL robot joint set; we select the scoped
    # ones server-side, so the client stays scope-agnostic. The daemon safely
    # holds the joints a scoped policy doesn't command (verified partial-action
    # contract), so a one-arm policy leaves the other arm held/teleoperable.
    scope = _read_scope(bundle)
    if scope:
        state_joints = list(scope.get("state_joints") or [])
        action_joints = list(scope.get("action_joints") or [])
        session_joints = set(joints)
        missing = [
            j for j in dict.fromkeys(state_joints + action_joints)
            if j not in session_joints
        ]
        if missing:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"scoped policy needs joint(s) {missing} that this robot session "
                    f"does not provide ({joints})."
                ),
            )
        if state_dim is not None and len(state_joints) != state_dim:
            raise HTTPException(
                status_code=422,
                detail=(f"bundle scope inconsistent: {len(state_joints)} state_joints "
                        f"vs policy state dim {state_dim}."),
            )
        if action_dim is not None and len(action_joints) != action_dim:
            raise HTTPException(
                status_code=422,
                detail=(f"bundle scope inconsistent: {len(action_joints)} action_joints "
                        f"vs policy action dim {action_dim}."),
            )
    else:
        state_joints = list(joints)
        action_joints = list(joints)
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
        "joints": state_joints,          # order for the observation.state vector
        "action_joints": action_joints,  # order for the returned action dict
        "scoped": scope is not None,
        "image_shapes": image_shapes,
        "execution": execution,
        "fps": resolved_fps,
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
    # Inference-time execution controls for ACT (no effect on training):
    #   temporal_ensemble_coeff — set (e.g. 0.01) for smooth closed-loop
    #     execution (re-plan every step, blend chunks); None to disable.
    #   n_action_steps — open-loop execution horizon (1..chunk_size) when NOT
    #     ensembling. Ignored when temporal_ensemble_coeff is set (forced to 1).
    # Both omitted → use the checkpoint's saved values.
    temporal_ensemble_coeff: float | None = None
    n_action_steps: int | None = None
    # Control-loop rate override (Hz). Omit to use the bundle's stamped training
    # fps (nori_meta.json), falling back to DEFAULT_FPS. ACT should execute at
    # the fps it was trained on.
    fps: int | None = None


@router.post("/load")
def rollout_load(body: LoadBody):
    if not body.joints:
        raise HTTPException(status_code=422, detail="joints list is empty — is telemetry flowing?")
    with _lock:
        _session.clear()
        sess = _load_bundle(
            body.ref, body.joints,
            temporal_ensemble_coeff=body.temporal_ensemble_coeff,
            n_action_steps=body.n_action_steps,
            fps=body.fps,
        )
        _session.update(sess)
        logger.info("[ROLLOUT] loaded %s on %s (%d joints, images: %s, exec: %s)",
                    body.ref, sess["device"], len(body.joints),
                    list(sess["image_shapes"]), sess["execution"])
        return {
            "ref": body.ref,
            "device": sess["device"],
            "joints": sess["joints"],
            "image_keys": {k: list(v) for k, v in sess["image_shapes"].items()},
            "fps": sess["fps"],
            "execution": sess["execution"],
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
        joints = _session["joints"]                                   # state vector order
        action_joints = _session.get("action_joints") or joints       # action dict order
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

        # DEBUG (throttled ~1/s): diagnose a "driving but not moving" run.
        #  - action max_delta ≈ 0  => the policy is commanding ~the current pose
        #    (no motion) — an observation/out-of-distribution problem.
        #  - a camera mean ≈ 0     => that feed is black; ~constant across ticks
        #    => it's frozen. Either way the policy sees the wrong scene.
        global _act_dbg_counter
        _act_dbg_counter += 1
        if _act_dbg_counter % 15 == 0:
            cur = [float(body.state.get(j, 0.0)) for j in action_joints]
            dmax = max((abs(a - c) for a, c in zip(vec, cur)), default=0.0)
            jmax = action_joints[max(range(len(vec)), key=lambda i: abs(vec[i] - cur[i]))] if vec else "-"
            cams = {k.split(".")[-1]: round(float(obs[k].mean().item()), 3) for k in _session["image_shapes"]}
            logger.info(
                "[ROLLOUT-DBG] action max_delta=%.3f @%s (~0 => policy commanding NO motion) | cam means=%s (~0 => black feed)",
                dmax, jmax, cams,
            )
        if len(vec) != len(action_joints):
            raise HTTPException(
                status_code=500,
                detail=f"policy produced {len(vec)} outputs for {len(action_joints)} action joints",
            )
        # Only the scoped joints are commanded; the daemon holds the rest.
        return {"action": {j: v for j, v in zip(action_joints, vec)}}


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
