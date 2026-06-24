# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
# Copyright 2026 Nori Lab contributors.
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

"""SO-101 Feetech auto-calibration adapted for Nori's live bus."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from contextlib import nullcontext, suppress
from dataclasses import dataclass
from threading import RLock
from typing import Any

import scservo_sdk as scs

from lerobot.motors import MotorCalibration

logger = logging.getLogger(__name__)

COMM_ERR = (RuntimeError, ConnectionError)

SO_MOTOR_NUMBERS: dict[str, int] = {
    "shoulder_pan": 1,
    "shoulder_lift": 2,
    "elbow_flex": 3,
    "wrist_flex": 4,
    "wrist_roll": 5,
    "gripper": 6,
}
MOTOR_NAMES: list[str] = list(SO_MOTOR_NUMBERS)
CALIBRATE_FIRST: list[str] = ["shoulder_pan"]
CALIBRATE_REST: list[str] = ["wrist_roll", "gripper", "wrist_flex", "elbow_flex", "shoulder_lift"]

FULL_TURN = 4096
MID_POS = 2047
STS_HALF_TURN_RAW = 2047
HOMING_OFFSET_MAX_MAG = 2047

DEFAULT_VELOCITY_LIMIT = 1000
DEFAULT_MAX_TORQUE = 1000
DEFAULT_TORQUE_LIMIT = 380
DEFAULT_ACCELERATION = 50
DEFAULT_POS_SPEED = 1000
DEFAULT_P_COEFFICIENT = 16
DEFAULT_I_COEFFICIENT = 0
DEFAULT_D_COEFFICIENT = 32
DEFAULT_TIMEOUT = 20.0
DEFAULT_UNFOLD_TIMEOUT = 6.0

POSITION_TOLERANCE = 20
STALL_VELOCITY_THRESHOLD = 3
STALL_POSITION_DELTA_THRESHOLD = 3
OVERLOAD_SETTLE_TIME = 0.2
SAFE_IO_RETRIES = 5
SAFE_IO_INTERVAL = 0.2
UNFOLD_OVERLOAD_SETTLE = 0.3
UNFOLD_TOLERANCE_DEG = 5.0

POS_EX_START_ADDR = 41
POS_LIMITS_START_ADDR = 9


class AutoCalibrationCancelledError(Exception):
    """Raised when the user stops calibration while SO-101 auto calibration is running."""


@dataclass
class SO101AutoCalibrationResult:
    """Measured calibration values from the SO-101 flow."""

    calibration: dict[str, MotorCalibration]
    mins: dict[str, int]
    maxes: dict[str, int]
    mids: dict[str, int]
    current_positions: dict[str, int]


def motor_label(name: str) -> str:
    number = SO_MOTOR_NUMBERS.get(name, "")
    return f"{name}({number})" if number != "" else name


class SO101AutoCalibrator:
    """Runs the SO-101 calibration flow on an already-connected Feetech bus."""

    def __init__(
        self,
        bus: Any,
        *,
        io_lock: RLock | None = None,
        status_callback: Callable[[str], None] | None = None,
        position_callback: Callable[[dict[str, int]], None] | None = None,
        stop_requested: Callable[[], bool] | None = None,
    ) -> None:
        self.bus = bus
        self.io_lock = io_lock
        self.status_callback = status_callback
        self.position_callback = position_callback
        self.stop_requested = stop_requested or (lambda: False)

    def run(
        self,
        *,
        velocity_limit: int = DEFAULT_VELOCITY_LIMIT,
        timeout_s: float = DEFAULT_TIMEOUT,
        unfold_timeout_s: float = DEFAULT_UNFOLD_TIMEOUT,
    ) -> SO101AutoCalibrationResult:
        self._validate_bus_motors()
        all_mins: dict[str, int] = {}
        all_maxes: dict[str, int] = {}
        all_mids: dict[str, int] = {}
        all_unfold_directions: dict[str, str | None] = {}
        all_reference_positions: dict[str, int] = {}

        try:
            self._set_status("SO-101 auto calibration: initializing servos...")
            self._run_init()

            self._set_status("SO-101 auto calibration: unfolding wrist flex...")
            direction, _ = self.unfold_single_joint("wrist_flex", 80, unfold_timeout_s)
            if direction is not None:
                all_unfold_directions["wrist_flex"] = direction
            time.sleep(0.1)

            self._set_status("SO-101 auto calibration: unfolding shoulder lift...")
            direction, _ = self.unfold_single_joint("shoulder_lift", 15, unfold_timeout_s)
            if direction is not None:
                all_unfold_directions["shoulder_lift"] = direction
            self._record_reference_position("shoulder_lift", all_reference_positions)

            self._set_status("SO-101 auto calibration: unfolding elbow flex...")
            direction, _ = self.unfold_single_joint("elbow_flex", 30, unfold_timeout_s)
            if direction is not None:
                all_unfold_directions["elbow_flex"] = direction
            self._record_reference_position("elbow_flex", all_reference_positions)
            time.sleep(0.1)

            self._set_status("SO-101 auto calibration: centering shoulder lift and elbow flex...")
            for motor in ["shoulder_lift", "elbow_flex"]:
                self.go_to_mid(motor)
                time.sleep(0.1)

            self._set_status("SO-101 auto calibration: measuring shoulder lift and elbow flex...")
            ccw_first_2_3 = {
                "shoulder_lift": all_unfold_directions.get("shoulder_lift") != "reverse",
                "elbow_flex": all_unfold_directions.get("elbow_flex") != "reverse",
            }
            results_2_3 = self._calibrate_motors(
                ["shoulder_lift", "elbow_flex"],
                velocity_limit=velocity_limit,
                timeout_s=timeout_s,
                ccw_first=ccw_first_2_3,
                unfold_directions=all_unfold_directions,
                reference_positions=all_reference_positions,
            )
            self._apply_results(results_2_3, all_mins, all_maxes, all_mids, ["shoulder_lift", "elbow_flex"])
            self._fold_arm(all_mins, all_maxes, all_unfold_directions, motors=["shoulder_lift", "elbow_flex"])

            time.sleep(0.1)
            self._set_status("SO-101 auto calibration: positioning elbow for wrist/gripper measurement...")
            self._move_arm_by_angle(
                all_unfold_directions,
                80,
                fold=False,
                motors=["elbow_flex"],
                all_mins=all_mins,
                all_maxes=all_maxes,
            )

            self._set_status("SO-101 auto calibration: measuring wrist roll, gripper, and wrist flex...")
            rest_motors = ["wrist_roll", "gripper", "wrist_flex"]
            results_rest = self._calibrate_motors(
                rest_motors,
                velocity_limit=velocity_limit,
                timeout_s=timeout_s,
                reference_positions=all_reference_positions,
            )
            self._apply_results(results_rest, all_mins, all_maxes, all_mids, rest_motors)
            time.sleep(0.1)

            self._set_status("SO-101 auto calibration: folding wrist/gripper for shoulder pan...")
            self._fold_arm(
                all_mins,
                all_maxes,
                all_unfold_directions,
                motors=["elbow_flex", "wrist_flex", "gripper"],
                unfold_per_motor={"elbow_flex": False, "wrist_flex": True, "gripper": False},
            )

            self._set_status("SO-101 auto calibration: measuring shoulder pan...")
            results_pan = self._calibrate_motors(
                ["shoulder_pan"],
                velocity_limit=velocity_limit,
                timeout_s=timeout_s,
            )
            self._apply_results(results_pan, all_mins, all_maxes, all_mids, ["shoulder_pan"])
            time.sleep(0.1)

            self._set_status("SO-101 auto calibration: folding arm...")
            self._fold_arm(all_mins, all_maxes, all_unfold_directions)

            self._set_status("SO-101 auto calibration: restoring servo modes...")
            for name in self.bus.motors:
                self.write("Lock", name, 0)
                time.sleep(0.01)
                self.write("Operating_Mode", name, 0)
                time.sleep(0.01)
            time.sleep(1.0)

            calibration = self._build_calibration(all_mins, all_maxes, all_mids)
            current_positions = self.sync_read_positions()
            return SO101AutoCalibrationResult(
                calibration=calibration,
                mins=all_mins,
                maxes=all_maxes,
                mids=all_mids,
                current_positions=current_positions,
            )
        finally:
            self.safe_disable_all()

    def _validate_bus_motors(self) -> None:
        missing = [motor for motor in MOTOR_NAMES if motor not in self.bus.motors]
        if missing:
            raise RuntimeError(f"SO-101 auto calibration requires missing motors: {missing}")

    def _build_calibration(
        self,
        all_mins: dict[str, int],
        all_maxes: dict[str, int],
        all_mids: dict[str, int],
    ) -> dict[str, MotorCalibration]:
        calibration = {}
        for name in CALIBRATE_REST + CALIBRATE_FIRST:
            motor = self.bus.motors[name]
            offset = all_mids[name] - STS_HALF_TURN_RAW
            offset = max(-HOMING_OFFSET_MAX_MAG, min(HOMING_OFFSET_MAX_MAG, offset))
            calibration[name] = MotorCalibration(
                id=motor.id,
                drive_mode=0,
                homing_offset=offset,
                range_min=all_mins[name],
                range_max=all_maxes[name],
            )
            logger.info(
                "%s SO-101 result: min=%s max=%s mid=%s offset=%s",
                motor_label(name),
                all_mins[name],
                all_maxes[name],
                all_mids[name],
                offset,
            )
        return calibration

    def _io(self):
        return self.io_lock if self.io_lock is not None else nullcontext()

    def _check_cancelled(self) -> None:
        if self.stop_requested():
            raise AutoCalibrationCancelledError("Auto calibration cancelled")

    def _set_status(self, message: str) -> None:
        logger.info(message)
        if self.status_callback is not None:
            self.status_callback(message)

    def _record_position(self, motor: str, position: int) -> None:
        if self.position_callback is not None and 0 <= int(position) < 5000:
            self.position_callback({motor: int(position)})

    def _record_positions(self, positions: dict[str, int]) -> None:
        if self.position_callback is not None:
            valid = {motor: int(pos) for motor, pos in positions.items() if 0 <= int(pos) < 5000}
            if valid:
                self.position_callback(valid)

    def read(self, data_name: str, motor: str, *, normalize: bool = False) -> int:
        self._check_cancelled()
        with self._io():
            value = int(self.bus.read(data_name, motor, normalize=normalize))
        if data_name == "Present_Position":
            self._record_position(motor, value)
        return value

    def write(self, data_name: str, motor: str, value: int, *, normalize: bool = True) -> None:
        self._check_cancelled()
        with self._io():
            self.bus.write(data_name, motor, value, normalize=normalize)

    def sync_write(self, data_name: str, values: int | dict[str, int], *, normalize: bool = False) -> None:
        self._check_cancelled()
        with self._io():
            self.bus.sync_write(data_name, values, normalize=normalize)

    def sync_read_positions(self, motors: str | list[str] | None = None) -> dict[str, int]:
        self._check_cancelled()
        with self._io():
            positions = self.bus.sync_read("Present_Position", motors, normalize=False)
        cast_positions = {motor: int(pos) for motor, pos in positions.items()}
        self._record_positions(cast_positions)
        return cast_positions

    def enable_torque(self, motor: str) -> None:
        self._check_cancelled()
        with self._io():
            self.bus.enable_torque(motor)

    def disable_torque(self, motor: str) -> None:
        with self._io():
            self.bus.disable_torque(motor)

    def _write_raw_bytes(
        self,
        addr: int,
        motor_id: int,
        data: list[int],
        *,
        num_retry: int = 0,
        raise_on_error: bool = True,
        err_msg: str = "",
    ) -> tuple[int, int]:
        self._check_cancelled()
        comm = self.bus._comm_success
        error = self.bus._no_error
        with self._io():
            for n_try in range(1 + num_retry):
                comm, error = self.bus.packet_handler.writeTxRx(
                    self.bus.port_handler, motor_id, addr, len(data), data
                )
                if self.bus._is_comm_success(comm):
                    break
                logger.debug(
                    "_write_raw_bytes @%s len=%s id=%s try=%s: %s",
                    addr,
                    len(data),
                    motor_id,
                    n_try,
                    self.bus.packet_handler.getTxRxResult(comm),
                )
        if not self.bus._is_comm_success(comm) and raise_on_error:
            raise ConnectionError(f"{err_msg} {self.bus.packet_handler.getTxRxResult(comm)}")
        if self.bus._is_error(error) and raise_on_error:
            raise RuntimeError(f"{err_msg} {self.bus.packet_handler.getRxPacketError(error)}")
        return comm, error

    def write_position_limits(self, motor: str, range_min: int, range_max: int) -> None:
        motor_id = self.bus._get_motor_id(motor)
        data = self.bus._split_into_byte_chunks(range_min, 2) + self.bus._split_into_byte_chunks(range_max, 2)
        self._write_raw_bytes(
            POS_LIMITS_START_ADDR,
            motor_id,
            data,
            raise_on_error=True,
            err_msg=f"write_position_limits(id={motor_id}, rmin={range_min}, rmax={range_max}) failed",
        )

    def read_position_limits(self, motor: str) -> tuple[int, int]:
        return (
            self.read("Min_Position_Limit", motor, normalize=False),
            self.read("Max_Position_Limit", motor, normalize=False),
        )

    def safe_write(
        self,
        reg: str,
        motor: str,
        value: int,
        *,
        normalize: bool = True,
        retries: int = SAFE_IO_RETRIES,
        interval_s: float = SAFE_IO_INTERVAL,
    ) -> None:
        for attempt in range(retries):
            try:
                self.write(reg, motor, value, normalize=normalize)
                return
            except COMM_ERR as e:
                if attempt < retries - 1:
                    time.sleep(interval_s)
                    continue
                raise RuntimeError(
                    f"safe_write: failed all {retries} attempts {reg}={value} on {motor}: {e}"
                ) from e
        raise RuntimeError(f"safe_write: unable to write {reg} on {motor}")

    def safe_write_position_limits(
        self,
        motor: str,
        range_min: int,
        range_max: int,
        *,
        retries: int = SAFE_IO_RETRIES,
        interval_s: float = SAFE_IO_INTERVAL,
    ) -> None:
        for attempt in range(retries):
            try:
                self.write_position_limits(motor, range_min, range_max)
                return
            except COMM_ERR as e:
                if attempt < retries - 1:
                    time.sleep(interval_s)
                    continue
                raise RuntimeError(
                    "safe_write_position_limits: "
                    f"failed all {retries} attempts rmin={range_min} rmax={range_max} on {motor}: {e}"
                ) from e
        raise RuntimeError(f"safe_write_position_limits: unable to write on {motor}")

    def safe_disable_all(
        self,
        motor_names: list[str] | None = None,
        *,
        num_try_per_motor: int = 3,
        interval_s: float = 0.1,
    ) -> None:
        names = motor_names if motor_names is not None else list(self.bus.motors)
        for motor in names:
            for _ in range(num_try_per_motor):
                try:
                    with self._io():
                        self.bus.write("Torque_Enable", motor, 0)
                    break
                except COMM_ERR:
                    time.sleep(interval_s)

    def _read_with_retry(
        self,
        data_name: str,
        motor: str,
        retries: int = SAFE_IO_RETRIES,
        interval_s: float = SAFE_IO_INTERVAL,
    ) -> int:
        for attempt in range(retries):
            try:
                return self.read(data_name, motor, normalize=False)
            except COMM_ERR as e:
                if attempt < retries - 1:
                    time.sleep(interval_s)
                    continue
                raise RuntimeError(
                    f"_read_with_retry: failed all {retries} attempts {data_name} on {motor}: {e}"
                ) from e
        raise RuntimeError(f"_read_with_retry: unable to read {data_name} on {motor}")

    def _safe_stop_and_clear_overload(self, motor: str, settle_s: float = 0.5) -> None:
        for _ in range(5):
            try:
                self.write("Goal_Velocity", motor, 0, normalize=False)
                break
            except COMM_ERR:
                time.sleep(0.1)
        for _ in range(5):
            try:
                self.disable_torque(motor)
                break
            except COMM_ERR:
                time.sleep(0.1)
        time.sleep(settle_s)

    def _write_torque_with_recovery(
        self,
        motor: str,
        value: int,
        retries: int = 3,
        interval_s: float = 0.5,
    ) -> None:
        for attempt in range(retries):
            try:
                self.write("Torque_Enable", motor, value)
                return
            except RuntimeError as e:
                if attempt < retries - 1:
                    with suppress(*COMM_ERR):
                        self.write("Torque_Enable", motor, 0)
                    time.sleep(interval_s)
                    continue
                raise RuntimeError(
                    f"_write_torque_with_recovery: failed all {retries} attempts "
                    f"Torque_Enable={value} on {motor}: {e}"
                ) from e
            except ConnectionError as e:
                if attempt < retries - 1:
                    time.sleep(interval_s)
                    continue
                raise RuntimeError(
                    f"_write_torque_with_recovery: failed all {retries} attempts "
                    f"Torque_Enable={value} on {motor}: {e}"
                ) from e

    def _clear_and_enable_torque(self, motor: str, settle_s: float = OVERLOAD_SETTLE_TIME) -> None:
        for _ in range(5):
            try:
                self.write("Torque_Enable", motor, 0)
                break
            except COMM_ERR:
                time.sleep(0.1)
        time.sleep(settle_s)
        self._write_torque_with_recovery(motor, 1)
        with suppress(*COMM_ERR):
            self.write("Lock", motor, 1)

    def _prepare_motors_for_range_measure(self, motors: list[str]) -> None:
        for motor in motors:
            self._safe_stop_and_clear_overload(motor)
        for motor in motors:
            phase_raw = self.read("Phase", motor, normalize=False)
            if phase_raw & 0x10:
                self.write("Phase", motor, phase_raw & ~0x10, normalize=False)
            self.write("Homing_Offset", motor, 0, normalize=False)
            self.write("Operating_Mode", motor, 1)
            self.enable_torque(motor)
        if motors:
            time.sleep(0.1)

    def _wait_for_stall(
        self,
        motor: str,
        stall_confirm_samples: int,
        timeout_s: float,
        sample_interval_s: float,
        *,
        velocity_threshold: int = STALL_VELOCITY_THRESHOLD,
        position_delta_threshold: int = STALL_POSITION_DELTA_THRESHOLD,
    ) -> str:
        stall_count = 0
        stable_count = 0
        prev_position: int | None = None
        start_time = time.monotonic()
        while time.monotonic() - start_time < timeout_s:
            self._check_cancelled()
            try:
                velocity = self.read("Present_Velocity", motor, normalize=False)
                position = self.read("Present_Position", motor, normalize=False)
                moving = self.read("Moving", motor, normalize=False)
                status = self.read("Status", motor, normalize=False)
            except COMM_ERR:
                stable_count = 0
                stall_count += 1
                if stall_count >= stall_confirm_samples:
                    return f"stall confirmed ({stall_confirm_samples}x): comm exception"
                time.sleep(sample_interval_s)
                continue

            velocity_ok = abs(velocity) < velocity_threshold
            position_ok = prev_position is None or abs(position - prev_position) < position_delta_threshold
            moving_ok = moving == 0
            if velocity_ok and position_ok and moving_ok:
                stable_count += 1
                if stable_count >= stall_confirm_samples:
                    return f"limit confirmed ({stall_confirm_samples}x): velocity near zero + position stable"
            else:
                stable_count = 0
            prev_position = position

            if status & 0x20:
                stall_count += 1
                if stall_count >= stall_confirm_samples:
                    return f"stall confirmed ({stall_confirm_samples}x): Status=0x{status:02X}"
            else:
                stall_count = 0

            time.sleep(sample_interval_s)
        return f"timeout ({timeout_s}s)"

    def _wait_for_stall_multi(
        self,
        motors: list[str],
        stall_confirm_samples: int,
        timeout_s: float,
        sample_interval_s: float,
        *,
        velocity_threshold: int = STALL_VELOCITY_THRESHOLD,
        position_delta_threshold: int = STALL_POSITION_DELTA_THRESHOLD,
    ) -> tuple[dict[str, str], dict[str, int]]:
        still_running = set(motors)
        reasons: dict[str, str] = {}
        positions: dict[str, int] = {}
        prev_pos: dict[str, int | None] = dict.fromkeys(motors)
        stable_count: dict[str, int] = dict.fromkeys(motors, 0)
        stall_count: dict[str, int] = dict.fromkeys(motors, 0)
        start_time = time.monotonic()

        while still_running and time.monotonic() - start_time < timeout_s:
            self._check_cancelled()
            for motor in list(still_running):
                try:
                    velocity = self.read("Present_Velocity", motor, normalize=False)
                    position = self.read("Present_Position", motor, normalize=False)
                    moving = self.read("Moving", motor, normalize=False)
                    status = self.read("Status", motor, normalize=False)
                except COMM_ERR:
                    stall_count[motor] = stall_count.get(motor, 0) + 1
                    if stall_count[motor] >= stall_confirm_samples:
                        reasons[motor] = f"stall confirmed ({stall_confirm_samples}x): comm exception"
                        positions[motor] = self._read_with_retry("Present_Position", motor)
                        self.write("Goal_Velocity", motor, 0)
                        still_running.discard(motor)
                    continue

                velocity_ok = abs(velocity) < velocity_threshold
                position_ok = (
                    prev_pos[motor] is None or abs(position - prev_pos[motor]) < position_delta_threshold
                )
                moving_ok = moving == 0
                if velocity_ok and position_ok and moving_ok:
                    stable_count[motor] = stable_count.get(motor, 0) + 1
                    if stable_count[motor] >= stall_confirm_samples:
                        reasons[motor] = (
                            f"limit confirmed ({stall_confirm_samples}x): velocity near zero + position stable"
                        )
                        positions[motor] = position
                        self.write("Goal_Velocity", motor, 0)
                        still_running.discard(motor)
                        continue
                else:
                    stable_count[motor] = 0
                prev_pos[motor] = position

                if status & 0x20:
                    stall_count[motor] = stall_count.get(motor, 0) + 1
                    if stall_count[motor] >= stall_confirm_samples:
                        reasons[motor] = f"stall confirmed ({stall_confirm_samples}x): Status=0x{status:02X}"
                        positions[motor] = position
                        self.write("Goal_Velocity", motor, 0)
                        still_running.discard(motor)
                else:
                    stall_count[motor] = 0

            time.sleep(sample_interval_s)

        for motor in still_running:
            reasons[motor] = f"timeout ({timeout_s}s)"
            try:
                positions[motor] = self.read("Present_Position", motor, normalize=False)
            except COMM_ERR:
                positions[motor] = 0
            with suppress(*COMM_ERR):
                self.write("Goal_Velocity", motor, 0)
        return reasons, positions

    def _run_direction_until_stall(
        self,
        motors: list[str],
        velocity: int | dict[str, int],
        *,
        stall_confirm_samples: int = 2,
        timeout_s: float = 10.0,
        sample_interval_s: float = 0.05,
        initial_move_delay_s: float = 0.5,
    ) -> tuple[dict[str, str], dict[str, int]]:
        velocity_by_motor = velocity if isinstance(velocity, dict) else dict.fromkeys(motors, velocity)
        self.sync_write("Goal_Velocity", velocity_by_motor, normalize=False)
        time.sleep(initial_move_delay_s)
        if len(motors) == 1:
            motor = motors[0]
            reason = self._wait_for_stall(motor, stall_confirm_samples, timeout_s, sample_interval_s)
            reasons = {motor: reason}
            positions = {motor: self._read_with_retry("Present_Position", motor)}
        else:
            reasons, positions = self._wait_for_stall_multi(
                motors,
                stall_confirm_samples,
                timeout_s,
                sample_interval_s,
            )
        for motor in motors:
            with suppress(*COMM_ERR):
                self.write("Goal_Velocity", motor, 0, normalize=False)
        return reasons, positions

    def measure_ranges_of_motion(
        self,
        motor: str,
        *,
        velocity_limit: int = DEFAULT_VELOCITY_LIMIT,
        stall_confirm_samples: int = 2,
        timeout_s: float = DEFAULT_TIMEOUT,
        sample_interval_s: float = 0.05,
        initial_move_delay_s: float = 0.5,
    ) -> tuple[int, int, int, int, int, int]:
        self._prepare_motors_for_range_measure([motor])
        cw_reasons, pos_cw = self._run_direction_until_stall(
            [motor],
            velocity_limit,
            stall_confirm_samples=stall_confirm_samples,
            timeout_s=timeout_s,
            sample_interval_s=sample_interval_s,
            initial_move_delay_s=initial_move_delay_s,
        )
        logger.info("%s CW stop reason: %s", motor_label(motor), cw_reasons[motor])

        self._clear_and_enable_torque(motor)
        time.sleep(0.05)
        ccw_reasons, pos_ccw = self._run_direction_until_stall(
            [motor],
            -velocity_limit,
            stall_confirm_samples=stall_confirm_samples,
            timeout_s=timeout_s,
            sample_interval_s=sample_interval_s,
            initial_move_delay_s=initial_move_delay_s,
        )
        logger.info("%s CCW stop reason: %s", motor_label(motor), ccw_reasons[motor])

        return self._compute_mid_and_range_from_limits(motor, pos_cw[motor], pos_ccw[motor])

    def measure_ranges_of_motion_multi(
        self,
        motors: list[str],
        *,
        velocity_limit: int = DEFAULT_VELOCITY_LIMIT,
        stall_confirm_samples: int = 2,
        timeout_s: float = DEFAULT_TIMEOUT,
        sample_interval_s: float = 0.05,
        initial_move_delay_s: float = 0.5,
        ccw_first: bool | dict[str, bool] = False,
        reference_positions: dict[str, int] | None = None,
    ) -> dict[str, tuple[int, int, int, int, int, int]]:
        if not motors:
            return {}
        if len(motors) == 1:
            motor = motors[0]
            return {
                motor: self.measure_ranges_of_motion(
                    motor,
                    velocity_limit=velocity_limit,
                    stall_confirm_samples=stall_confirm_samples,
                    timeout_s=timeout_s,
                    sample_interval_s=sample_interval_s,
                    initial_move_delay_s=initial_move_delay_s,
                )
            }

        self._prepare_motors_for_range_measure(motors)

        def is_ccw_first(motor: str) -> bool:
            return ccw_first.get(motor, False) if isinstance(ccw_first, dict) else bool(ccw_first)

        first_velocity = {motor: (-velocity_limit if is_ccw_first(motor) else velocity_limit) for motor in motors}
        second_velocity = {motor: (velocity_limit if is_ccw_first(motor) else -velocity_limit) for motor in motors}

        first_reasons, first_pos = self._run_direction_until_stall(
            motors,
            first_velocity,
            stall_confirm_samples=stall_confirm_samples,
            timeout_s=timeout_s,
            sample_interval_s=sample_interval_s,
            initial_move_delay_s=initial_move_delay_s,
        )
        logger.info("First-direction stop reasons: %s", first_reasons)
        for motor in motors:
            self._clear_and_enable_torque(motor)
        time.sleep(0.05)

        second_reasons, second_pos = self._run_direction_until_stall(
            motors,
            second_velocity,
            stall_confirm_samples=stall_confirm_samples,
            timeout_s=timeout_s,
            sample_interval_s=sample_interval_s,
            initial_move_delay_s=initial_move_delay_s,
        )
        logger.info("Second-direction stop reasons: %s", second_reasons)
        time.sleep(OVERLOAD_SETTLE_TIME)

        pos_cw = {
            motor: first_pos[motor] if first_velocity[motor] == velocity_limit else second_pos[motor]
            for motor in motors
        }
        pos_ccw = {
            motor: second_pos[motor] if first_velocity[motor] == velocity_limit else first_pos[motor]
            for motor in motors
        }

        result: dict[str, tuple[int, int, int, int, int, int]] = {}
        for motor in motors:
            reference = reference_positions.get(motor) if reference_positions else None
            result[motor] = self._compute_mid_and_range_from_limits(
                motor,
                pos_cw[motor],
                pos_ccw[motor],
                reference_pos=reference,
            )
        return result

    def _compute_mid_and_range_from_limits(
        self,
        motor: str,
        pos_cw: int,
        pos_ccw: int,
        *,
        move_timeout: float = 5.0,
        reference_pos: int | None = None,
    ) -> tuple[int, int, int, int, int, int]:
        arc_ccw_to_cw = (pos_cw - pos_ccw) % FULL_TURN
        arc_cw_to_ccw = (pos_ccw - pos_cw) % FULL_TURN
        if reference_pos is not None:
            start_pos = reference_pos
        else:
            shortest_arc = min(arc_ccw_to_cw, arc_cw_to_ccw)
            steps_back = max(1, shortest_arc // 3)
            back_deg = steps_back * 360.0 / FULL_TURN
            self.unfold_single_joint(motor, back_deg, move_timeout=move_timeout)
            time.sleep(0.1)
            present_raw = self._read_with_retry("Present_Position", motor)
            homing_raw = self._read_with_retry("Homing_Offset", motor)
            start_pos = (present_raw + homing_raw) % FULL_TURN

        start_in_arc_a = (start_pos - pos_ccw) % FULL_TURN <= arc_ccw_to_cw
        if start_in_arc_a:
            physical_range = arc_ccw_to_cw
            mid = (pos_ccw + physical_range // 2) % FULL_TURN
        else:
            physical_range = arc_cw_to_ccw
            mid = (pos_cw + physical_range // 2) % FULL_TURN
        raw_min = min(pos_cw, pos_ccw)
        raw_max = max(pos_cw, pos_ccw)
        homing_offset = mid - MID_POS
        homing_offset = max(-HOMING_OFFSET_MAX_MAG, min(HOMING_OFFSET_MAX_MAG, homing_offset))
        half = physical_range // 2
        range_min = max(0, min(FULL_TURN - 1, MID_POS - half))
        range_max = max(0, min(FULL_TURN - 1, MID_POS + half))
        logger.info(
            "%s CW=%s CCW=%s reference=%s range=%s mid=%s raw_min=%s raw_max=%s offset=%s",
            motor_label(motor),
            pos_cw,
            pos_ccw,
            start_pos,
            physical_range,
            mid,
            raw_min,
            raw_max,
            homing_offset,
        )
        return range_min, range_max, mid, raw_min, raw_max, homing_offset

    def wait_until_stopped(
        self,
        motor: str,
        timeout_s: float = 10.0,
        poll_interval_s: float = 0.05,
    ) -> bool:
        start_time = time.monotonic()
        while time.monotonic() - start_time < timeout_s:
            self._check_cancelled()
            try:
                moving = self.read("Moving", motor, normalize=False)
            except COMM_ERR:
                time.sleep(poll_interval_s)
                continue
            if moving == 0:
                return True
            time.sleep(poll_interval_s)
        return False

    def write_pos_ex_and_wait(
        self,
        motor: str,
        position: int,
        speed: int,
        acc: int,
        timeout_s: float = 10.0,
        poll_interval_s: float = 0.05,
        *,
        num_retry: int = 0,
    ) -> bool:
        try:
            self.write("Operating_Mode", motor, 0)
            time.sleep(0.05)
            motor_id = self.bus._get_motor_id(motor)
            position_encoded = self.bus._encode_sign("Goal_Position", {motor_id: position})[motor_id]
            speed_encoded = self.bus._encode_sign("Goal_Velocity", {motor_id: speed})[motor_id]
            data = (
                [acc]
                + self.bus._split_into_byte_chunks(position_encoded, 2)
                + [0, 0]
                + self.bus._split_into_byte_chunks(speed_encoded, 2)
            )
            self._write_raw_bytes(
                POS_EX_START_ADDR,
                motor_id,
                data,
                num_retry=num_retry,
                raise_on_error=True,
                err_msg=(
                    f"write_pos_ex_and_wait(id={motor_id}, pos={position}, speed={speed}, acc={acc}) failed"
                ),
            )
            time.sleep(0.3)
        except COMM_ERR:
            return False
        result = self.wait_until_stopped(motor, timeout_s=timeout_s, poll_interval_s=poll_interval_s)
        time.sleep(0.1)
        self._record_position(motor, self._read_with_retry("Present_Position", motor))
        return result

    def sync_write_pos_ex(self, values: dict[str, tuple[int, int, int]], *, num_retry: int = 0) -> None:
        self._check_cancelled()
        with self._io():
            for motor_name, (position, speed, acc) in values.items():
                motor_id = self.bus._get_motor_id(motor_name)
                position_encoded = self.bus._encode_sign("Goal_Position", {motor_id: position})[motor_id]
                speed_encoded = self.bus._encode_sign("Goal_Velocity", {motor_id: speed})[motor_id]
                data = (
                    [acc]
                    + self.bus._split_into_byte_chunks(position_encoded, 2)
                    + [0, 0]
                    + self.bus._split_into_byte_chunks(speed_encoded, 2)
                )
                comm = self.bus._comm_success
                error = self.bus._no_error
                for n_try in range(1 + num_retry):
                    comm, error = self.bus.packet_handler.regWriteTxRx(
                        self.bus.port_handler,
                        motor_id,
                        POS_EX_START_ADDR,
                        len(data),
                        data,
                    )
                    if self.bus._is_comm_success(comm):
                        break
                    logger.debug(
                        "sync_write_pos_ex RegWrite id=%s try=%s: %s",
                        motor_id,
                        n_try,
                        self.bus.packet_handler.getTxRxResult(comm),
                    )
                if self.bus._is_error(error):
                    logger.warning(
                        "sync_write_pos_ex RegWrite id=%s: %s",
                        motor_id,
                        self.bus.packet_handler.getRxPacketError(error),
                    )
            comm = self.bus.packet_handler.action(self.bus.port_handler, scs.BROADCAST_ID)
        if not self.bus._is_comm_success(comm):
            raise ConnectionError(
                f"sync_write_pos_ex RegAction failed: {self.bus.packet_handler.getTxRxResult(comm)}"
            )

    def go_to_mid(
        self,
        motor: str,
        *,
        timeout_s: float = DEFAULT_TIMEOUT,
        poll_interval_s: float = 0.05,
    ) -> bool:
        ok = self.write_pos_ex_and_wait(
            motor,
            MID_POS,
            DEFAULT_POS_SPEED,
            DEFAULT_ACCELERATION,
            timeout_s=timeout_s,
            poll_interval_s=poll_interval_s,
        )
        if not ok:
            with suppress(*COMM_ERR):
                current = self.read("Present_Position", motor, normalize=False)
                logger.warning("%s centering timed out, current position=%s", motor_label(motor), current)
        return ok

    def _unfold_move_and_wait(
        self,
        motor: str,
        goal: int,
        timeout_s: float,
        tolerance_deg: float = UNFOLD_TOLERANCE_DEG,
    ) -> tuple[bool, int, str]:
        goal = max(0, min(goal, FULL_TURN - 1))
        ok = self.write_pos_ex_and_wait(
            motor,
            goal,
            DEFAULT_POS_SPEED,
            DEFAULT_ACCELERATION,
            timeout_s=timeout_s,
            poll_interval_s=0.05,
        )
        time.sleep(0.3)
        try:
            position = self.read("Present_Position", motor, normalize=False)
        except COMM_ERR:
            self._clear_overload_unfold(motor)
            position = self._read_with_retry("Present_Position", motor)
            return False, position, "stalled (comm exception)"
        if not ok:
            self._clear_overload_unfold(motor)
            return False, position, "timeout"
        error_deg = abs(position - goal) * 360.0 / FULL_TURN
        if error_deg <= tolerance_deg:
            return True, position, "arrived"
        try:
            status = self.read("Status", motor, normalize=False)
        except COMM_ERR:
            status = 0
        if status & 0x20:
            self._clear_overload_unfold(motor)
            return False, position, f"stalled (Status=0x{status:02X})"
        return False, position, "not arrived"

    def _clear_overload_unfold(self, motor: str) -> None:
        with suppress(*COMM_ERR):
            self.write("Torque_Enable", motor, 0)
            time.sleep(UNFOLD_OVERLOAD_SETTLE + 0.1)
            self.write("Torque_Enable", motor, 1)

    def unfold_single_joint(
        self,
        motor: str,
        unfold_angle: float,
        move_timeout: float,
    ) -> tuple[str | None, int]:
        target_steps = int(unfold_angle / 360.0 * FULL_TURN)
        logger.info("Unfolding %s by %s steps", motor_label(motor), target_steps)

        self._write_torque_with_recovery(motor, 128)
        self._write_torque_with_recovery(motor, 1)
        time.sleep(0.1)
        self._record_position(motor, self._read_with_retry("Present_Position", motor))
        time.sleep(0.1)

        self.write("Operating_Mode", motor, 0)
        self._write_torque_with_recovery(motor, 1)
        time.sleep(0.3)

        reached, pos_after, _reason = self._unfold_move_and_wait(motor, MID_POS + target_steps, move_timeout)
        if reached:
            return "forward", target_steps

        self.write_pos_ex_and_wait(
            motor,
            MID_POS,
            DEFAULT_POS_SPEED,
            DEFAULT_ACCELERATION,
            timeout_s=5.0,
            poll_interval_s=0.05,
        )

        reached, pos_after, reason = self._unfold_move_and_wait(motor, MID_POS - target_steps, move_timeout)
        if reached:
            return "reverse", target_steps
        logger.warning("%s unfold failed at pos=%s: %s", motor_label(motor), pos_after, reason)
        return None, 0

    def _record_reference_position(self, motor_name: str, out: dict[str, int]) -> None:
        try:
            present = self.read("Present_Position", motor_name, normalize=False)
            homing_offset = self.read("Homing_Offset", motor_name, normalize=False)
            out[motor_name] = (present + homing_offset) % FULL_TURN
        except COMM_ERR:
            pass

    def _calibrate_motors(
        self,
        motor_names: list[str],
        *,
        velocity_limit: int = DEFAULT_VELOCITY_LIMIT,
        timeout_s: float = DEFAULT_TIMEOUT,
        ccw_first: bool | dict[str, bool] = False,
        unfold_directions: dict[str, str | None] | None = None,
        reference_positions: dict[str, int] | None = None,
    ) -> dict[str, tuple[int, int, int]]:
        if not motor_names:
            return {}
        raw_results = self.measure_ranges_of_motion_multi(
            motor_names,
            velocity_limit=velocity_limit,
            timeout_s=timeout_s,
            ccw_first=ccw_first,
            reference_positions=reference_positions,
        )
        result: dict[str, tuple[int, int, int]] = {}
        for motor in motor_names:
            range_min, range_max, mid_raw, _raw_min, _raw_max, homing_offset = raw_results[motor]
            logger.info(
                "%s post-offset range_min=%s range_max=%s mid=%s homing_offset=%s",
                motor_label(motor),
                range_min,
                range_max,
                mid_raw,
                homing_offset,
            )
            time.sleep(0.05)
            self.safe_write("Homing_Offset", motor, homing_offset, normalize=False)
            self.safe_write_position_limits(motor, range_min, range_max)
            time.sleep(0.1)

            do_2_3_together = (
                unfold_directions is not None
                and "shoulder_lift" in motor_names
                and "elbow_flex" in motor_names
            )
            if motor == "wrist_roll" or do_2_3_together and motor in ("shoulder_lift", "elbow_flex"):
                pass
            else:
                self.go_to_mid(motor)
            result[motor] = (range_min, range_max, mid_raw)
        return result

    @staticmethod
    def _apply_results(
        results: dict[str, tuple[int, int, int]],
        all_mins: dict[str, int],
        all_maxes: dict[str, int],
        all_mids: dict[str, int],
        motor_list: list[str],
    ) -> None:
        for motor in motor_list:
            all_mins[motor], all_maxes[motor], all_mids[motor] = results[motor]

    def _fold_arm(
        self,
        all_mins: dict[str, int],
        all_maxes: dict[str, int],
        all_unfold_directions: dict[str, str | None],
        *,
        motors: list[str] | None = None,
        unfold: bool = False,
        unfold_per_motor: dict[str, bool] | None = None,
    ) -> None:
        default_order = ["shoulder_lift", "elbow_flex", "wrist_flex", "gripper"]
        fold_order = motors if motors else default_order
        values: dict[str, tuple[int, int, int]] = {}

        for motor in fold_order:
            if motor not in all_mins or motor not in all_maxes:
                continue
            per_unfold = unfold_per_motor.get(motor, unfold) if unfold_per_motor is not None else unfold
            direction = all_unfold_directions.get(motor)
            if motor == "gripper":
                fold_end = all_mins[motor]
                unfold_end = all_maxes[motor]
            else:
                fold_end = all_maxes[motor] if direction == "reverse" else all_mins[motor]
                unfold_end = all_mins[motor] if direction == "reverse" else all_maxes[motor]
            target = unfold_end if per_unfold else fold_end
            values[motor] = (target, DEFAULT_POS_SPEED, DEFAULT_ACCELERATION)
            self.write("Operating_Mode", motor, 0)
            with suppress(*COMM_ERR):
                self._record_position(motor, self.read("Present_Position", motor, normalize=False))
        if not values:
            return

        self.sync_write_pos_ex(values)
        time.sleep(0.3)
        start_time = time.monotonic()
        while time.monotonic() - start_time < 10.0:
            self._check_cancelled()
            try:
                if all(self.read("Moving", motor, normalize=False) == 0 for motor in values):
                    break
            except COMM_ERR:
                pass
            time.sleep(0.05)
        for motor in values:
            with suppress(*COMM_ERR):
                self._record_position(motor, self.read("Present_Position", motor, normalize=False))

    def _move_arm_by_angle(
        self,
        all_unfold_directions: dict[str, str | None],
        angle_deg: float,
        *,
        fold: bool = False,
        motors: list[str] | None = None,
        all_mins: dict[str, int] | None = None,
        all_maxes: dict[str, int] | None = None,
    ) -> None:
        default_order = ["shoulder_lift", "elbow_flex", "wrist_flex"]
        move_order = motors if motors else default_order
        angle_steps = int(angle_deg / 360.0 * FULL_TURN)
        for motor in move_order:
            if all_mins is not None and all_maxes is not None and (motor not in all_mins or motor not in all_maxes):
                continue
            try:
                present = self.read("Present_Position", motor, normalize=False)
            except COMM_ERR:
                logger.warning("%s failed to read current pos, skipping relative move", motor_label(motor))
                continue
            direction = all_unfold_directions.get(motor)
            if fold:
                target = present - angle_steps if direction == "forward" else present + angle_steps
            else:
                target = present + angle_steps if direction == "forward" else present - angle_steps
            if all_mins is not None and all_maxes is not None:
                target = max(all_mins[motor], min(all_maxes[motor], target))
            ok = self.write_pos_ex_and_wait(
                motor,
                target,
                DEFAULT_POS_SPEED,
                DEFAULT_ACCELERATION,
                timeout_s=DEFAULT_UNFOLD_TIMEOUT,
                poll_interval_s=0.05,
            )
            if not ok:
                logger.warning("%s relative move timed out", motor_label(motor))

    def _run_init(self) -> None:
        init_checks = [
            ("Lock", 1),
            ("Return_Delay_Time", 0),
            ("Operating_Mode", 0),
            ("Max_Torque_Limit", DEFAULT_MAX_TORQUE),
            ("Torque_Limit", DEFAULT_TORQUE_LIMIT),
            ("Acceleration", DEFAULT_ACCELERATION),
            ("P_Coefficient", DEFAULT_P_COEFFICIENT),
            ("I_Coefficient", DEFAULT_I_COEFFICIENT),
            ("D_Coefficient", DEFAULT_D_COEFFICIENT),
            ("Homing_Offset", 0),
        ]
        for motor in MOTOR_NAMES:
            logger.info("Configuring servo %s", motor_label(motor))
            with suppress(*COMM_ERR):
                self.write("Torque_Enable", motor, 0)
                time.sleep(0.05)
            param_set_ok = True
            try:
                for register, expected in init_checks:
                    self.write(register, motor, expected, normalize=(register != "Homing_Offset"))
                    time.sleep(0.01)
                    got = self.read(register, motor, normalize=False)
                    if got != expected:
                        logger.warning(
                            "%s %s setting mismatch: set=%s read=%s",
                            motor_label(motor),
                            register,
                            expected,
                            got,
                        )
                        param_set_ok = False
                self.write_position_limits(motor, 0, FULL_TURN - 1)
                time.sleep(0.05)
                limits = self.read_position_limits(motor)
                if limits != (0, FULL_TURN - 1):
                    logger.warning(
                        "%s position limits mismatch: set=(0, 4095) read=%s",
                        motor_label(motor),
                        limits,
                    )
                    param_set_ok = False
                time.sleep(0.2)
                self.write("Torque_Enable", motor, 1)
                time.sleep(0.05)
                torque_enable = self.read("Torque_Enable", motor, normalize=False)
                if torque_enable != 1:
                    logger.warning(
                        "%s Torque_Enable mismatch: set=1 read=%s",
                        motor_label(motor),
                        torque_enable,
                    )
                    param_set_ok = False
                time.sleep(0.1)
            except Exception as e:
                logger.warning("Error setting parameters on %s: %s", motor_label(motor), e)
                param_set_ok = False
            if not param_set_ok:
                logger.warning("Parameter verification had anomalies on %s; forcing continuation", motor_label(motor))


def run_so101_auto_calibration(
    bus: Any,
    *,
    io_lock: RLock | None = None,
    status_callback: Callable[[str], None] | None = None,
    position_callback: Callable[[dict[str, int]], None] | None = None,
    stop_requested: Callable[[], bool] | None = None,
    velocity_limit: int = DEFAULT_VELOCITY_LIMIT,
    timeout_s: float = DEFAULT_TIMEOUT,
    unfold_timeout_s: float = DEFAULT_UNFOLD_TIMEOUT,
) -> SO101AutoCalibrationResult:
    """Run the SO-101 calibration flow on Nori's connected Feetech bus."""
    calibrator = SO101AutoCalibrator(
        bus,
        io_lock=io_lock,
        status_callback=status_callback,
        position_callback=position_callback,
        stop_requested=stop_requested,
    )
    return calibrator.run(
        velocity_limit=velocity_limit,
        timeout_s=timeout_s,
        unfold_timeout_s=unfold_timeout_s,
    )
