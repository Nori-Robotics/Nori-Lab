"""
Nori cloud-inference server for MolmoAct2-SO100_101  (spike — task #38).

Runs on an AWS GPU instance (g5.xlarge / A10G 24GB is enough in bf16 <16GB).
Serves the robot rollout over plain JSON (NO pickle on the wire — avoids the
LeRobot PolicyServer CVE-2026-25874 class):

    POST /act  { images:[b64...], state:[6 floats], instruction:str, num_steps? }
      -> { actions: [[...DOF...], ...] }   # a 10-30 move chunk, ROBOT SCALE

The model is loaded once at startup. Inference is serialized behind a lock
(single GPU). Bearer-token auth (NORI_INFER_TOKEN) on every call.

The exact model API mirrors the allenai/MolmoAct2-SO100_101 model card:
    model.predict_action(processor=..., images=[...], task=..., state=...,
        norm_tag="so100_so101_molmoact2", inference_action_mode="continuous",
        num_steps=10, normalize_language=True, enable_cuda_graph=True).actions

Deploy + test: see README.md in this directory.
"""

import base64
import io
import os
import secrets
import threading
import time
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel
from transformers import AutoModelForImageTextToText, AutoProcessor

import rtc as rtcmod

REPO_ID = os.environ.get("MOLMOACT_REPO", "allenai/MolmoAct2-SO100_101")
NORM_TAG = os.environ.get("MOLMOACT_NORM_TAG", "so100_so101_molmoact2")
AUTH_TOKEN = os.environ.get("NORI_INFER_TOKEN")  # REQUIRED — the rollout sends it
# bf16 fits <16GB (A10G/L4). Set MOLMOACT_BF16=0 to run fp32 (~26GB, needs L40S/48GB).
DTYPE = torch.bfloat16 if os.environ.get("MOLMOACT_BF16", "1") == "1" else torch.float32
# Defensive caps: a valid-token caller can't burn unbounded GPU via a huge solver
# step count or a flood of images (the endpoint is public, token-gated).
MAX_NUM_STEPS = 50
MAX_IMAGES = 6

app = FastAPI(title="nori-molmoact2")
_model = None
_processor = None
_lock = threading.Lock()  # single GPU: serialize predict_action calls
# RTC (Real-Time Chunking). The flow-loop patch closes over ONE state object, but
# the guidance target is per-CLIENT — two rollouts sharing a server would otherwise
# steer each other's arms. Inference is already serialized behind _lock, so we keep
# one state and swap the cached chunk in/out per session under that same lock.
ACTION_HORIZON = 30            # this checkpoint's chunk length
_rtc_state = rtcmod.RTCState()
_rtc_prev: dict = {}           # session id -> previous chunk (normalized, on-device)
_RTC_SESSION_CAP = 8           # bound the cache; robot sessions are few and long-lived
_load_error: Optional[str] = None  # set if the background load failed


def _load_model() -> None:
    """Load weights in a background thread so the HTTP port is up immediately.

    MolmoAct2 is ~21GB — a blocking startup event would keep the port dark for
    minutes and a HuggingFace Space health-probe would kill the container as
    unhealthy before the model ever finishes loading. /health reports progress.
    """
    global _model, _processor, _load_error
    try:
        proc = AutoProcessor.from_pretrained(REPO_ID, trust_remote_code=True)
        model = (
            AutoModelForImageTextToText.from_pretrained(
                REPO_ID, trust_remote_code=True, dtype=DTYPE
            )
            .to("cuda")
            .eval()
        )
        # Inert until a session sets a target. Guarded: RTC is an optimisation, and
        # nothing here may be allowed to stop the model from loading.
        try:
            if rtcmod.install_rtc(model, _rtc_state) is None:
                print("[molmoact2] RTC: flow loop not found — serving un-guided", flush=True)
        except Exception as exc:
            print(f"[molmoact2] RTC install failed ({exc}) — serving un-guided", flush=True)
        _processor, _model = proc, model
        print(f"[molmoact2] loaded {REPO_ID} dtype={DTYPE} (RTC patch installed)", flush=True)
    except Exception as exc:  # surface load failures via /health instead of a dead port
        _load_error = f"{type(exc).__name__}: {exc}"
        print(f"[molmoact2] LOAD FAILED — {_load_error}", flush=True)


@app.on_event("startup")
def _startup() -> None:
    if not AUTH_TOKEN:
        raise RuntimeError("NORI_INFER_TOKEN must be set (bearer token for /act)")
    threading.Thread(target=_load_model, name="molmoact2-load", daemon=True).start()


class ActRequest(BaseModel):
    images: list[str]      # base64 JPEG/PNG (optionally a data: URL), 2+ camera views
    state: list[float]     # robot joint state (6 for a single SO-100/101 arm)
    instruction: str       # natural-language task, e.g. "pick up the red cup"
    num_steps: int = 10    # flow-matching integration steps (latency <-> quality)
    # RTC FEASIBILITY PROBE (see cloud_inference/rtc.py). RTC's per-step PiGDM
    # correction is a VJP, so it needs (a) autograd enabled and (b) the CUDA-graph
    # fast path off. Both are optimisations we currently rely on, and latency is
    # already the binding constraint: after the chunk-stride fix the queue covers
    # ~1s of motion against a 0.65-1.2s round-trip. So measure the cost BEFORE
    # building the integration — if compute doubles, RTC needs a latency
    # reduction (in-region GPU) to be viable at all.
    # Cost is still bounded by MAX_NUM_STEPS and the bearer token.
    enable_cuda_graph: bool = True
    enable_grad: bool = False
    # RTC: send {session, consumed, delay} to make this chunk continuous with the
    # previous one. `consumed` aligns the cached chunk to the new timeline;
    # `delay` is how many actions will execute WHILE this inference runs, and
    # becomes the frozen prefix. Omit the block entirely to run without RTC.
    rtc: Optional["RTCParams"] = None


class RTCParams(BaseModel):
    session: str
    consumed: int = 0
    delay: int = 0


class ActResponse(BaseModel):
    actions: list[list[float]]  # chunk: N moves x DOF, ROBOT SCALE (already de-normalized)
    # Server-side compute time, so the client can separate GPU cost from network
    # RTT. Additive + optional: existing clients that read only `actions` are
    # unaffected.
    compute_ms: Optional[float] = None
    # None when RTC wasn't requested; otherwise why it did or didn't apply.
    rtc: Optional[dict] = None


def _decode(b64: str) -> np.ndarray:
    if b64.lstrip().startswith("data:") and "," in b64[:64]:
        b64 = b64.split(",", 1)[1]
    img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    return np.asarray(img)


def _status() -> dict:
    status = "ready" if _model is not None else ("error" if _load_error else "loading")
    return {"ok": _model is not None, "status": status, "error": _load_error,
            "repo": REPO_ID, "dtype": str(DTYPE)}


@app.get("/")
def root() -> dict:
    # HuggingFace Docker Spaces route external traffic only after their readiness
    # probe gets a 2xx on "/". Without this the app loads fine but the proxy 404s
    # every request (incl. /health) and the Space auto-sleeps unused. Harmless
    # elsewhere (AWS/Modal just get an extra liveness route).
    return _status()


@app.get("/health")
def health() -> dict:
    return _status()


class PointRequest(BaseModel):
    image: str             # base64 JPEG/PNG, one camera view
    query: str = "the red cup"
    max_new_tokens: int = 96


class PointResponse(BaseModel):
    raw: str                       # the VLM's verbatim generation
    points: list[list[float]]      # parsed [[x, y], ...] in PERCENT of image size
    compute_ms: Optional[float] = None


@app.post("/point", response_model=PointResponse)
def point(req: PointRequest, authorization: Optional[str] = Header(None)) -> PointResponse:
    """Perception probe (diagnostic, not on the control path): ask the Molmo2-ER
    backbone — a pixel-accurate pointing model — to point at `query` in ONE
    frame. Separates "does the model SEE the target in our camera domain" from
    "does it act correctly": wrong/absent points on live robot frames = visual
    domain gap (no calibration work can fix it); correct points + wrong motion
    = the failure is downstream of perception."""
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {AUTH_TOKEN}"):
        raise HTTPException(status_code=401, detail="bad or missing bearer token")
    if _model is None:
        detail = f"model load failed: {_load_error}" if _load_error else "model not loaded yet"
        raise HTTPException(status_code=503, detail=detail)
    img = Image.fromarray(_decode(req.image))
    prompt = f"Point to {req.query}."
    t0 = time.time()
    try:
        with _lock, torch.inference_mode():
            # Preferred: the processor's chat template (Molmo2 family). Fallback:
            # the classic Molmo processor.process() API. Both produce tensors the
            # underlying ImageTextToText model can generate from.
            try:
                inputs = _processor.apply_chat_template(
                    [{"role": "user",
                      "content": [{"type": "image", "image": img},
                                  {"type": "text", "text": prompt}]}],
                    add_generation_prompt=True, tokenize=True,
                    return_dict=True, return_tensors="pt")
            except Exception:
                inputs = _processor.process(images=[img], text=prompt)
                inputs = {k: (v.unsqueeze(0) if hasattr(v, "dim") and v.dim() in (1, 3) else v)
                          for k, v in inputs.items()}
            inputs = {k: (v.to(_model.device) if hasattr(v, "to") else v)
                      for k, v in inputs.items()}
            out = _model.generate(**inputs, max_new_tokens=int(req.max_new_tokens))
            n_in = inputs["input_ids"].shape[1] if "input_ids" in inputs else 0
            text = _processor.tokenizer.decode(out[0][n_in:], skip_special_tokens=False)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"pointing failed: {type(exc).__name__}: {exc}")
    # Parse Molmo point markup: <point x="53.1" y="42.2" ...> (single) and the
    # <points x1=".." y1=".." x2=".." ...> multi-point form. Percent coordinates.
    import re
    pts = [[float(x), float(y)] for x, y in
           re.findall(r'x\d*="([0-9.]+)"\s+y\d*="([0-9.]+)"', text)]
    return PointResponse(raw=text, points=pts,
                         compute_ms=round((time.time() - t0) * 1000.0, 1))


@app.post("/act", response_model=ActResponse)
def act(req: ActRequest, authorization: Optional[str] = Header(None)) -> ActResponse:
    # Constant-time compare so a bad token can't be recovered via response timing.
    # Checked BEFORE any model work so unauthenticated calls never touch the GPU.
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {AUTH_TOKEN}"):
        raise HTTPException(status_code=401, detail="bad or missing bearer token")
    if _model is None:
        detail = f"model load failed: {_load_error}" if _load_error else "model not loaded yet"
        raise HTTPException(status_code=503, detail=detail)
    if not 1 <= len(req.images) <= MAX_IMAGES:
        raise HTTPException(status_code=422, detail=f"need 1..{MAX_IMAGES} camera images")
    num_steps = max(1, min(int(req.num_steps), MAX_NUM_STEPS))  # clamp GPU cost
    images = [_decode(b) for b in req.images]
    state = np.asarray(req.state, dtype=np.float32)
    # Autograd roughly doubles activation memory, and the weights alone are ~21GB
    # on a 24GB A10G — so the grad path can simply OOM. Report that as a clean 507
    # rather than letting it wedge the container: "RTC does not fit on this
    # hardware" is a legitimate measurement outcome, not a crash.
    # RTC decides the execution knobs: its per-step PiGDM correction is a VJP, so
    # autograd must be ON and the CUDA-graph fast path OFF (you cannot backprop a
    # captured graph). Measured cost of that swap: 303ms -> 827ms compute.
    rtc_req = req.rtc
    rtc_horizon = None
    rtc_note = None
    if rtc_req is not None:
        rtc_horizon = rtcmod.pick_execution_horizon(rtc_req.delay, ACTION_HORIZON)
        if rtc_horizon is None:
            # d > H/2: frozen prefix and free tail would overlap. Serve a normal
            # chunk rather than a silently ill-defined one.
            rtc_note = (f"skipped: delay {rtc_req.delay} too large for horizon "
                        f"{ACTION_HORIZON} (needs d <= H/2)")
    use_rtc = rtc_req is not None and rtc_horizon is not None
    cuda_graph = False if use_rtc else bool(req.enable_cuda_graph)
    grad_ctx = torch.enable_grad() if (use_rtc or req.enable_grad) else torch.no_grad()
    t0 = time.perf_counter()
    try:
        with _lock, grad_ctx:
            if use_rtc:
                # Swap this session's cached chunk in under the lock (see _rtc_prev).
                _rtc_state.prev = _rtc_prev.get(rtc_req.session)
                _rtc_state.enabled = _rtc_state.prev is not None
                _rtc_state.consumed = max(0, int(rtc_req.consumed))
                _rtc_state.delay = max(0, int(rtc_req.delay))
                _rtc_state.execution_horizon = rtc_horizon
                _rtc_state.applied = 0
            out = _model.predict_action(
                processor=_processor,
                images=images,
                task=req.instruction,
                state=state,
                norm_tag=NORM_TAG,
                inference_action_mode="continuous",
                num_steps=num_steps,
                normalize_language=True,
                enable_cuda_graph=cuda_graph,
            )
            if use_rtc:
                # the patched flow loop wrote the new chunk into state.prev
                if len(_rtc_prev) >= _RTC_SESSION_CAP and rtc_req.session not in _rtc_prev:
                    _rtc_prev.pop(next(iter(_rtc_prev)))
                _rtc_prev[rtc_req.session] = _rtc_state.prev
                rtc_note = {"guided_steps": _rtc_state.applied,
                            "execution_horizon": rtc_horizon,
                            "delay": _rtc_state.delay,
                            "consumed": _rtc_state.consumed,
                            "had_target": bool(_rtc_state.enabled)}
                _rtc_state.prev = None      # don't leak one session's chunk to the next
                _rtc_state.enabled = False
    except torch.cuda.OutOfMemoryError as e:
        torch.cuda.empty_cache()
        raise HTTPException(
            status_code=507,
            detail=f"CUDA OOM (enable_grad={req.enable_grad}, "
                   f"cuda_graph={req.enable_cuda_graph}): {e}",
        ) from e
    if torch.cuda.is_available():
        torch.cuda.synchronize()   # predict_action is async; time the real compute
    compute_ms = (time.perf_counter() - t0) * 1000.0
    acts = out.actions
    if torch.is_tensor(acts):  # predict_action returns a CUDA tensor — move to host first
        acts = acts.detach().float().cpu().numpy()
    acts = np.asarray(acts, dtype=np.float32)
    if acts.ndim == 3 and acts.shape[0] == 1:  # (1, chunk, DOF) -> (chunk, DOF)
        acts = acts[0]
    return ActResponse(actions=acts.tolist(), compute_ms=round(compute_ms, 1),
                       rtc=(rtc_note if isinstance(rtc_note, dict)
                            else ({"skipped": rtc_note} if rtc_note else None)))
