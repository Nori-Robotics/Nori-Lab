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

export function VrHandoff({ room }: { room: string }) {
  const [copied, setCopied] = useState(false);

  const url = useMemo(() => {
    const u = new URL("/nori/vr", vrBase());
    // Room stays in the query (it's the semi-public serial). Room-token auth is retired — the
    // robot gates private rooms via Supabase RLS — so the link carries no secret. See
    // DEPLOY_FRONTEND.md.
    if (room.trim()) u.searchParams.set("room", room.trim());
    return u.toString();
  }, [room]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the text below is still selectable */ }
  };

  return (
    <div className="space-y-2 rounded-lg border border-nori-h14131a/10 bg-background/60 p-3">
      <p className="text-sm font-medium">On a headset? Open this on your Quest browser:</p>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded bg-nori-h14131a/5 px-2 py-1.5 font-mono text-xs"
          title={url}
        >
          {url}
        </code>
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
