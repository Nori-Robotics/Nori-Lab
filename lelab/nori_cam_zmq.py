# NORI: Additive file. FULL-QUALITY camera frames for cloud inference (option "B").
#
# DEPRECATED (2026-07-21) — superseded by the robot-side policy streamer
# (NoriTelop rpi5/media/policy_streamer.py, docs/protocol_streaming_design.md).
# This module PULLS by SUBscribing to the Pi's camera sockets over the LAN,
# which (a) is dead on customer-provisioned units (NORI_CAM_BIND=127.0.0.1),
# (b) carries no capture timestamps (staleness is judged by arrival), and
# (c) delivers no calibration. The streamer PUSHES frames with capture mono_ts
# and the robot.json preamble, works under the customer bind posture, and has
# an in-session control plane. New work goes to the policy-stream receiver
# (see cloud_inference/STREAM_INTEGRATION_PLAN.md); this path remains only as
# a dev-bench fallback and warns when activated.
#
# WHY. Until now the cloud VLA was fed frames the browser cropped out of the ONE
# composite WebRTC track: 4 cameras tiled into a single H264 frame that an ABR loop
# degrades to 480p or even 240p under load — so each camera reaches the model as a
# ~quarter-frame, heavily compressed. Meanwhile the RECORDING path (the datasets the
# model is trained on) subscribes to a completely different, much better source.
#
# The Pi's image_server.py is the SINGLE capture layer: it opens each camera ONCE and
# publishes it on a per-camera ZeroMQ PUB socket as full-resolution MJPEG. Consumers
# subscribe independently:
#     teleop  -> webrtc_robot.py SUBs all cams, composites 2x2, H264 (the WAN view)
#     record  -> the laptop SUBs each cam -> LeRobotDataset  (training data)
# This module makes CLOUD INFERENCE a third subscriber of that same stream, so the
# model sees frames of the same kind/quality it was trained on instead of the
# degraded composite. No Pi-side change is required — we just subscribe.
#
# Contract (image_server.py): tcp://<host>:(NORI_CAM_BASE_PORT + index_in_cameras.json)
# wire format  b"<name> <capture_monotonic_seconds>\n" + <jpeg_bytes>
# The header carries the camera NAME, so we verify the port->role mapping at runtime
# instead of trusting the configured order blindly.
#
# LAN-only: ZMQ is not the WAN teleop path. This is for a laptop on the robot's
# network (exactly where recording and local rollout already run). If it isn't
# reachable, the rollout transparently falls back to the browser's composite crops.

import base64
import logging
import os
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_BASE_PORT = 5555
# A frame older than this is treated as missing (camera died / bridge restarted)
# rather than silently feeding the policy a frozen scene.
STALE_AFTER_S = 1.0
RECV_POLL_MS = 200


def _env_roles() -> Optional[list[str]]:
    """Camera roles in cameras.json ORDER (that order fixes the port numbers).
    e.g. NORI_CAM_ROLES=left_wrist,right_wrist,overhead,front"""
    raw = (os.environ.get("NORI_CAM_ROLES") or "").strip()
    parsed = [r.strip() for r in raw.split(",") if r.strip()]
    return parsed or None


def zmq_host() -> Optional[str]:
    """Robot IP/host publishing the camera sockets. Unset -> feature off."""
    h = (os.environ.get("NORI_CAM_ZMQ_HOST") or "").strip()
    return h or None


def role_of(view_key: str) -> str:
    """'observation.images.overhead' -> 'overhead' (the ZMQ camera name)."""
    return view_key.rsplit(".", 1)[-1]


class ZmqCameraSource:
    """Latest-wins subscriber to the Pi's per-camera MJPEG PUB sockets.

    One SUB socket per camera with CONFLATE=1 so we always hold the FRESHEST frame
    (no backlog to drain — stale frames are worse than no frames for a control
    loop). A daemon thread per camera keeps `_latest[role]` current; the rollout
    reads it with no blocking."""

    def __init__(self, host: str, roles: list[str], base_port: int = DEFAULT_BASE_PORT):
        import zmq  # lazy: lelab must import fine without pyzmq installed

        self.host = host
        self.roles = list(roles)
        self.base_port = int(base_port)
        self._latest: dict[str, tuple[bytes, float]] = {}  # role -> (jpeg, recv_monotonic)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._ctx = zmq.Context.instance()
        self._threads: list[threading.Thread] = []
        self.name_mismatch: dict[str, str] = {}  # configured role -> name seen on the wire
        self.frames_seen = 0

        for i, role in enumerate(self.roles):
            port = self.base_port + i
            t = threading.Thread(target=self._rx, args=(role, port), name=f"zmqcam-{role}", daemon=True)
            t.start()
            self._threads.append(t)
        logger.info("[CAM-ZMQ] subscribing %s -> %s ports %d..%d",
                    self.roles, host, self.base_port, self.base_port + len(self.roles) - 1)

    def _rx(self, role: str, port: int) -> None:
        import zmq

        sock = self._ctx.socket(zmq.SUB)
        sock.setsockopt(zmq.SUBSCRIBE, b"")
        sock.setsockopt(zmq.CONFLATE, 1)  # keep only the newest frame
        sock.setsockopt(zmq.LINGER, 0)
        sock.connect(f"tcp://{self.host}:{port}")
        poller = zmq.Poller()
        poller.register(sock, zmq.POLLIN)
        try:
            while not self._stop.is_set():
                if not dict(poller.poll(RECV_POLL_MS)).get(sock):
                    continue
                data = sock.recv(zmq.NOBLOCK)
                head, _, jpeg = data.partition(b"\n")
                if not jpeg:
                    continue
                # The header names the camera — verify the port->role mapping so a
                # mis-ordered NORI_CAM_ROLES surfaces instead of silently feeding
                # the policy the WRONG camera.
                wire_name = head.split(b" ", 1)[0].decode(errors="replace")
                if wire_name and wire_name != role:
                    self.name_mismatch[role] = wire_name
                with self._lock:
                    self._latest[role] = (jpeg, time.monotonic())
                    self.frames_seen += 1
        except Exception as e:
            logger.warning("[CAM-ZMQ] %s receiver stopped: %s", role, e)
        finally:
            try:
                sock.close(0)
            except Exception:
                pass

    def latest_jpeg(self, role: str) -> Optional[bytes]:
        with self._lock:
            got = self._latest.get(role)
        if not got:
            return None
        jpeg, ts = got
        return None if (time.monotonic() - ts) > STALE_AFTER_S else jpeg

    def frames_b64(self, view_keys: list[str]) -> Optional[dict[str, str]]:
        """base64 JPEG per requested view, or None if ANY view is missing/stale —
        the caller then falls back rather than sending the model a partial obs."""
        out: dict[str, str] = {}
        for vk in view_keys:
            jpeg = self.latest_jpeg(role_of(vk))
            if jpeg is None:
                return None
            out[vk] = base64.b64encode(jpeg).decode()
        return out

    def status(self) -> dict:
        with self._lock:
            fresh = {r: round(time.monotonic() - ts, 2) for r, (_, ts) in self._latest.items()}
        return {
            "host": self.host, "base_port": self.base_port, "roles": self.roles,
            "age_s": fresh, "frames_seen": self.frames_seen,
            "name_mismatch": self.name_mismatch or None,
        }

    def close(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=1.0)


def build_source(view_keys: list[str]) -> Optional[ZmqCameraSource]:
    """Create a source for the rollout's views, or None (feature off / unavailable).
    Never raises: a missing pyzmq, a bad host, or an unset NORI_CAM_ZMQ_HOST all
    degrade to the browser-composite path."""
    host = zmq_host()
    if not host:
        return None
    roles = _env_roles()
    if not roles:
        # Without the cameras.json order we can't map roles->ports reliably.
        logger.warning("[CAM-ZMQ] NORI_CAM_ZMQ_HOST set but NORI_CAM_ROLES is not "
                       "(need cameras.json order) — staying on the composite path")
        return None
    missing = [role_of(v) for v in view_keys if role_of(v) not in roles]
    if missing:
        logger.warning("[CAM-ZMQ] view(s) %s not in NORI_CAM_ROLES %s — composite path", missing, roles)
        return None
    try:
        base = int(os.environ.get("NORI_CAM_BASE_PORT", str(DEFAULT_BASE_PORT)))
        logger.warning("[CAM-ZMQ] DEPRECATED direct-SUB camera path active — "
                       "superseded by the robot's policy streamer (see "
                       "cloud_inference/STREAM_INTEGRATION_PLAN.md)")
        return ZmqCameraSource(host, roles, base_port=base)
    except Exception as e:  # pyzmq missing, bad host, etc.
        logger.warning("[CAM-ZMQ] unavailable (%s) — falling back to the composite path", e)
        return None
