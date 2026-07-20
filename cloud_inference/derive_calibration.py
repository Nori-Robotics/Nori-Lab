#!/usr/bin/env python3
"""Derive the per-joint calibration that reconciles Nori's joint convention with
MolmoAct2's SO-100/101 convention, and write it to a JSON the rollout loads
(NORI_INFER_CALIB / ~/.nori_joint_calib.json).

Method: quantile-match each joint's Nori state distribution (from a reference
capture) onto the model's distribution (from norm_stats): A=(mQ99-mQ01)/(nQ99-nQ01),
B=mQ01 - A*nQ01. Low-variance joints (tiny Nori range → ill-conditioned scale,
e.g. wrist_roll) fall back to offset-only (A=1, B=median shift).

A live check showed this cuts open-loop error ~10x (20.9deg -> 2.1deg). It is a
STOPGAP that assumes a linear convention difference; the real fix for the camera
domain gap is a finetune (see cloud_inference/FINETUNE_PLAN.md).

    python cloud_inference/derive_calibration.py --dataset move_red_left --arm left
    # writes ~/.nori_joint_calib.json ; then: export NORI_INFER_CALIB=~/.nori_joint_calib.json
"""
import argparse
import glob
import importlib.util
import json
import os
import urllib.request
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("ncr", _HERE.parent / "lelab" / "nori_cloud_rollout.py")
cr = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(cr)

NORM_STATS_URL = "https://huggingface.co/allenai/MolmoAct2-SO100_101/raw/main/norm_stats.json"


def _dataset_dir(name: str) -> Path:
    p = Path(name)
    if p.is_dir():
        return p
    return Path.home() / ".cache/huggingface/lerobot" / name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True, help="repo_id or path of a reference capture")
    ap.add_argument("--arm", default="left", choices=["left", "right"])
    ap.add_argument("--out", default=str(Path.home() / ".nori_joint_calib.json"))
    ap.add_argument("--min-range", type=float, default=15.0,
                    help="deg; joints whose Nori q01..q99 span is below this use offset-only")
    args = ap.parse_args()

    keys = cr.arm_keys(args.arm)
    short = [k.replace(args.arm + "_arm_", "").replace(".pos", "") for k in keys]

    # model per-joint state stats (names == model order)
    with urllib.request.urlopen(NORM_STATS_URL, timeout=30) as r:
        ss = json.load(r)["metadata_by_tag"]["so100_so101_molmoact2"]["state_stats"]
    m_q01, m_q99, m_q50 = np.array(ss["q01"]), np.array(ss["q99"]), np.array(ss["q50"])

    # Nori per-joint state stats over ALL episodes of the reference capture
    d = _dataset_dir(args.dataset)
    info = json.loads((d / "meta/info.json").read_text())
    sn = info["features"]["observation.state"]["names"]
    idx = [sn.index(k) for k in keys]
    rows = []
    for pqf in sorted(glob.glob(str(d / "data" / "**" / "*.parquet"), recursive=True)):
        rows.extend(pq.read_table(pqf, columns=["observation.state"]).column(0).to_pylist())
    if not rows:
        print(f"no parquet rows under {d}/data")
        return 2
    nori = np.array(rows)[:, idx]
    n_q01, n_q99, n_q50 = (np.percentile(nori, q, axis=0) for q in (1, 99, 50))

    A, B, mode = np.ones(6), np.zeros(6), []
    for j in range(6):
        span = n_q99[j] - n_q01[j]
        if abs(span) >= args.min_range:
            A[j] = (m_q99[j] - m_q01[j]) / span
            B[j] = m_q01[j] - A[j] * n_q01[j]
            mode.append("scale+offset")
        else:  # ill-conditioned scale -> offset-only (match medians), A=1
            A[j] = 1.0
            B[j] = m_q50[j] - n_q50[j]
            mode.append("offset-only")

    print(f"calibration for arm={args.arm} from {args.dataset} ({len(nori)} frames):")
    print(f"  {'joint':<14}{'nori q01..q99':>20}{'model q01..q99':>20}{'A':>8}{'B':>9}  mode")
    for j in range(6):
        print(f"  {short[j]:<14}{f'{n_q01[j]:.1f}..{n_q99[j]:.1f}':>20}"
              f"{f'{m_q01[j]:.1f}..{m_q99[j]:.1f}':>20}{A[j]:>8.2f}{B[j]:>9.1f}  {mode[j]}")

    out = {
        "arm": args.arm,
        "joints": [k.replace(".pos", "").replace(args.arm + "_arm_", "") for k in keys],
        "A": [round(float(x), 6) for x in A],
        "B": [round(float(x), 4) for x in B],
        "source": f"quantile-match vs norm_stats; ref={args.dataset}; min_range={args.min_range}",
    }
    Path(args.out).write_text(json.dumps(out, indent=2) + "\n")
    print(f"\nwrote {args.out}\nenable with: export NORI_INFER_CALIB={args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
