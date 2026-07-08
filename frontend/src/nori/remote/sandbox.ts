// NORI: sandbox containment for the script worker (docs/llm_integration_plan.md, Phase B). The list
// of network/module escape-hatch globals to neuter, and the neutering itself — extracted from
// scriptWorker.ts so the SECURITY LOGIC is unit-testable deterministically (sandbox.test.ts). The
// load-bearing guarantee is structural (the worker has no RTCDataChannel); this is defense in depth.
//
// NOTE: true worker-vs-browser global isolation can only be verified in a real browser (the node
// test polyfills don't faithfully replicate a worker's global) — that stays the manual B5 check in
// docs/hardware_test_plan.md. Here we test that neuterGlobals() replaces each hatch with a thrower.

export const BLOCKED_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "EventSource"];

// Replace each named global on `target` with a function that throws when called, so a pasted script
// can't fetch / open a socket / import more code. Best-effort: redefine to a thrower, else delete,
// else leave (non-configurable — the no-datachannel guarantee still holds). WebAssembly is an object
// (not callable), so it's dropped to undefined rather than replaced with a thrower.
export function neuterGlobals(target: Record<string, unknown>, names: string[] = BLOCKED_GLOBALS): void {
  for (const name of names) {
    const thrower = () => {
      throw new Error(`${name} is disabled in the script sandbox`);
    };
    try {
      Object.defineProperty(target, name, { value: thrower, configurable: true, writable: false });
    } catch {
      try {
        delete target[name];
      } catch {
        /* non-configurable; the no-datachannel property still holds */
      }
    }
  }
  try {
    Object.defineProperty(target, "WebAssembly", { value: undefined, configurable: true });
  } catch {
    /* ignore */
  }
}
