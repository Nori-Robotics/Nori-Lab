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


def test_shared_live_reader_backs_off_missing_arm(monkeypatch: pytest.MonkeyPatch) -> None:
    from lelab import nori_leader_setup as leader

    calls: list[tuple[int, ...]] = []

    class FakeBus:
        def __init__(self, port: str, **_kwargs) -> None:
            self.port = port

        def open(self) -> None:
            pass

        def close(self) -> None:
            pass

        def read_positions(self, motor_ids):
            ids = tuple(motor_ids)
            calls.append(ids)
            return {motor_id: 2000 + motor_id for motor_id in ids if motor_id in leader.LEFT_LEADER_IDS}

    monkeypatch.setattr(leader, "SCSBus", FakeBus)
    monkeypatch.setattr(leader, "load_leader_calibration", lambda _calibration_id: {})
    manager = leader.SharedLivePositionManager()

    first = manager.read(port="/dev/ttyUSB0", calibration_id="demo")
    second = manager.read(port="/dev/ttyUSB0", calibration_id="demo")

    assert calls[0] == leader.ALL_LEADER_IDS
    assert calls[1] == leader.LEFT_LEADER_IDS
    assert first["leaders"]["left"]["visible"] == 6
    assert first["leaders"]["right"]["visible"] == 0
    assert second["leaders"]["left"]["visible"] == 6
    assert second["leaders"]["right"]["visible"] == 0


def test_manual_start_captures_center_and_initial_ranges(monkeypatch: pytest.MonkeyPatch) -> None:
    from lelab import nori_leader_setup as leader

    disabled: list[tuple[int, ...]] = []

    class FakeBus:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_exc) -> None:
            pass

        def ping(self, motor_id: int) -> bool:
            return motor_id in leader.LEFT_LEADER_IDS

        def read_positions(self, motor_ids):
            return {motor_id: 2000 + motor_id for motor_id in motor_ids}

        def disable_torque(self, ids) -> None:
            disabled.append(tuple(ids))

    monkeypatch.setattr(leader, "SCSBus", FakeBus)
    manager = leader.ManualCalibrationManager()

    result = manager.start("left", port="/dev/ttyUSB0")

    assert result["success"] is True
    session = manager.status()["session"]
    assert session["center"][1] == 2001
    assert session["mins"][5] == 2005
    assert session["maxes"][5] == 2005
    assert disabled == [leader.LEFT_LEADER_IDS]


def test_manual_manager_observes_live_positions_for_ranges() -> None:
    from lelab import nori_leader_setup as leader

    manager = leader.ManualCalibrationManager()
    manager._session = leader.ManualSession(  # noqa: SLF001 - targeted state-machine unit test
        id="demo",
        side="left",
        calibration_id="demo",
        port_identity=leader.PortIdentity(device="/dev/ttyUSB0"),
        ids=leader.LEFT_LEADER_IDS,
        center={1: 2048, 2: 2048},
        mins={1: 2048, 2: 2048},
        maxes={1: 2048, 2: 2048},
    )

    manager.observe_positions({1: 1800, 2: 2300, 7: 1000})
    manager.observe_positions({1: 2200, 2: 1900})

    session = manager.status()["session"]
    assert session["mins"][1] == 1800
    assert session["maxes"][1] == 2200
    assert session["mins"][2] == 1900
    assert session["maxes"][2] == 2300
    assert 7 not in session["mins"]


def test_auto_manager_live_frame_uses_position_callback_state() -> None:
    from lelab import nori_leader_setup as leader

    manager = leader.AutoCalibrationManager()
    manager.status = leader.AutoCalibrationStatus(
        active=True,
        status="running",
        side="left",
        current_positions={"left": {"shoulder_pan": 2058, "wrist_roll": 2500}},
    )

    frame = manager.live_frame(port="/dev/ttyUSB0", calibration_id="missing")

    assert frame is not None
    assert frame["port"] == "/dev/ttyUSB0"
    assert frame["leaders"]["left"]["visible"] == 2
    assert frame["leaders"]["left"]["motors"]["shoulder_pan"]["raw"] == 2058
    assert frame["leaders"]["left"]["motors"]["wrist_roll"]["raw"] == 2500


def test_auto_save_pairs_two_single_arm_ports(
    leader_cache: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Each arm on its own USB cable: auto-detect must save DIFFERENT ports per
    side (the regression: it saved the first arm's port for both sides, so only
    the first-plugged arm ever connected)."""
    from lelab import nori_leader_setup as leader

    ids_by_port = {
        "/dev/ttyUSB0": list(leader.LEFT_LEADER_IDS),
        "/dev/ttyUSB1": list(leader.RIGHT_LEADER_IDS),
    }
    identities = [
        leader.PortIdentity(device="/dev/ttyUSB0"),
        leader.PortIdentity(device="/dev/ttyUSB1"),
    ]
    monkeypatch.setattr(leader, "detect_serial_ports", lambda: identities)

    def fake_probe(identity, **_kwargs):
        hits = ids_by_port[identity.device]
        return leader.PortProbe(
            open_path=identity.device,
            identity=identity.to_json(),
            expected_hits=hits,
            left_hits=[m for m in hits if m in leader.LEFT_LEADER_IDS],
            right_hits=[m for m in hits if m in leader.RIGHT_LEADER_IDS],
            all_hits=[],
            can_left=set(hits) >= set(leader.LEFT_LEADER_IDS),
            can_right=set(hits) >= set(leader.RIGHT_LEADER_IDS),
        )

    monkeypatch.setattr(leader, "probe_port", fake_probe)

    result = leader.auto_save_detected_ports()
    assert result["success"] is True
    saved = leader.load_leader_ports()
    assert saved["left"].open_path == "/dev/ttyUSB0"
    assert saved["right"].open_path == "/dev/ttyUSB1"


def test_shared_live_reader_reads_both_ports(
    leader_cache: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two-port topology: the live reader opens BOTH saved ports and reads each
    side's IDs from its own bus, merging into one frame."""
    from lelab import nori_leader_setup as leader

    leader.save_leader_ports(
        leader.PortIdentity(device="/dev/ttyUSB0"),
        leader.PortIdentity(device="/dev/ttyUSB1"),
    )
    reads: dict[str, list[tuple[int, ...]]] = {}

    class FakeBus:
        def __init__(self, port: str, **_kwargs) -> None:
            self.port = port

        def open(self) -> None:
            pass

        def close(self) -> None:
            pass

        def read_positions(self, motor_ids):
            ids = tuple(motor_ids)
            reads.setdefault(self.port, []).append(ids)
            side_ids = leader.LEFT_LEADER_IDS if self.port.endswith("USB0") else leader.RIGHT_LEADER_IDS
            return {m: 2000 + m for m in ids if m in side_ids}

    monkeypatch.setattr(leader, "SCSBus", FakeBus)
    monkeypatch.setattr(leader, "load_leader_calibration", lambda _cid: {})
    manager = leader.SharedLivePositionManager()

    frame = manager.read(calibration_id="demo")
    # Each port was asked only for its OWN side's IDs, and both sides are visible.
    assert reads["/dev/ttyUSB0"][0] == leader.LEFT_LEADER_IDS
    assert reads["/dev/ttyUSB1"][0] == leader.RIGHT_LEADER_IDS
    assert frame["leaders"]["left"]["visible"] == 6
    assert frame["leaders"]["right"]["visible"] == 6
    manager.close()


def test_one_dead_port_does_not_blank_the_other(
    leader_cache: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two-port topology with one cable yanked: the surviving arm keeps serving
    (with a warning) instead of the whole frame going disconnected."""
    from lelab import nori_leader_setup as leader

    leader.save_leader_ports(
        leader.PortIdentity(device="/dev/ttyUSB0"),
        leader.PortIdentity(device="/dev/ttyUSB1"),
    )

    class FakeBus:
        def __init__(self, port: str, **_kwargs) -> None:
            self.port = port

        def open(self) -> None:
            pass

        def close(self) -> None:
            pass

        def read_positions(self, motor_ids):
            if self.port.endswith("USB1"):
                raise OSError("device disconnected")
            return {m: 2000 + m for m in motor_ids}

    monkeypatch.setattr(leader, "SCSBus", FakeBus)
    monkeypatch.setattr(leader, "load_leader_calibration", lambda _cid: {})
    manager = leader.SharedLivePositionManager()

    frame = manager.read(calibration_id="demo")
    assert frame["leaders"]["left"]["visible"] == 6
    assert frame["leaders"]["right"]["visible"] == 0
    assert any("unreachable" in w for w in frame["warnings"])
    manager.close()


def test_auto_save_preserves_other_side_when_one_arm_silent(
    leader_cache: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The setup panel auto-runs detection on mount; a probe that catches only ONE
    arm (the other still enumerating) must NOT collapse a saved two-port config."""
    from lelab import nori_leader_setup as leader

    leader.save_leader_ports(
        leader.PortIdentity(device="/dev/ttyUSB0", serial_number="LEFT1"),
        leader.PortIdentity(device="/dev/ttyUSB1", serial_number="RIGHT1"),
    )
    # Only the right arm's port answers this probe round.
    identities = [leader.PortIdentity(device="/dev/ttyUSB1", serial_number="RIGHT1")]
    monkeypatch.setattr(leader, "detect_serial_ports", lambda: identities)

    def fake_probe(identity, **_kwargs):
        hits = list(leader.RIGHT_LEADER_IDS)
        return leader.PortProbe(
            open_path=identity.device, identity=identity.to_json(),
            expected_hits=hits, left_hits=[], right_hits=hits, all_hits=[],
            can_left=False, can_right=True,
        )

    monkeypatch.setattr(leader, "probe_port", fake_probe)
    result = leader.auto_save_detected_ports()
    assert result["success"] is True
    saved = leader.load_leader_ports()
    assert saved["left"].open_path == "/dev/ttyUSB0"   # preserved, NOT clobbered
    assert saved["right"].open_path == "/dev/ttyUSB1"


def test_dead_port_bus_is_dropped_and_replug_recovers(
    leader_cache: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A yanked cable's stale fd must be dropped (reads fail forever on it) and the
    port reopened on replug — within the retry window the arm comes back."""
    from lelab import nori_leader_setup as leader

    leader.save_leader_ports(
        leader.PortIdentity(device="/dev/ttyUSB0"),
        leader.PortIdentity(device="/dev/ttyUSB1"),
    )
    monkeypatch.setattr(leader, "LIVE_PORT_RETRY_SEC", 0.0)
    right_alive = {"open": True, "read": True}

    class FakeBus:
        def __init__(self, port: str, **_kwargs) -> None:
            self.port = port

        def open(self) -> None:
            if self.port.endswith("USB1") and not right_alive["open"]:
                raise OSError("no such device")

        def close(self) -> None:
            pass

        def read_positions(self, motor_ids):
            ids = tuple(motor_ids)
            if self.port.endswith("USB1"):
                if not right_alive["read"]:
                    raise OSError("device disconnected")
                return {m: 2000 + m for m in ids if m in leader.RIGHT_LEADER_IDS}
            return {m: 2000 + m for m in ids if m in leader.LEFT_LEADER_IDS}

    monkeypatch.setattr(leader, "SCSBus", FakeBus)
    monkeypatch.setattr(leader, "load_leader_calibration", lambda _cid: {})
    manager = leader.SharedLivePositionManager()

    # Healthy: both arms.
    f1 = manager.read(calibration_id="demo")
    assert f1["leaders"]["left"]["visible"] == 6 and f1["leaders"]["right"]["visible"] == 6

    # Yank right: read fails -> bus dropped, left keeps serving with a warning.
    right_alive["read"] = False
    right_alive["open"] = False
    f2 = manager.read(calibration_id="demo")
    assert f2["leaders"]["left"]["visible"] == 6
    assert f2["leaders"]["right"]["visible"] == 0
    assert any("unreachable" in w or "retry" in w for w in f2["warnings"])

    # Replug right: fresh open succeeds -> right comes back (retry window is 0).
    right_alive["open"] = True
    right_alive["read"] = True
    # right motors are in missing-backoff; step past it
    manager._missing_until.clear()
    manager._miss_counts.clear()
    f3 = manager.read(calibration_id="demo")
    assert f3["leaders"]["right"]["visible"] == 6
    manager.close()
