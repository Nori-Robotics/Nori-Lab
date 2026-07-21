# NORI: P2 tests — the lelab endpoints that arm the policy-stream receiver and
# the observation-source preference in the cloud act path
# (STREAM_INTEGRATION_PLAN §2). The receiver itself is covered by
# test_policy_stream_rx.py; here we test the wiring around it.

import json
import socket
import struct
import time

import pytest

import lelab.nori_rollout as nr

SERIAL = "NORI-L2-0007"


def wait_for(cond, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture(autouse=True)
def clean_stream(tmp_path, monkeypatch):
    monkeypatch.setenv("NORI_STREAM_CALIB_PATH", str(tmp_path / "calib.json"))
    yield
    nr.stream_close()          # idempotent; never leaves a listener behind


# ---- endpoint lifecycle -----------------------------------------------------

def test_open_returns_target_and_status_arms():
    out = nr.stream_open(nr.StreamOpenBody(expected_serial=SERIAL))
    assert out["port"] > 0 and out["host"]
    st = nr.stream_status()
    assert st["armed"] and not st["connected"]


def test_open_requires_serial():
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        nr.stream_open(nr.StreamOpenBody(expected_serial="  "))


def test_reopen_replaces_listener():
    p1 = nr.stream_open(nr.StreamOpenBody(expected_serial=SERIAL))["port"]
    p2 = nr.stream_open(nr.StreamOpenBody(expected_serial=SERIAL))["port"]
    assert p2 > 0
    # the first port is closed: connecting to it must fail
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", p1), timeout=0.5).close()
    assert nr.stream_status()["port"] == p2


def test_close_disarms():
    nr.stream_open(nr.StreamOpenBody(expected_serial=SERIAL))
    assert nr.stream_close()["closed"] is True
    assert nr.stream_status() == {"armed": False, "connected": False,
                                  "preamble_received": False}
    assert nr.stream_close()["closed"] is False  # idempotent


def test_robot_dial_in_through_endpoint():
    out = nr.stream_open(nr.StreamOpenBody(expected_serial=SERIAL))
    sk = socket.create_connection(("127.0.0.1", out["port"]), timeout=2.0)
    pre = json.dumps({"kind": "policy_stream_meta", "serial": SERIAL,
                      "mono_epoch": time.monotonic(), "wall_epoch": time.time(),
                      "cameras": ["overhead"], "fps": 20,
                      "calibration": None}).encode()
    sk.sendall(struct.pack(">I", len(pre)) + pre)
    frame = b"overhead %f\n" % time.monotonic() + b"\xff\xd8JPEG\xff\xd9"
    sk.sendall(struct.pack(">I", len(frame)) + frame)
    assert wait_for(lambda: nr.stream_status().get("connected"))
    assert wait_for(lambda: nr.stream_status().get("frames_seen", 0) >= 1)
    sk.close()


# ---- observation-source preference in _cloud_act ---------------------------

class StubRoll:
    def __init__(self):
        self.got = None

    def serve(self, images, state):
        self.got = (list(images), list(state))
        return {"action": None, "queue": 0, "warming": True}


class StubStream:
    def __init__(self, imgs):
        self.imgs = imgs

    def frames_b64(self, views):
        return dict(self.imgs) if self.imgs is not None else None

    def close(self):  # the autouse cleanup fixture may stream_close() us
        pass


@pytest.fixture
def cloud_session():
    views = ["observation.images.overhead"]
    roll = StubRoll()
    nr._session.clear()
    nr._session.update({"mode": "cloud", "ref": "test", "cloud": roll,
                        "views": views, "arm_keys": ["left_arm_shoulder_pan.pos"],
                        "cam": None})
    yield views, roll
    nr._session.clear()


def test_stream_preferred_over_composite(cloud_session, monkeypatch):
    views, roll = cloud_session
    monkeypatch.setattr(nr, "_stream", StubStream({views[0]: "U1RSRUFN"}))
    body = nr.ActBody(state={"left_arm_shoulder_pan.pos": 1.0},
                      images={views[0]: "Q09NUE9TSVRF"})
    nr._cloud_act(body)
    assert nr._session["frame_source"] == "stream"
    assert roll.got[0] == ["U1RSRUFN"]          # the STREAM bytes, not the composite


def test_stale_stream_falls_back_to_composite_with_warning(cloud_session, monkeypatch, caplog):
    views, roll = cloud_session
    monkeypatch.setattr(nr, "_stream", StubStream(None))   # armed but stale/empty
    nr._session["frame_source"] = "stream"                 # we WERE on the stream
    body = nr.ActBody(state={"left_arm_shoulder_pan.pos": 1.0},
                      images={views[0]: "Q09NUE9TSVRF"})
    import logging
    with caplog.at_level(logging.WARNING):
        nr._cloud_act(body)
    assert nr._session["frame_source"] == "composite"
    assert roll.got[0] == ["Q09NUE9TSVRF"]
    assert any("DEPRECATED browser composite" in r.message for r in caplog.records)


def test_composite_warning_fires_once_not_per_tick(cloud_session, monkeypatch, caplog):
    views, roll = cloud_session
    monkeypatch.setattr(nr, "_stream", None)
    body = nr.ActBody(state={"left_arm_shoulder_pan.pos": 1.0},
                      images={views[0]: "Q09NUE9TSVRF"})
    import logging
    with caplog.at_level(logging.WARNING):
        nr._cloud_act(body)   # transition -> warns
        nr._cloud_act(body)   # steady state -> silent
        nr._cloud_act(body)
    warns = [r for r in caplog.records if "DEPRECATED browser composite" in r.message]
    assert len(warns) == 1
