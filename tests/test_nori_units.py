# NORI: Additive file. lelab/nori_units.py — exact units affine from robot.json.
import json

from lelab import nori_units
from lelab.nori_cloud_rollout import MOLMOACT2_JOINTS, load_calibration


def _motor(lo, hi, drive=0):
    return {"id": 1, "drive_mode": drive, "homing_offset": 12,
            "range_min": lo, "range_max": hi}


def _robot(arm="left", drive=0):
    return {f"{arm}_arm_{j}": _motor(1024, 3072, drive)
            for j in nori_units.JOINTS if j != "gripper"}


def test_joint_order_matches_model_contract():
    # nori_units duplicates the list to avoid a circular import — catch drift.
    assert nori_units.JOINTS == MOLMOACT2_JOINTS


def test_exact_affine_values():
    cal = nori_units.affine_from_robot_json(_robot(), "left")
    assert cal is not None
    # lo=1024 hi=3072: A = 2048*(360/4096)/200 = 0.9 ; mid=2048 -> B = 0
    for j, (a, b) in enumerate(zip(cal["A"], cal["B"])):
        if nori_units.JOINTS[j] == "gripper":
            assert (a, b) == (1.0, 0.0)          # 0-100 on both conventions
        else:
            assert abs(a - 0.9) < 1e-9 and abs(b) < 1e-9
    # n=100 -> raw=3072 -> (3072-2048)*360/4096 = 90 deg
    assert abs(cal["A"][0] * 100.0 + cal["B"][0] - 90.0) < 1e-9
    assert cal["A_inverse"] == cal["A"] and cal["B_inverse"] == cal["B"]


def test_drive_mode_flips_sign_and_offcenter_range_shifts_b():
    cal = nori_units.affine_from_robot_json(_robot(drive=1), "left")
    assert all(a < 0 for j, a in enumerate(cal["A"]) if nori_units.JOINTS[j] != "gripper")
    robot = _robot()
    robot["left_arm_shoulder_pan"] = _motor(2048, 4096)   # mid=3072 -> B=+90deg
    cal = nori_units.affine_from_robot_json(robot, "left")
    assert abs(cal["B"][0] - 90.0) < 1e-9


def test_incomplete_or_malformed_robot_json_refused():
    robot = _robot()
    del robot["left_arm_wrist_roll"]                       # missing joint
    assert nori_units.affine_from_robot_json(robot, "left") is None
    robot = _robot()
    robot["left_arm_elbow_flex"] = _motor(3000, 3000)      # hi <= lo
    assert nori_units.affine_from_robot_json(robot, "left") is None
    assert nori_units.affine_from_robot_json(_robot(arm="left"), "right") is None


def test_load_calibration_falls_back_to_streamed_robot_json(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))              # no ~/.nori_joint_calib.json
    monkeypatch.delenv("NORI_INFER_CALIB", raising=False)
    streamed = tmp_path / "robot_calib.json"
    streamed.write_text(json.dumps(_robot()))
    monkeypatch.setenv("NORI_STREAM_CALIB_PATH", str(streamed))
    cal = load_calibration("left")
    assert cal is not None and abs(cal["A"][0] - 0.9) < 1e-9

    # A hand-derived joint-calib file, when present, still WINS (it can carry
    # the measured asymmetric gains the exact mapping doesn't model).
    (tmp_path / ".nori_joint_calib.json").write_text(
        json.dumps({"A": [2.0] * 6, "B": [0.0] * 6}))
    cal = load_calibration("left")
    assert cal is not None and cal["A"][0] == 2.0


def test_load_calibration_none_when_nothing_available(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("NORI_INFER_CALIB", raising=False)
    monkeypatch.setenv("NORI_STREAM_CALIB_PATH", str(tmp_path / "absent.json"))
    assert load_calibration("left") is None
