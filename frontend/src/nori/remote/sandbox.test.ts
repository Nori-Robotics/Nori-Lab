// NORI: B5 — sandbox neutering logic. Deterministic (no worker, no network): drive neuterGlobals()
// on a fake global carrying each escape hatch and confirm they become throwers. (True worker-vs-
// browser global isolation is a manual browser check — see docs/hardware_test_plan.md §1.)

import { describe, expect, it } from "vitest";
import { BLOCKED_GLOBALS, neuterGlobals } from "./sandbox";

// A fake global with every hatch initially present and working (as a real browser worker would have).
function fakeGlobal(): Record<string, unknown> {
  return {
    fetch: () => Promise.resolve("net!"),
    XMLHttpRequest: function () {},
    WebSocket: function () {},
    importScripts: () => {},
    EventSource: function () {},
    WebAssembly: { instantiate: () => {} },
    // a benign global that must be left alone:
    Math,
  };
}

describe("sandbox neutering (B5)", () => {
  it("replaces every escape-hatch global with a thrower", () => {
    const g = fakeGlobal();
    neuterGlobals(g);
    for (const name of BLOCKED_GLOBALS) {
      expect(() => (g[name] as () => void)()).toThrow(/is disabled in the script sandbox/i);
    }
  });

  it("drops WebAssembly to undefined (object, not callable)", () => {
    const g = fakeGlobal();
    neuterGlobals(g);
    expect(g.WebAssembly).toBeUndefined();
  });

  it("neuters a hatch even when it is initially ABSENT", () => {
    const g: Record<string, unknown> = {}; // nothing defined (e.g. a lean runtime)
    neuterGlobals(g);
    expect(() => (g.fetch as () => void)()).toThrow(/fetch is disabled/i);
    expect(() => (g.WebSocket as () => void)()).toThrow(/WebSocket is disabled/i);
  });

  it("leaves non-hatch globals untouched", () => {
    const g = fakeGlobal();
    neuterGlobals(g);
    expect(g.Math).toBe(Math);
  });
});
