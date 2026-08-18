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
from collections import deque
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel

MODEL_KIND = os.environ.get("MODEL_KIND", "molmoact2")
AUTH_TOKEN = os.environ.get("NORI_INFER_TOKEN")  # transition-era shared secret

# V4 scoped-inference grants (pentest 2026-08-12). The backend mints a short-lived
# ES256 JWT bound to {customer_id, policy_ref}; the serving box holds ONLY the
# PUBLIC key, so it verifies but can never mint (airgap-consistent — a popped
# endpoint forges nothing). Contract agreed with the backend grant module:
#   header  X-Nori-Token: <ES256 JWT>   (Bearer also accepted)
#   claims  {customer_id, policy_ref, dom:"nori-infer-grant-v1", iat, exp}
#   env     NORI_GRANT_PUBLIC_KEY  — PEM public half of the backend signing key
#           NORI_SERVE_POLICY_REF  — THIS endpoint's policy id = the jobs.id (row
#                                    UUID) of the promoted checkpoint it serves;
#                                    the backend mint puts the same jobs.id in the
#                                    policy_ref claim, so a grant for any other
#                                    policy is rejected here
#           NORI_INFER_REQUIRE_GRANT=1 — drop the static-token fallback once the
#                                    mint endpoint is live (transition off-ramp)
# The fleet grant-verification public key. Baked as the default (a PUBLIC key is
# not a secret — same value session 2 baked into nori_ws session_grant.py, one
# keypair serves V1-robot + V4-inference, domain-separated by the `dom` claim);
# NORI_GRANT_PUBLIC_KEY overrides it for rotation without a code change.
DEFAULT_GRANT_PUBLIC_KEY = (
    "-----BEGIN PUBLIC KEY-----\n"
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8qMb2C283jbDvlUth3IqAUcSmwK2\n"
    "CZy4p/re774MgGn7kReJlA0VdvWQspehVyTMFwWJ+LrDyQtIliobDn5W6g==\n"
    "-----END PUBLIC KEY-----\n"
)
GRANT_PUBLIC_KEY = os.environ.get("NORI_GRANT_PUBLIC_KEY") or DEFAULT_GRANT_PUBLIC_KEY
SERVE_POLICY_REF = os.environ.get("NORI_SERVE_POLICY_REF")
REQUIRE_GRANT = os.environ.get("NORI_INFER_REQUIRE_GRANT", "0").strip() == "1"
GRANT_DOMAIN = "nori-infer-grant-v1"
# Server-level abuse cap on the action horizon, restoring the guard the
# single-model server had (MAX_NUM_STEPS=50) that was lost in the multi-policy
# refactor — only the molmoact2 adapter re-clamps, so pi05/groot would honor an
# arbitrary num_steps and let one authed caller request unbounded compute.
# Generous upper bound; each adapter still clamps to its own chunk semantics.
MAX_NUM_STEPS = int(os.environ.get("NORI_INFER_MAX_NUM_STEPS", "100"))
# Pentest V11 (serving side): abuse/DoS caps on /act. A leaked or weakly-scoped
# token could otherwise pour unbounded GPU spend, or a single huge/decompression-
# bomb image could OOM the box. Defaults are generous vs a real rollout (~15 Hz,
# 640x480 JPEGs ~70-270 KB base64) so nothing legitimate is clipped.
MAX_IMAGE_B64 = int(os.environ.get("NORI_INFER_MAX_IMAGE_B64", str(3 * 1024 * 1024)))   # per-image
MAX_IMAGE_PIXELS = int(os.environ.get("NORI_INFER_MAX_IMAGE_PIXELS", str(4096 * 4096)))  # decompress-bomb
MAX_STATE_LEN = int(os.environ.get("NORI_INFER_MAX_STATE_LEN", "512"))                    # DOF vector
RATE_MAX = int(os.environ.get("NORI_INFER_RATE_MAX", "60"))          # requests per window, per caller
RATE_WINDOW_S = float(os.environ.get("NORI_INFER_RATE_WINDOW_S", "2.0"))  # -> 30 req/s sustained (2x a 15Hz loop)
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
    # An endpoint must be able to authenticate SOMEHOW: a static token (transition)
    # or a grant public key (V4). Grant-only endpoints (REQUIRE_GRANT) need no
    # static secret; fail closed if neither is configured.
    if not AUTH_TOKEN and not GRANT_PUBLIC_KEY:
        raise RuntimeError("configure NORI_INFER_TOKEN or NORI_GRANT_PUBLIC_KEY")
    if GRANT_PUBLIC_KEY and not SERVE_POLICY_REF:
        print("[serve] WARNING: NORI_GRANT_PUBLIC_KEY set without NORI_SERVE_POLICY_REF "
              "— grants are verified for signature/expiry but NOT bound to this "
              "policy (any customer's valid grant is accepted). Set the ref.", flush=True)
    threading.Thread(target=_load, name=f"{MODEL_KIND}-load", daemon=True).start()


def _verify_grant(tok: str) -> Optional[dict]:
    """Verify an ES256 inference grant. Returns the claims on success, None on any
    failure (bad sig / wrong domain / policy mismatch / expired). Standalone — no
    backend import; the endpoint holds only the public key (verify, never mint)."""
    if not GRANT_PUBLIC_KEY:
        return None
    try:
        import jwt as pyjwt
        claims = pyjwt.decode(tok, GRANT_PUBLIC_KEY, algorithms=["ES256"])
    except Exception:
        return None  # signature invalid, expired (pyjwt enforces exp), or malformed
    if claims.get("dom") != GRANT_DOMAIN:
        return None
    # Policy binding: the SERVER supplies its own ref — a grant minted for another
    # policy must not run here. Enforced only when the ref is configured (see the
    # startup warning); a signed+expiring grant is still better than a static token.
    if SERVE_POLICY_REF and claims.get("policy_ref") != SERVE_POLICY_REF:
        return None
    return claims


def _require_auth(x_nori_token: Optional[str], authorization: Optional[str]) -> str:
    """Authorize an /act call and RETURN the caller identity (for per-caller rate
    limiting): "cust:<id>" from a scoped grant, or "static" for the shared token.
    Prefers a scoped ES256 grant (V4); falls back to the static shared token during
    the transition (until NORI_INFER_REQUIRE_GRANT=1). Checked before any model
    work; constant-time on the static path."""
    bearer = (authorization[7:].strip()
              if authorization and authorization.lower().startswith("bearer ") else None)
    presented = x_nori_token or bearer

    # 1) Preferred: a valid scoped grant.
    if presented:
        claims = _verify_grant(presented)
        if claims is not None:
            return f"cust:{claims.get('customer_id', '?')}"

    # 2) Transition fallback: the static shared secret, unless grants are required.
    if not REQUIRE_GRANT and AUTH_TOKEN:
        if x_nori_token and secrets.compare_digest(x_nori_token, AUTH_TOKEN):
            return "static"
        if authorization and secrets.compare_digest(authorization, f"Bearer {AUTH_TOKEN}"):
            return "static"

    raise HTTPException(status_code=401, detail="bad or missing auth token")


_rate_lock = threading.Lock()
_rate_hits: dict[str, deque] = {}


def _rate_check(caller: str) -> None:
    """Per-caller sliding-window rate limit (pentest V11): bounds GPU-spend abuse
    from one identity. 429 when a caller exceeds RATE_MAX requests in RATE_WINDOW_S.
    The window is sized well above a real rollout's rate, so legitimate control
    loops never trip it. Keyed on the caller id from _require_auth (per-customer
    under grants; all static-token callers share one bucket during transition)."""
    now = time.monotonic()
    with _rate_lock:
        dq = _rate_hits.setdefault(caller, deque())
        cutoff = now - RATE_WINDOW_S
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= RATE_MAX:
            raise HTTPException(status_code=429, detail="inference rate limit exceeded")
        dq.append(now)


def _decode(b64: str) -> np.ndarray:
    if b64.lstrip().startswith("data:") and "," in b64[:64]:
        b64 = b64.split(",", 1)[1]
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    # Pentest V11: reject a decompression bomb (small payload, huge canvas) before
    # allocating the pixel buffer — PIL exposes size without decoding the raster.
    w, h = img.size
    if w * h > MAX_IMAGE_PIXELS:
        raise HTTPException(status_code=413,
                            detail=f"image {w}x{h} exceeds the {MAX_IMAGE_PIXELS}px cap")
    return np.asarray(img.convert("RGB"))


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
    caller = _require_auth(x_nori_token, authorization)
    _rate_check(caller)                          # V11: per-caller GPU-spend ceiling
    if _adapter is None:
        detail = f"model load failed: {_load_error}" if _load_error else "model not loaded yet"
        raise HTTPException(status_code=503, detail=detail)
    limits = _adapter.meta()
    max_images = int(limits.get("max_images", 6))
    if not 1 <= len(req.images) <= max_images:
        raise HTTPException(status_code=422, detail=f"need 1..{max_images} camera images")
    # V11 input caps: reject oversized payloads BEFORE base64-decoding/PIL-opening.
    if len(req.state) > MAX_STATE_LEN:
        raise HTTPException(status_code=422, detail=f"state length {len(req.state)} exceeds {MAX_STATE_LEN}")
    for b in req.images:
        if len(b) > MAX_IMAGE_B64:
            raise HTTPException(status_code=413,
                                detail=f"an image ({len(b)} b64 chars) exceeds the {MAX_IMAGE_B64} cap")
    images = [_decode(b) for b in req.images]
    state = np.asarray(req.state, dtype=np.float32)
    num_steps = max(1, min(int(req.num_steps), MAX_NUM_STEPS))
    t0 = time.perf_counter()
    with _lock:
        try:
            actions, extra = _adapter.act(
                images=images, state=state, instruction=req.instruction,
                num_steps=num_steps,
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
