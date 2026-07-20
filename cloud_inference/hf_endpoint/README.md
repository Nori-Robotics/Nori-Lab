# MolmoAct2 on a HuggingFace Inference Endpoint (task #38, no-AWS-quota path)

Test MolmoAct2-SO100_101 **today** without waiting on AWS GPU quota. HF provides
the GPU + HTTPS + auth; you provide `handler.py`. Same contract as the AWS FastAPI
variant, so `lelab`'s milestone-2 wiring is identical (just a different URL/auth).

## 1. Create a handler repo on HF
This repo ships **only** the handler (the 5B model downloads by ID at endpoint
startup — don't duplicate the weights).
```bash
# from this directory (cloud_inference/hf_endpoint)
pip install -U huggingface_hub
hf auth login                    # your HF token (write access)
hf repo create norirobotics/molmoact2-endpoint --type model
hf upload norirobotics/molmoact2-endpoint . --repo-type model
# uploads handler.py + requirements.txt to the repo root
```

## 2. Deploy the Inference Endpoint (UI, ~2 min)
1. Go to **https://ui.endpoints.huggingface.co** → **New endpoint**.
2. **Model repository:** `norirobotics/molmoact2-endpoint`.
3. **Instance:** GPU → **Nvidia A10G** (small, ~$1/hr; bf16 fits <16 GB) — or L40S for lower latency.
4. **Task:** Custom (it auto-detects `handler.py`).
5. **Security:** Protected (token-authenticated). Create.
6. Wait for **Running** (first boot pulls the ~20 GB model + captures CUDA graphs — a few minutes).
7. Copy the **Endpoint URL**.

## 3. Smoke-test
```bash
IMG=$(base64 -i workspace.jpg | tr -d '\n')   # macOS; Linux: base64 -w0 workspace.jpg
curl -s -X POST "<ENDPOINT_URL>" \
  -H "Authorization: Bearer $HF_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"inputs\":{\"images\":[\"$IMG\",\"$IMG\"],\"state\":[0,0,0,0,0,0],\"instruction\":\"pick up the red cup\",\"num_steps\":10}}"
# -> {"actions": [[...6...], ... 10-30 rows ...]}   ROBOT SCALE
```
A 10–30 × 6 chunk of finite numbers = **milestone 1 proven** (no AWS needed).

## Notes
- **Scale-to-zero:** in the endpoint settings, set it to sleep after N minutes idle to avoid paying while not testing (adds cold-start on wake).
- **Contract is identical to the AWS server** (see ../README.md): 6-dim state (single SO-101 arm), ≥2 camera views, language instruction, chunked open-loop output.
- **Compliance (task #37):** HF is a *third party* — for the spike use test footage only; production inference should move to your own infra/AWS (the AWS FastAPI variant), which is why we built both.
- **`transformers` pin:** if the endpoint errors on model load, pin `transformers` in requirements.txt to the version on the MolmoAct2 model card, re-upload, and redeploy.

## Milestone 2 (same as AWS path)
`lelab` cloud-inference mode: per-tick `/act` serves the next action from a chunk
queue; when it drains, POST `{images,state,instruction}` here, refill; keep the
watchdog + bounds. Only the endpoint URL + auth header differ from the AWS variant.
