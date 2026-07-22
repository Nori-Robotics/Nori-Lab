// Local-API auth, frontend side (backend counterpart: lelab/local_auth.py).
//
// The lelab launcher (and later the desktop shell) append ?token=<local API
// token> to the launch URL. On SAME-ORIGIN pages this module is not strictly
// needed — the server exchanges the URL token for an HttpOnly SameSite=Strict
// cookie before the SPA even boots, and the browser attaches it to every
// fetch/WebSocket automatically. It exists for the CROSS-ORIGIN flows where
// that cookie can't carry auth: `lelab --dev` (page on :8080, API on :8000)
// and a hosted page pointed at a LeLab server via ?api=. Here the token is
// picked out of the URL, persisted, scrubbed from the address bar, and sent
// as a request header (fetch) or query param (WebSocket — no headers there).
//
// Never attach the token to non-LeLab URLs: it is a local capability secret.
// ApiContext.fetchWithHeaders gates on the request targeting `baseUrl`;
// lelabFetch call sites target the LeLab API by construction.

const STORAGE_KEY = "lelab.apiToken";
export const LOCAL_TOKEN_HEADER = "X-LeLab-Token";

let token: string | null = null;
let initialized = false;

/** Pick up ?token= from the launch URL and scrub it from the address bar (and
 * thus history/bookmarks/screen-shares). Other params (?api=, ?room=) are
 * preserved. Idempotent; called from main.tsx before the app renders so no
 * fetch can race it. */
export function initLocalAuth(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("token");
    if (fromQuery) {
      window.localStorage.setItem(STORAGE_KEY, fromQuery);
      url.searchParams.delete("token");
      window.history.replaceState(window.history.state, "", url.toString());
      token = fromQuery;
      return;
    }
    token = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage/History unavailable (rare embedded contexts). Same-origin pages
    // still work via the cookie; cross-origin calls will warn server-side.
  }
}

export function getLocalToken(): string | null {
  if (!initialized) initLocalAuth();
  return token;
}

/** fetch() with the local API token attached — for LeLab-targeted calls that
 * don't go through ApiContext.fetchWithHeaders (the raw call sites in
 * nori/remote/*). NEVER use for third-party URLs. */
export function lelabFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const t = getLocalToken();
  if (!t) return fetch(input, init);
  return fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), [LOCAL_TOKEN_HEADER]: t },
  });
}

/** Append ?token= to a LeLab WebSocket URL. Browsers can't set WS handshake
 * headers; the cookie covers same-origin, this covers dev/?api= cross-origin. */
export function tokenizeWsUrl(url: string): string {
  const t = getLocalToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}

/** Test hook: forget picked-up state so each test starts clean. */
export function resetLocalAuthForTests(): void {
  initialized = false;
  token = null;
}
