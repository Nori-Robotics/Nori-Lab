# NORI: local language-conditioned VLA rollout (smolvla) — the two behaviors
# that make a local smolvla bundle drivable:
#   1. execution overrides: smolvla gets an open-loop horizon (default half the
#      50-step chunk, env/request-overridable, clamped) and NO temporal
#      ensembler; ACT behavior unchanged.
#   2. per-tick task injection: when the session carries an instruction, every
#      /act batch gains a "task" key (the fitted preprocessor's tokenizer step
#      reads it); ACT sessions (no task) stay untouched.

import pytest
import torch

import lelab.nori_rollout as nr

VIEW = "observation.images.overhead"


class Cfg:
    def __init__(self, type_, chunk=50, n_action_steps=None, tec=None):
        self.type = type_
        self.chunk_size = chunk
        self.n_action_steps = n_action_steps if n_action_steps is not None else chunk
        self.temporal_ensemble_coeff = tec


# ---- 1. execution overrides -------------------------------------------------

def test_smolvla_default_horizon_is_half_chunk(monkeypatch):
    monkeypatch.delenv("NORI_SMOLVLA_ACTION_STEPS", raising=False)
    cfg = Cfg("smolvla")
    eff = nr._apply_act_execution(cfg, None, None)
    assert cfg.n_action_steps == 25
    assert eff == {"temporal_ensemble_coeff": None, "n_action_steps": 25}


def test_smolvla_request_override_and_clamp():
    cfg = Cfg("smolvla")
    assert nr._apply_act_execution(cfg, None, 10)["n_action_steps"] == 10
    cfg = Cfg("smolvla")
    assert nr._apply_act_execution(cfg, None, 999)["n_action_steps"] == 50  # clamp to chunk
    cfg = Cfg("smolvla")
    assert nr._apply_act_execution(cfg, None, 0)["n_action_steps"] == 1     # floor


def test_smolvla_env_default(monkeypatch):
    monkeypatch.setenv("NORI_SMOLVLA_ACTION_STEPS", "40")
    cfg = Cfg("smolvla")
    assert nr._apply_act_execution(cfg, None, None)["n_action_steps"] == 40


def test_smolvla_ignores_temporal_ensemble():
    cfg = Cfg("smolvla")
    eff = nr._apply_act_execution(cfg, 0.01, None)
    assert eff["temporal_ensemble_coeff"] is None       # ACT-only knob dropped
    assert eff["n_action_steps"] == 25                  # horizon still applied


def test_act_branch_unchanged():
    cfg = Cfg("act", chunk=100)
    eff = nr._apply_act_execution(cfg, 0.01, 30)
    assert eff["temporal_ensemble_coeff"] == 0.01
    assert eff["n_action_steps"] == 1                   # ensembling forces 1


def test_other_policies_still_noop():
    cfg = Cfg("diffusion", chunk=16, n_action_steps=8)
    eff = nr._apply_act_execution(cfg, None, 4)
    assert cfg.n_action_steps == 8                      # untouched
    assert eff["n_action_steps"] == 8


# ---- 2. per-tick task injection ---------------------------------------------

class SpyPre:
    """Stands in for the fitted preprocessor; records the batch it was given."""

    def __init__(self):
        self.seen = None

    def __call__(self, obs):
        self.seen = dict(obs)
        return obs


class FakePolicy:
    def select_action(self, batch):
        return torch.zeros(1, 1)


@pytest.fixture
def session():
    nr._session.clear()
    yield nr._session
    nr._session.clear()


# 1x1 black JPEG, enough for _decode_image
_JPEG = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
    "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB"
    "AAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z"
)


def _run_act(session, task):
    spy = SpyPre()
    session.update({
        "ref": "t", "policy": FakePolicy(), "pre": spy, "post": lambda a: a,
        "device": "cpu", "joints": ["j1"], "action_joints": ["j1"],
        "image_shapes": {VIEW: (3, 1, 1)}, "use_stream": False, "task": task,
    })
    out = nr.rollout_act(nr.ActBody(state={"j1": 0.0}, images={VIEW: _JPEG}))
    assert out["action"] == {"j1": 0.0}
    return spy.seen


def test_task_injected_for_language_session(session):
    seen = _run_act(session, "pick up the cup")
    assert seen["task"] == "pick up the cup"


def test_no_task_key_for_act_session(session):
    seen = _run_act(session, None)
    assert "task" not in seen


def test_language_policy_types_registry():
    assert "smolvla" in nr._LANGUAGE_POLICY_TYPES
    assert "act" not in nr._LANGUAGE_POLICY_TYPES
