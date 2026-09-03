// NORI: Additive. FROZEN L2 REGRESSION GOLDEN for the VR arm mapper.
//
// The deployed L-series fleet is frozen: those robots will never speak the A3
// cartesian task vocabulary, and their operators must see no change from any
// A3 work. The mapper is shared code — the hosted VR page is ONE bundle that
// serves both fleets, because the robot is chosen at runtime by its pairing
// code, not by which build the operator loaded. So the fleets cannot be
// separated by shipping two tools; they are separated by the descriptor gate,
// and this file is what proves the gate holds.
//
// `vrL2Golden.json` was captured from the mapper as it stood at commit bf7f375,
// BEFORE the cartesian vocabulary existed, over a 61-frame sequence that covers
// clutch engage/release/re-engage, translation on all three axes, wrist
// rotation, gripper toggling, thumbstick base steering, a non-zero control yaw
// (post-recenter), and a tracking jump. A mapper with no descriptor must
// reproduce it EXACTLY.
//
// If this fails, an A3 change leaked into the L2 path. That is a customer-facing
// regression, not a test to update — regenerate the golden only when the L2
// behaviour is being changed on purpose.
import { describe, it, expect } from "vitest";
import { VrJogMapper, type VrControllerFrame } from "@nori/sdk/vr";
import GOLDEN from "./vrL2Golden.json";

// Must stay identical to the sequence the golden was captured from.
const SEQ: Array<[number, number, number, [number, number, number, number], number, number, number, number]> = [];
for (let i = 0; i < 60; i++) {
  const t = i / 60;
  SEQ.push([
    Math.sin(t * 6) * 0.08, Math.cos(t * 5) * 0.06, -t * 0.15,
    [Math.sin(t * 2) * 0.3, Math.sin(t * 3) * 0.2, Math.cos(t * 4) * 0.25, 1],
    i < 5 ? 0 : (i > 45 && i < 50 ? 0 : 1),   // clutch drops mid-run and re-engages
    i % 7 === 0 ? 1 : 0,                       // trigger toggles
    Math.sin(t * 4), Math.cos(t * 3),          // thumbstick
  ]);
}
SEQ.push([9, 9, 9, [0, 0, 0, 1], 1, 0, 0, 0]); // tracking jump -> baseline reset

function replay(descriptor?: unknown) {
  const m = new VrJogMapper();
  if (descriptor !== undefined) m.setDescriptor(descriptor as never);
  m.setControlYaw(0.4);
  return SEQ.map(([x, y, z, q, sq, tr, sx, sy]) => {
    const f: VrControllerFrame = {
      position: [x, y, z], orientation: q, trigger: tr, squeeze: sq,
      thumbstick: { x: sx, y: sy },
    };
    return JSON.parse(JSON.stringify(m.map({ left: f, right: f, controls: {} })));
  });
}

describe("L2 VR mapper is frozen", () => {
  it("no descriptor reproduces the pre-cartesian output exactly", () => {
    expect(replay()).toEqual(GOLDEN);
  });

  it("a descriptor without jog_scale.task also reproduces it exactly", () => {
    // Every deployed L2 daemon sends a descriptor — it just never carries a
    // task vocabulary. That must land on the legacy path, not merely near it.
    expect(replay({ joints: [], jog_scale: { joints: { "left_arm_shoulder_pan.pos": 12 } } }))
      .toEqual(GOLDEN);
  });

  it("an A3 descriptor DOES change the output (the golden is not vacuous)", () => {
    // Guards the guard: if setDescriptor silently stopped working, both tests
    // above would pass while the gate was dead.
    expect(replay({ jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08 } } }))
      .not.toEqual(GOLDEN);
  });
});
