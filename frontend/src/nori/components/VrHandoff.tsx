// NORI: Additive. The laptop→headset handoff for VR. The full app runs on the operator's
// machine (localhost in the desktop bundle); the headset can't reach that, so instead of
// "pushing" the user into VR we hand them a link to the PUBLIC hosted VR page (/nori/vr).
// They open it in the Quest browser, where they Connect + Enter VR. See DEPLOY_FRONTEND.md.

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

// The hosted VR origin. Baked as VITE_VR_BASE_URL in the full-app / desktop build (localhost
// can't be opened on a headset); falls back to the current origin when the app is itself hosted.
const vrBase = (): string =>
  import.meta.env.VITE_VR_BASE_URL?.replace(/\/+$/, "") || window.location.origin;

export function VrHandoff({ room, token }: { room: string; token: string }) {
  const [includeToken, setIncludeToken] = useState(false);
  const [copied, setCopied] = useState(false);

  const url = useMemo(() => {
    const u = new URL("/nori/vr", vrBase());
    if (room.trim()) u.searchParams.set("room", room.trim());
    let s = u.toString();
    // The token rides in the URL FRAGMENT (#), never the query: fragments are not sent to
    // the server, so the credential never lands in CDN/proxy access logs or the Referer
    // header. Room stays in the query (it's the semi-public serial). See DEPLOY_FRONTEND.md.
    if (includeToken && token.trim()) s += "#token=" + encodeURIComponent(token.trim());
    return s;
  }, [room, token, includeToken]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the text below is still selectable */ }
  };

  return (
    <div className="space-y-2 rounded-lg border border-[#14131a]/10 bg-background/60 p-3">
      <p className="text-sm font-medium">On a headset? Open this on your Quest browser:</p>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded bg-[#14131a]/5 px-2 py-1.5 font-mono text-xs"
          title={url}
        >
          {url}
        </code>
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={includeToken}
          onChange={(e) => setIncludeToken(e.target.checked)}
        />
        include access token (skip typing it on the headset)
      </label>
      {includeToken && (
        <p className="text-xs text-[#a06a1e]">
          Carries your access token in the URL fragment (kept out of server logs) — still,
          only open it on your own devices.
        </p>
      )}
    </div>
  );
}
