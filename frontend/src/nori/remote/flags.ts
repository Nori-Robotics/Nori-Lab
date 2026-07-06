// NORI: Additive file. Phase 7 feature gates.
//
// M6 = full telepresence video (operator camera -> robot screen). Per the plan it is
// BUILT but shipped DARK: all the capture/self-view/track-attach code exists and is
// exercisable, but the UI is hidden and the camera is never acquired unless this flag is on.
// Flip it for local dev without a rebuild via the browser console:
//   localStorage.setItem("nori_m6_video", "1"); location.reload();
//
// Keep this the single place the app asks "is operator video on?" so turning M6 on later is
// a one-line change (or a build-time default), not a hunt through the call code.

export function isM6VideoEnabled(): boolean {
  try {
    return localStorage.getItem("nori_m6_video") === "1";
  } catch {
    return false;
  }
}

// Tier-1 script console (docs/llm_integration_plan.md): paste / run a TS script that drives the
// robot through @nori/sdk in a sandboxed Web Worker. Shipped DARK — the panel is hidden and no
// script can run unless this flag is on. Flip for local dev:
//   localStorage.setItem("nori_script_console", "1"); location.reload();
export function isScriptConsoleEnabled(): boolean {
  try {
    return localStorage.getItem("nori_script_console") === "1";
  } catch {
    return false;
  }
}
