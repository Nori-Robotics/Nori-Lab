# Patch Policy (research reimplementation)

Reimplementation of **"Patch Policy: Efficient Embodied Control via Dense Visual
Representations"** (Zhou, Cui, Langford, Tan, LeCun, Pinto — NYU/Meta-FAIR,
[arXiv:2607.18236](https://arxiv.org/abs/2607.18236),
[project page](https://patch-policy.github.io/)). Built from the paper — the
official repo was a code-less placeholder as of 2026-07-26; diff against it when
it drops.

Feed the FULL 16×16 grid of patch tokens from a **frozen DINOv2 ViT-S/14** into
a small (~15M trainable) transformer with a **block-causal attention mask**
(bidirectional within a frame, causal across frames), and decode an action
chunk at the last patch token of every frame. Paper: ~40% relative improvement
over global-pooled baselines; beats fine-tuned OpenVLA-OFT by 18% at 0.7% of
the parameters; ~6.5 GPU-hours to train on 1× L40S.

## Fidelity to the paper

Faithful: frozen encoder (no fine-tuning), dense patches consumed directly
(384-dim policy trunk == ViT-S dim, projection only if dims differ), learned 1D
positional embedding over the flattened T×P sequence, block-causal mask,
per-frame chunk readout at each frame's last patch token with loss on every
frame, vision-only observations, real-world recipe defaults (T=2, chunk 5,
batch 128, lr 3e-4, wd 1e-4, 8 layers / 8 heads).

**Deviations (documented, deliberate):**

- **Head:** v0 uses a chunked **L1-regression head** (ACT-style). The paper
  evaluates VQ-BeT and Diffusion-Policy heads; the trunk is the contribution
  and heads are interchangeable. v1 should wire LeRobot's VQ-BeT head (the
  paper's best: 10.99 ms inference vs ~445 ms for the DP head).
- Multi-camera patch order (concat in configured camera order) and image
  antialiased-bilinear resize to 224×224 are unspecified in the paper.

## Layout

- `patch_policy/model.py` — config, frozen DINOv2 encoder, block-causal trunk,
  chunked head, `loss()` (pad-masked L1 on normalized actions), `act()`
  (denormalized chunk for the latest frame).
- `patch_policy/data.py` — `LeRobotDataset` adapter: per-frame action chunks
  via `delta_timestamps`, `*_is_pad` → loss mask, pyav video backend
  (torchcodec dylibs are broken on some Macs).
- `patch_policy/train.py` — BC trainer (AdamW, AMP on CUDA, checkpoints).
- `tests/` — no-network unit tests (fake encoder), including a behavioral
  proof of the causal mask: perturbing the last frame leaves earlier frames'
  outputs unchanged.

## Verified 2026-07-26 (M-series Mac)

- 6/6 unit tests pass.
- Real end-to-end smoke on the local `move_red_cup` dataset (146 eps, 15 fps,
  12-dim bimanual actions, camera `remote`): loss 1.11 → 0.75 over 10 steps,
  ~4.4 it/s at batch 4 on MPS, checkpoint save/load round-trips.
- `act()` latency **23 ms on MPS** (43 Hz) — 14× real-time for a 5-step chunk
  at 15 fps. Laptop inference is viable; no cloud endpoint needed.

## Run

```bash
cd research/patch_policy

python3.12 -m pytest tests/ -q                     # unit tests (CPU, no network)

# Local smoke (Mac):
python3.12 -m patch_policy.train --repo-id move_red_cup --cameras remote \
    --steps 200 --batch 8 --workers 0 --device mps --out runs/smoke

# Real training (1x L40S, paper recipe — expect ~6.5 GPU-hours):
python3.12 -m patch_policy.train --repo-id <repo> --cameras <cams...> \
    --steps 100000 --batch 128 --out runs/<task>
```

## Next steps

1. Full training run on `move_red_cup` (L40S via the HF Jobs training lane) and
   an on-robot A/B against the existing ACT baseline.
2. VQ-BeT head via LeRobot's implementation (paper's best head).
3. 3-camera config (front + both wrists) per the dataset-collection protocol —
   sequence grows to T×768 tokens, still small.
4. Rollout integration: adapt the laptop policy runner to feed `act()` a
   rolling T-frame window (repeat oldest frame during warmup) and execute
   chunks with the existing chunk executor.
5. Optional speedup: precompute/cache DINOv2 features per dataset (encoder is
   frozen — features never change) to cut training image decode/encode cost.
