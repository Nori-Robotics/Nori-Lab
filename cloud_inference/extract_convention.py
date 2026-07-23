#!/usr/bin/env python3
"""Extract the per-MODEL units convention from a hardware-validated calibration.

The manual quantile calibration (~/.nori_joint_calib.json) is secretly a product
of two maps:  (per-MODEL convention: nori-degrees -> model-degrees)  o
(per-ROBOT exact map: normalized -> nori-degrees, fully determined by that
robot's robot.json). The second half is automated (the policy stream delivers
robot.json); the first half is a property of the model checkpoint — THE SAME
FOR EVERY ROBOT — and this tool factors it out so it can be shipped in the repo
(lelab/model_conventions/<model>.json) and composed automatically forever after.

    A_convention = A_validated / A_exact
    B_convention = B_validated - A_convention * B_exact     (per joint)

Inputs MUST come from the SAME robot: the validated calib, and that robot's
robot.json (the streamed copy at ~/.nori_robot_calib.json, or the file itself).

    python cloud_inference/extract_convention.py \
        --calib ~/.nori_joint_calib.json --robot-json ~/.nori_robot_calib.json \
        --arm left --out lelab/model_conventions/molmoact2_so100.json

Sanity: convention A's should land near +-1 (the two degree conventions differ
mostly by zero offsets, not scale). A wild A (e.g. wrist_roll's behaviour-tuned
28.66) is preserved but flagged — it encodes model behaviour, not units, and
travels with the convention to every robot by design (see the calib's source
note: do not "fix" it without a hardware run).

After extracting: commit the output file, delete ~/.nori_joint_calib.json on
every laptop, and the composed zero-touch path takes over (load_calibration ->
nori_units.load_composed_calibration). Validate once with an observe-only run.
"""
import argparse
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from lelab.nori_units import JOINTS, affine_from_robot_json  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calib", default=str(Path.home() / ".nori_joint_calib.json"),
                    help="hardware-validated quantile calibration")
    ap.add_argument("--robot-json", default=str(Path.home() / ".nori_robot_calib.json"),
                    help="robot.json of the SAME robot the calib was derived on")
    ap.add_argument("--arm", default="left", choices=["left", "right"])
    ap.add_argument("--out", default=str(_HERE.parent / "lelab" / "model_conventions"
                                         / "molmoact2_so100.json"))
    args = ap.parse_args()

    v = json.loads(Path(args.calib).read_text())
    v = v.get(args.arm, v)
    exact = affine_from_robot_json(json.loads(Path(args.robot_json).read_text()), args.arm)
    if exact is None:
        print(f"robot.json lacks a complete {args.arm}-arm calibration — wrong file?")
        return 1

    def factor(Av, Bv):
        Ac = [av / a for av, a in zip(Av, exact["A"])]
        Bc = [bv - ac * b for bv, ac, b in zip(Bv, Ac, exact["B"])]
        return Ac, Bc

    A, B = factor([float(x) for x in v["A"]], [float(x) for x in v["B"]])
    A_inv, B_inv = factor([float(x) for x in v.get("A_inverse", v["A"])],
                          [float(x) for x in v.get("B_inverse", v["B"])])

    print(f"{'joint':14} {'conv A':>10} {'conv B':>10}   sanity")
    for j, ac, bc in zip(JOINTS, A, B):
        note = "ok" if 0.5 <= abs(ac) <= 2.0 else \
            "FLAG: far from +-1 — behaviour-tuned gain or a units problem; verify on hardware"
        print(f"{j:14} {ac:10.4f} {bc:10.2f}   {note}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "model": "MolmoAct2-SO100_101",
        "joints": JOINTS,
        "A": A, "B": B, "A_inverse": A_inv, "B_inverse": B_inv,
        "source": {"calib": str(args.calib), "robot_json": str(args.robot_json),
                   "arm": args.arm,
                   "validated_source_note": v.get("source", "")},
    }, indent=2) + "\n")
    print(f"\nwrote {out}\ncommit it; laptops can then delete ~/.nori_joint_calib.json "
          f"— the composed zero-touch path takes over. Validate observe-only first.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
