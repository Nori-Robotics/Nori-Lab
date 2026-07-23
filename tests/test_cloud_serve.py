"""HTTP-surface tests for cloud_inference/serve (MODEL_KIND=fake, no GPU deps).

Covers what the GPU smokes can't cheaply: auth precedence (X-Nori-Token primary,
Bearer transition), readiness semantics (/ vs /ready), the frozen /act contract
+ per-policy meta plumbing, and error mapping. Adapters' model code is exercised
by in-image smokes instead."""

import base64
import importlib
import io
import sys
from pathlib import Path

import pytest

SERVE_DIR = Path(__file__).resolve().parents[1] / "cloud_inference" / "serve"
TOKEN = "test-token-123"


@pytest.fixture()
def client(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("MODEL_KIND", "fake")
    monkeypatch.setenv("NORI_INFER_TOKEN", TOKEN)
    monkeypatch.syspath_prepend(str(SERVE_DIR))
    for mod in ("server", "adapters", "adapters.base", "adapters.fake"):
        sys.modules.pop(mod, None)
    server = importlib.import_module("server")
    with TestClient(server.app) as c:   # context manager runs startup (background load)
        # fake adapter loads instantly, but don't race the thread
        for _ in range(200):
            if c.get("/ready").status_code == 200:
                break
        yield c


def _b64_image() -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (32, 24), (10, 20, 30)).save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def _act_body(**over):
    body = {"images": [_b64_image(), _b64_image()],
            "state": [0.0, 1.0, 2.0, 3.0, 4.0, 5.0],
            "instruction": "pick up the red cup"}
    body.update(over)
    return body


def test_root_and_health_are_200_with_meta(client):
    for route in ("/", "/health"):
        r = client.get(route)
        assert r.status_code == 200
        assert r.json()["kind"] == "fake"
    assert client.get("/ready").json()["meta"]["horizon"] == 5


def test_act_rejects_missing_and_bad_tokens(client):
    assert client.post("/act", json=_act_body()).status_code == 401
    r = client.post("/act", json=_act_body(), headers={"X-Nori-Token": "wrong"})
    assert r.status_code == 401
    r = client.post("/act", json=_act_body(), headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_act_accepts_x_nori_token_primary(client):
    r = client.post("/act", json=_act_body(), headers={"X-Nori-Token": TOKEN})
    assert r.status_code == 200
    out = r.json()
    assert len(out["actions"]) == 5 and len(out["actions"][0]) == 6
    # chunk semantics travel with every response — the client never assumes
    assert out["meta"]["chunk_hz"] == 15.0 and out["meta"]["kind"] == "fake"
    assert out["compute_ms"] >= 0


def test_act_accepts_bearer_transition(client):
    r = client.post("/act", json=_act_body(),
                    headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200


def test_act_bad_bearer_but_good_x_nori_token_passes(client):
    # The protected-endpoint reality: Authorization carries an HF token the app
    # can't verify — X-Nori-Token alone must be sufficient.
    r = client.post("/act", json=_act_body(),
                    headers={"Authorization": "Bearer hf_something_else",
                             "X-Nori-Token": TOKEN})
    assert r.status_code == 200


def test_act_enforces_adapter_image_cap(client):
    body = _act_body(images=[_b64_image()] * 3)   # fake caps max_images at 2
    r = client.post("/act", json=body, headers={"X-Nori-Token": TOKEN})
    assert r.status_code == 422


def test_act_adapter_contract_error_maps_to_422(client):
    r = client.post("/act", json=_act_body(state=[1.0, 2.0]),
                    headers={"X-Nori-Token": TOKEN})
    assert r.status_code == 422


def test_rtc_reported_unsupported_not_silently_dropped(client):
    r = client.post("/act", json=_act_body(rtc={"session": "s1", "delay": 2}),
                    headers={"X-Nori-Token": TOKEN})
    assert r.status_code == 200
    assert "unsupported" in (r.json()["rtc"] or {}).get("skipped", "")


def test_point_501_without_pointing_backbone(client):
    r = client.post("/point", json={"image": _b64_image(), "query": "cup"},
                    headers={"X-Nori-Token": TOKEN})
    assert r.status_code == 501
