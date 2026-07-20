---
title: MolmoAct2 SO100 101 Inference
emoji: 🤖
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: Nori cloud-inference server for MolmoAct2-SO100_101 (/act)
---

# MolmoAct2-SO100_101 — Nori cloud inference

Private Docker Space serving `allenai/MolmoAct2-SO100_101` for Nori robot rollout.
It runs our own FastAPI/uvicorn server (`molmoact2_server.py`) — **not** the HF
Inference-Endpoint toolkit, which is incompatible with the transformers version
this model needs.

## Endpoints
- `GET /health` → `{"ok", "status": "loading|ready|error", "error", "repo", "dtype"}`
- `POST /act` (Bearer `NORI_INFER_TOKEN`) →
  `{ images:[b64...], state:[6 floats], instruction:str, num_steps? }`
  → `{ actions: [[...6 DOF...], ... up to 30 moves] }` (robot scale).

## Required setup (Space **Settings**)
1. **Hardware**: a GPU tier — `a10g-small` (A10G 24GB, ~$1/hr) is enough (bf16 <16GB).
2. **Secrets**:
   - `NORI_INFER_TOKEN` — the bearer token the rollout client sends (required).
   - `HF_TOKEN` — only if the model repo is gated (allenai's is public; usually not needed).
3. First boot downloads ~21GB, so `/health` reports `"loading"` for a few minutes,
   then `"ready"`. Add **persistent storage** later to skip re-downloads on restart.

Deploy/update instructions: see `cloud_inference/space/DEPLOY.md` in the Nori-Lab repo.
