# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Local-API auth: per-install capability token + Host allowlist middleware.

Threat model: LeLab binds 127.0.0.1 with no auth, so any web page open in a
browser on the same machine can drive it. Simple no-preflight POSTs
(/stop-teleoperation, /stop-recording, ...) execute from any origin regardless
of CORS, and DNS rebinding defeats Origin-based checks entirely — a rebound
page becomes "same-origin" with the API and can read every response.

The fix is a capability token, delivered once in the launch URL
(`http://localhost:8000/?token=...`, the Jupyter pattern) and exchanged by this
middleware for an HttpOnly SameSite=Strict cookie. Browsers then attach it
automatically to every fetch and WebSocket handshake from the app's own origin,
while a cross-site page can neither read nor send it, and a DNS-rebound page
gets no cookie because cookies match by hostname. A Host-header allowlist
backstops rebinding independently of the token.

Rollout (`LELAB_AUTH` env var):
    warn    (default) log requests that enforcement WOULD reject; block nothing.
    enforce reject them: 401/403 for HTTP, close(1008) for WebSockets.
    off     no checks, no logging.
The default stays "warn" until the frontend attaches tokens everywhere
(hosted `?api=` flow included) and field warn-logs are quiet; the flip to
"enforce" is a deliberate, separately-revertible change.

What is public even under "enforce":
    - anything served by the static frontend mount (the SPA bundle is public
      code and — by design — never contains the token),
    - `/nori/config` (the frontend bootstrap probes it pre-auth; blocking it
      makes a healthy local LeLab look dead, see NoriContext.tsx),
    - OPTIONS (CORS preflights carry no ambient authority and must not 401).

The robot never talks to this surface (LeLab is the client on every
robot-facing channel), so nothing here affects the Pi or WAN teleop.
"""

from __future__ import annotations

import logging
import os
import secrets
from collections.abc import Callable, Sequence
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
from starlette.routing import Mount
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocket

from .utils import config

logger = logging.getLogger(__name__)

COOKIE_NAME = "lelab_token"
TOKEN_QUERY_PARAM = "token"
TOKEN_HEADER = "x-lelab-token"
COOKIE_MAX_AGE = 30 * 24 * 3600  # re-minted on every launcher-opened page load

# Hostnames that are always trusted (loopback only — matches the bind address).
_DEFAULT_ALLOWED_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# Paths that stay public under enforcement. Keep this list tiny and justified:
# /nori/config is the frontend's pre-auth bootstrap probe (public by design).
PUBLIC_PATHS = frozenset({"/nori/config"})


def auth_mode() -> str:
    """Current mode: "warn" (default), "enforce", or "off". Read per-request so
    tests (and a stuck user) can change it without restarting the server."""
    mode = os.environ.get("LELAB_AUTH", "warn").strip().lower()
    return mode if mode in ("warn", "enforce", "off") else "warn"


def get_or_create_local_token() -> str:
    """The local API token: `LELAB_TOKEN` env if set (launcher/desktop shell),
    else a per-install secret persisted at `config.LOCAL_AUTH_TOKEN_FILE`
    (created 0600 on first use).

    Persistent-by-default is deliberate: a per-launch token would invalidate the
    browser's cookie on every restart, breaking bookmarked `localhost:8000` tabs.
    A per-install secret keeps those working while remaining unguessable.
    Deliberately uncached — it's a tiny local file read at localhost rates, and
    caching would leak state between tests that redirect the path.
    """
    env = os.environ.get("LELAB_TOKEN", "").strip()
    if env:
        return env
    path = Path(config.LOCAL_AUTH_TOKEN_FILE)
    try:
        token = path.read_text().strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    return token


def _hostname(host_header: str) -> str:
    """Hostname part of a Host header, lowercased, port and IPv6 brackets stripped."""
    host = host_header.strip().lower()
    if host.startswith("["):  # [::1]:8000
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if ":" in host else host


def _host_allowed(host_header: str) -> bool:
    """True if the Host header names loopback or an LELAB_ALLOWED_HOSTS entry.

    An EMPTY Host is allowed: browsers always send one (so the attack traffic we
    care about is covered), while some non-browser tooling doesn't.
    """
    if not host_header:
        return True
    name = _hostname(host_header)
    if name in _DEFAULT_ALLOWED_HOSTS:
        return True
    extra = os.environ.get("LELAB_ALLOWED_HOSTS", "")
    return name in {_hostname(h) for h in extra.split(",") if h.strip()}


# Warn-mode messages are deduped per (reason, method, path) so a polling page
# doesn't flood the log; the first occurrence of each is what matters.
_warned: set[tuple[str, str, str]] = set()


def _reset_warn_dedupe() -> None:
    """Test hook."""
    _warned.clear()


def _warn_once(reason: str, method: str, path: str, detail: str) -> None:
    key = (reason, method, path)
    if key in _warned:
        return
    _warned.add(key)
    logger.warning(
        "local-auth: WOULD REJECT %s %s (%s) — allowed because LELAB_AUTH=warn. %s "
        "This becomes a hard rejection when enforcement ships.",
        method,
        path,
        reason,
        detail,
    )


class LocalAuthMiddleware:
    """Pure ASGI middleware (NOT BaseHTTPMiddleware — that never sees WebSocket
    handshakes, and /ws/joint-data must be covered too).

    `routes_provider` returns the FastAPI app's route table; a request is
    "API" (protected) iff a non-Mount route matches its path. Everything that
    falls through to the static SPA mount is public. Matching against the real
    route table means new endpoints are protected automatically — no allowlist
    to forget to update.
    """

    def __init__(self, app: ASGIApp, routes_provider: Callable[[], Sequence]) -> None:
        self.app = app
        self._routes_provider = routes_provider
        self._api_matchers: list | None = None  # built lazily, after all routes register

    def _is_api_path(self, path: str) -> bool:
        if self._api_matchers is None:
            self._api_matchers = [
                r.path_regex
                for r in self._routes_provider()
                if not isinstance(r, Mount) and getattr(r, "path_regex", None) is not None
            ]
        return any(m.match(path) for m in self._api_matchers)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        mode = auth_mode()
        if mode == "off":
            return await self.app(scope, receive, send)

        method = scope.get("method", "WS")
        # CORS preflights carry no cookies and no ambient authority; rejecting
        # them would break legitimate cross-origin flows before auth even runs.
        if method == "OPTIONS":
            return await self.app(scope, receive, send)

        path = scope["path"]
        headers = Headers(scope=scope)
        expected = get_or_create_local_token()

        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        url_token = next(iter(query.get(TOKEN_QUERY_PARAM, [])), None)
        cookies = SimpleCookie()
        cookies.load(headers.get("cookie", ""))
        cookie_token = cookies[COOKIE_NAME].value if COOKIE_NAME in cookies else None
        header_token = headers.get(TOKEN_HEADER)

        presented = url_token or cookie_token or header_token
        authed = presented is not None and secrets.compare_digest(presented, expected)

        # A valid URL token mints the cookie on the response — the one-time
        # exchange that makes every later same-origin fetch/WS carry auth
        # automatically. Done on ANY response (the entry URL hits the static
        # index.html, not an API route).
        outbound = send
        if scope["type"] == "http" and url_token is not None and authed:

            async def send_with_cookie(message: Message) -> None:
                if message["type"] == "http.response.start":
                    MutableHeaders(scope=message).append(
                        "set-cookie",
                        f"{COOKIE_NAME}={expected}; Path=/; Max-Age={COOKIE_MAX_AGE}; "
                        "HttpOnly; SameSite=Strict",
                    )
                await send(message)

            outbound = send_with_cookie

        protected = path not in PUBLIC_PATHS and self._is_api_path(path)
        if not protected:
            return await self.app(scope, receive, outbound)

        host_header = headers.get("host", "")
        if not _host_allowed(host_header):
            # Independent of the token: a DNS-rebound page's requests arrive with
            # the attacker's hostname here even though they hit our socket.
            detail = (
                f"Host {host_header!r} is not a trusted hostname. If you reach LeLab through a "
                "tunnel or LAN address, add it to LELAB_ALLOWED_HOSTS (comma-separated)."
            )
            if mode == "warn":
                _warn_once("untrusted Host header", method, path, detail)
            else:
                return await self._reject(scope, receive, send, 403, detail)

        if not authed:
            detail = (
                "Missing or invalid local API token. Launch via `lelab` (or the desktop app) so the "
                "browser is opened with the token URL, or append ?token=<LELAB_TOKEN> once to set "
                "the auth cookie."
            )
            if mode == "warn":
                _warn_once("missing/invalid token", method, path, detail)
            else:
                return await self._reject(scope, receive, send, 401, detail)

        return await self.app(scope, receive, outbound)

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send, status: int, detail: str) -> None:
        if scope["type"] == "websocket":
            # Close-before-accept: uvicorn turns this into a 403 handshake reject.
            await WebSocket(scope, receive=receive, send=send).close(code=1008)
            return
        response = JSONResponse({"detail": detail}, status_code=status)
        await response(scope, receive, send)
