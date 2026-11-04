// NORI: Additive. A3 VR gripper: hold to move, alternating direction, release
// holds (2026-11-02). The old mapping closed whenever the trigger was up, so a
// held object was squeezed for as long as the arm was clutched; it crushed a
// test box. These pin the replacement through the mapper, as the headset uses it.
import { describe, it, expect } from "vitest";
import { VrJogMapper, type VrControllerFrame } from "@nori/sdk/vr";

const A3 = { jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08 } } };
const HOLD = "right_arm_gripper.pos";

function rig(gripperPos = 50, cartesian = true) {
  const m = new VrJogMapper();
  m.setDescriptor((cartesian ? A3 : { jog_scale: { joints: {} } }) as never);
  m.setTuning({ gripperOpenRate: 0.4 });
  m.setGripperPos(null, gripperPos);
  const frame = (trigger: number, clutch = 1): VrControllerFrame => ({
    position: [0, 0, 0], orientation: [0, 0, 0, 1], trigger, squeeze: clutch, thumbstick: { x: 0, y: 0 },
  });
  const step = (trigger: number, clutch = 1) => {
    const r = m.map({ right: frame(trigger, clutch) }, 1 / 72);
    return { rate: r.jog?.right_arm?.gripper ?? null, hold: r.action[HOLD] };
  };
  return { m, step };
}

describe("A3 VR gripper: hold to move, alternating direction", () => {
  it("first squeeze closes, release stops and holds, next squeeze opens", () => {
    const { m, step } = rig(50);
    step(0);                                    // clutch engages, trigger up
    expect(step(0).rate).toBe(0);               // trigger up does NOT close any more
    expect(step(1).rate).toBeCloseTo(-0.4);     // squeeze 1: close
    m.setGripperPos(null, 30);                  // jaws moved while held
    expect(step(1).rate).toBeCloseTo(-0.4);
    const rel = step(0);                        // release
    expect(rel.rate).toBe(0);
    expect(rel.hold).toBe(30);                  // held exactly where the jaws are
    expect(step(1).rate).toBeCloseTo(0.4);      // squeeze 2: open
    step(0);
    expect(step(1).rate).toBeCloseTo(-0.4);     // squeeze 3: close again
  });

  it("releasing holds once, briefly, and never keeps tightening", () => {
    const { step } = rig(40);
    step(0); step(1); step(1);
    const holds = [];
    for (let k = 0; k < 20; k++) { const s = step(0); holds.push(s.hold); expect(s.rate).toBe(0); }
    const sent = holds.filter((h) => h !== undefined);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(10);       // a short burst, not a stream
    expect(new Set(sent).size).toBe(1);         // one position, not ratcheting
  });

  it("opens and closes at the same tuned speed", () => {
    const { step } = rig(50);
    step(0);
    const close = step(1).rate!; step(0);
    const open = step(1).rate!;
    expect(open).toBeCloseTo(-close);
  });

  it("a squeeze with the jaws fully open closes, fully closed opens", () => {
    const a = rig(98);
    a.step(0); a.step(1); a.step(0);             // that squeeze closed; next would open...
    a.m.setGripperPos(null, 99);                 // ...but the jaws are fully open
    expect(a.step(1).rate).toBeLessThan(0);
    const b = rig(2);
    b.step(0);
    expect(b.step(1).rate).toBeGreaterThan(0);   // first squeeze, already closed: opens
  });

  it("letting go of the clutch mid-squeeze ends the squeeze: hold and reverse", () => {
    const { m, step } = rig(60);
    step(0); step(1); step(1);                   // closing
    m.setGripperPos(null, 45);
    const off = step(1, 0);                      // clutch released, trigger still held
    expect(off.hold).toBe(45);
    step(0, 1);                                  // re-clutch, trigger up
    expect(step(1).rate).toBeGreaterThan(0);     // next squeeze opens
  });
});

describe("legacy (L2) gripper is unchanged", () => {
  it("trigger up still closes, held opens", () => {
    const { step } = rig(50, false);
    step(0);
    expect(step(0).rate!).toBeLessThan(0);
    expect(step(1).rate!).toBeGreaterThan(0);
    expect(step(0).hold).toBeUndefined();
  });
});
