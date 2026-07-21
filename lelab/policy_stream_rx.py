# NORI: Additive file. Laptop-side receiver for the robot's policy stream
# (NoriTelop rpi5/media/policy_streamer.py; contract in that repo's
# docs/protocol_streaming_design.md §3.3, plan in
# cloud_inference/STREAM_INTEGRATION_PLAN.md §1).
#
# The robot connects OUT to us and pushes 4-byte big-endian length-prefixed
# blobs over TCP: blob 0 is a JSON preamble ({"kind":"policy_stream_meta",
# serial, mono_epoch, wall_epoch, cameras, fps, calibration|null}); every later
# blob is one camera payload verbatim — b"<name> <capture_monotonic_seconds>\n"
# + <jpeg> at sensor quality. This replaces the DEPRECATED direct-SUB path
# (nori_cam_zmq.py): it works under the customer bind posture (the Pi SUBs its
# own loopback sockets and pushes), carries capture timestamps end to end, and
# delivers the robot's calibration in the preamble.
#
# The v1 laptop sink has NO auth (NoriTelop §9 open question), so the exposure
# is bounded structurally instead:
#   * exactly ONE connection is ever accepted, and only inside a short arming
#     window after open() — a rollout arms us immediately before telling the
#     robot to dial, so the listener is never idling open;
#   * the preamble must parse, be the right kind, and carry the serial of the
#     robot this session is paired with — anything else is dropped loudly;
#   * blob sizes are capped so garbage can't balloon memory.
# Residual risk: a LAN host that knows the window, fakes the paired serial, and
# races the real robot. Accepted for v1; real sink auth tracks with NoriTelop.
#
# Staleness is judged from CAPTURE time, not arrival. Frame timestamps are
# Pi-monotonic; we anchor them by recording our own monotonic clock when the
# preamble arrives (offset = local_mono - preamble.mono_epoch, LAN transit
# ~instant), so a frame's age is local_mono_now - (mono_ts + offset). No wall
# clocks involved — NTP skew between Pi and laptop never enters.
#
# Interface parity with the deprecated ZmqCameraSource ON PURPOSE
# (frames_b64 / status / close), so nori_rollout.py swaps sources without
# changing the consumer seam. frames_b64 is all-or-nothing: a stale or missing
# view returns None and the caller falls back (visibly) rather than sending the
# model a partial observation.

import base64
import json
import logging
import os
import socket
import struct
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# One frame every 50 ms at the streamer's default 20 fps; 2 s of silence means
# the stream is gone (the robot's own silence watchdog fires at ~5 s). A stale
# view reads as MISSING, never served as live.
STALE_AFTER_S = 2.0
# The arming window: how long after open() the robot may dial in. start() on
# the robot side can legitimately take ~8 s (sink connect + preamble through
# the bridge relay), so leave margin beyond that.
ARM_WINDOW_S = 30.0
# Blob cap. Sensor JPEGs are tens of KB; 8 MB is far beyond any real frame and
# exists so a garbage length prefix can't allocate unbounded memory.
MAX_BLOB = 8 * 1024 * 1024
PREAMBLE_KIND = "policy_stream_meta"


def role_of(view_key: str) -> str:
    """'observation.images.overhead' -> 'overhead' (same rule as the deprecated
    ZMQ source, so view keys stay interchangeable at the consumer seam)."""
    return view_key.rsplit(".", 1)[-1]


def _calib_path() -> Path:
    return Path(os.environ.get("NORI_STREAM_CALIB_PATH",
                               str(Path.home() / ".nori_robot_calib.json")))


class StreamListener:
    """Accepts ONE policy-stream connection and serves latest-wins frames.

    Lifecycle: open() binds+arms, the robot dials in, frames flow, close()
    tears down. Not a daemon — one listener per rollout session. Nothing here
    ever raises into the rollout: failures surface as status()/None and the
    caller falls back."""

    def __init__(self, expected_serial: str, host: str = "", port: int = 0,
                 arm_window_s: float = ARM_WINDOW_S,
                 stale_after_s: float = STALE_AFTER_S):
        self.expected_serial = str(expected_serial)
        self.host = host or "0.0.0.0"
        self.port = int(port)
        self.arm_window_s = float(arm_window_s)
        self.stale_after_s = float(stale_after_s)

        self._srv: Optional[socket.socket] = None
        self._conn: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # preamble-derived state
        self.meta: Optional[dict] = None
        self.calibration: Optional[dict] = None
        self._mono_offset: Optional[float] = None  # local_mono - pi_mono
        # per-camera latest-wins: name -> (jpeg bytes, capture_local_mono)
        self._latest: dict = {}

        # observability (mirrors the deprecated source's honest-counters idiom)
        self.frames_seen = 0
        self.refused_conns = 0
        self.error: Optional[str] = None
        self.connected = False
        self._accepted_once = False

    # ---- lifecycle ----------------------------------------------------
    def open(self) -> tuple[str, int]:
        """Bind + arm. Returns (host, port) to hand to the robot as `target`."""
        srv = socket.socket()
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((self.host, self.port))
        srv.listen(2)                    # backlog >1 so extras can be REFUSED, not ignored
        srv.settimeout(0.5)              # bounded accept so close() is honored
        self._srv = srv
        self.port = srv.getsockname()[1]
        self._thread = threading.Thread(target=self._run, name="policy-stream-rx",
                                        daemon=True)
        self._thread.start()
        logger.info("[STREAM-RX] armed on %s:%d for serial=%s (window %.0fs)",
                    self.host, self.port, self.expected_serial, self.arm_window_s)
        return self.host, self.port

    def close(self) -> None:
        self._stop.set()
        for s in (self._conn, self._srv):
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass
        if self._thread is not None:
            self._thread.join(timeout=3.0)
        with self._lock:
            self.connected = False

    # ---- consumer seam (parity with the deprecated ZmqCameraSource) ----
    def frames_b64(self, view_keys: list) -> Optional[dict]:
        """base64 JPEG per requested view, or None if ANY view is missing or
        stale — the caller then falls back rather than sending a partial obs."""
        now = time.monotonic()
        out: dict = {}
        with self._lock:
            for vk in view_keys:
                got = self._latest.get(role_of(vk))
                if got is None:
                    return None
                jpeg, cap_mono = got
                if now - cap_mono > self.stale_after_s:
                    return None
                out[vk] = base64.b64encode(jpeg).decode()
        return out

    def status(self) -> dict:
        now = time.monotonic()
        with self._lock:
            ages = {n: round(now - cap, 2) for n, (_, cap) in self._latest.items()}
            return {
                "armed": not self._stop.is_set() and not self._accepted_once,
                "connected": self.connected,
                "serial": (self.meta or {}).get("serial"),
                "preamble_received": self.meta is not None,
                "calibration_present": self.calibration is not None,
                "cameras": (self.meta or {}).get("cameras"),
                "age_s": ages,
                "frames_seen": self.frames_seen,
                "refused_conns": self.refused_conns,
                "error": self.error,
                "host": self.host, "port": self.port,
            }

    # ---- internals -----------------------------------------------------
    def _run(self) -> None:
        try:
            self._accept_and_read()
        except Exception:
            # A receiver bug must never take the rollout down — same guarded-
            # thread rule the robot's streamer follows.
            logger.exception("[STREAM-RX] receiver thread died")
            with self._lock:
                self.error = self.error or "receiver thread died"
                self.connected = False

    def _accept_and_read(self) -> None:
        deadline = time.monotonic() + self.arm_window_s
        conn = None
        while not self._stop.is_set() and conn is None:
            if time.monotonic() > deadline:
                with self._lock:
                    self.error = "arming window expired (robot never connected)"
                logger.warning("[STREAM-RX] %s", self.error)
                return
            try:
                conn, addr = self._srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return  # closed under us
        if conn is None:
            return
        self._conn = conn
        self._accepted_once = True
        conn.settimeout(0.5)
        logger.info("[STREAM-RX] connection from %s", addr)

        # From here on, EXACTLY this one connection: refuse any others loudly
        # instead of leaving them in the backlog looking half-open.
        refuser = threading.Thread(target=self._refuse_extras, daemon=True,
                                   name="policy-stream-refuse")
        refuser.start()

        # Blob 0 must be a valid preamble from the paired robot, else drop.
        blob = self._read_blob(conn)
        if blob is None or not self._take_preamble(blob):
            conn.close()
            with self._lock:
                self.connected = False
            return
        with self._lock:
            self.connected = True
        while not self._stop.is_set():
            blob = self._read_blob(conn)
            if blob is None:
                break
            self._take_frame(blob)
        with self._lock:
            self.connected = False
        logger.info("[STREAM-RX] stream ended (%s)", self.error or "peer closed")

    def _refuse_extras(self) -> None:
        while not self._stop.is_set():
            try:
                extra, addr = self._srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with self._lock:
                self.refused_conns += 1
            logger.warning("[STREAM-RX] refused second connection from %s", addr)
            extra.close()

    def _read_blob(self, conn: socket.socket) -> Optional[bytes]:
        head = self._read_n(conn, 4)
        if head is None:
            return None
        (length,) = struct.unpack(">I", head)
        if length == 0 or length > MAX_BLOB:
            with self._lock:
                self.error = f"bad blob length {length} — dropping connection"
            logger.warning("[STREAM-RX] %s", self.error)
            return None
        return self._read_n(conn, length)

    def _read_n(self, conn: socket.socket, n: int) -> Optional[bytes]:
        buf = b""
        while len(buf) < n and not self._stop.is_set():
            try:
                chunk = conn.recv(n - len(buf))
            except socket.timeout:
                continue
            except OSError:
                return None
            if not chunk:      # orderly close
                return None
            buf += chunk
        return buf if len(buf) == n else None

    def _take_preamble(self, blob: bytes) -> bool:
        try:
            meta = json.loads(blob)
        except ValueError:
            with self._lock:
                self.error = "preamble is not JSON — dropping connection"
            logger.warning("[STREAM-RX] %s", self.error)
            return False
        if meta.get("kind") != PREAMBLE_KIND:
            with self._lock:
                self.error = f"unexpected preamble kind {meta.get('kind')!r}"
            logger.warning("[STREAM-RX] %s", self.error)
            return False
        serial = str(meta.get("serial", ""))
        if serial != self.expected_serial:
            # The serial gate: without sink auth this is what stops an
            # arbitrary LAN host from feeding the policy fabricated vision.
            with self._lock:
                self.error = (f"serial mismatch: stream says {serial!r}, session "
                              f"is paired with {self.expected_serial!r} — dropped")
            logger.warning("[STREAM-RX] %s", self.error)
            return False
        # Anchor Pi-monotonic frame timestamps to OUR monotonic clock. The
        # preamble just crossed the LAN (~ms), so local-now ≈ pi mono_epoch.
        offset = time.monotonic() - float(meta.get("mono_epoch", 0.0))
        with self._lock:
            self.meta = meta
            self._mono_offset = offset
            self.calibration = meta.get("calibration")
        if self.calibration:
            self._persist_calibration()
        else:
            logger.warning("[STREAM-RX] preamble carries NO calibration — the "
                           "robot could not read robot.json; units work stays blocked")
        # Forward-compat rule: unknown preamble fields are ignored.
        logger.info("[STREAM-RX] preamble ok: serial=%s cameras=%s fps=%s calib=%s",
                    serial, meta.get("cameras"), meta.get("fps"),
                    "yes" if self.calibration else "none")
        return True

    def _persist_calibration(self) -> None:
        """robot.json is non-secret by design (NoriTelop chmod 644); persisting
        it is what un-blocks the units-conversion work with zero manual steps."""
        try:
            p = _calib_path()
            p.write_text(json.dumps(self.calibration, indent=2) + "\n")
            logger.info("[STREAM-RX] calibration persisted -> %s", p)
        except OSError as e:
            logger.warning("[STREAM-RX] could not persist calibration (%s)", e)

    def _take_frame(self, blob: bytes) -> None:
        nl = blob.find(b"\n")            # wire: b"<name> <mono_ts>\n" + jpeg
        if nl < 0:
            return                        # not a frame; ignore (forward-compat)
        try:
            name_b, ts_b = blob[:nl].split(b" ", 1)
            name = name_b.decode("ascii", "replace")
            cap_pi_mono = float(ts_b)
        except (ValueError, UnicodeDecodeError):
            return
        cap_local = cap_pi_mono + (self._mono_offset or 0.0)
        with self._lock:
            self._latest[name] = (blob[nl + 1:], cap_local)
            self.frames_seen += 1
