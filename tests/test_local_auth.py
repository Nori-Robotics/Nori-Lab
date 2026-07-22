# Tests for lelab.local_auth — token persistence, the warn/enforce/off modes,
# cookie exchange, Host allowlist, and WebSocket coverage. These run against the
# real app (like the rest of the suite) with explicit LELAB_AUTH modes; the
# shared `client` fixture keeps auth off for every other test file.

from __future__ import annotations

import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from lelab import local_auth
from lelab.local_auth import COOKIE_NAME, get_or_create_local_token
from lelab.utils import config as cfg

TOKEN = "test-token-abc123"


@pytest.fixture(autouse=True)
def _fresh_warn_dedupe():
    local_auth._reset_warn_dedupe()
    yield


@pytest.fixture
def enforce_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Client with enforcement ON and a known token. base_url pins the Host
    header to localhost so the Host check passes unless a test overrides it."""
    monkeypatch.setenv("LELAB_AUTH", "enforce")
    monkeypatch.setenv("LELAB_TOKEN", TOKEN)
    from lelab.server import app

    return TestClient(app, base_url="http://localhost")


@pytest.fixture
def warn_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("LELAB_AUTH", "warn")
    monkeypatch.setenv("LELAB_TOKEN", TOKEN)
    from lelab.server import app

    return TestClient(app, base_url="http://localhost")


# ---------------------------------------------------------------- token store


def test_env_token_wins_and_writes_no_file(monkeypatch, tmp_path):
    monkeypatch.setattr(cfg, "LOCAL_AUTH_TOKEN_FILE", str(tmp_path / "tok"))
    monkeypatch.setenv("LELAB_TOKEN", "from-env")
    assert get_or_create_local_token() == "from-env"
    assert not (tmp_path / "tok").exists()


def test_file_token_created_stable_and_private(monkeypatch, tmp_path):
    monkeypatch.setattr(cfg, "LOCAL_AUTH_TOKEN_FILE", str(tmp_path / "sub" / "tok"))
    monkeypatch.delenv("LELAB_TOKEN", raising=False)
    first = get_or_create_local_token()
    assert first and first == get_or_create_local_token()
    path = Path(tmp_path / "sub" / "tok")
    assert path.read_text().strip() == first
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


# ---------------------------------------------------------------- enforce mode


def test_public_paths_stay_open(enforce_client):
    assert enforce_client.get("/nori/config").status_code == 200


def test_api_rejected_without_token(enforce_client):
    r = enforce_client.get("/teleoperation-status")
    assert r.status_code == 401
    assert "token" in r.json()["detail"].lower()


def test_api_rejected_with_wrong_token(enforce_client):
    r = enforce_client.get("/teleoperation-status", headers={"X-LeLab-Token": "nope"})
    assert r.status_code == 401


def test_header_token_accepted(enforce_client):
    r = enforce_client.get("/teleoperation-status", headers={"X-LeLab-Token": TOKEN})
    assert r.status_code == 200


def test_url_token_accepted_and_mints_cookie(enforce_client):
    r = enforce_client.get(f"/teleoperation-status?token={TOKEN}")
    assert r.status_code == 200
    set_cookie = r.headers["set-cookie"]
    assert f"{COOKIE_NAME}={TOKEN}" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=Strict" in set_cookie
    # TestClient persists the cookie: the follow-up carries no explicit token.
    assert enforce_client.get("/teleoperation-status").status_code == 200


def test_static_entrypoint_mints_cookie(enforce_client):
    """The launch URL hits the static index.html, not an API route — the cookie
    exchange must happen there too (skipped if dist isn't built locally)."""
    r = enforce_client.get(f"/?token={TOKEN}")
    if r.status_code == 404:
        pytest.skip("frontend/dist not built in this checkout")
    assert COOKIE_NAME in r.headers.get("set-cookie", "")


def test_untrusted_host_rejected_even_with_token(enforce_client):
    r = enforce_client.get(
        "/teleoperation-status",
        headers={"Host": "evil.example", "X-LeLab-Token": TOKEN},
    )
    assert r.status_code == 403
    assert "LELAB_ALLOWED_HOSTS" in r.json()["detail"]


def test_allowed_hosts_env_extends_allowlist(enforce_client, monkeypatch):
    monkeypatch.setenv("LELAB_ALLOWED_HOSTS", "my-tunnel.example, other.example:9999")
    r = enforce_client.get(
        "/teleoperation-status",
        headers={"Host": "my-tunnel.example:8000", "X-LeLab-Token": TOKEN},
    )
    assert r.status_code == 200


def test_options_never_rejected(enforce_client):
    """CORS preflights must not 401/403 — they carry no ambient authority."""
    r = enforce_client.options("/move-arm", headers={"Host": "evil.example"})
    assert r.status_code not in (401, 403)


# TestClient hardcodes Host: testserver on WS handshakes (ignoring base_url), so
# the accept-path test must present a trusted Host explicitly — real browsers
# send the true host here.
_WS_HOST = {"Host": "localhost"}


def test_websocket_rejected_without_token(enforce_client):
    with (
        pytest.raises(WebSocketDisconnect),
        enforce_client.websocket_connect("/ws/joint-data", headers=_WS_HOST),
    ):
        pass


def test_websocket_accepted_with_url_token(enforce_client):
    with enforce_client.websocket_connect(f"/ws/joint-data?token={TOKEN}", headers=_WS_HOST):
        pass


def test_unknown_path_is_public(enforce_client):
    """Anything not matching an API route falls through to the SPA mount (or
    404s) — never a 401. The frontend bundle is public by design."""
    assert enforce_client.get("/some/spa/route").status_code != 401


# ------------------------------------------------------------------ warn mode


def test_warn_mode_allows_and_logs(warn_client, caplog):
    with caplog.at_level("WARNING", logger="lelab.local_auth"):
        r = warn_client.get("/teleoperation-status")
    assert r.status_code == 200
    assert any("WOULD REJECT" in m for m in caplog.messages)


def test_warn_mode_dedupes_repeat_offenders(warn_client, caplog):
    with caplog.at_level("WARNING", logger="lelab.local_auth"):
        warn_client.get("/teleoperation-status")
        warn_client.get("/teleoperation-status")
    assert sum("WOULD REJECT" in m for m in caplog.messages) == 1


def test_warn_mode_quiet_when_authed(warn_client, caplog):
    with caplog.at_level("WARNING", logger="lelab.local_auth"):
        r = warn_client.get("/teleoperation-status", headers={"X-LeLab-Token": TOKEN})
    assert r.status_code == 200
    assert not any("WOULD REJECT" in m for m in caplog.messages)


# ------------------------------------------------------------------- off mode


def test_off_mode_skips_everything(monkeypatch, caplog):
    monkeypatch.setenv("LELAB_AUTH", "off")
    from lelab.server import app

    c = TestClient(app, base_url="http://localhost")
    with caplog.at_level("WARNING", logger="lelab.local_auth"):
        assert c.get("/teleoperation-status").status_code == 200
    assert not caplog.messages
