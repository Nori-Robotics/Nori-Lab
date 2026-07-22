# NORI: P6 — local (laptop ACT) inference on stream frames, provenance-gated
# (STREAM_INTEGRATION_PLAN §5). The rule under test: frame source must MATCH
# the policy's training domain; explicit request wins; fallback is loud and
# all-or-nothing.

import json

import pytest
from fastapi import HTTPException

import lelab.nori_rollout as nr

VIEWS = ["observation.images.left_wrist", "observation.images.overhead"]


# ---- the provenance rule (pure) --------------------------------------------

@pytest.mark.parametrize("requested,cap_src,expect", [
    (None, "raw_bundle", True),    # auto: trained on full-quality -> stream
    (None, "browser", False),      # auto: trained on composite -> composite
    (None, None, False),           # unstamped (every pre-stamp bundle) -> today's behavior
    (True, "browser", True),       # explicit override wins (warned at load)
    (True, None, True),
    (False, "raw_bundle", False),  # explicit opt-out wins
])
def test_resolve_use_stream(requested, cap_src, expect):
    assert nr._resolve_use_stream(requested, cap_src) is expect


def test_read_capture_source(tmp_path):
    (tmp_path / "nori_meta.json").write_text(json.dumps({"capture_source": "raw_bundle"}))
    assert nr._read_capture_source(tmp_path) == "raw_bundle"
    (tmp_path / "nori_meta.json").write_text(json.dumps({"capture_source": "browser"}))
    assert nr._read_capture_source(tmp_path) == "browser"
    (tmp_path / "nori_meta.json").write_text(json.dumps({"capture_source": "??"}))
    assert nr._read_capture_source(tmp_path) is None      # unknown value = unstamped
    (tmp_path / "nori_meta.json").write_text("not json")
    assert nr._read_capture_source(tmp_path) is None      # unreadable = unstamped
    assert nr._read_capture_source(tmp_path / "nope") is None


# ---- the frame selector -----------------------------------------------------

class StubStream:
    def __init__(self, imgs):
        self.imgs = imgs

    def frames_b64(self, keys):
        return dict(self.imgs) if self.imgs is not None else None

    def close(self):
        pass


@pytest.fixture
def local_session():
    nr._session.clear()
    nr._session.update({"ref": "t", "image_shapes": {v: (3, 240, 320) for v in VIEWS}})
    yield
    nr._session.clear()


def body(images):
    return nr.ActBody(state={}, images=images)


COMPOSITE = {v: "Q09NUE9TSVRF" for v in VIEWS}
STREAMED = {v: "U1RSRUFN" for v in VIEWS}


def test_stream_preferred_when_opted_in(local_session, monkeypatch):
    nr._session["use_stream"] = True
    monkeypatch.setattr(nr, "_stream", StubStream(STREAMED))
    got = nr._local_images(body(COMPOSITE))
    assert got == STREAMED
    assert nr._session["frame_source"] == "stream"


def test_composite_when_not_opted_in_even_if_stream_live(local_session, monkeypatch):
    # A browser-provenance policy must NOT get stream frames just because the
    # stream happens to be running — that is the inverted train/infer mismatch.
    nr._session["use_stream"] = False
    monkeypatch.setattr(nr, "_stream", StubStream(STREAMED))
    got = nr._local_images(body(COMPOSITE))
    assert got == COMPOSITE
    assert nr._session["frame_source"] == "composite"


def test_stale_stream_falls_back_with_one_warning(local_session, monkeypatch, caplog):
    import logging
    nr._session["use_stream"] = True
    monkeypatch.setattr(nr, "_stream", StubStream(None))   # armed but stale
    with caplog.at_level(logging.WARNING):
        got1 = nr._local_images(body(COMPOSITE))
        got2 = nr._local_images(body(COMPOSITE))
    assert got1 == COMPOSITE and got2 == COMPOSITE
    warns = [r for r in caplog.records if "falling back" in r.message]
    assert len(warns) == 1                                  # transition only, not per tick


def test_stream_wanted_but_never_armed(local_session, monkeypatch):
    nr._session["use_stream"] = True
    monkeypatch.setattr(nr, "_stream", None)
    assert nr._local_images(body(COMPOSITE)) == COMPOSITE


def test_missing_composite_view_still_422(local_session, monkeypatch):
    nr._session["use_stream"] = False
    monkeypatch.setattr(nr, "_stream", None)
    with pytest.raises(HTTPException) as e:
        nr._local_images(body({VIEWS[0]: "x"}))             # overhead missing
    assert e.value.status_code == 422


def test_recovery_back_to_stream(local_session, monkeypatch):
    nr._session["use_stream"] = True
    stub = StubStream(None)
    monkeypatch.setattr(nr, "_stream", stub)
    assert nr._local_images(body(COMPOSITE)) == COMPOSITE   # stale -> composite
    stub.imgs = STREAMED                                    # frames return
    assert nr._local_images(body(COMPOSITE)) == STREAMED    # picked up again
    assert nr._session["frame_source"] == "stream"
