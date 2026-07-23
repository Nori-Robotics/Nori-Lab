# Deploy MolmoAct2 as a HuggingFace Docker Space

This folder IS the Space contents (`Dockerfile`, `README.md`, `requirements.txt`,
`molmoact2_server.py`). `molmoact2_server.py` is a copy of the canonical
`../molmoact2_server.py` — after editing the canonical server, re-copy it:

```bash
cp ../molmoact2_server.py molmoact2_server.py
```

## Target
Space `NoriRobotics/molmoact2-space` (**public**, Docker SDK, GPU hardware).

### Why public (not private)
A **private** Space gates its `*.hf.space` app URL behind HF auth and returns
**404** to unauthenticated callers — and that gate consumes the `Authorization`
header, which is the SAME header our `/act` needs for its `NORI_INFER_TOKEN`
bearer. HF's gate and our app-level auth can't share one header, so a
token-authenticated custom app must be **public**. Security is preserved: the
model weights are already public (allenai), `/` and `/health` are harmless, and
`/act` still requires our bearer token (verified: a wrong token → 401).
On AWS/Modal this whole issue vanishes (no HF proxy) — the server is identical.

## Path A — scripted (create repo + upload folder)
Uses the org token already in `nori-backend/.env` (`HF_ORG_ADMIN_TOKEN`), read
in-process, never printed. From `cloud_inference/space/`:

```bash
python - <<'PY'
import os
from dotenv import load_dotenv
from huggingface_hub import HfApi
load_dotenv("/Users/michael/Documents/Nori-Robotics/nori-backend/.env")
api = HfApi(token=os.environ["HF_ORG_ADMIN_TOKEN"])
repo = "NoriRobotics/molmoact2-space"
api.create_repo(repo, repo_type="space", space_sdk="docker", private=True, exist_ok=True)
api.upload_folder(repo_id=repo, repo_type="space", folder_path=".")
print("uploaded ->", repo)
PY
```

Creating the Space defaults to **free CPU** hardware; a CPU box cannot load the
model. After upload, finish in the UI (Path B steps 2-3).

## Path B — UI
1. huggingface.co → New Space → owner `NoriRobotics`, SDK **Docker**, **private**.
   Clone it, copy this folder's files in, `git add . && git commit && git push`.
2. **Settings → Variables and secrets**: add secret `NORI_INFER_TOKEN` (the bearer
   token the rollout sends). Add `HF_TOKEN` only if the model repo is gated.
3. **Settings → Hardware**: pick a GPU — `a10g-small` (~$1/hr) is enough.

## Verify
First boot downloads ~21GB. Poll health (no auth needed):

```bash
curl -s https://norirobotics-molmoact2-space.hf.space/health
# {"ok":false,"status":"loading",...}  ->  {"ok":true,"status":"ready",...}
```

Smoke-test `/act` (needs the token; keep it out of shell history — read from a file):

```bash
TOKEN=$(cat ~/.nori_infer_token)   # or your secret manager
curl -s https://norirobotics-molmoact2-space.hf.space/act \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"images":["<b64-jpeg>","<b64-jpeg>"],"state":[0,0,0,0,0,0],
       "instruction":"pick up the red cup","num_steps":10}'
# -> {"actions":[[...6...], ...]}   ~30 moves, robot scale
```

The exact subdomain is shown on the Space page (Embed → Direct URL). It is
`https://<owner>-<space-name>.hf.space`, lowercased with `/` → `-`.

## Cost note
A GPU Space bills while **Running**. Set **Sleep after inactivity** in Settings
(e.g. 15 min) for the spike so it pauses when idle; the robot rollout wakes it
(cold start ≈ first-boot download unless persistent storage is attached).

## Inference Endpoint (step 4 — the migration target)

The SAME image runs as an Inference Endpoint custom container. Create with
(values per INFERENCE_ENDPOINT_PLAN §2.4):

- **repository**: `allenai/MolmoAct2-SO100_101` — mounted at `/repository`; the
  server loads from the mount when present (no 21GB boot download) and falls
  back to the Hub download, so the image stays Space-compatible.
- **container port**: `7860` (or set a `PORT` env — the CMD honours it). A port
  mismatch is the #1 "stuck initializing" cause.
- **health_route**: `/ready` — 503 until the model is loaded (do NOT use `/` or
  `/health`; they stay 200-while-loading for the Space's readiness probe).
- **type**: `protected` (HF token at the edge). App auth rides `X-Nori-Token`
  (primary; constant-time). The rollout client sends both headers; set
  `NORI_INFER_HF_TOKEN` on the laptop so Authorization carries an HF token with
  `inference.endpoints.infer.write` for the edge.
- **scaling**: `min_replica=1` (scale-to-zero is unusable for a control loop),
  `max_replica=2`, `scaling_metric=pendingRequests`, scale-to-zero disabled.
- **secrets**: `NORI_INFER_TOKEN` (same value as `~/.nori_infer_token`).
- ⚠️ RTC's session cache assumes ONE replica — RTC is default-off and measured
  non-viable here, but if it is ever enabled, pin `max_replica=1` or add sticky
  sessions.
