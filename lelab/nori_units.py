# NORI: Additive file. Derive the Nori<->SO-100/101 units affine EXACTLY from the
# robot's own motor calibration (robot.json) — the file the policy-stream preamble
# delivers and lelab/policy_stream_rx.py persists (~/.nori_robot_calib.json).
#
# Why this exists: without a units calibration the rollout passes normalized
# [-100,100] state to a model that speaks absolute degrees (and executes returned
# degrees as if normalized) — one confident lurch to a nonsense pose. The existing
# derive_calibration.py stopgap needs a reference CAPTURE and silently goes stale
# whenever the motors are recalibrated (the capture's normalized values are
# relative to the ranges at record time). This derivation needs no capture and can
# never go stale: recalibrate the motors and the next stream start carries the new
# robot.json.
#
# The robot daemon's math (NoriTelop rpi5/nori_core_agent/src/calibration.cpp) is
# exactly invertible, and Nori uses the lerobot STS3215 conventions natively:
#
#   normalized  n in [-100,100]:  raw = lo + (n' + 100)/200 * (hi - lo),
#                                 n' = -n if drive_mode else n
#   degrees (normalize_leader_degrees): deg = (raw - 2048) * 360/4096
#
# so deg(n) = A*n + B with
#   A = s * (hi - lo) * (360/4096) / 200,   s = -1 if drive_mode else +1
#   B = (lo + (hi - lo)/2 - 2048) * 360/4096
#
# homing_offset cancels out: both conventions live in the same homed raw frame.
# The gripper is RANGE_0_100 on the robot and 0-100 in the SO-100 datasets ->
# identity. Output format matches load_calibration() ({"A","B","A_inverse",
# "B_inverse"}, model joint order).

import json
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

STS3215_CENTER = 2048
DEG_PER_TICK = 360.0 / 4096.0
# The model's canonical joint order (mirrors nori_cloud_rollout.MOLMOACT2_JOINTS;
# duplicated by value to avoid a circular import — drift is caught by the tests).
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]


def streamed_calib_path() -> Path:
    # Same env override policy_stream_rx uses to persist it.
    return Path(os.environ.get("NORI_STREAM_CALIB_PATH",
                               str(Path.home() / ".nori_robot_calib.json")))


def affine_from_robot_json(robot: dict, arm: str) -> Optional[dict]:
    """Exact per-joint affine for `arm` from a robot.json dict, or None if any
    arm joint is missing/malformed (all-or-nothing: a partial mapping would mix
    converted and raw joints in one state vector)."""
    A: list = []
    B: list = []
    for j in JOINTS:
        if j == "gripper":
            A.append(1.0)
            B.append(0.0)
            continue
        m = robot.get(f"{arm}_arm_{j}")
        if not isinstance(m, dict):
            return None
        try:
            lo = int(m["range_min"])
            hi = int(m["range_max"])
            drive = int(m.get("drive_mode", 0)) != 0
        except (KeyError, TypeError, ValueError):
            return None
        if hi <= lo:
            return None
        s = -1.0 if drive else 1.0
        A.append(s * (hi - lo) * DEG_PER_TICK / 200.0)
        B.append((lo + (hi - lo) / 2.0 - STS3215_CENTER) * DEG_PER_TICK)
    return {"A": A, "B": B, "A_inverse": list(A), "B_inverse": list(B)}


def convention_path() -> Path:
    """The shipped per-MODEL convention constant: nori-degrees -> model-degrees,
    one file per checkpoint, IN THE REPO (a property of the model, not of any
    robot). Produced once by cloud_inference/extract_convention.py from any
    hardware-validated quantile calibration + the robot.json of the SAME robot
    it was derived on. NORI_MODEL_CONVENTION overrides for experiments."""
    return Path(os.environ.get(
        "NORI_MODEL_CONVENTION",
        str(Path(__file__).parent / "model_conventions" / "molmoact2_so100.json")))


def compose_with_convention(convention: dict, robot: dict, arm: str) -> Optional[dict]:
    """Full nori-normalized -> model-degrees affine for THIS robot:
    (per-model constant) o (this robot's exact map from robot.json).
    model = Ac*(a*n + b) + Bc  =>  A = Ac*a, B = Ac*b + Bc."""
    exact = affine_from_robot_json(robot, arm)
    if exact is None:
        return None
    try:
        Ac, Bc = convention["A"], convention["B"]
        Ac_i = convention.get("A_inverse", Ac)
        Bc_i = convention.get("B_inverse", Bc)
        if not all(len(v) == len(JOINTS) for v in (Ac, Bc, Ac_i, Bc_i)):
            return None
        return {
            "A": [ac * a for ac, a in zip(Ac, exact["A"])],
            "B": [ac * b + bc for ac, b, bc in zip(Ac, exact["B"], Bc)],
            "A_inverse": [ac * a for ac, a in zip(Ac_i, exact["A"])],
            "B_inverse": [ac * b + bc for ac, b, bc in zip(Ac_i, exact["B"], Bc_i)],
        }
    except (KeyError, TypeError):
        return None


def load_composed_calibration(arm: str) -> Optional[dict]:
    """Zero-touch units mapping: shipped model convention o streamed robot.json.
    Both halves are automatic (the repo ships one; the robot streams the other),
    so a new robot/laptop needs NO manual calibration step. Returns None if
    either half is missing — the caller decides how loudly to complain."""
    cp = convention_path()
    if not cp.is_file():
        return None
    rp = streamed_calib_path()
    if not rp.is_file():
        logger.warning("[NORI-UNITS] model convention present (%s) but no streamed "
                       "robot.json at %s — start a policy stream once to deliver it", cp, rp)
        return None
    try:
        convention = json.loads(cp.read_text())
        robot = json.loads(rp.read_text())
    except (OSError, ValueError) as e:
        logger.warning("[NORI-UNITS] unreadable convention/robot.json (%s)", e)
        return None
    cal = compose_with_convention(convention, robot, arm)
    if cal is None:
        logger.warning("[NORI-UNITS] convention o robot.json composition failed "
                       "(incomplete %s-arm calibration?)", arm)
        return None
    logger.info("[NORI-UNITS] units = shipped model convention o streamed robot.json "
                "(%s arm) — zero-touch. A=%s B=%s", arm,
                [round(a, 4) for a in cal["A"]], [round(b, 2) for b in cal["B"]])
    return cal


def load_streamed_calibration(arm: str) -> Optional[dict]:
    """Units affine from the policy-stream-delivered robot.json, if present."""
    p = streamed_calib_path()
    if not p.is_file():
        return None
    try:
        robot = json.loads(p.read_text())
    except (OSError, ValueError) as e:
        logger.warning("[NORI-UNITS] unreadable streamed robot.json %s (%s)", p, e)
        return None
    cal = affine_from_robot_json(robot, arm)
    if cal is None:
        logger.warning("[NORI-UNITS] streamed robot.json %s lacks complete %s-arm "
                       "calibration — units conversion disabled", p, arm)
        return None
    logger.info("[NORI-UNITS] units affine derived from streamed robot.json (%s, %s arm): "
                "A=%s B=%s", p, arm,
                [round(a, 4) for a in cal["A"]], [round(b, 2) for b in cal["B"]])
    return cal
