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
