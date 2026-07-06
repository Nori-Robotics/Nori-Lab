"""Nori L2 dual leader setup, calibration, and diagnostics.

This module is intentionally leader-only. It does not connect to the robot core
agent; it prepares and validates the two local leader arms used by Nori L2.
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
import select
import sys
import termios
import threading
import time
import tty
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal

logger = logging.getLogger(__name__)

LeaderSide = Literal["left", "right"]
LeaderAutoSide = Literal["left", "right", "both"]
DirectionMode = Literal["normal", "inverted"]

BAUDRATE = 1_000_000
STS3215_RESOLUTION = 4096
STS3215_MAX_POSITION = STS3215_RESOLUTION - 1
HEADER = b"\xff\xff"
INST_PING = 0x01
INST_READ = 0x02
INST_WRITE = 0x03
REG_ID = 5
REG_LOCK = 55
REG_TORQUE_ENABLE = 40
REG_PRESENT_POSITION = 56

LEFT_LEADER_IDS = (1, 2, 3, 4, 5, 6)
RIGHT_LEADER_IDS = (7, 8, 9, 10, 11, 12)
ALL_LEADER_IDS = LEFT_LEADER_IDS + RIGHT_LEADER_IDS

JOINT_LAYOUT: list[tuple[str, str, bool]] = [
    ("shoulder_pan", "M100_100", False),
    ("shoulder_lift", "M100_100", False),
    ("elbow_flex", "M100_100", False),
    ("wrist_flex", "M100_100", False),
    ("wrist_roll", "M100_100", True),
    ("gripper", "0_100", False),
]

TARGET_PREFIX: dict[LeaderSide, str] = {
    "left": "left_arm",
    "right": "right_arm",
}

CONFIG_DIR = (
    Path.home()
    / ".cache"
    / "huggingface"
    / "lerobot"
    / "calibration"
    / "teleoperators"
    / "nori_l2_dual_leader"
)
PORTS_PATH = CONFIG_DIR / "leader_ports.json"
DEFAULT_CALIBRATION_ID = "nori_l2_dual_leader_dev"
LIVE_READ_TIMEOUT = 0.012
LIVE_MISSING_RETRY_BASE_SEC = 0.25
LIVE_MISSING_RETRY_MAX_SEC = 1.0


def _require_serial():
    try:
        import serial as serial_module
    except ModuleNotFoundError as exc:
        raise RuntimeError("pyserial is required for Nori leader setup") from exc
    return serial_module


def _require_list_ports():
    try:
        from serial.tools import list_ports as list_ports_module
    except ModuleNotFoundError as exc:
        raise RuntimeError("pyserial is required for Nori leader setup") from exc
    return list_ports_module


def _checksum(parts: Iterable[int]) -> int:
    return (~sum(int(p) & 0xFF for p in parts)) & 0xFF


def leader_ids(side: LeaderSide) -> tuple[int, ...]:
    return LEFT_LEADER_IDS if side == "left" else RIGHT_LEADER_IDS


def leader_joint_specs(side: LeaderSide) -> list[tuple[str, int, str, bool]]:
    return [
        (joint, motor_id, norm_mode, circular)
        for (joint, norm_mode, circular), motor_id in zip(JOINT_LAYOUT, leader_ids(side), strict=True)
    ]


def expected_joint_ids(side: LeaderSide) -> dict[str, int]:
    return {joint: motor_id for joint, motor_id, _norm, _circular in leader_joint_specs(side)}


def leader_target_name(side: LeaderSide, joint: str) -> str:
    return f"{TARGET_PREFIX[side]}_{joint}.pos"


def _target_name_from_cal(side: LeaderSide, joint: str, cal: dict[str, Any]) -> str:
    saved = str(cal.get("target_name") or "")
    expected_prefix = f"{TARGET_PREFIX[side]}_"
    if saved.startswith(expected_prefix):
        return saved if saved.endswith(".pos") else f"{saved}.pos"
    return leader_target_name(side, joint)


@dataclass(frozen=True)
class PortIdentity:
    device: str
    stable_path: str | None = None
    serial_number: str | None = None
    hwid: str | None = None
    location: str | None = None

    @property
    def open_path(self) -> str:
        return self.stable_path or self.device

    @property
    def key(self) -> str:
        return self.serial_number or self.stable_path or self.device

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> "PortIdentity":
        return cls(
            device=str(payload.get("device") or payload.get("open_path") or ""),
            stable_path=payload.get("stable_path"),
            serial_number=payload.get("serial_number"),
            hwid=payload.get("hwid"),
            location=payload.get("location"),
        )


@dataclass(frozen=True)
class PortProbe:
    open_path: str
    identity: dict[str, Any]
    expected_hits: list[int]
    left_hits: list[int]
    right_hits: list[int]
    all_hits: list[int]
    can_left: bool
    can_right: bool

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def _by_id_for_device(device: str) -> str | None:
    try:
        resolved = Path(device).resolve()
    except OSError:
        return None
    for candidate in glob.glob("/dev/serial/by-id/*"):
        try:
            if Path(candidate).resolve() == resolved:
                return candidate
        except OSError:
            continue
    return None


def detect_serial_ports() -> list[PortIdentity]:
    list_ports = _require_list_ports()
    identities: list[PortIdentity] = []
    seen: set[str] = set()
    for port in list_ports.comports():
        device = str(getattr(port, "device", "") or "")
        if not device or device in seen:
            continue
        seen.add(device)
        identities.append(
            PortIdentity(
                device=device,
                stable_path=_by_id_for_device(device),
                serial_number=getattr(port, "serial_number", None),
                hwid=getattr(port, "hwid", None),
                location=getattr(port, "location", None),
            )
        )
    return identities


class SCSBus:
    """Minimal STS/SCS protocol bus for ping/read/write setup operations."""

    def __init__(self, port: str, baudrate: int = BAUDRATE, timeout: float = 0.06):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.ser = None

    def __enter__(self) -> "SCSBus":
        self.open()
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def open(self) -> None:
        serial = _require_serial()
        self.ser = serial.serial_for_url(self.port, baudrate=self.baudrate, timeout=self.timeout)
        time.sleep(0.08)

    def close(self) -> None:
        if self.ser is not None:
            try:
                self.ser.close()
            finally:
                self.ser = None

    def _txrx(
        self,
        motor_id: int,
        instruction: int,
        params: list[int],
        expect_status: bool = True,
    ) -> tuple[int, bytes] | None:
        if self.ser is None:
            raise RuntimeError("serial port is not open")
        body = [motor_id, len(params) + 2, instruction, *params]
        packet = HEADER + bytes([*body, _checksum(body)])
        try:
            self.ser.reset_input_buffer()
        except Exception:
            pass
        self.ser.write(packet)
        if not expect_status:
            return None

        data = bytearray()
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            waiting = getattr(self.ser, "in_waiting", 0)
            chunk = self.ser.read(max(1, int(waiting)))
            if chunk:
                data.extend(chunk)
            idx = data.find(HEADER)
            if idx < 0:
                continue
            if idx > 0:
                del data[:idx]
                idx = 0
            if len(data) < idx + 4:
                continue
            length = data[idx + 3]
            total = idx + 4 + length
            if len(data) < total:
                continue
            payload = bytes(data[idx + 2 : total])
            if len(payload) < 4:
                return None
            if _checksum(payload[:-1]) != payload[-1]:
                return None
            status_id = payload[0]
            error = payload[2]
            params_out = payload[3:-1]
            if status_id != motor_id or error:
                return None
            return error, params_out
        return None

    def ping(self, motor_id: int) -> bool:
        return self._txrx(motor_id, INST_PING, []) is not None

    def read(self, motor_id: int, addr: int, length: int) -> int | None:
        result = self._txrx(motor_id, INST_READ, [addr, length])
        if result is None:
            return None
        _error, params = result
        if len(params) < length:
            return None
        if length == 1:
            return params[0]
        return int(params[0]) | (int(params[1]) << 8)

    def write1(self, motor_id: int, addr: int, value: int) -> bool:
        return self._txrx(motor_id, INST_WRITE, [addr, value & 0xFF]) is not None

    def disable_torque(self, ids: Iterable[int]) -> None:
        for motor_id in ids:
            self.write1(motor_id, REG_TORQUE_ENABLE, 0)
            self.write1(motor_id, REG_LOCK, 0)

    def read_positions(self, ids: Iterable[int]) -> dict[int, int]:
        out: dict[int, int] = {}
        for motor_id in ids:
            value = self.read(motor_id, REG_PRESENT_POSITION, 2)
            if value is not None:
                out[motor_id] = int(value)
        return out


def scan_ids(bus: SCSBus, start: int = 1, stop: int = 253) -> list[int]:
    return [motor_id for motor_id in range(start, stop + 1) if bus.ping(motor_id)]


def probe_port(identity: PortIdentity, *, include_all: bool = False) -> PortProbe:
    try:
        with SCSBus(identity.open_path) as bus:
            expected_hits = [motor_id for motor_id in ALL_LEADER_IDS if bus.ping(motor_id)]
            all_hits = scan_ids(bus) if include_all else []
    except Exception:
        expected_hits = []
        all_hits = []
    left_hits = [motor_id for motor_id in expected_hits if motor_id in LEFT_LEADER_IDS]
    right_hits = [motor_id for motor_id in expected_hits if motor_id in RIGHT_LEADER_IDS]
    return PortProbe(
        open_path=identity.open_path,
        identity=identity.to_json(),
        expected_hits=expected_hits,
        left_hits=left_hits,
        right_hits=right_hits,
        all_hits=all_hits,
        can_left=set(left_hits) == set(LEFT_LEADER_IDS),
        can_right=set(right_hits) == set(RIGHT_LEADER_IDS),
    )


def probe_leader_ports(*, include_all: bool = False) -> list[dict[str, Any]]:
    return [probe_port(identity, include_all=include_all).to_json() for identity in detect_serial_ports()]


def save_leader_ports(left: PortIdentity, right: PortIdentity | None = None) -> dict[str, Any]:
    right = right or left
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "left": left.to_json(),
        "right": right.to_json(),
        "saved_at": time.time(),
    }
    PORTS_PATH.write_text(json.dumps(payload, indent=4, sort_keys=True) + "\n")
    return payload


def load_leader_ports() -> dict[LeaderSide, PortIdentity]:
    if not PORTS_PATH.is_file():
        raise RuntimeError(f"leader ports are not configured: {PORTS_PATH}")
    payload = json.loads(PORTS_PATH.read_text())
    return {
        "left": PortIdentity.from_json(payload["left"]),
        "right": PortIdentity.from_json(payload["right"]),
    }


def save_ports_from_paths(left_port: str, right_port: str | None = None) -> dict[str, Any]:
    left = PortIdentity(device=left_port, stable_path=_by_id_for_device(left_port))
    right = PortIdentity(device=right_port or left_port, stable_path=_by_id_for_device(right_port or left_port))
    return {"success": True, "ports": save_leader_ports(left, right)}


def auto_save_detected_ports() -> dict[str, Any]:
    probes = [probe_port(identity) for identity in detect_serial_ports()]
    shared = next((probe for probe in probes if probe.can_left and probe.can_right), None)
    if shared is None:
        return {
            "success": False,
            "message": "Could not find one USB bus with both leader arms",
            "probes": [probe.to_json() for probe in probes],
        }
    identity = PortIdentity.from_json(shared.identity)
    ports = save_leader_ports(identity, identity)
    return {"success": True, "ports": ports, "probes": [probe.to_json() for probe in probes]}


def _port_for_side(side: LeaderSide) -> str:
    return load_leader_ports()[side].open_path


def set_connected_servo_id(
    *,
    target_id: int,
    port: str,
    scan_max: int = 253,
) -> dict[str, Any]:
    if not 1 <= int(target_id) <= 253:
        raise ValueError("target_id must be in 1..253")
    with SCSBus(port) as bus:
        before = scan_ids(bus, 1, scan_max)
        if before == [target_id]:
            return {
                "success": True,
                "message": "already at target id",
                "previous_id": target_id,
                "target_id": target_id,
                "before": before,
                "after": before,
            }
        if len(before) != 1:
            raise RuntimeError(f"expected exactly one connected servo before writing, saw {before}")
        previous_id = before[0]
        if not bus.write1(previous_id, REG_LOCK, 0):
            raise RuntimeError(f"failed to unlock servo {previous_id}")
        if not bus.write1(previous_id, REG_ID, target_id):
            raise RuntimeError(f"failed to write ID {target_id} to servo {previous_id}")
        time.sleep(0.2)
        after = scan_ids(bus, 1, scan_max)
        if after != [target_id]:
            raise RuntimeError(f"ID write did not verify; before={before}, after={after}")
        return {
            "success": True,
            "previous_id": previous_id,
            "target_id": target_id,
            "before": before,
            "after": after,
        }


def identify_leader_motors(
    *,
    port: str | None = None,
    all_ids: bool = False,
    cycles: int = 1,
) -> dict[str, Any]:
    resolved = port or _port_for_side("left")
    ids = range(1, 254) if all_ids else ALL_LEADER_IDS
    snapshots: list[dict[int, bool]] = []
    with SCSBus(resolved) as bus:
        for _ in range(max(1, cycles)):
            snapshots.append({motor_id: bus.ping(motor_id) for motor_id in ids})
    latest = snapshots[-1]
    return {
        "success": True,
        "port": resolved,
        "ids": {str(motor_id): ok for motor_id, ok in latest.items()},
        "present": [motor_id for motor_id, ok in latest.items() if ok],
    }


def calibration_path(calibration_id: str = DEFAULT_CALIBRATION_ID) -> Path:
    if not calibration_id or "/" in calibration_id or "\\" in calibration_id or ".." in calibration_id:
        raise ValueError(f"invalid calibration id: {calibration_id!r}")
    return CONFIG_DIR / f"{calibration_id}.json"


def load_leader_calibration(calibration_id: str = DEFAULT_CALIBRATION_ID) -> dict[str, Any]:
    path = calibration_path(calibration_id)
    if not path.is_file():
        raise RuntimeError(f"leader calibration missing: {path}")
    return json.loads(path.read_text())


def write_leader_calibration(payload: dict[str, Any], calibration_id: str = DEFAULT_CALIBRATION_ID) -> Path:
    path = calibration_path(calibration_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_suffix(path.suffix + f".backup.{time.strftime('%Y%m%d-%H%M%S')}")
        path.replace(backup)
    path.write_text(json.dumps(payload, indent=4, sort_keys=True) + "\n")
    return path


def empty_calibration_payload(calibration_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "id": calibration_id,
        "leaders": {},
    }


def _merge_side_calibration(
    calibration_id: str,
    side: LeaderSide,
    side_payload: dict[str, Any],
) -> dict[str, Any]:
    try:
        payload = load_leader_calibration(calibration_id)
    except RuntimeError:
        payload = empty_calibration_payload(calibration_id)
    payload.setdefault("schema_version", 1)
    payload["id"] = calibration_id
    payload.setdefault("leaders", {})
    payload["leaders"][side] = side_payload
    write_leader_calibration(payload, calibration_id)
    return payload


def _same_serial_identity(left: PortIdentity, right: PortIdentity) -> bool:
    if left.key == right.key:
        return True
    try:
        return Path(left.open_path).resolve() == Path(right.open_path).resolve()
    except OSError:
        return left.open_path == right.open_path


def _wrap_delta(raw: int, center: int) -> int:
    delta = (int(raw) - int(center)) % STS3215_RESOLUTION
    if delta > STS3215_RESOLUTION // 2:
        delta -= STS3215_RESOLUTION
    return delta


def _direction(cal: dict[str, Any]) -> int:
    return -1 if int(cal.get("direction", 1)) < 0 else 1


def leader_raw_to_degrees(raw: int, cal: dict[str, Any]) -> float:
    """Map leader body joints to degree-style targets."""
    center = int(cal["center_raw"])
    if cal.get("circular"):
        return _direction(cal) * (_wrap_delta(raw, center) * 360.0) / STS3215_MAX_POSITION

    range_min = int(cal["range_min"])
    range_max = int(cal["range_max"])
    if range_max <= range_min:
        return 0.0
    bounded = min(range_max, max(range_min, int(raw)))
    return _direction(cal) * ((bounded - center) * 360.0) / STS3215_MAX_POSITION


def normalize_leader_raw(raw: int, cal: dict[str, Any]) -> float:
    if cal.get("norm_mode") != "0_100":
        return leader_raw_to_degrees(raw, cal)
    range_min = int(cal["range_min"])
    range_max = int(cal["range_max"])
    if range_max <= range_min:
        return 0.0
    bounded = min(range_max, max(range_min, int(raw)))
    norm = ((bounded - range_min) / (range_max - range_min)) * 100.0
    return 100.0 - norm if _direction(cal) < 0 else norm


def leader_calibration_warnings(
    calibration: dict[str, Any],
    min_body_span: int = 256,
    min_gripper_span: int = 100,
) -> list[str]:
    warnings: list[str] = []
    for side in ("left", "right"):
        side_cal = calibration.get("leaders", {}).get(side, {})
        for joint, cal in side_cal.get("motors", {}).items():
            if cal.get("circular"):
                continue
            span = int(cal.get("range_max", 0)) - int(cal.get("range_min", 0))
            threshold = min_gripper_span if joint == "gripper" else min_body_span
            if span < threshold:
                warnings.append(f"{side} {joint} calibration span is only {span} ticks")
    return warnings


def build_side_calibration(
    side: LeaderSide,
    port_identity: PortIdentity,
    center: dict[int, int],
    mins: dict[int, int],
    maxes: dict[int, int],
) -> dict[str, Any]:
    motors: dict[str, dict[str, Any]] = {}
    for joint, motor_id, norm_mode, circular in leader_joint_specs(side):
        if circular:
            range_min = 0
            range_max = STS3215_MAX_POSITION
        else:
            range_min = int(mins[motor_id])
            range_max = int(maxes[motor_id])
        motors[joint] = {
            "id": motor_id,
            "center_raw": int(center[motor_id]),
            "range_min": range_min,
            "range_max": range_max,
            "norm_mode": norm_mode,
            "circular": bool(circular),
            "direction": 1,
            "target_name": leader_target_name(side, joint),
        }
    return {"port": port_identity.to_json(), "motors": motors}


@dataclass
class ManualSession:
    id: str
    side: LeaderSide
    calibration_id: str
    port_identity: PortIdentity
    ids: tuple[int, ...]
    center: dict[int, int] = field(default_factory=dict)
    mins: dict[int, int] = field(default_factory=dict)
    maxes: dict[int, int] = field(default_factory=dict)
    active: bool = True
    created_at: float = field(default_factory=time.time)

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "side": self.side,
            "calibration_id": self.calibration_id,
            "port": self.port_identity.to_json(),
            "center": self.center,
            "mins": self.mins,
            "maxes": self.maxes,
            "active": self.active,
            "created_at": self.created_at,
        }


class ManualCalibrationManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._session: ManualSession | None = None

    def start(self, side: LeaderSide, calibration_id: str = DEFAULT_CALIBRATION_ID, port: str | None = None) -> dict[str, Any]:
        with self._lock:
            if self._session and self._session.active:
                return {"success": False, "message": "Manual calibration already active", "session": self._session.to_json()}
            port_identity = load_leader_ports()[side] if port is None else PortIdentity(device=port, stable_path=_by_id_for_device(port))
            ids = leader_ids(side)
            with SCSBus(port_identity.open_path) as bus:
                hits = [motor_id for motor_id in ids if bus.ping(motor_id)]
                if len(hits) != len(ids):
                    return {"success": False, "message": f"{side} leader missing IDs", "hits": hits}
                center = bus.read_positions(ids)
                missing = [motor_id for motor_id in ids if motor_id not in center]
                if missing:
                    return {"success": False, "message": f"failed to read IDs {missing}"}
                bus.disable_torque(ids)
            range_ids = [motor_id for _joint, motor_id, _norm, _circular in leader_joint_specs(side)]
            self._session = ManualSession(
                id=str(uuid.uuid4()),
                side=side,
                calibration_id=calibration_id,
                port_identity=port_identity,
                ids=ids,
                center=center,
                mins={motor_id: center[motor_id] for motor_id in range_ids},
                maxes={motor_id: center[motor_id] for motor_id in range_ids},
            )
            return {"success": True, "session": self._session.to_json()}

    def capture_center(self) -> dict[str, Any]:
        with self._lock:
            session = self._require_session()
            with SCSBus(session.port_identity.open_path) as bus:
                center = bus.read_positions(session.ids)
            missing = [motor_id for motor_id in session.ids if motor_id not in center]
            if missing:
                return {"success": False, "message": f"failed to read IDs {missing}"}
            session.center = center
            range_ids = [motor_id for _joint, motor_id, _norm, _circular in leader_joint_specs(session.side)]
            session.mins = {motor_id: center[motor_id] for motor_id in range_ids}
            session.maxes = {motor_id: center[motor_id] for motor_id in range_ids}
            return {"success": True, "session": session.to_json()}

    def sample(self) -> dict[str, Any]:
        with self._lock:
            session = self._require_session()
            if not session.center:
                return {"success": False, "message": "capture center before sampling ranges"}
            with SCSBus(session.port_identity.open_path) as bus:
                positions = bus.read_positions(session.mins.keys())
            self._observe_positions_unlocked(positions)
            return {"success": True, "positions": positions, "session": session.to_json()}

    def observe_positions(self, positions: dict[int, int]) -> None:
        with self._lock:
            self._observe_positions_unlocked(positions)

    def _observe_positions_unlocked(self, positions: dict[int, int]) -> None:
        session = self._session
        if not session or not session.active or not session.center:
            return
        for motor_id, pos in positions.items():
            if motor_id not in session.mins:
                continue
            session.mins[motor_id] = min(session.mins[motor_id], pos)
            session.maxes[motor_id] = max(session.maxes[motor_id], pos)

    def finish(self) -> dict[str, Any]:
        with self._lock:
            session = self._require_session()
            if not session.center:
                return {"success": False, "message": "capture center before finishing"}
            side_payload = build_side_calibration(
                session.side,
                session.port_identity,
                session.center,
                session.mins,
                session.maxes,
            )
            payload = _merge_side_calibration(session.calibration_id, session.side, side_payload)
            session.active = False
            self._session = None
            return {
                "success": True,
                "path": str(calibration_path(session.calibration_id)),
                "calibration": payload,
            }

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            if self._session:
                self._session.active = False
            self._session = None
            return {"success": True}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {"active": bool(self._session and self._session.active), "session": self._session.to_json() if self._session else None}

    def _require_session(self) -> ManualSession:
        if not self._session or not self._session.active:
            raise RuntimeError("no active manual calibration session")
        return self._session


manual_manager = ManualCalibrationManager()


def _side_motor_table(side: LeaderSide):
    from lerobot.motors import Motor, MotorNormMode

    mode_m100 = getattr(MotorNormMode, "RANGE_M100_100")
    mode_0100 = getattr(MotorNormMode, "RANGE_0_100")
    table = {}
    for joint, motor_id, norm_mode, _circular in leader_joint_specs(side):
        table[joint] = Motor(motor_id, "sts3215", mode_0100 if norm_mode == "0_100" else mode_m100)
    return table


def _make_feetech_bus(side: LeaderSide, port: str):
    from lerobot.motors.feetech import FeetechMotorsBus

    return FeetechMotorsBus(port=port, motors=_side_motor_table(side))


def _auto_result_to_side_payload(side: LeaderSide, port_identity: PortIdentity, result: Any) -> dict[str, Any]:
    motors: dict[str, dict[str, Any]] = {}
    for joint, motor_id, norm_mode, circular in leader_joint_specs(side):
        cal = result.calibration[joint]
        if circular:
            range_min = 0
            range_max = STS3215_MAX_POSITION
            center = int(result.current_positions.get(joint, STS3215_MAX_POSITION // 2))
        else:
            range_min = int(cal.range_min)
            range_max = int(cal.range_max)
            center = int(result.mids.get(joint, (range_min + range_max) // 2))
        motors[joint] = {
            "id": motor_id,
            "norm_mode": norm_mode,
            "center_raw": center,
            "range_min": range_min,
            "range_max": range_max,
            "circular": bool(circular),
            "direction": 1,
            "target_name": leader_target_name(side, joint),
        }
    return {"port": port_identity.to_json(), "motors": motors}


def run_powered_auto_calibration(
    side: LeaderSide,
    *,
    calibration_id: str = DEFAULT_CALIBRATION_ID,
    port: str | None = None,
    stop_requested: Any | None = None,
    status_callback: Any | None = None,
    position_callback: Any | None = None,
) -> dict[str, Any]:
    from .so101_auto_calibration import run_so101_auto_calibration

    port_identity = load_leader_ports()[side] if port is None else PortIdentity(device=port, stable_path=_by_id_for_device(port))
    bus = _make_feetech_bus(side, port_identity.open_path)
    bus.connect(handshake=False)
    try:
        result = run_so101_auto_calibration(
            bus,
            status_callback=status_callback,
            position_callback=position_callback,
            stop_requested=stop_requested,
        )
    finally:
        try:
            bus.disconnect()
        except Exception:
            logger.debug("Failed to disconnect leader auto-calibration bus", exc_info=True)
    side_payload = _auto_result_to_side_payload(side, port_identity, result)
    payload = _merge_side_calibration(calibration_id, side, side_payload)
    return {"success": True, "path": str(calibration_path(calibration_id)), "calibration": payload}


@dataclass
class AutoCalibrationStatus:
    active: bool = False
    status: str = "idle"
    side: LeaderAutoSide | None = None
    calibration_id: str = DEFAULT_CALIBRATION_ID
    message: str = ""
    error: str | None = None
    result: dict[str, Any] | None = None
    current_positions: dict[str, dict[str, int]] = field(default_factory=dict)


class AutoCalibrationManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.status = AutoCalibrationStatus()

    def start(
        self,
        side: LeaderAutoSide,
        calibration_id: str = DEFAULT_CALIBRATION_ID,
        port: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if self.status.active:
                return {"success": False, "message": "Auto calibration already active", "status": asdict(self.status)}
            self._stop.clear()
            self.status = AutoCalibrationStatus(
                active=True,
                status="running",
                side=side,
                calibration_id=calibration_id,
                message="Starting leader auto-calibration",
            )
            self._thread = threading.Thread(
                target=self._worker,
                args=(side, calibration_id, port),
                name="nori-leader-auto-calibration",
                daemon=True,
            )
            self._thread.start()
            return {"success": True, "status": asdict(self.status)}

    def _worker(self, side: LeaderAutoSide, calibration_id: str, port: str | None) -> None:
        def set_message(message: str) -> None:
            with self._lock:
                self.status.message = message

        def set_positions(current_side: LeaderSide, positions: dict[str, int]) -> None:
            with self._lock:
                side_positions = self.status.current_positions.setdefault(current_side, {})
                for joint, position in positions.items():
                    side_positions[joint] = int(position)

        try:
            sides: list[LeaderSide] = ["left", "right"] if side == "both" else [side]
            results: dict[str, Any] = {}
            for current_side in sides:
                if self._stop.is_set():
                    break
                with self._lock:
                    self.status.message = f"Starting {current_side} leader auto-calibration"
                result = run_powered_auto_calibration(
                    current_side,
                    calibration_id=calibration_id,
                    port=port,
                    stop_requested=self._stop.is_set,
                    status_callback=lambda message, current_side=current_side: set_message(
                        f"{current_side}: {message.replace('SO-101', 'Nori L2 leader')}"
                    ),
                    position_callback=lambda positions, current_side=current_side: set_positions(
                        current_side,
                        positions,
                    ),
                )
                results[current_side] = result
            with self._lock:
                self.status.active = False
                self.status.status = "completed"
                self.status.message = "Auto calibration completed"
                self.status.result = results
        except Exception as exc:
            with self._lock:
                self.status.active = False
                self.status.status = "error" if not self._stop.is_set() else "cancelled"
                self.status.message = "Auto calibration stopped" if self._stop.is_set() else "Auto calibration failed"
                self.status.error = str(exc) if not self._stop.is_set() else None

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=2.0)
        return {"success": True, "status": self.get_status()}

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            return asdict(self.status)

    def live_frame(self, *, port: str | None, calibration_id: str) -> dict[str, Any] | None:
        with self._lock:
            active = self.status.active
            positions_by_side = {
                side: dict(positions)
                for side, positions in self.status.current_positions.items()
            }
        # Only serve the auto worker's readings while a calibration session is
        # actively running (it owns the bus then, so the shared live reader must
        # not also open it). Once the session ends, fall through to None so
        # read_shared_live_positions does a real live bus read — otherwise the
        # last-read positions get served forever with a deceptively fresh
        # updated_at, and the live view freezes on a stale frame.
        if not active:
            return None
        raw_positions: dict[int, int] = {}
        for side, positions in positions_by_side.items():
            if side not in ("left", "right"):
                continue
            joint_ids = expected_joint_ids(side)  # type: ignore[arg-type]
            for joint, position in positions.items():
                motor_id = joint_ids.get(joint)
                if motor_id is not None:
                    raw_positions[motor_id] = int(position)
        if not raw_positions:
            return None
        try:
            calibration = load_leader_calibration(calibration_id)
        except RuntimeError:
            calibration = {}
        return _format_shared_live_positions(raw_positions, port=port or "", calibration=calibration)


auto_manager = AutoCalibrationManager()


class DualLeaderReader:
    def __init__(self, calibration: dict[str, Any]):
        self.left = calibration["leaders"]["left"]
        self.right = calibration["leaders"]["right"]
        self.left_identity = PortIdentity.from_json(self.left["port"])
        self.right_identity = PortIdentity.from_json(self.right["port"])
        self.shared_bus = _same_serial_identity(self.left_identity, self.right_identity)
        self.left_bus: SCSBus | None = None
        self.right_bus: SCSBus | None = None

    def open(self) -> None:
        self.left_bus = SCSBus(self.left_identity.open_path)
        self.left_bus.open()
        if self.shared_bus:
            self.right_bus = self.left_bus
            self.left_bus.disable_torque(self._side_ids("left") + self._side_ids("right"))
            return
        self.right_bus = SCSBus(self.right_identity.open_path)
        try:
            self.right_bus.open()
            self.left_bus.disable_torque(self._side_ids("left"))
            self.right_bus.disable_torque(self._side_ids("right"))
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        if self.right_bus is not None and self.right_bus is not self.left_bus:
            self.right_bus.close()
        if self.left_bus is not None:
            self.left_bus.close()
        self.left_bus = None
        self.right_bus = None

    def _side_ids(self, side: LeaderSide) -> tuple[int, ...]:
        motors = self.left["motors"] if side == "left" else self.right["motors"]
        return tuple(int(cal["id"]) for cal in motors.values())

    def _read_side_targets(self, side: LeaderSide, bus: SCSBus) -> dict[str, float]:
        side_calibration = self.left if side == "left" else self.right
        positions = bus.read_positions(int(cal["id"]) for cal in side_calibration["motors"].values())
        targets: dict[str, float] = {}
        for joint, cal in side_calibration["motors"].items():
            motor_id = int(cal["id"])
            if motor_id not in positions:
                continue
            targets[_target_name_from_cal(side, joint, cal)] = normalize_leader_raw(positions[motor_id], cal)
        return targets

    def read_targets(self) -> dict[str, float]:
        if self.left_bus is None or self.right_bus is None:
            raise RuntimeError("leader reader is not open")
        targets = self._read_side_targets("left", self.left_bus)
        targets.update(self._read_side_targets("right", self.right_bus))
        return targets


def read_live_targets(calibration_id: str = DEFAULT_CALIBRATION_ID) -> dict[str, Any]:
    calibration = load_leader_calibration(calibration_id)
    warnings = leader_calibration_warnings(calibration)
    reader = DualLeaderReader(calibration)
    reader.open()
    try:
        return {"success": True, "targets": reader.read_targets(), "warnings": warnings}
    finally:
        reader.close()


class SharedLivePositionManager:
    """Persistent shared-bus reader for UI telemetry."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._bus: SCSBus | None = None
        self._port: str | None = None
        self._calibration_id: str | None = None
        self._calibration: dict[str, Any] = {}
        self._missing_until: dict[int, float] = {}
        self._miss_counts: dict[int, int] = {}

    def close(self) -> None:
        with self._lock:
            self._close_unlocked()

    def _close_unlocked(self) -> None:
        if self._bus is not None:
            try:
                self._bus.close()
            finally:
                self._bus = None
        self._port = None
        self._calibration_id = None
        self._calibration = {}
        self._missing_until = {}
        self._miss_counts = {}

    def _ensure_open(self, port: str, calibration_id: str) -> None:
        if self._bus is not None and self._port == port and self._calibration_id == calibration_id:
            return
        self._close_unlocked()
        try:
            self._calibration = load_leader_calibration(calibration_id)
        except RuntimeError:
            self._calibration = {}
        self._bus = SCSBus(port, timeout=LIVE_READ_TIMEOUT)
        self._bus.open()
        self._port = port
        self._calibration_id = calibration_id

    def _ids_for_live_read(self, now: float) -> tuple[int, ...]:
        healthy: list[int] = []
        due_missing: list[int] = []
        for motor_id in ALL_LEADER_IDS:
            if self._missing_until.get(motor_id, 0.0) > now:
                continue
            if self._miss_counts.get(motor_id, 0) > 0:
                due_missing.append(motor_id)
            else:
                healthy.append(motor_id)
        # Retry at most one missing motor per frame so an unplugged arm cannot
        # spend the entire live-read budget timing out.
        return tuple(healthy + due_missing[:1])

    def _update_missing_backoff(self, attempted_ids: Iterable[int], raw_positions: dict[int, int], now: float) -> None:
        for motor_id in attempted_ids:
            if motor_id in raw_positions:
                self._miss_counts.pop(motor_id, None)
                self._missing_until.pop(motor_id, None)
                continue
            misses = self._miss_counts.get(motor_id, 0) + 1
            self._miss_counts[motor_id] = misses
            delay = min(LIVE_MISSING_RETRY_MAX_SEC, LIVE_MISSING_RETRY_BASE_SEC * (2 ** min(misses - 1, 3)))
            self._missing_until[motor_id] = now + delay

    def read(self, *, port: str | None = None, calibration_id: str = DEFAULT_CALIBRATION_ID) -> dict[str, Any]:
        resolved = port or _port_for_side("left")
        with self._lock:
            try:
                self._ensure_open(resolved, calibration_id)
                if self._bus is None:
                    raise RuntimeError("leader live reader failed to open")
                now = time.monotonic()
                read_ids = self._ids_for_live_read(now)
                raw_positions = self._bus.read_positions(read_ids) if read_ids else {}
                self._update_missing_backoff(read_ids, raw_positions, now)
                manual_manager.observe_positions(raw_positions)
                return _format_shared_live_positions(
                    raw_positions,
                    port=resolved,
                    calibration=self._calibration,
                )
            except Exception:
                self._close_unlocked()
                raise


def _format_shared_live_positions(
    raw_positions: dict[int, int],
    *,
    port: str,
    calibration: dict[str, Any],
) -> dict[str, Any]:
    leaders: dict[str, Any] = {}
    for side in ("left", "right"):
        side_motors: dict[str, Any] = {}
        side_cal = calibration.get("leaders", {}).get(side, {}).get("motors", {})
        for joint, motor_id, _norm_mode, _circular in leader_joint_specs(side):  # type: ignore[arg-type]
            raw = raw_positions.get(motor_id)
            cal = side_cal.get(joint)
            target = normalize_leader_raw(raw, cal) if raw is not None and cal else None
            side_motors[joint] = {
                "id": motor_id,
                "raw": raw,
                "target": target,
                "ok": raw is not None,
            }
        leaders[side] = {
            "visible": sum(1 for row in side_motors.values() if row["ok"]),
            "motors": side_motors,
        }

    return {
        "success": True,
        "connected": True,
        "reason": None,
        "port": port,
        "leaders": leaders,
        "updated_at": time.time(),
    }


def _disconnected_live_frame(*, port: str, reason: str) -> dict[str, Any]:
    """A well-formed live frame for when no leader hardware is reachable.

    Returned instead of raising so the UI's live poll gets a clean 200
    "nothing connected" state rather than a stream of 400s whenever the arms
    aren't plugged in or ports haven't been configured yet.
    """
    frame = _format_shared_live_positions({}, port=port, calibration={})
    frame["connected"] = False
    frame["reason"] = reason
    return frame


shared_live_manager = SharedLivePositionManager()


def read_shared_live_positions(
    *,
    port: str | None = None,
    calibration_id: str = DEFAULT_CALIBRATION_ID,
) -> dict[str, Any]:
    auto_frame = auto_manager.live_frame(port=port, calibration_id=calibration_id)
    if auto_frame is not None:
        return auto_frame
    try:
        resolved = port or _port_for_side("left")
    except RuntimeError as exc:
        # Ports not configured yet — expected before hardware setup.
        return _disconnected_live_frame(port="", reason=str(exc))
    try:
        return shared_live_manager.read(port=resolved, calibration_id=calibration_id)
    except (OSError, RuntimeError) as exc:
        # Serial port present but unreadable (arm unplugged / busy / missing driver).
        return _disconnected_live_frame(port=resolved, reason=str(exc))


def close_shared_live_reader() -> dict[str, Any]:
    shared_live_manager.close()
    return {"success": True}


def list_directions(calibration_id: str = DEFAULT_CALIBRATION_ID) -> dict[str, Any]:
    payload = load_leader_calibration(calibration_id)
    out: dict[str, dict[str, str]] = {}
    for side in ("left", "right"):
        out[side] = {}
        motors = payload.get("leaders", {}).get(side, {}).get("motors", {})
        for joint, cal in motors.items():
            out[side][joint] = "inverted" if int(cal.get("direction", 1)) < 0 else "normal"
    return {"success": True, "directions": out}


def set_direction(
    side: LeaderSide,
    joint: str,
    *,
    mode: DirectionMode | None = None,
    calibration_id: str = DEFAULT_CALIBRATION_ID,
) -> dict[str, Any]:
    payload = load_leader_calibration(calibration_id)
    motors = payload["leaders"][side]["motors"]
    if joint not in motors:
        raise KeyError(joint)
    previous = "inverted" if int(motors[joint].get("direction", 1)) < 0 else "normal"
    next_mode = mode or ("normal" if previous == "inverted" else "inverted")
    motors[joint]["direction"] = -1 if next_mode == "inverted" else 1
    write_leader_calibration(payload, calibration_id)
    return {"success": True, "side": side, "joint": joint, "previous": previous, "direction": next_mode}


def _json_print(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def _read_key_nonblocking() -> str | None:
    if not sys.stdin.isatty():
        return None
    old = termios.tcgetattr(sys.stdin)
    try:
        tty.setcbreak(sys.stdin.fileno())
        ready, _, _ = select.select([sys.stdin], [], [], 0)
        if ready:
            return sys.stdin.read(1)
    finally:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
    return None


def _wizard_set_ids(side: LeaderSide, port: str, scan_max: int) -> None:
    print(f"Setting {side} leader IDs on {port}")
    for joint, motor_id in expected_joint_ids(side).items():
        input(f"Connect ONLY {side} {joint}, then press ENTER to set ID {motor_id}...")
        _json_print(set_connected_servo_id(target_id=motor_id, port=port, scan_max=scan_max))


def _manual_cli(side: LeaderSide, calibration_id: str, port: str | None) -> None:
    print(f"Manual calibration for {side}. Move the arm to center, then press ENTER.")
    result = manual_manager.start(side, calibration_id, port)
    _json_print(result)
    if not result.get("success"):
        return
    input()
    _json_print(manual_manager.capture_center())
    print("Move the arm through usable ranges. Press ENTER to stop sampling.")
    while True:
        if _read_key_nonblocking() == "\n":
            break
        manual_manager.sample()
        time.sleep(0.05)
    _json_print(manual_manager.finish())


def _command_plan(_args: argparse.Namespace) -> None:
    _json_print(
        {
            "left": expected_joint_ids("left"),
            "right": expected_joint_ids("right"),
            "default_calibration_id": DEFAULT_CALIBRATION_ID,
        }
    )


def _command_ports(args: argparse.Namespace) -> None:
    _json_print(auto_save_detected_ports() if args.save else {"success": True, "probes": probe_leader_ports(include_all=args.all)})


def _command_set_id(args: argparse.Namespace) -> None:
    port = args.port or _port_for_side(args.side)
    if args.wizard:
        _wizard_set_ids(args.side, port, args.scan_max)
        return
    target_id = args.target_id or expected_joint_ids(args.side)[args.joint]
    _json_print(set_connected_servo_id(target_id=target_id, port=port, scan_max=args.scan_max))


def _command_identify(args: argparse.Namespace) -> None:
    _json_print(identify_leader_motors(port=args.port, all_ids=args.all_ids, cycles=args.cycles))


def _command_calibrate(args: argparse.Namespace) -> None:
    sides: list[LeaderSide] = ["left", "right"] if args.side == "both" else [args.side]
    if args.mode == "manual":
        for side in sides:
            _manual_cli(side, args.calibration_id, args.port)
        return
    for side in sides:
        _json_print(run_powered_auto_calibration(side, calibration_id=args.calibration_id, port=args.port))


def _command_directions(args: argparse.Namespace) -> None:
    if args.side and args.joint:
        _json_print(set_direction(args.side, args.joint, mode=args.mode, calibration_id=args.calibration_id))
    else:
        _json_print(list_directions(args.calibration_id))


def _command_print_targets(args: argparse.Namespace) -> None:
    while True:
        _json_print(read_live_targets(args.calibration_id))
        if args.once:
            break
        time.sleep(args.period)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Nori L2 dual leader setup")
    sub = parser.add_subparsers(dest="command", required=True)

    plan = sub.add_parser("plan")
    plan.set_defaults(func=_command_plan)

    ports = sub.add_parser("ports")
    ports.add_argument("--save", action="store_true")
    ports.add_argument("--all", action="store_true")
    ports.set_defaults(func=_command_ports)

    set_id = sub.add_parser("set-id")
    set_id.add_argument("--wizard", action="store_true")
    set_id.add_argument("--side", choices=["left", "right"], required=True)
    set_id.add_argument("--joint", choices=[joint for joint, _mode, _circular in JOINT_LAYOUT])
    set_id.add_argument("--target-id", type=int)
    set_id.add_argument("--port")
    set_id.add_argument("--scan-max", type=int, default=253)
    set_id.set_defaults(func=_command_set_id)

    identify = sub.add_parser("identify")
    identify.add_argument("--port")
    identify.add_argument("--all-ids", action="store_true")
    identify.add_argument("--cycles", type=int, default=1)
    identify.set_defaults(func=_command_identify)

    calibrate = sub.add_parser("calibrate")
    calibrate.add_argument("--mode", choices=["manual", "auto"], required=True)
    calibrate.add_argument("--side", choices=["left", "right", "both"], required=True)
    calibrate.add_argument("--calibration-id", default=DEFAULT_CALIBRATION_ID)
    calibrate.add_argument("--port")
    calibrate.set_defaults(func=_command_calibrate)

    directions = sub.add_parser("directions")
    directions.add_argument("--calibration-id", default=DEFAULT_CALIBRATION_ID)
    directions.add_argument("--side", choices=["left", "right"])
    directions.add_argument("--joint", choices=[joint for joint, _mode, _circular in JOINT_LAYOUT])
    directions.add_argument("--mode", choices=["normal", "inverted"])
    directions.set_defaults(func=_command_directions)

    targets = sub.add_parser("print-targets")
    targets.add_argument("--calibration-id", default=DEFAULT_CALIBRATION_ID)
    targets.add_argument("--period", type=float, default=0.1)
    targets.add_argument("--once", action="store_true")
    targets.set_defaults(func=_command_print_targets)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
