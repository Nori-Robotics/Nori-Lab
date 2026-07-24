"""arm="both": dual-lane MolmoAct2 rollout (one endpoint session per arm,
merged per tick). Covers lane construction (per-arm views/instruction/calib),
the merge/warming/failure semantics of _cloud_act, refusal paths, and teardown."""

import pytest
from fastapi import HTTPException

import lelab.nori_rollout as rollout

JOINTS_12 = [f"{a}_arm_{j}.pos"
             for a in ("left", "right")
             for j in ("shoulder_pan", "shoulder_lift", "elbow_flex",
                       "wrist_flex", "wrist_roll", "gripper")]
LEFT_KEYS = [k for k in JOINTS_12 if k.startswith("left_")]
RIGHT_KEYS = [k for k in JOINTS_12 if k.startswith("right_")]
L_WRIST, R_WRIST = "observation.images.left_wrist", "observation.images.right_wrist"
OVERHEAD = "observation.images.overhead"


class _FakeRollout:
    def __init__(self, **kw):
        self.kw = kw
        self.chunk_hz = kw.get("chunk_hz", 0.0)
        self.stride = 1
        self.watermark = kw.get("watermark", 0) or 0
        self.max_queue = kw.get("max_queue", 1)
        self.replace_on_refill = kw.get("replace_on_refill", True)
        self.serve_calls: list = []
        self.serve_result = {"action": {k: 0.5 for k in kw["action_keys"]},
                             "queue": 3, "warming": False}
        self.serve_error: Exception | None = None
        self.closed = 0

    def serve(self, images, state):
        self.serve_calls.append((list(images), list(state)))
        if self.serve_error:
            raise self.serve_error
        return self.serve_result

    def status(self):
        return {"arm_keys": self.kw["action_keys"][:1]}

    def close(self):
        self.closed += 1


@pytest.fixture()
def env(monkeypatch):
    cap: dict = {"health": {"status": "ready"}, "rollouts": [], "calib_arms": []}

    monkeypatch.setattr(rollout.cloudmod, "infer_url", lambda: "http://endpoint")
    monkeypatch.setattr(rollout.cloudmod, "infer_token", lambda: "tok")
    monkeypatch.setattr(rollout.cloudmod, "health_check", lambda ep, **k: cap["health"])

    def fake_calib(arm):
        cap["calib_arms"].append(arm)
        return {"A": [1.0] * 6, "B": [0.0] * 6, "arm": arm}

    monkeypatch.setattr(rollout.cloudmod, "load_calibration", fake_calib)
    monkeypatch.setattr(rollout.cloudmod, "arm_keys",
                        lambda arm: LEFT_KEYS if arm == "left" else RIGHT_KEYS)
    monkeypatch.setattr(rollout.cloudmod, "default_cloud_views",
                        lambda arm="left": [f"observation.images.{arm}_wrist", OVERHEAD])

    def fake_ctor(**kw):
        r = _FakeRollout(**kw)
        cap["rollouts"].append(r)
        return r

    monkeypatch.setattr(rollout.cloudmod, "CloudRollout", fake_ctor)
    monkeypatch.setattr(rollout.camzmq, "build_source", lambda views: None)
    monkeypatch.delenv("NORI_INFER_STRIDE", raising=False)
    monkeypatch.delenv("NORI_INFER_VIEWS", raising=False)
    monkeypatch.delenv("NORI_INFER_ARM", raising=False)
    monkeypatch.delenv("NORI_INFER_DUMP_FRAMES", raising=False)
    rollout._session.clear()
    rollout._stream = None
    yield cap
    rollout._session.clear()


def _body(**kw):
    kw.setdefault("ref", "molmoact2")
    kw.setdefault("provider", "cloud")
    kw.setdefault("instruction", "tidy the table")
    kw.setdefault("joints", list(JOINTS_12))
    kw.setdefault("arm", "both")
    return rollout.LoadBody(**kw)


def test_both_builds_two_lanes_with_per_arm_scoping(env):
    out = rollout._cloud_load(_body(instruction_right="pick up the red cup"))
    lanes = rollout._session["lanes"]
    assert [ln["arm"] for ln in lanes] == ["left", "right"]
    # per-arm views: own wrist + shared overhead; session views = dedup union
    assert lanes[0]["views"] == [L_WRIST, OVERHEAD]
    assert lanes[1]["views"] == [R_WRIST, OVERHEAD]
    assert rollout._session["views"] == [L_WRIST, OVERHEAD, R_WRIST]
    # per-arm instruction: left falls back to shared, right overridden
    assert env["rollouts"][0].kw["instruction"] == "tidy the table"
    assert env["rollouts"][1].kw["instruction"] == "pick up the red cup"
    # per-arm calibration + action keys
    assert env["calib_arms"] == ["left", "right"]
    assert env["rollouts"][0].kw["calib"]["arm"] == "left"
    assert env["rollouts"][1].kw["calib"]["arm"] == "right"
    assert out["action_joints"] == LEFT_KEYS + RIGHT_KEYS
    assert out["arm"] == "both" and out["calibrated"] is True
    assert set(out["image_keys"]) == {L_WRIST, OVERHEAD, R_WRIST}


def test_single_arm_still_one_lane(env):
    rollout._cloud_load(_body(arm="right"))
    lanes = rollout._session["lanes"]
    assert len(lanes) == 1 and lanes[0]["arm"] == "right"
    assert rollout._session["views"] == [R_WRIST, OVERHEAD]
    assert env["calib_arms"] == ["right"]


def test_both_refuses_explicit_views(env):
    with pytest.raises(HTTPException) as e:
        rollout._cloud_load(_body(views=[L_WRIST]))
    assert e.value.status_code == 422 and "per-arm" in e.value.detail


def test_both_refuses_non_molmoact2_endpoint(env):
    env["health"] = {"status": "ready", "meta": {"kind": "pi05", "chunk_hz": 15}}
    with pytest.raises(HTTPException) as e:
        rollout._cloud_load(_body())
    assert e.value.status_code == 422 and "single-arm" in e.value.detail


def test_both_requires_both_arms_joints(env):
    with pytest.raises(HTTPException) as e:
        rollout._cloud_load(_body(joints=LEFT_KEYS))   # right arm missing
    assert e.value.status_code == 422 and "right_arm" in e.value.detail


def _act(images=None):
    return rollout._cloud_act(rollout.ActBody(
        state={k: 0.1 * i for i, k in enumerate(JOINTS_12)},
        images=images or {L_WRIST: "imgL", OVERHEAD: "imgO", R_WRIST: "imgR"}))


def test_act_slices_views_and_state_per_lane_and_merges(env):
    rollout._cloud_load(_body())
    left, right = env["rollouts"]
    left.serve_result = {"action": {k: 1.0 for k in LEFT_KEYS}, "queue": 4, "warming": False}
    right.serve_result = {"action": {k: 2.0 for k in RIGHT_KEYS}, "queue": 2, "warming": False}
    out = _act()
    # each lane saw ITS wrist + overhead, in ITS order
    assert left.serve_calls[0][0] == ["imgL", "imgO"]
    assert right.serve_calls[0][0] == ["imgR", "imgO"]
    # each lane got ITS 6 joints, in model order
    assert left.serve_calls[0][1] == [0.1 * JOINTS_12.index(k) for k in LEFT_KEYS]
    assert right.serve_calls[0][1] == [0.1 * JOINTS_12.index(k) for k in RIGHT_KEYS]
    # merged 12-joint command; queue = the scarcer lane
    assert out["warming"] is False and len(out["action"]) == 12
    assert out["action"]["left_arm_gripper.pos"] == 1.0
    assert out["action"]["right_arm_gripper.pos"] == 2.0
    assert out["queue"] == 2


def test_act_warming_lane_holds_both_arms(env):
    rollout._cloud_load(_body())
    left, right = env["rollouts"]
    right.serve_result = {"action": None, "queue": 0, "warming": True}
    out = _act()
    assert out["action"] is None and out["warming"] is True
    # the primed lane was still served (buffers obs + keeps refilling)
    assert len(left.serve_calls) == 1


def test_act_failed_lane_halts_both_arms(env):
    rollout._cloud_load(_body())
    env["rollouts"][1].serve_error = rollout.cloudmod.CloudRolloutError("endpoint down")
    with pytest.raises(HTTPException) as e:
        _act()
    assert e.value.status_code == 503 and "right arm" in e.value.detail


def test_unload_closes_both_lanes(env):
    rollout._cloud_load(_body())
    rollout.rollout_unload()
    assert [r.closed for r in env["rollouts"]] == [1, 1]


def test_status_reports_per_arm_lanes(env):
    rollout._cloud_load(_body())
    st = rollout.rollout_status()
    assert st["arm"] == "both"
    assert set(st["cloud"].keys()) == {"left", "right"}
    # single-arm keeps the historical flat shape
    rollout._cloud_load(_body(arm="left"))
    st = rollout.rollout_status()
    assert "arm_keys" in st["cloud"]
