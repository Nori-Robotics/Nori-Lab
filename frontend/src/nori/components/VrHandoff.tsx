// NORI: Additive. The laptop→headset handoff for VR. The full app runs on the operator's
// machine (localhost in the desktop bundle); the headset can't reach that, so instead of
// "pushing" the user into VR we hand them a link to the PUBLIC hosted Remote page. They open
// it in the Quest browser, sign in, Connect, and press "Enter VR". See DEPLOY_FRONTEND.md.

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

// The hosted app origin. Baked as VITE_VR_BASE_URL in the full-app / desktop build (localhost
// can't be opened on a headset); falls back to the current origin when the app is itself hosted.
const vrBase = (): string =>
  import.meta.env.VITE_VR_BASE_URL?.replace(/\/+$/, "") || window.location.origin;

export function VrHandoff() {
  const [copied, setCopied] = useState(false);

  // Link straight to the Remote page — the headset signs in, Connects, and presses "Enter VR"
  // there. No room in the link: the active robot resolves from the signed-in account (the Pairing
  // selection) and Remote doesn't read a room query param. Room-token auth is retired, so the link
  // carries no secret either. See DEPLOY_FRONTEND.md.
  const url = useMemo(() => new URL("/nori/remote", vrBase()).toString(), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the text below is still selectable */ }
  };

  return (
    <div className="space-y-2 rounded-lg border border-nori-h14131a/10 bg-background/60 p-3">
      <p className="text-sm font-medium">
        On a headset? Open this on your Quest browser, then Connect and press "Enter VR":
      </p>
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
