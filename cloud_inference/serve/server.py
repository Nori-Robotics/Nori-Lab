"""
Nori multi-policy cloud-inference server (INFERENCE_ENDPOINT_PLAN step 5).

ONE image, model ADAPTERS: `MODEL_KIND` selects which policy this container
serves — each Inference Endpoint runs exactly one kind (separate endpoints per
model = independent scaling + failure domains, plan §3.4).

    MODEL_KIND=molmoact2   today's predict_action path, UNCHANGED semantics
    MODEL_KIND=pi05        LeRobot policies.pi05 checkpoint (a Nori finetune)
    MODEL_KIND=groot       GR00T N1.7 (stub — lands with the finetune lane)

The /act JSON contract is FROZEN (laptop client in the field) and adapters
extend, never break:

    POST /act { images:[b64...], state:[floats], instruction:str, num_steps? }
      -> { actions:[[...DOF...] x horizon], compute_ms, meta? }

Per-policy chunk semantics (chunk_hz / horizon / joint + camera contract) are
NOT constants — pi05 must not silently inherit MolmoAct2's 30 Hz x 30. Each
adapter reports its `meta` (surfaced in /health and every /act response) and
the step-6 client wiring reads it via /load policy_kind.

Auth: X-Nori-Token primary (constant-time), Bearer kept for transition — same
as the step-3 single-model server. NO pickle on the wire (LeRobot PolicyServer
CVE class); plain JSON only.

Torch/model imports live INSIDE adapters' load() so this module imports light
(tests run the HTTP surface with MODEL_KIND=fake and no GPU stack installed).
"""

from __future__ import annotations

import base64
import io
import os
import secrets
import threading
import time
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel

MODEL_KIND = os.environ.get("MODEL_KIND", "molmoact2")
AUTH_TOKEN = os.environ.get("NORI_INFER_TOKEN")  # REQUIRED
# Inference Endpoints mount the endpoint's model repo here (no boot download);
# adapters fall back to their Hub default when absent (Space / bare GPU box).
MODEL_PATH = os.environ.get("MODEL_PATH", "/repository")

app = FastAPI(title=f"nori-serve-{MODEL_KIND}")
_adapter = None                       # set by the background load
_load_error: Optional[str] = None
_lock = threading.Lock()              # single GPU: serialize inference


def _make_adapter():
    """Resolve MODEL_KIND -> adapter instance. Import inside the function so an
    unused kind's heavy deps are never touched."""
    if MODEL_KIND == "molmoact2":
        from adapters.molmoact2 import MolmoAct2Adapter
        return MolmoAct2Adapter(MODEL_PATH)
    if MODEL_KIND == "pi05":
        from adapters.pi05 import Pi05Adapter
        return Pi05Adapter(MODEL_PATH)
    if MODEL_KIND == "groot":
        from adapters.groot import GrootAdapter
        return GrootAdapter(MODEL_PATH)
    if MODEL_KIND == "fake":
        from adapters.fake import FakeAdapter  # tests/CI only — no GPU deps
        return FakeAdapter(MODEL_PATH)
    raise RuntimeError(f"unknown MODEL_KIND {MODEL_KIND!r}")


def _load() -> None:
    """Background load (port must be up immediately; see step-3 notes)."""
    global _adapter, _load_error
    try:
        a = _make_adapter()
        a.load()
        _adapter = a
        print(f"[serve] {MODEL_KIND} ready: {a.meta()}", flush=True)
    except Exception as exc:  # surfaced via /health + /ready, not a dead port
        _load_error = f"{type(exc).__name__}: {exc}"
        print(f"[serve] LOAD FAILED — {_load_error}", flush=True)


@app.on_event("startup")
def _startup() -> None:
    if not AUTH_TOKEN:
        raise RuntimeError("NORI_INFER_TOKEN must be set")
    threading.Thread(target=_load, name=f"{MODEL_KIND}-load", daemon=True).start()


def _require_auth(x_nori_token: Optional[str], authorization: Optional[str]) -> None:
    """X-Nori-Token primary (a protected endpoint's edge consumes Authorization;
    custom headers pass through); Bearer kept for the transition client. Each
    compare constant-time; checked before any model work."""
    if x_nori_token and secrets.compare_digest(x_nori_token, AUTH_TOKEN):
        return
    if authorization and secrets.compare_digest(authorization, f"Bearer {AUTH_TOKEN}"):
        return
    raise HTTPException(status_code=401, detail="bad or missing auth token")


def _decode(b64: str) -> np.ndarray:
    if b64.lstrip().startswith("data:") and "," in b64[:64]:
        b64 = b64.split(",", 1)[1]
    img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    return np.asarray(img)


def _status() -> dict:
    ready = _adapter is not None
    return {
        "ok": ready,
        "status": "ready" if ready else ("error" if _load_error else "loading"),
        "error": _load_error,
        "kind": MODEL_KIND,
        "meta": _adapter.meta() if ready else None,
    }


@app.get("/")
def root() -> dict:
    # Spaces route external traffic only after a 2xx on "/" — keep it 200 always.
    return _status()


@app.get("/health")
def health() -> dict:
    return _status()


@app.get("/ready")
def ready() -> dict:
    """503-until-loaded — set as the Inference Endpoint's health_route."""
    if _adapter is None:
        detail = f"model load failed: {_load_error}" if _load_error else "model loading"
        raise HTTPException(status_code=503, detail=detail)
    return _status()


class ActRequest(BaseModel):
    images: list[str]
    state: list[float]
    instruction: str
    num_steps: int = 10
    # MolmoAct2-only knobs — other adapters ignore/report them (see extras).
    enable_cuda_graph: bool = True
    enable_grad: bool = False
    rtc: Optional[dict] = None


class ActResponse(BaseModel):
    actions: list[list[float]]
    compute_ms: Optional[float] = None
    rtc: Optional[dict] = None
    # Per-policy chunk semantics so the client NEVER assumes another model's
    # constants (chunk_hz/horizon/dof/cameras). Additive — old clients that
    # read only `actions` are unaffected.
    meta: Optional[dict] = None


@app.post("/act", response_model=ActResponse)
def act(req: ActRequest, authorization: Optional[str] = Header(None),
        x_nori_token: Optional[str] = Header(None)) -> ActResponse:
    _require_auth(x_nori_token, authorization)
    if _adapter is None:
        detail = f"model load failed: {_load_error}" if _load_error else "model not loaded yet"
        raise HTTPException(status_code=503, detail=detail)
    limits = _adapter.meta()
    max_images = int(limits.get("max_images", 6))
    if not 1 <= len(req.images) <= max_images:
        raise HTTPException(status_code=422, detail=f"need 1..{max_images} camera images")
    images = [_decode(b) for b in req.images]
    state = np.asarray(req.state, dtype=np.float32)
    t0 = time.perf_counter()
    with _lock:
        try:
            actions, extra = _adapter.act(
                images=images, state=state, instruction=req.instruction,
                num_steps=req.num_steps,
                extras={"enable_cuda_graph": req.enable_cuda_graph,
                        "enable_grad": req.enable_grad, "rtc": req.rtc},
            )
        except HTTPException:
            raise
        except MemoryError as e:
            raise HTTPException(status_code=507, detail=str(e))
        except Exception as e:
            # Adapters raise HTTPException for contract errors; anything else is
            # a real inference failure worth a 500 with the class name.
            raise HTTPException(status_code=500,
                                detail=f"inference failed: {type(e).__name__}: {e}")
    compute_ms = (time.perf_counter() - t0) * 1000.0
    acts = np.asarray(actions, dtype=np.float32)
    if acts.ndim == 3 and acts.shape[0] == 1:
        acts = acts[0]
    return ActResponse(actions=acts.tolist(), compute_ms=round(compute_ms, 1),
                       rtc=(extra or {}).get("rtc"), meta=_adapter.meta())


class PointRequest(BaseModel):
    image: str
    query: str = "the red cup"
    max_new_tokens: int = 96


@app.post("/point")
def point(req: PointRequest, authorization: Optional[str] = Header(None),
          x_nori_token: Optional[str] = Header(None)) -> dict:
    """Perception probe — only meaningful for adapters with a pointing-capable
    VLM backbone (MolmoAct2). Others 501 so the client can feature-detect."""
    _require_auth(x_nori_token, authorization)
    if _adapter is None:
        detail = f"model load failed: {_load_error}" if _load_error else "model not loaded yet"
        raise HTTPException(status_code=503, detail=detail)
    if not hasattr(_adapter, "point"):
        raise HTTPException(status_code=501,
                            detail=f"{MODEL_KIND} has no pointing backbone")
    with _lock:
        return _adapter.point(image=_decode(req.image), query=req.query,
                              max_new_tokens=req.max_new_tokens)
