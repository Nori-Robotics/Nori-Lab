# MolmoAct2 cloud-inference spike (task #38)

Run `allenai/MolmoAct2-SO100_101` (5B VLA, flow-matching action expert) on an AWS
GPU and serve the robot rollout over authenticated JSON. This is **milestone 1**:
prove the model runs on AWS and returns SO-101 actions. Milestone 2 (wire it into
`lelab`'s rollout) follows once `/act` returns sane actions.

## 0. GPU quota (do this FIRST — it can gate "today")
New AWS accounts default to **0** for G instances. In **Service Quotas → EC2 →
"Running On-Demand G and VT instances"**, request **≥ 4 vCPU** (a `g5.xlarge` is
4 vCPU). Pick a region with stock (`us-east-1` / `us-west-2`). Approval is often
minutes, sometimes hours.

## 1. Launch the instance
- **`g5.xlarge`** (A10G, 24 GB — fits bf16 <16 GB) with the **AWS Deep Learning
  AMI (PyTorch)** so CUDA/drivers are preinstalled. (`g6.xlarge`/L4 is cheaper;
  `g6e.xlarge`/L40S if you want lower latency or fp32.)
- Security group: open **tcp/8000 to your Nori backend IP (or your IP) only** —
  never 0.0.0.0.

## 2. Install + run
```bash
# on the instance
git clone <this repo> && cd Nori-Lab/cloud_inference   # or scp this dir up
pip install -r requirements.txt                        # pin transformers per the model card

export NORI_INFER_TOKEN="$(openssl rand -hex 24)"      # the bearer token; share with the caller
export MOLMOACT_BF16=1                                  # bf16 (<16GB). =0 for fp32 (needs 48GB)
# export HF_TOKEN=...                                   # only if the repo ever becomes gated

uvicorn molmoact2_server:app --host 0.0.0.0 --port 8000
# first request warms CUDA graphs (slow); subsequent calls are fast.
```

## 3. Smoke-test with curl
```bash
IMG=$(base64 -w0 test_top.jpg)     # any RGB image; send 2 views ideally
curl -s https://<instance>:8000/health

curl -s -X POST http://<instance>:8000/act \
  -H "Authorization: Bearer $NORI_INFER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"images\":[\"$IMG\",\"$IMG\"],
       \"state\":[0,0,0,0,0,0],
       \"instruction\":\"pick up the red cup\",
       \"num_steps\":10}"
# -> {"actions": [[...6...], [...], ... 10-30 rows ...]}   ROBOT SCALE
```
If you get a 10–30 x 6 chunk of finite numbers, milestone 1 is done.

## Contract / gotchas
- **State is 6-dim** (single SO-100/101 arm). If your session is bimanual (12-dim),
  the spike targets ONE arm — send that arm's 6 joints.
- **≥2 camera views** recommended (`images=[top, side]`; order doesn't matter).
- **Language-conditioned:** you must send an `instruction` (new vs the ACT rollout).
- Output is a **chunk** (open-loop, 10–30 moves), already **de-normalized to robot
  scale** via `norm_tag`.
- **Security:** JSON only, no pickle; bearer-token auth; SG-restricted; put an
  ALB + ACM cert in front for TLS before it leaves a trusted network.
- **Compliance (task #37):** keep the path **transient — do not log request images**;
  it's your own AWS account (next to S3), so no third-party DPA, but the in-home
  video rule still applies. Use test footage for the spike.

## Milestone 2 (next, not in this file)
Add a cloud-inference mode to `lelab`'s `/nori/rollout` that maintains a **chunk
queue**: on each per-tick `/act`, serve the next action from the queue; when it
drains, POST `{images, state, instruction}` here, refill, continue. Keep the
daemon safety gating (watchdog + bounds). Full async-overlap + RTC smoothing is
task #37.
