#!/usr/bin/env python3
"""Phase-3 dry run: exercise the cloud-rollout CLIENT against the LIVE endpoint,
WITHOUT a robot. Validates the joint-order contract mapping + bounds guard + the
chunk queue end-to-end, so a wiring bug shows up here instead of on hardware.

It drives the real `CloudRollout` (same class the rollout uses) with a synthetic
observation, drains one full chunk, and prints each action as a JOINT-KEYED dict
plus per-joint ranges vs the model's own bounds.

    NORI_INFER_URL=https://norirobotics-molmoact2-space.hf.space \
      python cloud_inference/dryrun_cloud.py --arm left --instruction "pick up the red cup"

Token: ~/.nori_infer_token (or NORI_INFER_TOKEN). Needs pillow.
"""
import argparse
import base64
import importlib.util
import io
import os
import time
from pathlib import Path

# Import the canonical mapping/client from lelab (by path — no install needed).
_HERE = Path(__file__).resolve().parent
_MOD = _HERE.parent / "lelab" / "nori_cloud_rollout.py"
_spec = importlib.util.spec_from_file_location("nori_cloud_rollout", _MOD)
cr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cr)


def _frame(shade: int) -> str:
    from PIL import Image
    im = Image.new("RGB", (224, 224), (shade, shade, shade))
    for x in range(80, 150):
        for y in range(80, 150):
            im.putpixel((x, y), (200, 40, 40))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def _tensor_to_jpeg_b64(t) -> str:
    import io as _io
    import numpy as np
    from PIL import Image
    arr = t.detach().cpu().numpy() if hasattr(t, "detach") else np.asarray(t)
    if arr.ndim == 3 and arr.shape[0] in (1, 3):          # CHW -> HWC
        arr = np.transpose(arr, (1, 2, 0))
    if arr.dtype != np.uint8:                              # float [0,1] -> uint8
        arr = (np.clip(arr, 0, 1) * 255).astype(np.uint8) if arr.max() <= 1.0 else arr.astype(np.uint8)
    buf = _io.BytesIO()
    Image.fromarray(arr).save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def replay_dataset(args, endpoint, token) -> int:
    """EXPERIMENTAL (run in the lelab env — needs lerobot + a local capture).
    Replays a recorded episode's REAL overhead+front frames through the cloud
    policy and reports the per-joint open-loop error between the model's first
    predicted action and the human-demonstrated action. A big error means either
    a domain gap (Nori cameras vs the model's training views) or a mapping bug."""
    from lerobot.datasets.lerobot_dataset import LeRobotDataset
    ds = LeRobotDataset(args.dataset)
    feats = ds.meta.features
    state_names = feats["observation.state"]["names"]
    action_names = feats["action"]["names"]
    view_keys = args.views_keys or list(cr.DEFAULT_CLOUD_VIEWS)
    missing = [v for v in view_keys if v not in feats]
    if missing:
        print(f"dataset lacks view(s) {missing}; has image features: "
              f"{[k for k in feats if k.startswith('observation.images.')]}")
        return 2
    keys = cr.arm_keys(args.arm)
    ep = args.episode
    lo = int(ds.episode_data_index["from"][ep].item())
    hi = int(ds.episode_data_index["to"][ep].item())
    roll = cr.CloudRollout(endpoint=endpoint, token=token, instruction=args.instruction,
                           action_keys=keys, num_steps=args.num_steps, bounds=cr.MOLMOACT2_BOUNDS)
    print(f"replaying {args.dataset} ep{ep} frames [{lo},{hi}) | arm={args.arm} | views={view_keys}")
    errs = []
    for i in range(lo, hi):
        fr = ds[i]
        state = dict(zip(state_names, fr["observation.state"].tolist()))
        imgs = [_tensor_to_jpeg_b64(fr[v]) for v in view_keys]
        out = roll.serve(imgs, [state[k] for k in keys])
        if out["action"] is None:
            time.sleep(0.1)
            continue
        rec = dict(zip(action_names, fr["action"].tolist()))
        errs.append([abs(out["action"][k] - rec[k]) for k in keys])
    if not errs:
        print("no predictions collected")
        return 1
    import statistics
    print(f"\nframes scored: {len(errs)} | clamps={roll.status()['clamps']}")
    print("per-joint mean |predicted - demonstrated| (degrees):")
    for j, k in enumerate(keys):
        col = [e[j] for e in errs]
        print(f"  {k.replace(args.arm+'_arm_','').replace('.pos',''):<14} "
              f"mean {statistics.mean(col):6.2f}  max {max(col):6.2f}")
    print("\nlower is better; large errors => domain gap (cameras) or mapping issue.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", default=os.environ.get("NORI_INFER_ARM", "left"))
    ap.add_argument("--instruction", default="pick up the red cup")
    ap.add_argument("--num-steps", type=int, default=10)
    ap.add_argument("--views", type=int, default=2, help="how many synthetic views to send")
    ap.add_argument("--drain", type=int, default=30, help="actions to pull from the queue")
    ap.add_argument("--dataset", default=None, help="replay a real capture (repo_id/path)")
    ap.add_argument("--episode", type=int, default=0, help="episode index for --dataset replay")
    ap.add_argument("--views-keys", nargs="*", default=None,
                    help="image feature keys to send (default: overhead+front)")
    args = ap.parse_args()

    endpoint = cr.infer_url()
    token = cr.infer_token()
    if not endpoint or not token:
        print("set NORI_INFER_URL and ~/.nori_infer_token (or NORI_INFER_TOKEN)")
        return 2

    if args.dataset:
        return replay_dataset(args, endpoint, token)

    keys = cr.arm_keys(args.arm)
    print(f"endpoint : {endpoint}")
    print(f"arm      : {args.arm}")
    print(f"map (model order -> Nori key):")
    for j, k in zip(cr.MOLMOACT2_JOINTS, keys):
        print(f"           {j:<14} -> {k}")

    roll = cr.CloudRollout(
        endpoint=endpoint, token=token, instruction=args.instruction,
        action_keys=keys, num_steps=args.num_steps, bounds=cr.MOLMOACT2_BOUNDS,
    )
    images = [_frame(90 + 20 * i) for i in range(max(1, args.views))]
    state = [0.0] * 6  # neutral pose; the mapping/contract is what we're checking

    # Drive the client: serve() until it primes, then drain `--drain` actions.
    collected = []
    t0 = time.time()
    deadline = t0 + 60
    while len(collected) < args.drain and time.time() < deadline:
        try:
            out = roll.serve(images, state)
        except cr.CloudRolloutError as e:
            print("CLOUD ERROR:", e)
            return 1
        if out["action"] is None:
            time.sleep(0.1)  # warming: first chunk still compiling (~3.6s)
            continue
        collected.append(out["action"])
    if not collected:
        print("no actions served (timed out warming)")
        return 1

    st = roll.status()
    print(f"\nserved {len(collected)} actions | refills={st['refills']} "
          f"clamps={st['clamps']} | {time.time()-t0:.1f}s")
    print("\nfirst 3 actions (joint-keyed):")
    for a in collected[:3]:
        print("  " + ", ".join(f"{k.replace(args.arm+'_arm_','').replace('.pos','')}={v:.1f}"
                               for k, v in a.items()))

    print("\nper-joint range across chunk  (min .. max  | model bound):")
    for j, k, (lo, hi) in zip(cr.MOLMOACT2_JOINTS, keys, cr.MOLMOACT2_BOUNDS):
        vals = [a[k] for a in collected]
        flag = "" if lo <= min(vals) and max(vals) <= hi else "  <-- OUT OF BOUND"
        print(f"  {j:<14} {min(vals):8.2f} .. {max(vals):8.2f}   | [{lo:.0f}, {hi:.0f}]{flag}")
    print("\nDRY RUN OK — mapping + contract validated against the live model.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
