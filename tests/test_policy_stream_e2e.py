# NORI: end-to-end smoke of the policy-stream chain (P1+P2+P3's server contract)
# with NO robot and NO browser — a fake robot streamer speaks the wire, the REAL
# endpoint handlers arm the REAL receiver, and a REAL CloudRollout (injected
# caller, no network) serves /act exactly as policyRun drives it:
#
#   stream/open -> robot dials + preamble + frames -> status shows preamble
#   -> act ticks with EMPTY images (P3's upload skip)   -> frame_source "stream"
#   -> streamer dies -> frames go stale                 -> act(empty) = 422
#      (the browser's signal to re-attach composite)    -> act(composite) works
#   -> calibration from the preamble persisted           (the P5 unblock)
#
# This is the run P4 will do on hardware, minus the robot.

import base64
import json
import socket
import struct
import time

import pytest

import lelab.nori_cloud_rollout as cr
import lelab.nori_rollout as nr
import lelab.policy_stream_rx as rx

SERIAL = "NORI-L2-0007"
VIEWS = ["observation.images.left_wrist", "observation.images.overhead"]
JPEGS = {"left_wrist": b"\xff\xd8WRIST\xff\xd9", "overhead": b"\xff\xd8OVERHEAD\xff\xd9"}
CALIB = {"left_arm_shoulder_pan": {"id": 1, "drive_mode": 0, "homing_offset": 3,
                                   "range_min": 700, "range_max": 3350}}


class FakeRobotStreamer:
    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=2.0)

    def blob(self, raw):
        self.sock.sendall(struct.pack(">I", len(raw)) + raw)

    def preamble(self):
        self.blob(json.dumps({
            "kind": "policy_stream_meta", "serial": SERIAL,
            "mono_epoch": time.monotonic(), "wall_epoch": time.time(),
            "cameras": list(JPEGS), "fps": 20, "calibration": CALIB}).encode())

    def frames(self):
        for name, jpeg in JPEGS.items():
            self.blob(f"{name} {time.monotonic()}\n".encode() + jpeg)

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
def chain(tmp_path, monkeypatch):
    """The whole laptop side, wired for real; a fast stale threshold so the
    dead-streamer leg doesn't slow the suite."""
    monkeypatch.setenv("NORI_STREAM_CALIB_PATH", str(tmp_path / "calib.json"))

    chunk = [[float(i)] * 6 for i in range(30)]
    calls = []

    def fake_cloud(images, state):        # what the HF Space would do
        calls.append((list(images), list(state)))
        return [list(a) for a in chunk]

    roll = cr.CloudRollout(endpoint="http://fake", token="t", instruction="smoke",
                           action_keys=cr.arm_keys("left"), fps=15, caller=fake_cloud)
    nr._session.clear()
    nr._session.update({"mode": "cloud", "ref": "smoke", "cloud": roll,
                        "views": VIEWS, "arm_keys": cr.arm_keys("left"), "cam": None})
    yield calls, tmp_path
    nr._session.clear()
    nr.stream_close()


def act(images):
    state = {k: 1.0 for k in cr.arm_keys("left")}
    return nr._cloud_act(nr.ActBody(state=state, images=images))


def drain_warmup():
    """serve() returns warming until the injected chunk lands; tick like the
    browser does until an action arrives."""
    for _ in range(60):
        out = act({})
        if out["action"] is not None:
            return out
        time.sleep(0.05)
    raise AssertionError("queue never primed")


def test_full_chain_stream_then_death_then_composite(chain):
    calls, tmp_path = chain

    # 1. arm exactly as policyRun does
    out = nr.stream_open(nr.StreamOpenBody(expected_serial=SERIAL))
    assert out["port"] > 0
    # Fast staleness for the dead-streamer leg. NOTE: this must be set on the
    # INSTANCE — StreamListener binds STALE_AFTER_S as a default parameter at
    # class definition, so monkeypatching the module constant is a silent no-op
    # (this test originally did exactly that and the "dead" stream stayed fresh).
    nr._stream.stale_after_s = 0.4

    # 2. the robot dials in
    robot = FakeRobotStreamer("127.0.0.1", out["port"])
    robot.preamble()
    robot.frames()
    assert wait_for(lambda: nr.stream_status()["preamble_received"])
    assert wait_for(lambda: nr.stream_status()["frames_seen"] >= 2)

    # 3. P3 ticks: EMPTY images — the stream must feed the model
    out = drain_warmup()
    assert out["action"] is not None
    assert nr._session["frame_source"] == "stream"
    sent = calls[0][0]
    assert base64.b64decode(sent[0]) == JPEGS["left_wrist"]     # view order kept
    assert base64.b64decode(sent[1]) == JPEGS["overhead"]

    # 4. calibration from the preamble persisted — the P5 unblock
    assert json.loads((tmp_path / "calib.json").read_text()) == CALIB

    # 5. the robot dies; frames age out past the stale threshold
    robot.close()
    time.sleep(0.6)

    # empty-image ticks must now 422 — the browser's re-attach signal.
    # (drain the queue first: buffered actions serve without a refill/obs)
    from fastapi import HTTPException
    got_422 = False
    for _ in range(80):
        try:
            out = act({})
        except HTTPException as e:
            assert e.status_code == 422
            got_422 = True
            break
    assert got_422, "dead stream never surfaced as 422 to the (empty-image) client"

    # 6. composite frames in the body recover the run, marked honestly
    comp = {v: base64.b64encode(b"\xff\xd8COMPOSITE\xff\xd9").decode() for v in VIEWS}
    out = act(comp)
    assert nr._session["frame_source"] == "composite"

    # 7. teardown
    assert nr.stream_close()["closed"] is True


def test_load_would_see_streamed_cameras(chain):
    """The status surface the P3 start-sequence polls, end to end."""
    _, _ = chain
    out = nr.stream_open(nr.StreamOpenBody(expected_serial=SERIAL))
    robot = FakeRobotStreamer("127.0.0.1", out["port"])
    robot.preamble()
    assert wait_for(lambda: nr.stream_status()["preamble_received"])
    st = nr.stream_status()
    assert st["cameras"] == list(JPEGS)
    assert st["serial"] == SERIAL
    assert st["calibration_present"] is True
    robot.close()
