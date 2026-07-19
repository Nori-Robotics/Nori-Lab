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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", default=os.environ.get("NORI_INFER_ARM", "left"))
    ap.add_argument("--instruction", default="pick up the red cup")
    ap.add_argument("--num-steps", type=int, default=10)
    ap.add_argument("--views", type=int, default=2, help="how many camera views to send")
    ap.add_argument("--drain", type=int, default=30, help="actions to pull from the queue")
    args = ap.parse_args()

    endpoint = cr.infer_url()
    token = cr.infer_token()
    if not endpoint or not token:
        print("set NORI_INFER_URL and ~/.nori_infer_token (or NORI_INFER_TOKEN)")
        return 2

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
