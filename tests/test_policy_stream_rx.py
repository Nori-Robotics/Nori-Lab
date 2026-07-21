# NORI: tests for lelab/policy_stream_rx.py — the laptop half of the robot's
# policy stream (STREAM_INTEGRATION_PLAN.md §1/P1).
#
# FakeStreamer below speaks the ROBOT's wire verbatim (NoriTelop
# policy_streamer.py / test_policy_streamer.py FakeSink is the reference for
# the other direction): it CONNECTS OUT to the listener and sends 4-byte
# big-endian length-prefixed blobs — blob 0 the JSON preamble, then frames of
# b"<name> <mono_ts>\n" + jpeg. No robot, no network beyond loopback.

import json
import socket
import struct
import time

import pytest

from lelab.policy_stream_rx import StreamListener, role_of

SERIAL = "NORI-L2-0007"
JPEG = b"\xff\xd8\xff\xe0FAKEJPEG\xff\xd9"


def preamble(serial=SERIAL, calibration=None, cameras=("overhead", "left_wrist"),
             mono_epoch=None, **extra):
    d = {"kind": "policy_stream_meta", "serial": serial,
         "mono_epoch": time.monotonic() if mono_epoch is None else mono_epoch,
         "wall_epoch": time.time(), "cameras": list(cameras), "fps": 20,
         "calibration": calibration}
    d.update(extra)   # forward-compat: receivers must ignore unknown fields
    return d


class FakeStreamer:
    """The robot side of the wire: dial out, push blobs."""

    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=2.0)

    def blob(self, raw: bytes):
        self.sock.sendall(struct.pack(">I", len(raw)) + raw)

    def send_preamble(self, **kw):
        self.blob(json.dumps(preamble(**kw)).encode())

    def send_frame(self, name="overhead", ts=None, jpeg=JPEG):
        ts = time.monotonic() if ts is None else ts
        self.blob(f"{name} {ts}\n".encode() + jpeg)

    def close(self):
        self.sock.close()


def wait_for(cond, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def rx(tmp_path, monkeypatch):
    monkeypatch.setenv("NORI_STREAM_CALIB_PATH", str(tmp_path / "calib.json"))
    lst = StreamListener(SERIAL, host="127.0.0.1")
    lst.open()
    yield lst
    lst.close()


def test_role_of_strips_feature_prefix():
    assert role_of("observation.images.overhead") == "overhead"
    assert role_of("overhead") == "overhead"


def test_preamble_then_frames_served(rx):
    s = FakeStreamer("127.0.0.1", rx.port)
    s.send_preamble()
    s.send_frame("overhead")
    s.send_frame("left_wrist")
    assert wait_for(lambda: rx.frames_seen >= 2)
    got = rx.frames_b64(["observation.images.overhead",
                         "observation.images.left_wrist"])
    assert got is not None
    import base64
    assert base64.b64decode(got["observation.images.overhead"]) == JPEG
    st = rx.status()
    assert st["connected"] and st["preamble_received"]
    assert st["serial"] == SERIAL and st["cameras"] == ["overhead", "left_wrist"]
    s.close()


def test_all_or_nothing_missing_view(rx):
    s = FakeStreamer("127.0.0.1", rx.port)
    s.send_preamble()
    s.send_frame("overhead")
    assert wait_for(lambda: rx.frames_seen >= 1)
    # left_wrist never arrived -> the WHOLE request returns None
    assert rx.frames_b64(["observation.images.overhead",
                          "observation.images.left_wrist"]) is None
    s.close()


def test_stale_frames_read_as_missing(rx):
    s = FakeStreamer("127.0.0.1", rx.port)
    s.send_preamble()
    # capture ts far in the (Pi-)past: age >> stale_after
    s.send_frame("overhead", ts=time.monotonic() - 60.0)
    assert wait_for(lambda: rx.frames_seen >= 1)
    assert rx.frames_b64(["observation.images.overhead"]) is None
    st = rx.status()
    assert st["age_s"]["overhead"] > 50   # capture-time age, not arrival-time
    s.close()


def test_serial_mismatch_drops_connection(rx):
    s = FakeStreamer("127.0.0.1", rx.port)
    s.send_preamble(serial="NORI-L2-9999")
    assert wait_for(lambda: rx.status()["error"] is not None)
    assert "serial mismatch" in rx.status()["error"]
    assert not rx.status()["connected"]
    # frames after the drop must not be ingested
    try:
        s.send_frame("overhead")
        s.send_frame("overhead")
    except OSError:
        pass                              # peer already closed on us — equally fine
    time.sleep(0.2)
    assert rx.frames_seen == 0
    s.close()


def test_garbage_preamble_dropped(rx):
    s = FakeStreamer("127.0.0.1", rx.port)
    s.blob(b"not json at all")
    assert wait_for(lambda: rx.status()["error"] is not None)
    assert "not JSON" in rx.status()["error"]
    s.close()


def test_wrong_kind_dropped(rx):
    s = FakeStreamer("127.0.0.1", rx.port)
    s.send_preamble(kind_override=None)   # extra ignored; now break the kind:
    s.close()
    # (separate connection attempt would be refused; use a fresh listener)
    lst = StreamListener(SERIAL, host="127.0.0.1")
    lst.open()
    try:
        s2 = FakeStreamer("127.0.0.1", lst.port)
        s2.blob(json.dumps({"kind": "record_meta", "serial": SERIAL}).encode())
        assert wait_for(lambda: lst.status()["error"] is not None)
        assert "unexpected preamble kind" in lst.status()["error"]
        s2.close()
    finally:
        lst.close()


def test_oversized_blob_drops_connection(rx):
    s = FakeStreamer("127.0.0.1", rx.port)
    s.send_preamble()
    assert wait_for(lambda: rx.status()["preamble_received"])
    # a length prefix claiming 512MB must be refused without allocating it
    s.sock.sendall(struct.pack(">I", 512 * 1024 * 1024))
    assert wait_for(lambda: "bad blob length" in (rx.status()["error"] or ""))
    s.close()


def test_second_connection_refused(rx):
    s1 = FakeStreamer("127.0.0.1", rx.port)
    s1.send_preamble()
    assert wait_for(lambda: rx.status()["connected"])
    s2 = FakeStreamer("127.0.0.1", rx.port)
    # the extra either gets closed on us or never receives service
    assert wait_for(lambda: rx.status()["refused_conns"] >= 1)
    s2.close()
    # the FIRST stream keeps working
    s1.send_frame("overhead")
    assert wait_for(lambda: rx.frames_seen >= 1)
    s1.close()


def test_arming_window_expires(tmp_path, monkeypatch):
    monkeypatch.setenv("NORI_STREAM_CALIB_PATH", str(tmp_path / "c.json"))
    lst = StreamListener(SERIAL, host="127.0.0.1", arm_window_s=0.3)
    lst.open()
    try:
        assert wait_for(lambda: "arming window expired" in (lst.status()["error"] or ""),
                        timeout=2.0)
        assert lst.status()["armed"] is False or lst.status()["error"]
    finally:
        lst.close()


def test_calibration_persisted(rx, tmp_path):
    calib = {"left_arm_shoulder_pan": {"id": 1, "drive_mode": 0,
                                       "homing_offset": 3, "range_min": 700,
                                       "range_max": 3350}}
    s = FakeStreamer("127.0.0.1", rx.port)
    s.send_preamble(calibration=calib)
    assert wait_for(lambda: rx.status()["calibration_present"])
    saved = json.loads((tmp_path / "calib.json").read_text())
    assert saved == calib
    s.close()


def test_disconnect_flips_connected_and_frames_age_out(rx):
    s = FakeStreamer("127.0.0.1", rx.port)
    s.send_preamble()
    s.send_frame("overhead")
    assert wait_for(lambda: rx.status()["connected"] and rx.frames_seen >= 1)
    s.close()
    assert wait_for(lambda: not rx.status()["connected"])
    # last frame may still be fresh for a moment, but the status is honest
    assert rx.status()["preamble_received"]
