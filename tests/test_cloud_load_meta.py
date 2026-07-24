"""_cloud_load per-policy meta wiring (INFERENCE_ENDPOINT_PLAN step 6).

The endpoint's /health `meta` (step-5 multi-policy server) must drive the
session's chunk semantics: a pi05 endpoint runs at ITS chunk_hz with NO
molmoact2 bounds/calibration; a legacy no-meta server keeps exact molmoact2
behavior; an explicit policy_kind mismatch fails at /load."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import lelab.nori_rollout as rollout

ARM_KEYS = [f"left_arm_{j}.pos" for j in
            ("shoulder_pan", "shoulder_lift", "elbow_flex",
             "wrist_flex", "wrist_roll", "gripper")]
BOUNDS_SENTINEL = [(-1.0, 1.0)] * 6
CALIB_SENTINEL = {"calib": True}


class _FakeRollout:
    def __init__(self, **kw):
        self.kw = kw
        self.chunk_hz = kw.get("chunk_hz", 0.0)
        self.stride = 1
        self.watermark = kw.get("watermark", 0)
        self.max_queue = kw.get("max_queue", 1)
        self.replace_on_refill = kw.get("replace_on_refill", True)


@pytest.fixture()
def env(monkeypatch):
    """Mock the cloud module + camera source; return a dict the test mutates
    (health payload) plus a capture slot for the CloudRollout kwargs."""
    cap: dict = {"health": {"status": "ready"}}

    monkeypatch.setattr(rollout.cloudmod, "infer_url", lambda: "http://endpoint")
    monkeypatch.setattr(rollout.cloudmod, "infer_token", lambda: "tok")
    monkeypatch.setattr(rollout.cloudmod, "health_check",
                        lambda ep, **k: cap["health"])
    monkeypatch.setattr(rollout.cloudmod, "load_calibration",
                        lambda arm: CALIB_SENTINEL)
    monkeypatch.setattr(rollout.cloudmod, "MOLMOACT2_BOUNDS", BOUNDS_SENTINEL)
    monkeypatch.setattr(rollout.cloudmod, "arm_keys", lambda arm: list(ARM_KEYS))
    monkeypatch.setattr(rollout.cloudmod, "default_cloud_views",
                        lambda arm="left": ["observation.images.left_wrist",
                                            "observation.images.overhead"])

    def fake_ctor(**kw):
        cap["rollout"] = _FakeRollout(**kw)
        return cap["rollout"]

    monkeypatch.setattr(rollout.cloudmod, "CloudRollout", fake_ctor)
    monkeypatch.setattr(rollout.camzmq, "build_source", lambda views: None)
    monkeypatch.delenv("NORI_INFER_STRIDE", raising=False)
    monkeypatch.delenv("NORI_INFER_VIEWS", raising=False)
    rollout._session.clear()
    yield cap
    rollout._session.clear()


def _body(**over):
    kw = dict(ref="cloud:test", joints=list(ARM_KEYS), provider="cloud",
              instruction="pick up the red cup", fps=15)
    kw.update(over)
    return rollout.LoadBody(**kw)


def test_legacy_no_meta_keeps_molmoact2_semantics(env):
    out = rollout._cloud_load(_body())
    kw = env["rollout"].kw
    assert kw["chunk_hz"] == rollout.cloudmod.MOLMOACT2_CHUNK_HZ
    assert kw["bounds"] is BOUNDS_SENTINEL
    assert kw["calib"] is CALIB_SENTINEL
    assert out["policy_kind"] == "molmoact2"


def test_pi05_meta_drives_chunk_and_disables_molmoact2_conventions(env):
    env["health"] = {"status": "ready", "kind": "pi05",
                     "meta": {"kind": "pi05", "chunk_hz": 15.0, "horizon": 50,
                              "cameras": ["observation.images.overhead",
                                          "observation.images.front"]}}
    out = rollout._cloud_load(_body())
    kw = env["rollout"].kw
    assert kw["chunk_hz"] == 15.0          # NOT molmoact2's 30
    assert kw["bounds"] is None            # model-space clamp is molmoact2-only
    assert kw["calib"] is None             # fleet affine would corrupt a Nori finetune
    assert out["policy_kind"] == "pi05" and out["chunk_hz"] == 15.0
    # checkpoint's camera keys become the views when caller didn't choose
    assert list(rollout._session["views"]) == ["observation.images.overhead",
                                               "observation.images.front"]


def test_explicit_views_beat_meta_cameras(env):
    env["health"] = {"status": "ready",
                     "meta": {"kind": "pi05", "chunk_hz": 15.0,
                              "cameras": ["observation.images.front"]}}
    rollout._cloud_load(_body(views=["observation.images.left_wrist"]))
    assert list(rollout._session["views"]) == ["observation.images.left_wrist"]


def test_policy_kind_mismatch_fails_at_load(env):
    env["health"] = {"status": "ready", "meta": {"kind": "molmoact2", "chunk_hz": 30}}
    with pytest.raises(HTTPException) as e:
        rollout._cloud_load(_body(policy_kind="pi05"))
    assert e.value.status_code == 422
    assert "molmoact2" in e.value.detail and "pi05" in e.value.detail


def test_matching_policy_kind_passes(env):
    env["health"] = {"status": "ready", "meta": {"kind": "pi05", "chunk_hz": 15}}
    out = rollout._cloud_load(_body(policy_kind="pi05"))
    assert out["policy_kind"] == "pi05"
