# NORI: tests for nori_client's policy-bundle install flow (manifest +
# per-file downloads with hash verification). Pure offline — httpx is
# monkeypatched with a MockTransport standing in for Nori-Backend.

import hashlib
import json

import httpx
import pytest

from lelab import nori_client
from lelab.nori_client import NoriBackendError, NoriClient, _safe_bundle_name

REF = "11111111-2222-3333-4444-555555555555"
MODEL_BYTES = b"\x08\x00\x00\x00\x00\x00\x00\x00{}      " + b"\x00" * 16
CONFIG_BYTES = json.dumps({"type": "act", "chunk_size": 100}).encode()


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _mock_backend(manifest_files, file_bodies, monkeypatch):
    """Route manifest + file requests to canned responses via MockTransport."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/manifest"):
            return httpx.Response(200, json={"files": manifest_files})
        for name, body in file_bodies.items():
            if path.endswith(f"/files/{name}"):
                return httpx.Response(200, content=body)
        return httpx.Response(404, json={"detail": f"no route {path}"})

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(nori_client.httpx, "Client", patched_client)


class TestSafeBundleName:
    @pytest.mark.parametrize(
        "name", ["model.safetensors", "config.json", "policy_preprocessor.safetensors", "a-b_c.1"]
    )
    def test_accepts_plain_filenames(self, name):
        assert _safe_bundle_name(name)

    @pytest.mark.parametrize(
        "name",
        ["", "../evil", "a/b", "a\\b", ".hidden", "..", "/abs", "a" * 256, "café.json"],
    )
    def test_rejects_unsafe_names(self, name):
        assert not _safe_bundle_name(name)


class TestDownloadPolicyBundle:
    def _manifest(self):
        return [
            {"name": "model.safetensors", "size_bytes": len(MODEL_BYTES), "sha256": _sha(MODEL_BYTES)},
            {"name": "config.json", "size_bytes": len(CONFIG_BYTES), "sha256": _sha(CONFIG_BYTES)},
        ]

    def test_happy_path_installs_all_files(self, tmp_path, monkeypatch):
        _mock_backend(
            self._manifest(),
            {"model.safetensors": MODEL_BYTES, "config.json": CONFIG_BYTES},
            monkeypatch,
        )
        res = NoriClient(jwt="j").download_policy_bundle(REF, str(tmp_path))
        assert (tmp_path / "model.safetensors").read_bytes() == MODEL_BYTES
        assert (tmp_path / "config.json").read_bytes() == CONFIG_BYTES
        assert res["path"].endswith("model.safetensors")
        assert res["size_bytes"] == len(MODEL_BYTES) + len(CONFIG_BYTES)
        assert {f["name"] for f in res["files"]} == {"model.safetensors", "config.json"}
        assert not list(tmp_path.glob("*.part"))

    def test_hash_mismatch_refuses_install(self, tmp_path, monkeypatch):
        bad = self._manifest()
        bad[0]["sha256"] = "0" * 64
        _mock_backend(
            bad, {"model.safetensors": MODEL_BYTES, "config.json": CONFIG_BYTES}, monkeypatch
        )
        with pytest.raises(NoriBackendError, match="integrity failure"):
            NoriClient(jwt="j").download_policy_bundle(REF, str(tmp_path))
        assert not (tmp_path / "model.safetensors").exists()
        assert not list(tmp_path.glob("*.part"))

    def test_size_mismatch_refuses_install(self, tmp_path, monkeypatch):
        bad = self._manifest()
        bad[1]["size_bytes"] = 1
        _mock_backend(
            bad, {"model.safetensors": MODEL_BYTES, "config.json": CONFIG_BYTES}, monkeypatch
        )
        with pytest.raises(NoriBackendError, match="size mismatch"):
            NoriClient(jwt="j").download_policy_bundle(REF, str(tmp_path))
        assert not (tmp_path / "config.json").exists()

    def test_legacy_manifest_without_hashes_installs(self, tmp_path, monkeypatch):
        legacy = [{"name": "model.safetensors", "size_bytes": None, "sha256": None}]
        _mock_backend(legacy, {"model.safetensors": MODEL_BYTES}, monkeypatch)
        res = NoriClient(jwt="j").download_policy_bundle(REF, str(tmp_path))
        assert (tmp_path / "model.safetensors").read_bytes() == MODEL_BYTES
        assert res["size_bytes"] == len(MODEL_BYTES)

    def test_unsafe_manifest_name_rejected(self, tmp_path, monkeypatch):
        evil = [
            {"name": "model.safetensors", "size_bytes": None, "sha256": None},
            {"name": "../../evil.sh", "size_bytes": None, "sha256": None},
        ]
        _mock_backend(evil, {"model.safetensors": MODEL_BYTES}, monkeypatch)
        with pytest.raises(NoriBackendError, match="unsafe file name"):
            NoriClient(jwt="j").download_policy_bundle(REF, str(tmp_path))
        assert not (tmp_path.parent / "evil.sh").exists()

    def test_empty_manifest_rejected(self, tmp_path, monkeypatch):
        _mock_backend([], {}, monkeypatch)
        with pytest.raises(NoriBackendError, match="manifest is empty"):
            NoriClient(jwt="j").download_policy_bundle(REF, str(tmp_path))

    def test_bundle_without_model_rejected(self, tmp_path, monkeypatch):
        cfg_only = [{"name": "config.json", "size_bytes": len(CONFIG_BYTES), "sha256": _sha(CONFIG_BYTES)}]
        _mock_backend(cfg_only, {"config.json": CONFIG_BYTES}, monkeypatch)
        with pytest.raises(NoriBackendError, match="no model.safetensors"):
            NoriClient(jwt="j").download_policy_bundle(REF, str(tmp_path))

    def test_backend_error_on_file_surfaces_status(self, tmp_path, monkeypatch):
        # manifest lists a file the backend then 404s — no partial install.
        _mock_backend(self._manifest(), {"model.safetensors": MODEL_BYTES}, monkeypatch)
        with pytest.raises(NoriBackendError) as ei:
            NoriClient(jwt="j").download_policy_bundle(REF, str(tmp_path))
        assert ei.value.status_code == 404
        assert not list(tmp_path.glob("*.part"))
