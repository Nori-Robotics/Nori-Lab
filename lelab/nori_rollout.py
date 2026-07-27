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
import os
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import nori_cam_zmq as camzmq
from . import policy_stream_rx as streamrx
from . import nori_cloud_rollout as cloudmod
from .utils import config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nori/rollout")

# Suggested browser loop rate. ACT inference on Apple Silicon (mps) runs a
# forward pass in tens of ms; 10 Hz leaves headroom for JPEG encode + POST.
DEFAULT_FPS = 10
_act_dbg_counter = 0  # throttles the per-tick rollout debug line to ~1/sec

_lock = threading.Lock()  # single-flight inference + load/unload mutex

# The armed/live policy-stream receiver (STREAM_INTEGRATION_PLAN §2). Module-
# level, NOT session state: the orchestration arms it BEFORE /rollout/load
# (the robot needs a target to dial), so it must survive the load path's
# previous-session cleanup. Closed by /stream/close and by /unload.
_stream = None  # Optional[streamrx.StreamListener]


def _detect_host() -> str:
    """The LAN address the robot should dial. Default-route interface trick
    (no packet is sent); NORI_STREAM_HOST overrides for multi-NIC laptops."""
    env = os.environ.get("NORI_STREAM_HOST", "").strip()
    if env:
        return env
    import socket as _socket
    sk = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
    try:
        sk.connect(("10.255.255.255", 1))
        return sk.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sk.close()


class StreamOpenBody(BaseModel):
    # Supplied by the FRONTEND APP from its pairing/session state (the SDK does
    # not know the serial). The receiver drops any stream whose preamble names
    # a different robot — the v1 stand-in for sink auth.
    expected_serial: str
    port: int = 0  # 0 = ephemeral


@router.post("/stream/open")
def stream_open(body: StreamOpenBody):
    """Arm the policy-stream receiver. Returns the {host, port} the browser
    hands the robot as `target` in {type:"policy_stream", action:"start"}.
    Re-opening replaces any previous listener (a retry is open->start again)."""
    global _stream
    serial = body.expected_serial.strip()
    if not serial:
        raise HTTPException(status_code=422, detail="expected_serial is required")
    with _lock:
        if _stream is not None:
            _stream.close()
        lst = streamrx.StreamListener(
            serial, port=body.port or int(os.environ.get("NORI_STREAM_PORT", "0")))
        lst.open()  # binds all interfaces; we advertise the routable address
        _stream = lst
    return {"host": _detect_host(), "port": lst.port}


@router.post("/stream/close")
def stream_close():
    global _stream
    with _lock:
        had = _stream is not None
        if _stream is not None:
            _stream.close()
            _stream = None
    return {"closed": had}


@router.get("/stream/status")
def stream_status():
    st = _stream
    return st.status() if st is not None else {
        "armed": False, "connected": False, "preamble_received": False}
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


def _read_capture_source(bundle: Path) -> str | None:
    """The dataset provenance stamped into nori_meta.json at promotion:
    "raw_bundle" (Pi recorder, full-quality) or "browser" (deprecated composite
    catcher). Absent on every bundle promoted before the stamp exists — treated
    as browser-era, i.e. composite, i.e. today's behavior."""
    meta = bundle / "nori_meta.json"
    if not meta.is_file():
        return None
    try:
        with open(meta) as f:
            src = json.load(f).get("capture_source")
        return src if src in ("raw_bundle", "browser") else None
    except Exception:
        return None


def _resolve_use_stream(requested: bool | None, capture_source: str | None) -> bool:
    """The P6 provenance rule (STREAM_INTEGRATION_PLAN §5): the frame source
    must MATCH the policy's training domain. raw_bundle-trained -> stream frames
    (same bytes as training); browser-trained or unstamped -> composite, because
    feeding full-quality frames to a policy trained on degraded composites is
    the cloud path's train/infer mismatch, inverted. An explicit request wins
    either way — the operator may be A/B-testing exactly that mismatch."""
    if requested is not None:
        return requested
    return capture_source == "raw_bundle"


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
    # LOCAL sessions: feed the policy the robot's full-quality policy stream
    # instead of the browser's composite crops. None (default) = auto by the
    # bundle's stamped capture_source; explicit true/false overrides (warned
    # when it contradicts provenance). Cloud sessions ignore this — the stream
    # is always preferred there.
    use_stream: bool | None = None
    # Control-loop rate override (Hz). Omit to use the bundle's stamped training
    # fps (nori_meta.json), falling back to DEFAULT_FPS. ACT should execute at
    # the fps it was trained on.
    fps: int | None = None
    # --- cloud VLA fields (provider="cloud"); ignored by the local ACT path ---
    #   provider    — "local" (an installed ACT bundle) or "cloud" (a remote VLA
    #                 endpoint, e.g. MolmoAct2 on a HF Space / AWS g5).
    #   instruction — natural-language task the VLA is conditioned on (required for cloud).
    #   num_steps   — flow-matching integration steps (latency <-> quality).
    #   views       — image feature keys the browser should grab & send, in the
    #                 order the model expects them; omit to use NORI_INFER_VIEWS
    #                 or the single composite feed.
    provider: str = "local"
    instruction: str | None = None
    num_steps: int | None = None
    views: list[str] | None = None
    #   arm — which arm a single-arm cloud VLA drives ("left"/"right"), or
    #   "both": TWO independent endpoint sessions (one per arm), each fed its
    #   own wrist view + the shared overhead, merged into one 12-joint command
    #   per tick (MolmoAct2 only — the model is inherently single-arm). The
    #   Nori robot is bimanual; with one arm the daemon holds the other. Omit
    #   to use NORI_INFER_ARM (default "left").
    arm: str | None = None
    #   instruction_left / instruction_right — per-arm task overrides for
    #   arm="both" (e.g. "hold the bowl" / "pick up the red cup"); either
    #   falls back to `instruction`.
    instruction_left: str | None = None
    instruction_right: str | None = None
    #   policy_kind — which policy family the endpoint serves ("molmoact2",
    #   "pi05", "groot"). The multi-policy server reports its kind + chunk
    #   semantics in /health `meta` (INFERENCE_ENDPOINT_PLAN step 5/6); /load
    #   validates an explicit value against it (fail at load, not mid-rollout).
    #   Omit = trust the endpoint. Legacy single-model servers (no meta) are
    #   treated as molmoact2.
    policy_kind: str | None = None


def _env_arm() -> str:
    a = (os.environ.get("NORI_INFER_ARM") or "left").strip().lower()
    return a if a in ("left", "right", "both") else "left"


def _env_views() -> list[str] | None:
    raw = os.environ.get("NORI_INFER_VIEWS", "").strip()
    parsed = [v.strip() for v in raw.split(",") if v.strip()]
    return parsed or None


def _env_fps(default: int = 15) -> int:
    try:
        v = int(os.environ.get("NORI_INFER_FPS", str(default)))
        return v if v > 0 else default
    except ValueError:
        return default


def _cloud_load(body: LoadBody) -> dict:
    """Set up a cloud-VLA rollout session: no local weights — just an endpoint,
    a bearer token, and a chunk queue. The browser loop is identical to the
    local path (it grabs the returned `image_keys` and POSTs /act each tick)."""
    requested_kind = (body.policy_kind or "").strip().lower() or None
    endpoint = cloudmod.infer_url(requested_kind)
    token = cloudmod.infer_token(requested_kind)
    if not endpoint:
        raise HTTPException(
            status_code=503,
            detail=("cloud inference not configured — set NORI_INFER_URL"
                    + (f" or NORI_INFER_URL_{requested_kind.upper()}" if requested_kind else "")))
    if not token:
        raise HTTPException(status_code=503,
                            detail="cloud inference token missing — set NORI_INFER_TOKEN or ~/.nori_infer_token")
    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(status_code=422,
                            detail="a cloud VLA needs an instruction (natural-language task)")
    fps = body.fps if (body.fps and body.fps > 0) else _env_fps()
    arm = (body.arm or _env_arm()).strip().lower()
    # Fail fast on an unreachable endpoint; a not-yet-"ready" Space is fine (this
    # also wakes a sleeping Space — refills retry until the model finishes loading).
    # Health comes BEFORE joint scoping: the lane shape depends on the endpoint's
    # declared action dimension (meta.dof).
    try:
        health = cloudmod.health_check(endpoint)
    except Exception as e:
        raise HTTPException(status_code=502,
                            detail=f"cloud endpoint {endpoint} unreachable: {type(e).__name__}: {e}")
    # Per-policy chunk semantics from the endpoint's /health meta (step-5 server).
    # A legacy single-model server has no meta -> molmoact2 semantics, unchanged.
    meta = health.get("meta") or {}
    endpoint_kind = (meta.get("kind") or health.get("kind") or "molmoact2").lower()
    if body.policy_kind and endpoint_kind != body.policy_kind.strip().lower():
        raise HTTPException(
            status_code=422,
            detail=(f"endpoint {endpoint} serves policy kind {endpoint_kind!r}, "
                    f"but this load requested {body.policy_kind!r} — check NORI_INFER_URL"
                    + (f"_{requested_kind.upper()}" if requested_kind else "")))
    # chunk_hz: the rate the chunk was AUTHORED at. meta wins; molmoact2 default
    # otherwise. pi05/groot endpoints MUST carry meta (their server always does).
    meta_chunk_hz = float(meta.get("chunk_hz") or 0.0) or cloudmod.MOLMOACT2_CHUNK_HZ
    # Bounds + calibration are MolmoAct2 CONVENTIONS (SO-100/101 model space +
    # the nori<->fleet affine). A Nori finetune (pi05/groot) is trained in OUR
    # joint space — applying the molmoact2 calib would corrupt its actions.
    is_molmoact2 = endpoint_kind == "molmoact2"
    bounds = cloudmod.MOLMOACT2_BOUNDS if is_molmoact2 else None
    dof = int(meta.get("dof") or 0)

    # Lane shape (joint mapping):
    #   * molmoact2 / 6-dim finetune — the model's 6-DoF output maps to ONE
    #     arm's keys (arm_keys order); arm="both" runs TWO independent per-arm
    #     lanes merged into one command per tick.
    #   * 12-dim Nori finetune (pi05 trained on the bimanual dataset) — NATIVE
    #     bimanual: ONE session sees full state and outputs all 12 joints
    #     (left block then right, the fleet dataset convention). arm must be
    #     "both"; a single arm is meaningless for a 12-dim checkpoint.
    native_bimanual = (not is_molmoact2) and dof == 12
    if native_bimanual and arm != "both":
        raise HTTPException(
            status_code=422,
            detail=(f"this {endpoint_kind} checkpoint outputs 12 joints (native "
                    f"bimanual) — it drives both arms in one session; use arm='both'"))
    if arm == "both" and not is_molmoact2 and not native_bimanual:
        if dof != 6:
            raise HTTPException(
                status_code=422,
                detail=(f"endpoint serves {endpoint_kind!r} with action dim "
                        f"{dof or 'unknown'} — arm='both' needs a 12-dim native-"
                        f"bimanual finetune (one session) or a 6-dim single-arm "
                        f"model (two per-arm lanes)"))
    if native_bimanual:
        lane_arms = ["both"]
        per_arm_keys: dict[str, list[str]] = {
            "both": cloudmod.arm_keys("left") + cloudmod.arm_keys("right")}
    else:
        lane_arms = ["left", "right"] if arm == "both" else [arm]
        per_arm_keys = {}
        for a in lane_arms:
            try:
                per_arm_keys[a] = cloudmod.arm_keys(a)
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e))
    # Validate the keys exist in the live session so a bimanual/single-arm or
    # left/right mismatch fails at /load, not silently mid-rollout.
    have = set(body.joints)
    missing = [k for a in lane_arms for k in per_arm_keys[a] if k not in have]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=(f"cloud VLA drives the {arm!r} arm(s) but the session is missing "
                    f"joint(s) {missing}. Session joints: {sorted(body.joints)}."),
        )
    # Views. Single arm: caller/env choice, else the arm's wrist + overhead;
    # a Nori-finetune checkpoint may name its camera FEATURE KEYS in meta —
    # trust those when the caller didn't pick (MolmoAct2 meta lists ROLES, not
    # keys). Native bimanual: ONE session — meta camera keys win, else both
    # wrists + overhead. Dual-lane "both": each lane gets ITS OWN wrist + the
    # shared overhead — one flat views list can't scope per lane, so explicit
    # views are refused.
    explicit_views = body.views or _env_views()
    meta_cams = [c for c in (meta.get("cameras") or []) if isinstance(c, str)]
    meta_cam_keys = (meta_cams if meta_cams and all(
        c.startswith("observation.images.") for c in meta_cams) else None)
    if native_bimanual:
        views = explicit_views or meta_cam_keys or [
            "observation.images.left_wrist",
            "observation.images.right_wrist",
            "observation.images.overhead",
        ]
        lane_views = {"both": list(views)}
    elif arm == "both":
        if explicit_views:
            raise HTTPException(
                status_code=422,
                detail=("views cannot be set with arm='both' (they are per-arm: "
                        "each lane sees its own wrist + overhead) — omit views"))
        lane_views = {a: cloudmod.default_cloud_views(a) for a in lane_arms}
    else:
        views = explicit_views or cloudmod.default_cloud_views(arm)
        if not is_molmoact2 and not explicit_views and meta_cam_keys:
            views = meta_cam_keys
        lane_views = {arm: list(views)}
    union_views: list[str] = []
    for a in lane_arms:
        for v in lane_views[a]:
            if v not in union_views:
                union_views.append(v)

    # Per-arm instruction: instruction_left/right override the shared one (the
    # arms usually do DIFFERENT things — "hold the bowl" / "pick up the cup").
    # A native-bimanual model plans BOTH arms from ONE instruction — per-arm
    # overrides can't be honoured, so refuse them rather than silently drop one.
    if native_bimanual and (body.instruction_left or body.instruction_right):
        raise HTTPException(
            status_code=422,
            detail=("this checkpoint plans both arms from one instruction — use "
                    "the shared instruction, not instruction_left/right"))

    def _instr(a: str) -> str:
        if a == "both":
            return instruction
        ov = body.instruction_left if a == "left" else body.instruction_right
        return (ov or instruction).strip()

    # Queue-tuning knobs (env-overridable so we can retune against real latency
    # without a redeploy): watermark must cover the refill round-trip; max_queue
    # bounds staleness; replace_on_refill = receding horizon (jump to freshest
    # plan). With two lanes the endpoint serves both sessions, so a refill
    # round-trip can ~double under GPU contention — the watermark knob is the
    # lever if refills start missing the queue.
    lanes: list[dict] = []
    for a in lane_arms:
        calib = cloudmod.load_calibration(a) if is_molmoact2 else None
        roll = cloudmod.CloudRollout(
            endpoint=endpoint,
            token=token,
            instruction=_instr(a),
            action_keys=per_arm_keys[a],
            num_steps=body.num_steps or cloudmod._env_int("NORI_INFER_NUM_STEPS", cloudmod.DEFAULT_NUM_STEPS),
            watermark=cloudmod._env_int("NORI_INFER_WATERMARK", cloudmod.REFILL_WATERMARK),
            max_queue=cloudmod._env_int("NORI_INFER_MAX_QUEUE", cloudmod.MAX_QUEUE),
            replace_on_refill=cloudmod._env_bool("NORI_INFER_REPLACE", True),
            # fps drives the chunk STRIDE: the model authors 30 actions per second of
            # motion, so serving one per tick at 15fps halves the speed. NORI_INFER_STRIDE
            # forces a value (1 = the old one-action-per-tick behaviour).
            fps=float(fps),
            chunk_hz=(meta_chunk_hz
                      if not os.environ.get("NORI_INFER_STRIDE")
                      else float(fps) * cloudmod._env_int("NORI_INFER_STRIDE", 1)),
            bounds=bounds,
            calib=calib,
        )
        lanes.append({"arm": a, "roll": roll, "views": list(lane_views[a]),
                      "arm_keys": per_arm_keys[a], "calibrated": calib is not None})
    roll0 = lanes[0]["roll"]
    logger.info("[CLOUD-ROLLOUT] chunk stride=%d (fps=%s, chunk authored at %sHz) -- "
                "queue holds %.2fs of motion; the refill round-trip must fit inside that",
                roll0.stride, fps, roll0.chunk_hz, roll0.max_queue / (roll0.chunk_hz or 1))
    with _lock:
        _close_cam()   # release any previous session's camera subscriber
        _session.clear()
        _session.update({
            "mode": "cloud",
            "ref": body.ref,
            "lanes": lanes,
            "policy_kind": endpoint_kind,
            "joints": list(body.joints),
            "arm": arm,
            "views": union_views,   # union across lanes (camera source + UI)
            "fps": fps,
            "instruction": instruction,
            # Full-quality per-camera frames straight off the Pi's capture layer
            # (the source RECORDING uses). None -> browser composite crops.
            "cam": camzmq.build_source(list(union_views)),
        })
    for ln in lanes:
        logger.info("[ROLLOUT] cloud load %s -> %s (arm=%s, views=%s, fps=%d, calib=%s, "
                    "queue: wm=%d max=%d replace=%s, endpoint=%s)",
                    body.ref, endpoint, ln["arm"], ln["views"], fps,
                    "on" if ln["calibrated"] else "off",
                    ln["roll"].watermark, ln["roll"].max_queue,
                    ln["roll"].replace_on_refill, health.get("status"))
    return {
        "ref": body.ref,
        "provider": "cloud",
        "device": "cloud",
        "policy_kind": endpoint_kind,
        "chunk_hz": roll0.chunk_hz,
        "arm": arm,
        "calibrated": all(ln["calibrated"] for ln in lanes),
        "action_joints": [k for ln in lanes for k in ln["arm_keys"]],
        "joints": list(body.joints),
        # empty shapes: the client only needs the KEYS to know which tiles to grab;
        # the cloud server resizes frames itself (VLA processor).
        "image_keys": {v: [] for v in union_views},
        "fps": fps,
        "endpoint_status": health.get("status"),
    }


@router.post("/load")
def rollout_load(body: LoadBody):
    if not body.joints:
        raise HTTPException(status_code=422, detail="joints list is empty — is telemetry flowing?")
    if body.provider == "cloud":
        return _cloud_load(body)
    with _lock:
        _close_cam()   # release any previous session's camera subscriber
        _session.clear()
        sess = _load_bundle(
            body.ref, body.joints,
            temporal_ensemble_coeff=body.temporal_ensemble_coeff,
            n_action_steps=body.n_action_steps,
            fps=body.fps,
        )
        cap_src = _read_capture_source(Path(config.NORI_POLICY_CACHE) / body.ref)
        use_stream = _resolve_use_stream(body.use_stream, cap_src)
        if use_stream and cap_src != "raw_bundle":
            logger.warning("[ROLLOUT] use_stream FORCED on a %s-provenance policy — "
                           "its training frames were composite; expect a domain gap",
                           cap_src or "unstamped")
        sess["use_stream"] = use_stream
        sess["frame_source"] = None
        _session.update(sess)
        logger.info("[ROLLOUT] loaded %s on %s (%d joints, images: %s, exec: %s, "
                    "frames: %s [capture_source=%s])",
                    body.ref, sess["device"], len(body.joints),
                    list(sess["image_shapes"]), sess["execution"],
                    "stream-preferred" if use_stream else "composite", cap_src)
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


_dump_tick = 0


def _dump_frames(images: list[str], views: list[str]) -> None:
    """Write the exact frames handed to the policy to NORI_INFER_DUMP_FRAMES.

    Diagnostic only, and deliberately cheap to leave off: a single env var, no
    cost when unset. Filenames carry the tick and the view key so a sequence can
    be flipped through in order. Never raises — a debug aid must not be able to
    stop a rollout."""
    global _dump_tick
    out = os.environ.get("NORI_INFER_DUMP_FRAMES")
    if not out:
        return
    every = max(1, int(os.environ.get("NORI_INFER_DUMP_EVERY", "30")))
    tick = _dump_tick
    _dump_tick += 1
    if tick % every:
        return
    try:
        d = Path(out).expanduser()
        d.mkdir(parents=True, exist_ok=True)
        for key, b64 in zip(views, images):
            raw = b64.split(",", 1)[1] if b64.lstrip().startswith("data:") else b64
            short = key.replace("observation.images.", "")
            (d / f"t{tick:05d}_{short}.jpg").write_bytes(base64.b64decode(raw))
    except Exception as e:
        logger.warning("[ROLLOUT] frame dump failed (%s) — continuing", e)


def _cloud_act(body: ActBody) -> dict:
    """Serve one action from the cloud chunk queue(s) (lock already held). Maps
    the browser's {featureKey: dataURL} dict to each lane's ordered view list,
    hands off to CloudRollout.serve() per lane (fast: pop + maybe kick an async
    refill), and merges the per-arm actions into one command. Single-arm = one
    lane; arm='both' = two."""
    lanes: list[dict] = _session["lanes"]
    views: list[str] = _session["views"]   # union across lanes (frame gathering)
    # Prefer FULL-QUALITY per-camera frames from the Pi's capture layer (the same
    # source the recorder/training data uses). Fall back to the browser's crops of
    # the ABR-degraded composite when that source isn't configured/reachable, or
    # when any view is stale — a partial/frozen obs is worse than the composite.
    # Source preference (STREAM_INTEGRATION_PLAN §2): the robot's policy
    # stream > the DEPRECATED direct-SUB tap > the browser composite. The
    # composite is a warned legacy fallback now that browser capture is
    # deprecated for inference — warn on the TRANSITION into it, not per tick
    # (15 Hz of identical warnings is noise, a silent fallback is worse).
    prev_src = _session.get("frame_source")
    images = None
    st = _stream
    if st is not None:
        stream_imgs = st.frames_b64(views)
        if stream_imgs is not None:
            images = [stream_imgs[v] for v in views]
            _session["frame_source"] = "stream"
    if images is None:
        cam = _session.get("cam")
        zmq_imgs = cam.frames_b64(views) if cam else None
        if zmq_imgs is not None:
            images = [zmq_imgs[v] for v in views]
            _session["frame_source"] = "zmq"
    if images is None:
        missing = [v for v in views if v not in body.images]
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"cloud policy needs image feature(s) {missing} — not supplied by the client.",
            )
        images = [body.images[v] for v in views]
        _session["frame_source"] = "composite"
        if prev_src != "composite":
            logger.warning(
                "[ROLLOUT] observation source is the DEPRECATED browser composite"
                + (" (stream went stale/disconnected)" if prev_src == "stream" else "")
                + " — full-quality path: arm /stream/open and start the robot's policy stream")
    # NORI_INFER_DUMP_FRAMES=<dir>: write the images we ACTUALLY send, so the
    # policy's input can be inspected rather than reasoned about. A whole day of
    # this spike was spent theorising about frame quality without once looking at
    # a frame. Off unless the env var is set; writes every DUMP_EVERY-th tick so a
    # run yields a handful of files, not thousands.
    _dump_frames(images, views)
    imgs_by_key = dict(zip(views, images))
    # Serve every lane each tick: each buffers its own observation (its wrist +
    # overhead), pops its next action, and refills independently (concurrent
    # daemon threads; the endpoint serves one session per arm). While ANY lane
    # is still warming we command NOTHING — driving one arm against a frozen
    # partner is worse than waiting, and replace_on_refill re-plans the primed
    # lane from a fresh observation once both are ready, so the few actions it
    # popped meanwhile are safely discarded, not silently skipped motion.
    merged: dict[str, float] = {}
    queues: list[int] = []
    warming = False
    for ln in lanes:
        lane_images = [imgs_by_key[v] for v in ln["views"]]
        # State in the MODEL's joint order (arm_keys), not Nori's alphabetical sort.
        state = [float(body.state.get(k, 0.0)) for k in ln["arm_keys"]]
        try:
            out = ln["roll"].serve(lane_images, state)
        except cloudmod.CloudRolloutError as e:
            # buffer empty AND last refill failed -> 503 so the browser's failure
            # watchdog stops the rollout (non-2xx counts toward its 5-strike halt).
            # One dead lane halts BOTH arms — a half-driven bimanual task is unsafe.
            raise HTTPException(status_code=503,
                                detail=f"cloud inference unavailable ({ln['arm']} arm): {e}")
        queues.append(int(out.get("queue") or 0))
        if out.get("action") is None:
            warming = True
        else:
            merged.update(out["action"])
    if warming:
        return {"action": None, "queue": min(queues, default=0), "warming": True}
    return {"action": merged, "queue": min(queues, default=0), "warming": False}


@router.post("/act")
def rollout_act(body: ActBody):
    import torch

    with _lock:
        if not _session:
            raise HTTPException(status_code=409, detail="no policy loaded")
        if _session.get("mode") == "cloud":
            return _cloud_act(body)
        policy = _session["policy"]
        joints = _session["joints"]                                   # state vector order
        action_joints = _session.get("action_joints") or joints       # action dict order
        device = _session["device"]

        images_b64 = _local_images(body)

        obs: dict[str, Any] = {
            "observation.state": torch.tensor(
                [[float(body.state.get(j, 0.0)) for j in joints]], dtype=torch.float32
            ).to(device),
        }
        for key, chw in _session["image_shapes"].items():
            obs[key] = _decode_image(images_b64[key], chw).to(device)

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


def _local_images(body: "ActBody") -> dict:
    """Pick the local policy's frames: the robot's policy stream when this
    session opted in (P6 provenance rule) and every needed view is fresh, else
    the browser's composite crops. All-or-nothing per tick, exactly like the
    cloud path — a mixed observation is worse than either source. Warns on the
    TRANSITION into composite, not per tick."""
    keys = list(_session["image_shapes"])
    if _session.get("use_stream"):
        st = _stream
        stream_imgs = st.frames_b64(keys) if st is not None else None
        if stream_imgs is not None:
            _session["frame_source"] = "stream"
            return stream_imgs
        if _session.get("frame_source") != "composite":
            logger.warning("[ROLLOUT] local policy wanted STREAM frames but the "
                           "stream is %s — falling back to the deprecated composite",
                           "stale/incomplete" if st is not None else "not armed")
    missing = [k for k in keys if k not in body.images]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"policy needs image feature(s) {missing} — not supplied by the client.",
        )
    _session["frame_source"] = "composite"
    return {k: body.images[k] for k in keys}


def _close_cam() -> None:
    """Release the per-session resources that hold sockets: the ZMQ camera
    subscriber (daemon threads) and the cloud client's POOLED HTTP connection.
    Both must go on teardown or a re-load leaks — subscribers onto the same
    ports, and an idle keep-alive connection per rollout."""
    cam = _session.get("cam")
    if cam:
        try:
            cam.close()
        except Exception:
            logger.warning("[ROLLOUT] camera source close failed", exc_info=True)
    for ln in (_session.get("lanes") or []):
        roll = ln.get("roll")
        if roll is not None and hasattr(roll, "close"):
            try:
                roll.close()
            except Exception:
                logger.warning("[ROLLOUT] cloud client close failed (%s arm)",
                               ln.get("arm"), exc_info=True)


@router.post("/unload")
def rollout_unload():
    global _stream
    with _lock:
        had = _session.get("ref")
        _close_cam()
        _session.clear()
        # The stream listener is per-rollout-session (plan §1): tearing down the
        # session tears down the observation path with it.
        if _stream is not None:
            _stream.close()
            _stream = None
    return {"unloaded": had}


@router.get("/status")
def rollout_status():
    with _lock:
        if not _session:
            return {"loaded": None}
        if _session.get("mode") == "cloud":
            lanes = _session["lanes"]
            return {
                "loaded": _session["ref"],
                "provider": "cloud",
                "device": "cloud",
                "joints": _session["joints"],
                "arm": _session.get("arm"),
                "image_keys": list(_session["views"]),
                # single lane keeps the historical shape; arm="both" reports
                # one status per arm so a starving lane is visible in the field.
                "cloud": (lanes[0]["roll"].status() if len(lanes) == 1
                          else {ln["arm"]: ln["roll"].status() for ln in lanes}),
                # Which frame path the policy is actually being fed, so a silent
                # fallback to the degraded composite is visible in the field.
                "frame_source": _session.get("frame_source", "unknown"),
                "cameras": _session["cam"].status() if _session.get("cam") else None,
                "stream": _stream.status() if _stream is not None else None,
            }
        return {
            "loaded": _session["ref"],
            "device": _session["device"],
            "joints": _session["joints"],
            "image_keys": list(_session["image_shapes"]),
            "use_stream": _session.get("use_stream", False),
            "frame_source": _session.get("frame_source"),
            "stream": _stream.status() if _stream is not None else None,
        }
