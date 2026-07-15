# The upload driver forwards the local dataset name as the session label
# (training-picker naming, backend migration 021).
from pathlib import Path
from unittest.mock import MagicMock, patch

from lelab.nori_client import NoriClient


def _client_with_stubbed_flow(tmp_path):
    c = NoriClient(jwt="x", base_url="https://backend.example")
    c._put_file = MagicMock()
    c.start_dataset_upload = MagicMock(
        return_value={"session_id": "s1",
                      "uploads": [{"path": "meta/info.json", "put_url": "https://put.example/x"}],
                      "expires_at": "z"}
    )
    c.finalize_dataset_upload = MagicMock(return_value={"id": "s1", "status": "PROMOTED"})
    c.get_dataset_upload = MagicMock(return_value={"id": "s1", "status": "PROMOTED"})
    return c


@patch("lelab.nori_client.validate_manifest")
@patch("lelab.nori_client.build_manifest", return_value=[{"path": "meta/info.json", "size": 1}])
def test_label_defaults_to_dataset_dir_name(_bm, _vm, tmp_path):
    c = _client_with_stubbed_flow(tmp_path)
    c.upload_dataset(str(tmp_path / "pick_place_mugs"))
    kwargs = c.start_dataset_upload.call_args.kwargs
    assert kwargs["label"] == "pick_place_mugs"


@patch("lelab.nori_client.validate_manifest")
@patch("lelab.nori_client.build_manifest", return_value=[{"path": "meta/info.json", "size": 1}])
def test_explicit_label_wins(_bm, _vm, tmp_path):
    c = _client_with_stubbed_flow(tmp_path)
    c.upload_dataset(str(tmp_path / "whatever"), label="nice name")
    assert c.start_dataset_upload.call_args.kwargs["label"] == "nice name"


def test_start_body_carries_label():
    c = NoriClient(jwt="x", base_url="https://backend.example")
    c._request = MagicMock(return_value={})
    c.start_dataset_upload([{"path": "p", "size": 1}], label="my set")
    body = c._request.call_args.kwargs["json"]
    assert body["label"] == "my set"


def test_start_body_omits_null_label():
    c = NoriClient(jwt="x", base_url="https://backend.example")
    c._request = MagicMock(return_value={})
    c.start_dataset_upload([{"path": "p", "size": 1}])
    assert "label" not in c._request.call_args.kwargs["json"]


# ---- idempotent upload (duplicate detection) --------------------------------

def _dataset_dir(tmp_path, name="move_red_cup", content=b"x" * 100):
    d = tmp_path / name
    (d / "meta").mkdir(parents=True)
    (d / "meta" / "info.json").write_text('{"codebase_version": "v3.0"}')
    (d / "data.parquet").write_bytes(content)
    return d


def _manifest_of(d):
    from lelab.nori_client import build_manifest
    return build_manifest(str(d))


def _promoted_row(d, session_id="s-old", finalized="2099-01-01T00:00:00+00:00"):
    return {
        "id": session_id,
        "status": "PROMOTED",
        "manifest": _manifest_of(d),
        "finalized_at": finalized,
    }


def _client_for_dedup(tmp_path, d, row):
    c = NoriClient(jwt="x", base_url="https://backend.example")
    c.list_my_datasets = MagicMock(return_value=[
        {"session_id": row["id"], "label": d.name, "created_at": "2099-01-01", "dataset_ref": "u/1/"},
    ])
    c.get_dataset_upload = MagicMock(return_value=row)
    c.start_dataset_upload = MagicMock()  # must NOT be called on dedup
    return c


def test_identical_unchanged_dataset_is_skipped(tmp_path):
    d = _dataset_dir(tmp_path)
    c = _client_for_dedup(tmp_path, d, _promoted_row(d))
    out = c.upload_dataset(str(d))
    assert out["deduplicated"] is True
    assert out["id"] == "s-old"
    c.start_dataset_upload.assert_not_called()


def test_changed_dataset_uploads(tmp_path):
    d = _dataset_dir(tmp_path)
    row = _promoted_row(d)
    (d / "data.parquet").write_bytes(b"y" * 150)  # size change -> manifest differs
    c = _client_for_dedup(tmp_path, d, row)
    c._put_file = MagicMock()
    c.start_dataset_upload = MagicMock(return_value={
        "session_id": "s-new",
        "uploads": [{"path": p["path"], "put_url": "https://put/x"} for p in _manifest_of(d)],
    })
    c.finalize_dataset_upload = MagicMock(return_value={"id": "s-new", "status": "PROMOTED"})
    c.get_dataset_upload = MagicMock(side_effect=[row, {"id": "s-new", "status": "PROMOTED"}])
    out = c.upload_dataset(str(d))
    assert "deduplicated" not in out
    c.start_dataset_upload.assert_called_once()


def test_same_size_but_newer_mtime_uploads(tmp_path):
    # Same manifest, but files touched AFTER the promoted session finalized ->
    # the mtime guard refuses to call it a duplicate.
    d = _dataset_dir(tmp_path)
    row = _promoted_row(d, finalized="2000-01-01T00:00:00+00:00")  # long ago
    c = _client_for_dedup(tmp_path, d, row)
    c._put_file = MagicMock()
    c.start_dataset_upload = MagicMock(return_value={
        "session_id": "s-new",
        "uploads": [{"path": p["path"], "put_url": "https://put/x"} for p in _manifest_of(d)],
    })
    c.finalize_dataset_upload = MagicMock(return_value={"id": "s-new", "status": "PROMOTED"})
    c.get_dataset_upload = MagicMock(side_effect=[row, {"id": "s-new", "status": "PROMOTED"}])
    out = c.upload_dataset(str(d))
    assert "deduplicated" not in out


def test_force_bypasses_dedup(tmp_path):
    d = _dataset_dir(tmp_path)
    c = _client_for_dedup(tmp_path, d, _promoted_row(d))
    c._put_file = MagicMock()
    c.start_dataset_upload = MagicMock(return_value={
        "session_id": "s-new",
        "uploads": [{"path": p["path"], "put_url": "https://put/x"} for p in _manifest_of(d)],
    })
    c.finalize_dataset_upload = MagicMock(return_value={"id": "s-new", "status": "PROMOTED"})
    c.get_dataset_upload = MagicMock(return_value={"id": "s-new", "status": "PROMOTED"})
    out = c.upload_dataset(str(d), force=True)
    assert "deduplicated" not in out
    c.start_dataset_upload.assert_called_once()


def test_dedup_check_failure_degrades_to_upload(tmp_path):
    d = _dataset_dir(tmp_path)
    c = NoriClient(jwt="x", base_url="https://backend.example")
    c.list_my_datasets = MagicMock(side_effect=RuntimeError("backend down"))
    c._put_file = MagicMock()
    c.start_dataset_upload = MagicMock(return_value={
        "session_id": "s-new",
        "uploads": [{"path": p["path"], "put_url": "https://put/x"} for p in _manifest_of(d)],
    })
    c.finalize_dataset_upload = MagicMock(return_value={"id": "s-new", "status": "PROMOTED"})
    c.get_dataset_upload = MagicMock(return_value={"id": "s-new", "status": "PROMOTED"})
    out = c.upload_dataset(str(d))
    assert out["status"] == "PROMOTED"
    c.start_dataset_upload.assert_called_once()
