// NORI: Additive. Regression guard for the VR base-steering sign.
//
// Why this exists: the VR thumbstick path once emitted a different base sign than the
// keyboard/script paths and steered mirrored on hardware for months — it slipped because the
// VR mapper had no tests at all. The convention has since been unified: EVERY jog producer
// (keyboard, scripts, VR) emits spec REP-103 — +linear = forward, +angular = turn LEFT — and
// the only robot that turns opposite (the frozen L2 fleet, angular only) gets its sign flipped
// in RemoteTeleop.wireJog behind a positive model match. So the mapper's contract is now the
// spec's: stick RIGHT = turn right = NEGATIVE angular, identical to what the keyboard's
// turn-right key emits. This test pins that the mapper stays sign-blind to the connected robot.
import { describe, it, expect } from "vitest";
import { VrJogMapper, type VrControllerFrame } from "@nori/sdk/vr";

// A right controller with the thumbstick pushed to (x, y) and nothing else touched.
function stick(x: number, y = 0): VrControllerFrame {
  return {
    position: [0, 0, 0],
    orientation: [0, 0, 0, 1],
    trigger: 0,
    squeeze: 0, // clutch released -> no arm jog, so `base` is all we get back
    thumbstick: { x, y },
  };
}

const baseOf = (x: number, y = 0) => new VrJogMapper().map({ right: stick(x, y) }).jog?.base;

describe("VR base steering", () => {
  it("stick right = turn right (negative angular, REP-103)", () => {
    expect(baseOf(1)?.angular).toBeLessThan(0);
  });

  it("stick left = turn left (positive angular, REP-103)", () => {
    expect(baseOf(-1)?.angular).toBeGreaterThan(0);
  });

  it("stick up = drive forward (positive linear)", () => {
    expect(baseOf(0, -1)?.linear).toBeGreaterThan(0); // WebXR reports stick-up as y = -1
  });

  it("ignores thumbstick slop inside the deadzone", () => {
    expect(new VrJogMapper().map({ right: stick(0.1, 0.1) }).jog).toBeNull();
  });
});
