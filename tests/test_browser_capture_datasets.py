# Tests for the capture card's local dataset management surface
# (/nori/capture/datasets list + rename, and finish's append_to validation).
# The export itself needs lerobot and is not exercised here (matching the
# repo's convention of not unit-testing the heavy integration paths).

import json
from pathlib import Path

import pytest


def _make_dataset(cache: Path, repo_id: str, *, episodes: int = 3, remote_view: bool = True) -> Path:
    d = cache / repo_id / "meta"
    d.mkdir(parents=True)
    features = {
        "observation.state": {"dtype": "float32", "shape": [6], "names": ["a"] * 6},
        "action": {"dtype": "float32", "shape": [6], "names": ["a"] * 6},
    }
    if remote_view:
        features["observation.images.remote"] = {"dtype": "video", "shape": [480, 640, 3]}
    (d / "info.json").write_text(json.dumps({
        "codebase_version": "v3.0",
        "fps": 15,
        "robot_type": "nori_remote",
        "total_episodes": episodes,
        "total_frames": episodes * 100,
        "features": features,
    }))
    return cache / repo_id


@pytest.fixture
def cache(tmp_lerobot_home: Path) -> Path:
    return tmp_lerobot_home


def test_list_datasets_shapes_and_order(client, cache):
    _make_dataset(cache, "older_set", episodes=2)
    _make_dataset(cache, "local_only", remote_view=False)
    # Non-datasets (no meta/info.json — e.g. the fixture's calibration dir)
    # and underscore dirs (the capture spool) are excluded.
    (cache / "_nori_captures" / "abc").mkdir(parents=True)

    r = client.get("/nori/capture/datasets")
    assert r.status_code == 200
    rows = r.json()["datasets"]
    assert {x["repo_id"] for x in rows} == {"older_set", "local_only"}
    by_id = {x["repo_id"]: x for x in rows}
    assert by_id["older_set"]["episodes"] == 2
    assert by_id["older_set"]["frames"] == 200
    assert by_id["older_set"]["appendable"] is True
    assert by_id["local_only"]["appendable"] is False


def test_rename_happy_path(client, cache):
    _make_dataset(cache, "pick_place_v1")
    r = client.post("/nori/capture/datasets/rename",
                    json={"repo_id": "pick_place_v1", "new_repo_id": "pick_place_mugs"})
    assert r.status_code == 200
    assert r.json()["repo_id"] == "pick_place_mugs"
    assert not (cache / "pick_place_v1").exists()
    assert (cache / "pick_place_mugs" / "meta" / "info.json").is_file()


def test_rename_collision_409(client, cache):
    _make_dataset(cache, "a_set")
    _make_dataset(cache, "b_set")
    r = client.post("/nori/capture/datasets/rename",
                    json={"repo_id": "a_set", "new_repo_id": "b_set"})
    assert r.status_code == 409
    assert (cache / "a_set").exists()  # untouched on refusal


@pytest.mark.parametrize("bad", ["../escape", ".hidden", "-flag", "with space", ""])
def test_rename_bad_names_422(client, cache, bad):
    _make_dataset(cache, "a_set")
    r = client.post("/nori/capture/datasets/rename",
                    json={"repo_id": "a_set", "new_repo_id": bad})
    assert r.status_code == 422
    assert (cache / "a_set").exists()


def test_rename_missing_404(client, cache):
    r = client.post("/nori/capture/datasets/rename",
                    json={"repo_id": "ghost", "new_repo_id": "anything"})
    assert r.status_code == 404


def test_rename_noop_ok(client, cache):
    _make_dataset(cache, "a_set")
    r = client.post("/nori/capture/datasets/rename",
                    json={"repo_id": "a_set", "new_repo_id": "a_set"})
    assert r.status_code == 200


def _start_capture_with_episode(client) -> str:
    cid = client.post("/nori/capture/start", json={}).json()["capture_id"]
    client.post(f"/nori/capture/{cid}/episode",
                json={"index": 0, "event": "start", "t_ms": 0.0, "task": "t"})
    client.post(f"/nori/capture/{cid}/episode",
                json={"index": 0, "event": "stop", "t_ms": 1000.0})
    return cid


def test_finish_append_to_unknown_422(client, cache):
    cid = _start_capture_with_episode(client)
    r = client.post(f"/nori/capture/{cid}/finish", json={"append_to": "ghost"})
    assert r.status_code == 422
    assert "ghost" in r.json()["detail"]


def test_finish_name_and_append_mutually_exclusive(client, cache):
    _make_dataset(cache, "a_set")
    cid = _start_capture_with_episode(client)
    r = client.post(f"/nori/capture/{cid}/finish",
                    json={"name": "x", "append_to": "a_set"})
    assert r.status_code == 422
    assert "mutually exclusive" in r.json()["detail"]
