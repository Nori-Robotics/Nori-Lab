# Tests for the full-quality camera source (lelab/nori_cam_zmq.py) — cloud
# inference subscribing to the Pi's per-camera MJPEG PUB sockets (image_server.py)
# instead of cropping the ABR-degraded composite.
#
# Driven against a FAKE publisher speaking image_server.py's wire format
# (b"<name> <capture_monotonic>\n" + jpeg), so no Pi/cameras are needed.

import base64
import threading
import time

import pytest

zmq = pytest.importorskip("zmq")

from lelab import nori_cam_zmq as cz  # noqa: E402

ROLES = ["left_wrist", "right_wrist", "overhead", "front"]
VIEWS = ["observation.images.overhead", "observation.images.front"]


@pytest.fixture
def publishers():
    """Spin up one PUB socket per role; yields (base_port, stop_event)."""
    stop = threading.Event()
    base = 5801
    threads = []

    def pub(role, port, name=None):
        s = zmq.Context.instance().socket(zmq.PUB)
        s.bind(f"tcp://127.0.0.1:{port}")
        time.sleep(0.2)  # PUB drops until subscribers attach
        while not stop.is_set():
            s.send(f"{name or role} {time.monotonic():.6f}\n".encode()
                   + b"\xff\xd8\xff" + role.encode() + b"-frame")
            time.sleep(0.05)
        s.close(0)

    for i, r in enumerate(ROLES):
        t = threading.Thread(target=pub, args=(r, base + i), daemon=True)
        t.start()
        threads.append(t)
    yield base, stop
    stop.set()
    for t in threads:
        t.join(timeout=1)


def _configure(monkeypatch, base):
    monkeypatch.setenv("NORI_CAM_ZMQ_HOST", "127.0.0.1")
    monkeypatch.setenv("NORI_CAM_ROLES", ",".join(ROLES))
    monkeypatch.setenv("NORI_CAM_BASE_PORT", str(base))


def test_off_unless_fully_configured(monkeypatch):
    # Every missing piece degrades to the composite path rather than erroring.
    monkeypatch.delenv("NORI_CAM_ZMQ_HOST", raising=False)
    assert cz.build_source(VIEWS) is None
    monkeypatch.setenv("NORI_CAM_ZMQ_HOST", "127.0.0.1")
    monkeypatch.delenv("NORI_CAM_ROLES", raising=False)
    assert cz.build_source(VIEWS) is None
    monkeypatch.setenv("NORI_CAM_ROLES", ",".join(ROLES))
    assert cz.build_source(["observation.images.not_a_camera"]) is None


def test_role_of():
    assert cz.role_of("observation.images.overhead") == "overhead"


def test_delivers_the_right_camera(monkeypatch, publishers):
    base, _ = publishers
    _configure(monkeypatch, base)
    src = cz.build_source(VIEWS)
    assert src is not None
    got, end = None, time.time() + 5
    while time.time() < end and got is None:
        got = src.frames_b64(VIEWS)
        time.sleep(0.05)
    assert got is not None and set(got) == set(VIEWS)
    # Bytes must come from the camera the view names — not a neighbouring port.
    assert b"overhead-frame" in base64.b64decode(got["observation.images.overhead"])
    assert not src.name_mismatch
    src.close()


def test_stale_frames_are_rejected(monkeypatch, publishers):
    # A frozen camera must read as MISSING (-> fall back), never be served as if live.
    base, stop = publishers
    _configure(monkeypatch, base)
    src = cz.build_source(VIEWS)
    end = time.time() + 5
    while time.time() < end and src.frames_b64(VIEWS) is None:
        time.sleep(0.05)
    stop.set()
    time.sleep(cz.STALE_AFTER_S + 0.3)
    assert src.frames_b64(VIEWS) is None
    src.close()


def test_name_mismatch_detected(monkeypatch):
    # If NORI_CAM_ROLES order disagrees with the wire, surface it instead of
    # silently feeding the policy the WRONG camera.
    stop = threading.Event()
    base = 5821

    def pub():
        s = zmq.Context.instance().socket(zmq.PUB)
        s.bind(f"tcp://127.0.0.1:{base + 2}")  # the port config calls 'overhead'
        time.sleep(0.2)
        while not stop.is_set():
            s.send(f"front {time.monotonic():.6f}\n".encode() + b"\xff\xd8\xffx")
            time.sleep(0.05)
        s.close(0)

    t = threading.Thread(target=pub, daemon=True)
    t.start()
    _configure(monkeypatch, base)
    src = cz.build_source(["observation.images.overhead"])
    end = time.time() + 4
    while time.time() < end and not src.name_mismatch:
        src.frames_b64(["observation.images.overhead"])
        time.sleep(0.05)
    assert src.name_mismatch.get("overhead") == "front"
    stop.set()
    t.join(timeout=1)
    src.close()
