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


def test_same_site_no_origin_refused(client):
    # Pentest 2026-08-14: a page on ANOTHER localhost PORT is `same-site` (not
    # cross-site), and its <img>/subresource GET omits Origin. This is the
    # local->local bypass — the SameSite=Strict lelab_token cookie would ride
    # along on a same-site request, so the gate must refuse it just like cross-site.
    r = client.get("/nori/rollout/status", headers={"Sec-Fetch-Site": "same-site"})
    assert r.status_code == 403
    r = client.post(TARGET, headers={"Sec-Fetch-Site": "same-site"})
    assert r.status_code == 403


def test_same_site_with_allowlisted_origin_passes(client):
    # Vite dev (localhost:8080 -> localhost:8000) is same-site but carries an
    # ALLOWLISTED Origin -> primary check vouches, backstop exempts it. Must pass.
    r = client.post(TARGET, headers={"Origin": "http://localhost:8080",
                                     "Sec-Fetch-Site": "same-site"})
    assert r.status_code == 200
    assert r.json() == {"unloaded": None}


def test_same_origin_no_origin_passes(client):
    # The served local UI calling itself is `same-origin` and omits Origin on GETs
    # — the one legitimate no-Origin browser caller. Must still pass.
    r = client.get("/nori/rollout/status", headers={"Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 200


def test_allowed_origins_pass(client):
    for origin in ("http://localhost:8000", "http://127.0.0.1:8000",
                   "http://localhost:8080"):
        r = client.post(TARGET, headers={"Origin": origin})
        assert r.status_code == 200, origin
        assert r.json() == {"unloaded": None}


def test_hosted_ui_origin_passes(client):
    # The deployed first-party page (lab.norirobotics.com) driving a LOCAL backend —
    # the flow the gate's first cut broke: post-disconnect config/status fetches got
    # 403 (gate) / 400 (CORS preflight) and the UI crashed. HTTPS origin only; and
    # the sibling test below pins that lookalike domains stay refused.
    # Sec-Fetch-Site MUST be in the test: real browsers stamp hosted->localhost as
    # cross-site (it IS cross-site), and the backstop's first cut refused every such
    # mutation even with an allowlisted Origin ("Provision account failed").
    r = client.post(TARGET, headers={"Origin": "https://lab.norirobotics.com",
                                     "Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 200
    # CORS layer must grant the read too (the browser enforces from the header).
    assert r.headers.get("access-control-allow-origin") == "https://lab.norirobotics.com"


def test_hosted_ui_lookalikes_refused(client):
    for origin in ("http://lab.norirobotics.com",          # plaintext downgrade
                   "https://lab.norirobotics.com.evil.io", # suffix trick
                   "https://evil-lab.norirobotics.com.attacker.example",
                   "https://labnorirobotics.com"):
        r = client.post(TARGET, headers={"Origin": origin})
        assert r.status_code == 403, origin


def test_no_origin_passes(client):
    # curl / SDKs / same-origin GETs send no Origin — untouched.
    r = client.post(TARGET)
    assert r.status_code == 200


def test_cross_site_sec_fetch_backstop(client):
    # Origin absent but the browser stamped cross-site provenance: refuse the
    # mutation anyway.
    r = client.post(TARGET, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    # An UNLISTED origin + cross-site stays refused too (the exemption is only
    # for allowlisted origins, where the primary check already vouched).
    r = client.post(TARGET, headers={"Origin": "https://evil.example",
                                     "Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    # A cross-site GET without Origin is ALSO refused (pentest V7): browsers omit
    # Origin on <img>/<script> subresource GETs, and some GET endpoints have
    # hardware side effects (leader-bus identify opens the serial bus), so an
    # <img src=".../identify"> drive-by is a cross-site Origin-less GET — caught here.
    r = client.get("/nori/rollout/status", headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


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
