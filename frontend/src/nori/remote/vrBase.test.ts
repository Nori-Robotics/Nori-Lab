// NORI: Additive. Regression guard for the VR base-steering sign.
//
// Why this exists: "+angular = left" is OUR convention, but the firmware turns the base the
// opposite way, so every path has to negate angular on the way to the wire. The keyboard
// (teleop.ts BASE_KEYS) and scripts (ScriptDriver.base — see its own test) both got that fix;
// the VR thumbstick path did NOT, and steered mirrored on hardware for months. It slipped
// because the VR mapper had no tests at all.
//
// The VR path is special: RemoteTeleop sends an ExternalJog VERBATIM (teleop.ts — `dcSend({jog:
// this.externalJog})`, no sign fixups), so VrJogMapper must emit the WIRE sign directly rather
// than our internal one. Concretely: stick RIGHT must put a POSITIVE angular on the wire, which
// is the same sign the keyboard emits for its "turn right" key (d/l -> -(-1) = +1).
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
  it("stick right = turn right (positive angular on the wire)", () => {
    // The bug: this used to be negative, i.e. pushing right turned the robot LEFT.
    expect(baseOf(1)?.angular).toBeGreaterThan(0);
  });

  it("stick left = turn left (negative angular on the wire)", () => {
    expect(baseOf(-1)?.angular).toBeLessThan(0);
  });

  it("stick up = drive forward (positive linear)", () => {
    expect(baseOf(0, -1)?.linear).toBeGreaterThan(0); // WebXR reports stick-up as y = -1
  });

  it("ignores thumbstick slop inside the deadzone", () => {
    expect(new VrJogMapper().map({ right: stick(0.1, 0.1) }).jog).toBeNull();
  });
});
