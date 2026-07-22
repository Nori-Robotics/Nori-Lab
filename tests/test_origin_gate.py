# NORI: the local-origin gate (server.py _local_origin_gate) — lelab's
# confused-deputy defense. All authority is ambient server-side (backend
# session, org tokens, the cloud-inference bearer), so a drive-by page POSTing
# to localhost:8000 would ride it: training dispatch, marketplace publish,
# dataset deletion, cloud-GPU /act. The gate refuses foreign origins BEFORE
# routing — stronger than CORS, which only gates response reads and cannot
# stop cross-site simple requests.

import pytest
from fastapi.testclient import TestClient

from lelab.server import app

# A harmless mutating route (no session -> {"unloaded": None}); the gate runs
# before routing, so the specific route doesn't matter — this one just proves
# allowed traffic still WORKS end to end.
TARGET = "/nori/rollout/unload"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_foreign_origin_refused_on_post(client):
    r = client.post(TARGET, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert "cross-origin" in r.json()["detail"]


def test_foreign_origin_refused_even_on_get(client):
    # Reads leak too (dataset listings, robot state) — the gate is not
    # mutation-only for the Origin check.
    r = client.get("/nori/rollout/status", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_null_origin_refused(client):
    # Sandboxed iframes / file:// pages send the literal string "null".
    r = client.post(TARGET, headers={"Origin": "null"})
    assert r.status_code == 403


def test_other_localhost_port_refused(client):
    # local->local is the PNA-bypassing case: another process serving a page on
    # a different localhost port is still a foreign origin.
    r = client.post(TARGET, headers={"Origin": "http://localhost:9999"})
    assert r.status_code == 403


def test_allowed_origins_pass(client):
    for origin in ("http://localhost:8000", "http://127.0.0.1:8000",
                   "http://localhost:8080"):
        r = client.post(TARGET, headers={"Origin": origin})
        assert r.status_code == 200, origin
        assert r.json() == {"unloaded": None}


def test_no_origin_passes(client):
    # curl / SDKs / same-origin GETs send no Origin — untouched.
    r = client.post(TARGET)
    assert r.status_code == 200


def test_cross_site_sec_fetch_backstop(client):
    # Origin absent but the browser stamped cross-site provenance: refuse the
    # mutation anyway.
    r = client.post(TARGET, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    # ...but a cross-site GET without Origin stays readable-by-design here
    # (the Origin check is the primary; this backstop is mutations-only).
    r = client.get("/nori/rollout/status", headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 200


def test_same_origin_sec_fetch_passes(client):
    r = client.post(TARGET, headers={"Sec-Fetch-Site": "same-origin",
                                     "Origin": "http://localhost:8000"})
    assert r.status_code == 200


def test_preflight_from_foreign_origin_dies(client):
    r = client.options(TARGET, headers={
        "Origin": "https://evil.example",
        "Access-Control-Request-Method": "POST",
    })
    # CORSMiddleware is OUTERMOST (added last), so a foreign preflight dies
    # there with 400 before the gate can 403 it — refused either way. What
    # matters: no approval header ever goes out.
    assert r.status_code in (400, 403)
    assert "access-control-allow-origin" not in r.headers


def test_preflight_from_allowed_origin_gets_cors(client):
    r = client.options(TARGET, headers={
        "Origin": "http://localhost:8080",
        "Access-Control-Request-Method": "POST",
    })
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "http://localhost:8080"
