from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def leader_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from lelab import nori_leader_setup as leader

    root = tmp_path / "nori_l2_dual_leader"
    monkeypatch.setattr(leader, "CONFIG_DIR", root)
    monkeypatch.setattr(leader, "PORTS_PATH", root / "leader_ports.json")
    return root


def test_expected_leader_ids_and_targets() -> None:
    from lelab import nori_leader_setup as leader

    assert leader.expected_joint_ids("left") == {
        "shoulder_pan": 1,
        "shoulder_lift": 2,
        "elbow_flex": 3,
        "wrist_flex": 4,
        "wrist_roll": 5,
        "gripper": 6,
    }
    assert leader.expected_joint_ids("right")["shoulder_pan"] == 7
    assert leader.leader_target_name("left", "wrist_roll") == "left_arm_wrist_roll.pos"
    assert leader.leader_target_name("right", "gripper") == "right_arm_gripper.pos"


def test_leader_raw_to_degrees_uses_degree_semantics() -> None:
    from lelab import nori_leader_setup as leader

    cal = {
        "center_raw": 2048,
        "range_min": 1024,
        "range_max": 3072,
        "direction": 1,
        "circular": False,
    }
    assert leader.leader_raw_to_degrees(2058, cal) == pytest.approx(10 * 360 / 4095)
    cal["direction"] = -1
    assert leader.leader_raw_to_degrees(2058, cal) == pytest.approx(-10 * 360 / 4095)


def test_gripper_normalizes_zero_to_100_and_respects_direction() -> None:
    from lelab import nori_leader_setup as leader

    cal = {
        "center_raw": 0,
        "range_min": 1000,
        "range_max": 3000,
        "norm_mode": "0_100",
        "direction": 1,
        "circular": False,
    }
    assert leader.normalize_leader_raw(2000, cal) == 50
    cal["direction"] = -1
    assert leader.normalize_leader_raw(2000, cal) == 50
    assert leader.normalize_leader_raw(1000, cal) == 100


def test_direction_updates_are_backed_up_and_persisted(leader_cache: Path) -> None:
    from lelab import nori_leader_setup as leader

    payload = leader.empty_calibration_payload("demo")
    payload["leaders"]["left"] = {
        "port": {"device": "/dev/ttyUSB0"},
        "motors": {
            "shoulder_lift": {
                "id": 2,
                "center_raw": 2048,
                "range_min": 1000,
                "range_max": 3000,
                "norm_mode": "M100_100",
                "circular": False,
                "direction": 1,
                "target_name": "left_arm_shoulder_lift.pos",
            }
        },
    }
    leader.write_leader_calibration(payload, "demo")

    result = leader.set_direction("left", "shoulder_lift", mode="inverted", calibration_id="demo")

    assert result["previous"] == "normal"
    assert result["direction"] == "inverted"
    saved = json.loads((leader_cache / "demo.json").read_text())
    assert saved["leaders"]["left"]["motors"]["shoulder_lift"]["direction"] == -1
    assert list(leader_cache.glob("demo.json.backup.*"))


def test_save_and_load_leader_ports_round_trip(leader_cache: Path) -> None:
    from lelab import nori_leader_setup as leader

    left = leader.PortIdentity(device="/dev/ttyUSB0", stable_path="/dev/serial/by-id/left")
    right = leader.PortIdentity(device="/dev/ttyUSB1", serial_number="R")
    leader.save_leader_ports(left, right)

    loaded = leader.load_leader_ports()

    assert loaded["left"].device == "/dev/ttyUSB0"
    assert loaded["right"].serial_number == "R"


def test_guarded_id_write_requires_single_responder(monkeypatch: pytest.MonkeyPatch) -> None:
    from lelab import nori_leader_setup as leader

    class FakeBus:
        def __init__(self, *_args, **_kwargs) -> None:
            self.ids = {1, 2}

        def __enter__(self):
            return self

        def __exit__(self, *_exc) -> None:
            pass

        def ping(self, motor_id: int) -> bool:
            return motor_id in self.ids

    monkeypatch.setattr(leader, "SCSBus", FakeBus)

    with pytest.raises(RuntimeError, match="expected exactly one"):
        leader.set_connected_servo_id(target_id=4, port="/dev/null")


def test_guarded_id_write_changes_and_verifies_single_servo(monkeypatch: pytest.MonkeyPatch) -> None:
    from lelab import nori_leader_setup as leader

    class FakeBus:
        ids = {1}

        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_exc) -> None:
            pass

        def ping(self, motor_id: int) -> bool:
            return motor_id in self.ids

        def write1(self, motor_id: int, addr: int, value: int) -> bool:
            if addr == leader.REG_ID:
                self.ids.remove(motor_id)
                self.ids.add(value)
            return True

    monkeypatch.setattr(leader, "SCSBus", FakeBus)

    result = leader.set_connected_servo_id(target_id=4, port="/dev/null", scan_max=12)

    assert result["success"] is True
    assert result["previous_id"] == 1
    assert result["after"] == [4]


def test_read_shared_live_positions_maps_both_leaders(
    leader_cache: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from lelab import nori_leader_setup as leader

    payload = leader.empty_calibration_payload("demo")
    for side in ("left", "right"):
        payload["leaders"][side] = {
            "port": {"device": "/dev/ttyUSB0"},
            "motors": {
                joint: {
                    "id": motor_id,
                    "center_raw": 2048,
                    "range_min": 1024,
                    "range_max": 3072,
                    "norm_mode": norm_mode,
                    "circular": circular,
                    "direction": 1,
                    "target_name": leader.leader_target_name(side, joint),
                }
                for joint, motor_id, norm_mode, circular in leader.leader_joint_specs(side)
            },
        }
    leader.write_leader_calibration(payload, "demo")

    class FakeBus:
        def __init__(self, port: str, **_kwargs) -> None:
            self.port = port

        def open(self) -> None:
            pass

        def close(self) -> None:
            pass

        def read_positions(self, motor_ids):
            assert tuple(motor_ids) == leader.ALL_LEADER_IDS
            return {
                1: 2058,
                5: 2500,
                7: 2048,
                12: 3072,
            }

    monkeypatch.setattr(leader, "SCSBus", FakeBus)
    leader.close_shared_live_reader()

    result = leader.read_shared_live_positions(port="/dev/ttyUSB0", calibration_id="demo")

    assert result["port"] == "/dev/ttyUSB0"
    assert result["leaders"]["left"]["visible"] == 2
    assert result["leaders"]["right"]["visible"] == 2
    assert result["leaders"]["left"]["motors"]["shoulder_pan"]["target"] == pytest.approx(10 * 360 / 4095)
    assert result["leaders"]["left"]["motors"]["wrist_roll"]["raw"] == 2500
    assert result["leaders"]["right"]["motors"]["gripper"]["target"] == 100
    leader.close_shared_live_reader()
