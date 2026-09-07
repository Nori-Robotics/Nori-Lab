// NORI: Additive file. Should this browser get the phone drive pad instead of the
// Remote console? Pure so it can be tested without a DOM; the Remote page calls it
// once on mount (not on resize — silently teleporting an operator off a live console
// because they rotated the phone or opened a keyboard is worse than a stale choice).

// Set when the operator explicitly asks for the full console from the phone page, so
// the auto-redirect doesn't bounce them straight back. Session-scoped on purpose: it
// is a "for this visit" override, not a preference to remember forever.
export const FORCE_CONSOLE_KEY = "nori_force_console";

export interface ViewportProbe {
  width: number;
  coarsePointer: boolean;   // matchMedia("(pointer: coarse)") — finger, not mouse
  forceConsole: boolean;    // the escape hatch above
}

// Phone, not "narrow window": BOTH a small viewport and a touch primary pointer.
// A part-width desktop browser is narrow but fine-pointered and keeps the console —
// it has the keyboard the console is built around.
export function prefersMobileDrive(p: ViewportProbe): boolean {
  if (p.forceConsole) return false;
  return p.coarsePointer && p.width <= 767;
}

// Read the probe off the live browser. Guarded for SSR/jsdom, where matchMedia may
// be missing — an absent matchMedia reads as fine-pointered, i.e. no redirect.
export function readViewport(): ViewportProbe {
  const mm = typeof window !== "undefined" ? window.matchMedia : undefined;
  let forceConsole = false;
  try { forceConsole = sessionStorage.getItem(FORCE_CONSOLE_KEY) === "1"; } catch { /* private mode */ }
  return {
    width: typeof window !== "undefined" ? window.innerWidth : 0,
    coarsePointer: mm ? window.matchMedia("(pointer: coarse)").matches : false,
    forceConsole,
  };
}
