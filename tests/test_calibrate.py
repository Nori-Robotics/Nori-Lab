# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Tests for lelab.calibrate — manager initial state and request schema."""

from __future__ import annotations


def test_calibration_status_defaults_to_idle() -> None:
    from lelab.calibrate import CalibrationStatus

    status = CalibrationStatus()
    assert status.calibration_active is False
    assert status.status == "idle"
    assert status.device_type is None
    assert status.error is None
    assert status.step == 0


def test_calibration_request_dataclass_round_trip() -> None:
    from lelab.calibrate import CalibrationRequest

    req = CalibrationRequest(
        device_type="teleop",
        port="/dev/ttyUSB0",
        config_file="my_calib",
    )
    assert req.device_type == "teleop"
    assert req.port == "/dev/ttyUSB0"
    assert req.config_file == "my_calib"
    assert req.robot_name is None


def test_calibration_manager_starts_idle() -> None:
    from lelab.calibrate import CalibrationManager

    mgr = CalibrationManager()
    assert mgr.status.calibration_active is False
    assert mgr.status.status == "idle"
    assert mgr.device is None
    assert mgr.calibration_thread is None


def test_calibration_manager_get_status_when_idle_returns_status_object() -> None:
    from lelab.calibrate import CalibrationManager, CalibrationStatus

    mgr = CalibrationManager()
    s = mgr.get_status()
    assert isinstance(s, CalibrationStatus)
    assert s.status == "idle"


def test_calibration_manager_rejects_double_start_via_message() -> None:
    """When calibration_active is True, start_calibration returns success=False."""
    from lelab.calibrate import CalibrationManager, CalibrationRequest

    mgr = CalibrationManager()
    mgr.status.calibration_active = True  # simulate already running

    result = mgr.start_calibration(
        CalibrationRequest(device_type="teleop", port="/dev/null", config_file="x")
    )
    assert result.get("success") is False
    assert "already" in result.get("message", "").lower()


def test_calibration_status_defaults_auto_calibration_idle() -> None:
    from lelab.calibrate import CalibrationStatus

    status = CalibrationStatus()
    assert status.auto_calibration_active is False
    assert status.auto_calibration_status == "idle"
    assert status.auto_calibration_message == ""
    assert status.auto_calibration_error is None


def test_auto_calibration_requires_active_recording_step() -> None:
    from lelab.calibrate import CalibrationManager

    mgr = CalibrationManager()
    result = mgr.start_auto_calibration()
    assert result.get("success") is False
    assert "start calibration" in result.get("message", "").lower()


def test_start_auto_calibration_starts_so101_worker(monkeypatch) -> None:
    from types import SimpleNamespace

    from lelab import calibrate

    started = []

    class FakeThread:
        def __init__(self, target, args=(), daemon=False):
            started.append((target, args, daemon))

        def start(self):
            started.append("started")

    mgr = calibrate.CalibrationManager()
    mgr.status.calibration_active = True
    mgr.status.status = "recording"
    mgr.device = SimpleNamespace(is_connected=True, bus=SimpleNamespace(motors={}))
    monkeypatch.setattr(calibrate.threading, "Thread", FakeThread)

    result = mgr.start_auto_calibration()

    assert result == {
        "success": True,
        "message": "SO-101 auto calibration started",
    }
    assert started == [(mgr._auto_calibrate_motors_worker, (), True), "started"]
    assert mgr.status.auto_calibration_active is True
    assert mgr.status.auto_calibration_status == "running"
    assert "SO-101" in mgr.status.auto_calibration_message


def test_auto_calibration_worker_applies_so101_result(monkeypatch) -> None:
    from types import SimpleNamespace

    from lelab import calibrate
    from lelab.so101_auto_calibration import SO101AutoCalibrationResult
    from lerobot.motors import MotorCalibration

    calls = []

    class FakeBus:
        motors = {
            "shoulder_pan": SimpleNamespace(id=1),
            "shoulder_lift": SimpleNamespace(id=2),
            "elbow_flex": SimpleNamespace(id=3),
            "wrist_flex": SimpleNamespace(id=4),
            "wrist_roll": SimpleNamespace(id=5),
            "gripper": SimpleNamespace(id=6),
        }

        def disable_torque(self):
            calls.append("disable_torque")

    calibration = {
        "shoulder_pan": MotorCalibration(1, 0, -20, 800, 3300),
        "shoulder_lift": MotorCalibration(2, 0, 10, 700, 3400),
        "elbow_flex": MotorCalibration(3, 0, 30, 600, 3500),
        "wrist_flex": MotorCalibration(4, 0, 40, 305, 4000),
        "wrist_roll": MotorCalibration(5, 0, 0, 0, 4095),
        "gripper": MotorCalibration(6, 0, -15, 1985, 3500),
    }
    runner_result = SO101AutoCalibrationResult(
        calibration=calibration,
        mins={name: cal.range_min for name, cal in calibration.items()},
        maxes={name: cal.range_max for name, cal in calibration.items()},
        mids={name: 2047 + cal.homing_offset for name, cal in calibration.items()},
        current_positions={
            "shoulder_pan": 2100,
            "shoulder_lift": 2200,
            "elbow_flex": 2300,
            "wrist_flex": 2400,
            "wrist_roll": 2500,
            "gripper": 2600,
        },
    )

    def fake_runner(bus, **kwargs):
        assert isinstance(bus, FakeBus)
        assert kwargs["io_lock"] is mgr._device_io_lock
        assert kwargs["stop_requested"]() is False
        kwargs["status_callback"]("SO-101 stage")
        kwargs["position_callback"]({"gripper": 2600})
        calls.append("runner")
        return runner_result

    mgr = calibrate.CalibrationManager()
    mgr.status.calibration_active = True
    mgr.status.status = "recording"
    mgr.status.auto_calibration_active = True
    mgr.device = SimpleNamespace(is_connected=True, bus=FakeBus(), calibration={})
    monkeypatch.setattr(calibrate, "run_so101_auto_calibration", fake_runner)

    mgr._auto_calibrate_motors_worker()

    assert calls == ["runner"]
    assert mgr.device.calibration is calibration
    assert mgr._mins["wrist_flex"] == 305
    assert mgr._maxes["wrist_flex"] == 4000
    assert mgr._homing_offsets["gripper"] == -15
    assert mgr.status.auto_calibration_active is False
    assert mgr.status.auto_calibration_status == "completed"
    assert mgr.status.recorded_ranges["wrist_roll"] == {
        "min": 0,
        "max": 4095,
        "current": 2500,
    }


def test_auto_calibration_worker_reports_runner_errors(monkeypatch) -> None:
    from types import SimpleNamespace

    from lelab import calibrate

    calls = []

    class FakeBus:
        motors = {"gripper": SimpleNamespace(id=6)}

        def disable_torque(self):
            calls.append("disable_torque")

    def fake_runner(*_args, **_kwargs):
        raise RuntimeError("range probe failed")

    mgr = calibrate.CalibrationManager()
    mgr.status.auto_calibration_active = True
    mgr.device = SimpleNamespace(is_connected=True, bus=FakeBus())
    monkeypatch.setattr(calibrate, "run_so101_auto_calibration", fake_runner)

    mgr._auto_calibrate_motors_worker()

    assert calls == ["disable_torque"]
    assert mgr.status.auto_calibration_active is False
    assert mgr.status.auto_calibration_status == "error"
    assert mgr.status.auto_calibration_error == "range probe failed"


def test_record_positions_preserves_gripper_ranges_during_auto_calibration() -> None:
    from lelab.calibrate import CalibrationManager

    mgr = CalibrationManager()
    mgr._auto_calibration_motor = "gripper"
    mgr.status.auto_calibration_active = True
    mgr._mins = {"gripper": 1985}
    mgr._maxes = {"gripper": 3500}

    mgr._record_positions({"gripper": 2})

    assert mgr._mins["gripper"] == 1985
    assert mgr._maxes["gripper"] == 3500
    assert mgr.status.recorded_ranges["gripper"] == {
        "min": 1985,
        "max": 3500,
        "current": 2,
    }


def test_record_positions_can_commit_auto_calibration_endpoint() -> None:
    from lelab.calibrate import CalibrationManager

    mgr = CalibrationManager()
    mgr._auto_calibration_motor = "gripper"
    mgr.status.auto_calibration_active = True
    mgr._mins = {"gripper": 2100}
    mgr._maxes = {"gripper": 2500}

    mgr._record_positions({"gripper": 3500}, allow_auto_range_update=True)

    assert mgr._mins["gripper"] == 2100
    assert mgr._maxes["gripper"] == 3500


def test_record_positions_accepts_zero_encoder_endpoint() -> None:
    from lelab.calibrate import CalibrationManager

    mgr = CalibrationManager()
    mgr._auto_calibration_motor = "wrist_roll"
    mgr.status.auto_calibration_active = True
    mgr._mins = {"wrist_roll": 2048}
    mgr._maxes = {"wrist_roll": 4095}

    mgr._record_positions({"wrist_roll": 0}, allow_auto_range_update=True)

    assert mgr._mins["wrist_roll"] == 0
    assert mgr._maxes["wrist_roll"] == 4095
    assert mgr.status.recorded_ranges["wrist_roll"] == {
        "min": 0,
        "max": 4095,
        "current": 0,
    }
