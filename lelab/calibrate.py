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

"""
Calibration module for the web interface.

This module provides calibration functionality similar to the CLI calibrate.py,
but adapted for the web interface with step-by-step guidance.
"""

import logging
import threading
import time
import traceback
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from lerobot.motors import MotorCalibration
from lerobot.motors.feetech import OperatingMode
from lerobot.robots import (
    Robot,
    make_robot_from_config,
)
from lerobot.teleoperators import (
    Teleoperator,
    make_teleoperator_from_config,
)
from lerobot.utils.utils import init_logging

from .so101_auto_calibration import (
    AutoCalibrationCancelledError,
    SO101AutoCalibrationResult,
    run_so101_auto_calibration,
)

logger = logging.getLogger(__name__)


class CalibrationDiscontinuityError(Exception):
    """Raised when a motor position reading jumps across the encoder wrap-around.

    The Feetech encoder is 12-bit (0-4095); if calibration starts with a joint
    near a boundary, moving it past 0 or 4095 produces a single-frame delta of
    ~4096. The user-side fix is to start with all joints in the middle of their
    range, as documented in the SO-101 docs.
    """


@dataclass
class CalibrationStatus:
    """Status information for calibration process"""

    calibration_active: bool = False
    status: str = "idle"  # "idle", "connecting", "recording", "completed", "error", "stopping"
    device_type: str | None = None
    error: str | None = None
    message: str = ""
    step: int = 0  # Current calibration step
    total_steps: int = 1  # Total number of calibration steps
    current_positions: dict[str, float] = None
    recorded_ranges: dict[str, dict[str, float]] = None  # {motor: {min: val, max: val, current: val}}
    auto_calibration_active: bool = False
    auto_calibration_status: str = "idle"  # "idle", "running", "completed", "error"
    auto_calibration_message: str = ""
    auto_calibration_error: str | None = None


@dataclass
class CalibrationRequest:
    """Request parameters for starting calibration"""

    device_type: Literal["robot", "teleop"]
    port: str
    config_file: str
    robot_name: str | None = None  # When set, write port + config back into the robot record on success


class CalibrationManager:
    """Manages calibration process for the web interface"""

    def __init__(self):
        self.status = CalibrationStatus()
        self.device: Robot | Teleoperator | None = None
        self.calibration_thread: threading.Thread | None = None
        self.auto_calibration_thread: threading.Thread | None = None
        self.stop_calibration = False
        self._status_lock = threading.Lock()
        self._device_io_lock = threading.RLock()
        self._step_complete = threading.Event()
        self._auto_calibration_stop = threading.Event()
        self._recording_active = False
        self._start_positions = {}
        self._mins = {}
        self._maxes = {}
        self._homing_offsets = {}
        self._current_request: CalibrationRequest | None = None
        self._auto_calibration_motor: str | None = None
        self._auto_calibration_range_guard_motors: set[str] = set()

        # Initialize logging
        init_logging()

    def get_status(self) -> CalibrationStatus:
        """Get current calibration status"""
        should_read_positions = (
            self.status.status == "recording" and self.device and self.device.is_connected
        )
        if should_read_positions:
            try:
                positions = self._read_positions(num_retry=2, retry_delay=0.005)
                if positions:
                    self._record_positions(positions)
            except Exception as e:
                # Reduce log spam by using debug level for expected port contention
                if "Port is in use" in str(e):
                    logger.debug(f"Port busy during position read: {e}")
                else:
                    logger.warning(f"Failed to read positions: {e}")

        with self._status_lock:
            return self.status

    def _update_status(self, **kwargs):
        """Update calibration status thread-safely"""
        with self._status_lock:
            for key, value in kwargs.items():
                if hasattr(self.status, key):
                    setattr(self.status, key, value)

    def start_calibration(self, request: CalibrationRequest) -> dict[str, Any]:
        """Start calibration process"""
        try:
            if self.status.calibration_active:
                return {"success": False, "message": "Calibration already active"}

            # Reset status and clear any previous calibration data
            self._start_positions = {}
            self._mins = {}
            self._maxes = {}
            self._homing_offsets = {}

            self._update_status(
                calibration_active=True,
                status="connecting",
                device_type=request.device_type,
                error=None,
                message=f"Starting calibration for {request.device_type}",
                step=0,
                current_positions=None,
                recorded_ranges=None,
                auto_calibration_active=False,
                auto_calibration_status="idle",
                auto_calibration_message="",
                auto_calibration_error=None,
            )
            self._current_request = request

            # Start calibration in a separate thread
            self.calibration_thread = threading.Thread(
                target=self._calibration_worker, args=(request,), daemon=True
            )
            self.stop_calibration = False
            self._step_complete.clear()
            self.calibration_thread.start()

            return {"success": True, "message": "Calibration started"}

        except Exception as e:
            logger.error(f"Error starting calibration: {e}")
            self._update_status(
                calibration_active=False, status="error", error=str(e), message="Failed to start calibration"
            )
            return {"success": False, "message": str(e)}

    def complete_step(self) -> dict[str, Any]:
        """Complete the current calibration step"""
        try:
            if not self.status.calibration_active:
                return {"success": False, "message": "No calibration active"}

            if self.status.auto_calibration_active:
                return {"success": False, "message": "Auto calibration is still running"}

            if self.status.status == "recording":
                # Complete recording step
                self._recording_active = False
                self._step_complete.set()
                return {"success": True, "message": "Range recording completed"}

            else:
                return {"success": False, "message": f"Cannot complete step in status: {self.status.status}"}

        except Exception as e:
            logger.error(f"Error completing step: {e}")
            return {"success": False, "message": str(e)}

    def stop_calibration_process(self) -> dict[str, Any]:
        """Stop calibration process"""
        try:
            if not self.status.calibration_active:
                return {"success": False, "message": "No calibration active"}

            logger.info("Stopping calibration process...")
            self.stop_calibration = True
            self._auto_calibration_stop.set()
            self._recording_active = False
            self._step_complete.set()  # Unblock any waiting step

            self._update_status(status="stopping", message="Stopping calibration...")

            # Wait for thread to finish
            if self.calibration_thread and self.calibration_thread.is_alive():
                self.calibration_thread.join(timeout=5.0)

            if self.auto_calibration_thread and self.auto_calibration_thread.is_alive():
                self.auto_calibration_thread.join(timeout=2.0)

            # Ensure cleanup is called if thread didn't finish properly
            if self.calibration_thread and self.calibration_thread.is_alive():
                logger.warning("Calibration thread did not finish within timeout, forcing cleanup")

            # Force cleanup and finish
            self._cleanup_and_finish("Calibration stopped", status="idle")

            logger.info("Calibration stop completed")
            return {"success": True, "message": "Calibration stopped"}

        except Exception as e:
            logger.error(f"Error stopping calibration: {e}")
            # Force cleanup on error too
            self._cleanup_and_finish("Calibration stopped with error", status="error")
            return {"success": False, "message": str(e)}

    def start_auto_calibration(self) -> dict[str, Any]:
        """Start the SO-101 auto calibration flow during range recording."""
        try:
            if not self.status.calibration_active or self.status.status != "recording":
                return {"success": False, "message": "Start calibration before running auto calibration"}

            if not self.device or not self.device.is_connected:
                return {"success": False, "message": "Device is not connected"}

            if self.status.auto_calibration_active:
                return {"success": False, "message": "Auto calibration already active"}

            self._auto_calibration_stop.clear()
            self._update_status(
                auto_calibration_active=True,
                auto_calibration_status="running",
                auto_calibration_message="Running SO-101 auto calibration...",
                auto_calibration_error=None,
            )

            self.auto_calibration_thread = threading.Thread(
                target=self._auto_calibrate_motors_worker,
                daemon=True,
            )
            self.auto_calibration_thread.start()

            return {"success": True, "message": "SO-101 auto calibration started"}
        except Exception as e:
            logger.error(f"Error starting auto calibration: {e}")
            self._update_status(
                auto_calibration_active=False,
                auto_calibration_status="error",
                auto_calibration_message="Auto calibration failed",
                auto_calibration_error=str(e),
            )
            return {"success": False, "message": str(e)}

    def _calibration_worker(self, request: CalibrationRequest):
        """Worker thread for calibration process"""
        try:
            logger.info(f"Starting calibration worker for {request.device_type}")

            # Create device configuration
            if request.device_type == "robot":
                from lerobot.robots.so_follower import SO101FollowerConfig

                config = SO101FollowerConfig(port=request.port, id=request.config_file)
            elif request.device_type == "teleop":
                from lerobot.teleoperators.so_leader import SO101LeaderConfig

                config = SO101LeaderConfig(port=request.port, id=request.config_file)
            else:
                raise ValueError(f"Unknown device type: {request.device_type}")

            self._update_status(status="connecting", message="Connecting to device...")

            # Create and connect device
            if request.device_type == "robot":
                self.device = make_robot_from_config(config)
            else:
                self.device = make_teleoperator_from_config(config)

            logger.info("Connecting to device...")
            self.device.connect(calibrate=False)

            if self.stop_calibration:
                logger.info("Calibration stopped after device connection")
                self._cleanup_and_finish("Calibration cancelled")
                return

            # Start Step 1: Homing
            self._step_homing()

            if self.stop_calibration:
                logger.info("Calibration stopped after homing step")
                self._cleanup_and_finish("Calibration cancelled")
                return

            # Start Step 2: Range Recording
            self._step_range_recording()

            if self.stop_calibration:
                logger.info("Calibration stopped after recording step")
                self._cleanup_and_finish("Calibration cancelled")
                return

            # Complete calibration
            self._complete_calibration()

            logger.info("Calibration completed successfully")
            self._cleanup_and_finish("Calibration completed successfully", status="completed")

        except CalibrationDiscontinuityError as e:
            logger.error(f"Calibration discontinuity: {e}")
            self._update_status(error=str(e))
            self._cleanup_and_finish(str(e), status="error")
        except Exception as e:
            logger.error(f"Calibration error: {e}")
            logger.error(traceback.format_exc())
            # Ensure cleanup happens even on error
            self._cleanup_and_finish(f"Calibration failed: {e}", status="error")
        finally:
            # Ensure we always clean up and reset the active flag
            logger.info("Calibration worker thread finishing")
            if self.status.calibration_active:
                logger.warning(
                    "Worker thread ending but calibration still marked as active - forcing cleanup"
                )
                self._cleanup_and_finish("Calibration stopped", status="idle")

    def _step_homing(self):
        """Auto-capture homing offsets from the device's current position."""
        logger.info("Setting homing offsets from current position")

        with self._device_io_lock:
            # Disable torque to allow manual movement during recording
            self.device.bus.disable_torque()
            for motor in self.device.bus.motors:
                self.device.bus.write("Operating_Mode", motor, OperatingMode.POSITION.value)

            self.device.bus.reset_calibration()
            actual_positions = self.device.bus.sync_read("Present_Position", normalize=False)
        logger.info(f"Current positions for homing: {actual_positions}")

        self._homing_offsets = self.device.bus._get_half_turn_homings(actual_positions)
        logger.info(f"Calculated homing offsets: {self._homing_offsets}")

        with self._device_io_lock:
            for motor, offset in self._homing_offsets.items():
                self.device.bus.write("Homing_Offset", motor, offset)

    def _step_range_recording(self):
        """Record range of motion as the user moves all joints."""
        logger.info("Starting range recording step")

        # Initialize range tracking with retry and validation
        self._start_positions = {}
        for attempt in range(5):  # Try multiple times to get valid initial positions
            try:
                positions = self._read_positions()
                # Validate initial positions
                valid_positions = {}
                for motor, pos in positions.items():
                    if 0 <= pos < 5000:  # Valid raw encoder range
                        valid_positions[motor] = pos

                if len(valid_positions) == len(positions):  # All positions are valid
                    self._start_positions = valid_positions
                    break
                else:
                    logger.warning(f"Attempt {attempt + 1}: Got invalid initial positions, retrying...")
                    time.sleep(0.1)
            except Exception as e:
                logger.warning(f"Attempt {attempt + 1}: Failed to read initial positions: {e}")
                time.sleep(0.1)

        if not self._start_positions:
            raise RuntimeError("Could not get valid initial positions after multiple attempts")

        logger.info(f"Starting positions for range recording: {self._start_positions}")

        self._mins = self._start_positions.copy()
        self._maxes = self._start_positions.copy()
        logger.info(f"Initialized mins: {self._mins}")
        logger.info(f"Initialized maxes: {self._maxes}")

        self._update_status(
            status="recording",
            step=1,
            message="Move ALL joints through their FULL ranges of motion - from minimum to maximum positions. Ensure each joint moves significantly from its starting position.",
            recorded_ranges={
                motor: {"min": pos, "max": pos, "current": pos}
                for motor, pos in self._start_positions.items()
            },
        )

        self._recording_active = True
        prev_positions: dict[str, int] = dict(self._start_positions)

        # Record positions until user completes step
        while not self._step_complete.is_set() and not self.stop_calibration:
            try:
                # Try reading positions with retry on port contention
                positions = self._read_positions(num_retry=3, retry_delay=0.01)

                if positions:
                    # Validate the readings - filter out invalid values
                    valid_positions = {}
                    for motor, pos in positions.items():
                        # Filter out clearly invalid readings (negative or extreme values).
                        # Raw encoder position 0 is valid and can be a true wrist-roll endpoint.
                        if 0 <= pos < 5000:  # Reasonable range for motor positions
                            valid_positions[motor] = pos
                        else:
                            logger.debug(f"Filtered invalid position for {motor}: {pos}")

                    # Only update if we have valid readings
                    if valid_positions:
                        for motor, pos in valid_positions.items():
                            if (
                                motor in prev_positions
                                and abs(pos - prev_positions[motor]) > 2000
                                and not self._is_expected_auto_calibration_motion(motor)
                            ):
                                raise CalibrationDiscontinuityError(
                                    "Motor discontinuity detected. Make sure to start "
                                    "the calibration with the robot in a middle position "
                                    "- all joints in the middle of their ranges."
                                )
                            prev_positions[motor] = pos
                        self._record_positions(valid_positions)

                time.sleep(0.05)  # 20Hz update rate
            except CalibrationDiscontinuityError:
                raise
            except Exception as e:
                if "Port is in use" in str(e):
                    logger.debug(f"Port busy during position read: {e}")
                else:
                    logger.warning(f"Error reading positions during recording: {e}")
                # Increase sleep time on error to reduce port contention
                time.sleep(0.2)

        if self.stop_calibration:
            logger.info("Range recording step cancelled due to stop request")
            return

        # Log the final recorded ranges for debugging
        logger.info("Final recorded ranges:")
        for motor in self._mins:
            logger.info(
                f"  {motor}: min={self._mins[motor]}, max={self._maxes[motor]}, range={self._maxes[motor] - self._mins[motor]}"
            )

        # Validate ranges
        same_min_max = [motor for motor in self._mins if self._mins[motor] == self._maxes[motor]]
        if same_min_max:
            raise ValueError(f"Some motors have the same min and max values: {same_min_max}")

        # Check for insufficient range movement (less than 100 motor steps)
        insufficient_range = []
        for motor in self._mins:
            range_diff = self._maxes[motor] - self._mins[motor]
            if range_diff < 100:  # Less than 100 motor steps seems insufficient
                insufficient_range.append(f"{motor}: {range_diff}")

        if insufficient_range:
            logger.warning(
                f"Some motors may not have been moved through sufficient range: {insufficient_range}"
            )
            logger.warning("Consider moving all joints through their full range of motion during calibration")

        self._step_complete.clear()
        logger.info("Range recording step completed")

    def _complete_calibration(self):
        """Complete the calibration and save results"""
        logger.info("Completing calibration...")

        # Log motor information for debugging
        logger.info("Motor configuration:")
        for motor, m in self.device.bus.motors.items():
            logger.info(f"  {motor}: ID={m.id}, Model={m.model}")

        # Create calibration dict
        calibration = {}
        for motor, m in self.device.bus.motors.items():
            calibration[motor] = MotorCalibration(
                id=m.id,
                drive_mode=0,
                homing_offset=self._homing_offsets[motor],
                range_min=self._mins[motor],
                range_max=self._maxes[motor],
            )
            logger.info(
                f"Calibration for {motor}: "
                f"ID={m.id}, "
                f"homing_offset={self._homing_offsets[motor]}, "
                f"range_min={self._mins[motor]}, "
                f"range_max={self._maxes[motor]}"
            )

        # Write and save calibration
        self.device.calibration = calibration
        with self._device_io_lock:
            self.device.bus.write_calibration(calibration)
        self.device._save_calibration()

        logger.info(f"Calibration saved to {self.device.calibration_fpath}")

        # Robot-record write-back: if this calibration was launched from a tile,
        # update the robot's port + config field for the side that was just calibrated.
        request = self._current_request
        if request is not None and request.robot_name:
            from .utils.config import save_robot_record

            if request.device_type == "teleop":
                patch = {"leader_port": request.port, "leader_config": f"{request.config_file}.json"}
            else:
                patch = {"follower_port": request.port, "follower_config": f"{request.config_file}.json"}
            try:
                save_robot_record(request.robot_name, patch, allow_create=False)
            except Exception as e:
                logger.warning(f"Robot-record write-back failed for {request.robot_name}: {e}")

    def _cleanup_and_finish(self, message: str, status: str = "completed"):
        """Clean up and finish calibration"""
        self._auto_calibration_stop.set()
        self._cleanup_device()
        self._recording_active = False
        self._update_status(
            calibration_active=False,
            status=status,
            message=message,
            auto_calibration_active=False,
        )

    def _cleanup_device(self):
        """Clean up device connection"""
        try:
            if self.device:
                logger.info("Disconnecting device...")
                with self._device_io_lock:
                    self.device.disconnect()
                self.device = None
        except Exception as e:
            logger.error(f"Error disconnecting device: {e}")

    def _read_positions(
        self,
        motors: str | Sequence[str] | None = None,
        *,
        num_retry: int = 3,
        retry_delay: float = 0.01,
    ) -> dict[str, int]:
        """Read raw motor positions with a short retry loop for serial-port contention."""
        for attempt in range(num_retry):
            try:
                with self._device_io_lock:
                    return self.device.bus.sync_read("Present_Position", motors, normalize=False)
            except Exception as read_error:
                if "Port is in use" in str(read_error) and attempt < num_retry - 1:
                    time.sleep(retry_delay)
                    continue
                raise
        return {}

    def _record_positions(
        self,
        positions: dict[str, int],
        *,
        update_ranges: bool = True,
        allow_auto_range_update: bool = False,
    ) -> None:
        """Merge live raw positions into the in-memory min/max range state."""
        if not positions:
            return

        with self._status_lock:
            if not self.status.recorded_ranges:
                self.status.recorded_ranges = {}
            if not self.status.current_positions:
                self.status.current_positions = {}

            for motor, pos in positions.items():
                if pos < 0 or pos >= 5000:
                    continue

                self.status.current_positions[motor] = pos
                should_update_range = update_ranges and (
                    allow_auto_range_update or not self._is_expected_auto_calibration_motion(motor)
                )
                if should_update_range:
                    if motor not in self._mins:
                        self._mins[motor] = pos
                    if motor not in self._maxes:
                        self._maxes[motor] = pos

                    self._mins[motor] = min(self._mins[motor], pos)
                    self._maxes[motor] = max(self._maxes[motor], pos)

                self.status.recorded_ranges[motor] = {
                    "min": self._mins.get(motor, pos),
                    "max": self._maxes.get(motor, pos),
                    "current": pos,
                }

    def _auto_calibrate_motors_worker(self) -> None:
        logger.info("Starting SO-101 auto calibration")
        try:
            if not self.device or not self.device.is_connected:
                raise RuntimeError("Device is not connected")

            motor_names = set(getattr(self.device.bus, "motors", {}))
            self._auto_calibration_motor = None
            self._auto_calibration_range_guard_motors = set(motor_names)

            result = run_so101_auto_calibration(
                self.device.bus,
                io_lock=self._device_io_lock,
                status_callback=lambda message: self._update_status(
                    auto_calibration_message=message
                ),
                position_callback=lambda positions: self._record_positions(
                    positions, update_ranges=False
                ),
                stop_requested=lambda: self._auto_calibration_stop.is_set()
                or self.stop_calibration,
            )

            if self._auto_calibration_stop.is_set() or self.stop_calibration:
                raise AutoCalibrationCancelledError("Auto calibration cancelled")

            self._apply_so101_auto_calibration_result(result)
            self._update_status(
                auto_calibration_active=False,
                auto_calibration_status="completed",
                auto_calibration_message=(
                    "SO-101 auto calibration completed. Save calibration to persist it."
                ),
                auto_calibration_error=None,
            )
            logger.info("SO-101 auto calibration completed")
        except AutoCalibrationCancelledError:
            logger.info("SO-101 auto calibration cancelled")
            self._update_status(
                auto_calibration_active=False,
                auto_calibration_status="idle",
                auto_calibration_message="Auto calibration cancelled",
                auto_calibration_error=None,
            )
        except Exception as e:
            logger.error("Auto calibration failed: %s", e)
            logger.error(traceback.format_exc())
            with self._device_io_lock:
                try:
                    if self.device:
                        self.device.bus.disable_torque()
                except Exception:
                    logger.debug("Failed to disable torque after auto calibration error", exc_info=True)
            self._update_status(
                auto_calibration_active=False,
                auto_calibration_status="error",
                auto_calibration_message="Auto calibration failed",
                auto_calibration_error=str(e),
            )
        finally:
            self._auto_calibration_motor = None
            self._auto_calibration_range_guard_motors.clear()

    def _apply_so101_auto_calibration_result(
        self, result: SO101AutoCalibrationResult
    ) -> None:
        for motor, calibration in result.calibration.items():
            self._mins[motor] = int(calibration.range_min)
            self._maxes[motor] = int(calibration.range_max)
            self._homing_offsets[motor] = int(calibration.homing_offset)

        self.device.calibration = result.calibration
        self._record_positions(result.current_positions, update_ranges=False)

        with self._status_lock:
            if not self.status.recorded_ranges:
                self.status.recorded_ranges = {}
            current_positions = self.status.current_positions or {}
            for motor, calibration in result.calibration.items():
                current = result.current_positions.get(
                    motor, current_positions.get(motor, calibration.range_min)
                )
                self.status.recorded_ranges[motor] = {
                    "min": int(calibration.range_min),
                    "max": int(calibration.range_max),
                    "current": int(current),
                }

    def _is_expected_auto_calibration_motion(self, motor: str) -> bool:
        return self.status.auto_calibration_active and (
            motor == self._auto_calibration_motor
            or motor in self._auto_calibration_range_guard_motors
        )


# Global calibration manager instance
calibration_manager = CalibrationManager()
