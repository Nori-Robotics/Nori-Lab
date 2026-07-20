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
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel
from transformers import AutoModelForImageTextToText, AutoProcessor

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
        _processor, _model = proc, model
        print(f"[molmoact2] loaded {REPO_ID} dtype={DTYPE}", flush=True)
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


class ActResponse(BaseModel):
    actions: list[list[float]]  # chunk: N moves x DOF, ROBOT SCALE (already de-normalized)


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
    with _lock, torch.no_grad():
        out = _model.predict_action(
            processor=_processor,
            images=images,
            task=req.instruction,
            state=state,
            norm_tag=NORM_TAG,
            inference_action_mode="continuous",
            num_steps=num_steps,
            normalize_language=True,
            enable_cuda_graph=True,
        )
    acts = out.actions
    if torch.is_tensor(acts):  # predict_action returns a CUDA tensor — move to host first
        acts = acts.detach().float().cpu().numpy()
    acts = np.asarray(acts, dtype=np.float32)
    if acts.ndim == 3 and acts.shape[0] == 1:  # (1, chunk, DOF) -> (chunk, DOF)
        acts = acts[0]
    return ActResponse(actions=acts.tolist())
