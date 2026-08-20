// Is this page being served from the internet, rather than from a LeLab server
// on the user's own machine or LAN?
//
// This decides where CLOUD data (library, customers, marketplace, training) is
// fetched from. Getting it from reachability instead — "did localhost:8000
// answer?" — was the cause of a real outage: a hosted page with a local LeLab
// running would route its cloud reads through that laptop, and the hosted
// origin has no way to authenticate to it (the local API's cookie is
// SameSite=Strict and CORS runs with allow_credentials=False), so every request
// 401'd with "Missing or invalid local API token".
//
// Deliberately conservative: anything that could be a LeLab server the user
// reached over their own network counts as NOT hosted, so this can only ever
// move traffic away from someone's laptop and never towards it.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** RFC1918 + link-local + mDNS — a machine on the user's own network. */
function isPrivateHost(host: string): boolean {
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

export function isHostedOrigin(hostname?: string): boolean {
  const host =
    hostname ?? (typeof window !== "undefined" ? window.location.hostname : "");
  if (!host) return false; // no window (SSR/tests) — assume local, the safe side
  const h = host.toLowerCase();
  if (LOOPBACK.has(h)) return false;
  if (isPrivateHost(h)) return false;
  return true;
}
