// NORI: Additive file. Links out to the hosted docs site.
//
// The docs are deliberately NOT bundled into the app. The desktop build freezes
// frontend/dist into the Tauri bundle, so anything shipped inside the app is only as fresh
// as the user's installed version — which is backwards for the pages people read precisely
// when something is broken. The docs deploy on their own cadence (docs/ -> its own Vercel
// project) and we link out to them.
//
// Opening a docs URL in the DESKTOP app needs care: the Tauri window IS the app (a webview
// pointed at the local backend), so a plain <a href> or window.open() would navigate the app
// away from itself with no way back. On desktop we hand the URL to the OS instead, via
// tauri-plugin-opener, which opens the user's real browser.

export const DOCS_URL =
  import.meta.env.VITE_DOCS_URL?.replace(/\/$/, "") ?? "https://docs.norirobotics.com";

/** True when running inside the Tauri desktop shell rather than a browser tab. */
const isDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Resolve a docs path ("/troubleshooting/connection") to an absolute URL.
 * A bare path is joined onto DOCS_URL; an absolute URL is passed through.
 */
export const docsUrl = (path = "/") =>
  /^https?:\/\//.test(path)
    ? path
    : `${DOCS_URL}${path.startsWith("/") ? path : `/${path}`}`;

/**
 * Open the docs. On desktop this goes to the system browser; on the web, a new tab.
 *
 * Falls back to window.open if the opener plugin is unavailable — an older desktop build
 * without the plugin would otherwise silently do nothing. That fallback navigates the
 * webview, which is degraded but strictly better than a dead link.
 */
export const openDocs = async (path = "/"): Promise<void> => {
  const url = docsUrl(path);

  if (isDesktop()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      // Plugin missing or refused — fall through to the web path.
    }
  }

  window.open(url, "_blank", "noopener,noreferrer");
};
