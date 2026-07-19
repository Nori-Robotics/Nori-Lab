# Tests for the cloud-VLA chunk queue (lelab/nori_cloud_rollout.py). The slow
# HTTP call to the cloud endpoint is injected (caller=), so these exercise the
# QUEUE semantics deterministically without a network or a GPU: warming, refill
# watermark, single-flight, joint mapping, bounds cap, and error surfacing.
#
# Refills run on a daemon thread; helpers below spin briefly on the observable
# state (queue length / refills counter) instead of sleeping a fixed time.

import threading
import time

import pytest

from lelab import nori_cloud_rollout as cr

JOINTS = ["a.pos", "b.pos", "c.pos", "d.pos", "e.pos", "f.pos"]  # 6-DoF single arm


def _chunk(n, dof=6, base=0.0):
    return [[base + i + j * 0.01 for j in range(dof)] for i in range(n)]


def _wait(pred, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.005)
    return False


def _make(caller, **kw):
    return cr.CloudRollout(
        endpoint="http://x", token="t", instruction="pick up the cup",
        joints=JOINTS, caller=caller, **kw,
    )


def test_warming_then_serves_mapped_actions():
    roll = _make(lambda img, st: _chunk(30))
    # First serve: queue empty -> warming marker, kicks a refill.
    first = roll.serve(["img"], [0.0] * 6)
    assert first["action"] is None and first["warming"] is True
    # Refill lands asynchronously.
    assert _wait(lambda: roll.status()["queue"] > 0), "refill never populated the queue"
    out = roll.serve(["img"], [0.0] * 6)
    assert out["warming"] is False
    # Action is a joint-keyed dict in the session's joint order.
    assert list(out["action"].keys()) == JOINTS
    assert out["action"]["a.pos"] == pytest.approx(0.0)  # row 0, col 0


def test_refill_only_when_at_or_below_watermark():
    calls = []

    def caller(img, st):
        calls.append(1)
        return _chunk(30)

    roll = _make(caller, watermark=8)
    roll.serve(["i"], [0.0] * 6)  # warms -> 1 refill (30 queued, 1 popped attempt)
    assert _wait(lambda: roll.status()["queue"] >= 20)
    # Drain down but stay above the watermark: no new refill should fire.
    for _ in range(5):
        roll.serve(["i"], [0.0] * 6)
    time.sleep(0.05)
    assert len(calls) == 1, "refilled while still above watermark"
    # Drain to the watermark -> exactly one more refill triggers.
    while roll.status()["queue"] > roll.watermark:
        roll.serve(["i"], [0.0] * 6)
    roll.serve(["i"], [0.0] * 6)  # this crosses <= watermark
    assert _wait(lambda: len(calls) == 2), "no refill at watermark"


def test_single_flight_no_overlapping_calls():
    inflight = []
    peak = [0]
    lk = threading.Lock()

    def caller(img, st):
        with lk:
            inflight.append(1)
            peak[0] = max(peak[0], len(inflight))
        time.sleep(0.05)
        with lk:
            inflight.pop()
        return _chunk(30)

    roll = _make(caller)
    # Hammer serve() while a refill is in flight; only one call may be outstanding.
    for _ in range(20):
        roll.serve(["i"], [0.0] * 6)
    assert _wait(lambda: roll.status()["refills"] >= 1)
    time.sleep(0.1)
    assert peak[0] == 1, f"overlapping cloud calls: peak={peak[0]}"


def test_max_queue_cap():
    roll = _make(lambda img, st: _chunk(200), max_queue=50)
    roll.serve(["i"], [0.0] * 6)
    assert _wait(lambda: roll.status()["queue"] >= 49)
    time.sleep(0.05)
    assert roll.status()["queue"] <= 50


def test_wrong_action_dim_surfaces_error_and_503_semantics():
    # Cloud returns 4-dim actions but the session has 6 joints -> refill errors,
    # queue stays empty, and serve() raises CloudRolloutError (endpoint -> 503).
    roll = _make(lambda img, st: _chunk(10, dof=4))
    roll.serve(["i"], [0.0] * 6)  # kicks the doomed refill
    assert _wait(lambda: roll.status()["error"] is not None)
    with pytest.raises(cr.CloudRolloutError):
        roll.serve(["i"], [0.0] * 6)


def test_transient_error_then_recovery():
    state = {"fail": True}

    def caller(img, st):
        if state["fail"]:
            raise RuntimeError("boom")
        return _chunk(30)

    roll = _make(caller)
    roll.serve(["i"], [0.0] * 6)
    assert _wait(lambda: roll.status()["error"] is not None)
    # Recover: next refill succeeds and clears the error.
    state["fail"] = False
    # serve() raises once (empty + error) but still records obs & kicks a refill.
    with pytest.raises(cr.CloudRolloutError):
        roll.serve(["i"], [0.0] * 6)
    assert _wait(lambda: roll.status()["queue"] > 0)
    assert roll.status()["error"] is None
    assert roll.serve(["i"], [0.0] * 6)["action"] is not None


def test_state_passed_through_to_caller():
    seen = {}

    def caller(img, st):
        seen["img"], seen["st"] = img, st
        return _chunk(5)

    roll = _make(caller)
    roll.serve(["frameA", "frameB"], [1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
    assert _wait(lambda: "st" in seen)
    assert seen["img"] == ["frameA", "frameB"]
    assert seen["st"] == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
