// NORI: Additive. Regression guard for the VR arm-axis VOCABULARY.
//
// Why this exists: the mapper emits jog keys by NAME, and the A3 gateway routes by
// name — shorts in its TASK_SHORTS (x/y/z/pitch/yaw + the shoulder_pan alias) drive
// the task-space lane, everything else the per-joint lane. So sending a legacy key
// to an A3 does not fail loudly, it moves a DIFFERENT AXIS.
//
// That is exactly what shipped: the mapper carried the L2 cylindrical vocabulary,
// where `y` means reach-plane HEIGHT and lateral hand motion drives `shoulder_pan`.
// On an A3 the gateway reads `y` as linear-y (SIDEWAYS) and `shoulder_pan` as a yaw
// (ROTATE), and vertical Cartesian had no key at all. Same failure shape as the base
// steering sign in vrBase.test.ts — silently wrong, for months, because the mapper
// had no tests.
//
// The gate is the PRESENCE of descriptor.jog_scale.task, mirroring teleop.ts's
// taskKeymapFor for the keyboard. Never a model string.
import { describe, it, expect } from "vitest";
import { VrJogMapper, type VrControllerFrame } from "@nori/sdk/vr";

// An A3-shaped descriptor: what matters is only that jog_scale.task EXISTS.
const A3 = { jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08, pitch: 0.25, yaw: 0.25 } } };

// A left controller at `pos` with the clutch squeezed.
function hand(pos: [number, number, number]): VrControllerFrame {
  return {
    position: pos,
    orientation: [0, 0, 0, 1],
    trigger: 0,
    squeeze: 1,          // clutch engaged
    thumbstick: { x: 0, y: 0 },
  };
}

// Drive the mapper two frames: the first engages the clutch and establishes the
// baseline (motion starts at rest), the second is the one that produces jog.
function moveBy(delta: [number, number, number], descriptor?: unknown) {
  const m = new VrJogMapper();
  if (descriptor !== undefined) m.setDescriptor(descriptor as never);
  m.map({ left: hand([0, 0, 0]) });
  return m.map({ left: hand(delta) }).jog?.left_arm ?? {};
}

// WebXR: +X right, +Y up, and the operator faces −Z, so −Z is forward.
const FORWARD: [number, number, number] = [0, 0, -0.05];
const UP: [number, number, number] = [0, 0.05, 0];
const RIGHT: [number, number, number] = [0.05, 0, 0];

describe("VR arm vocabulary — legacy (no descriptor)", () => {
  it("emits the L2 cylindrical key set, unchanged", () => {
    expect(Object.keys(moveBy(FORWARD)).sort())
      .toEqual(["gripper", "pitch", "shoulder_pan", "wrist_roll", "x", "y"]);
  });

  it("vertical hand motion drives `y` (reach-plane height)", () => {
    expect(moveBy(UP).y).toBeGreaterThan(0);
  });

  it("lateral hand motion drives `shoulder_pan`", () => {
    expect(moveBy(RIGHT).shoulder_pan).toBeGreaterThan(0);
  });

  it("never emits `z` — the browser vocabulary predates it", () => {
    expect(moveBy(UP).z).toBeUndefined();
  });
});

describe("VR arm vocabulary — cartesian (descriptor advertises jog_scale.task)", () => {
  it("emits translations, task rotation, and the roll joint", () => {
    // Rotation is back on the task lane after the wrist-joint attempt came out
    // inverted on hardware (2026-09-03). It stays an IK constraint until the
    // absolute-wrist rework lands — see the REVERTED note in vr.ts.
    expect(Object.keys(moveBy(FORWARD, A3)).sort())
      .toEqual(["gripper", "pitch", "wrist_roll", "x", "y", "yaw", "z"]);
  });

  it("forward hand motion drives +x (REP-103 forward)", () => {
    expect(moveBy(FORWARD, A3).x).toBeGreaterThan(0);
  });

  it("vertical hand motion drives +z, NOT y — the bug this fixes", () => {
    const arm = moveBy(UP, A3);
    expect(arm.z).toBeGreaterThan(0);
    // toBeCloseTo, not toBe: the lateral term is `-dx`, so a still hand yields -0.
    expect(arm.y).toBeCloseTo(0, 10);
  });

  it("hand right drives −y, since REP-103 +y is LEFT", () => {
    expect(moveBy(RIGHT, A3).y).toBeLessThan(0);
  });

  it("all three translation axes share one scale", () => {
    expect(Math.abs(moveBy(RIGHT, A3).y)).toBeCloseTo(Math.abs(moveBy(UP, A3).z), 6);
  });
});

describe("VR cartesian is POSITION control, scaled by the descriptor", () => {
  // The whole point: rate = hand metres / (advertised m/s x frame period). The
  // old code divided by the L2 daemon's 8.1 mm step, so an A3 tracked the hand
  // at ~26% and any brisk motion pinned the clamp — "moves by how long you hold
  // it, not how far you moved" (operator report, 2026-09-03).
  const at = (metres: number, d: unknown = A3) =>
    moveBy([0, 0, -metres], d).x as number;

  it("twice the hand distance asks for twice the rate", () => {
    // Deltas kept well under one frame's travel (A3 fixture: 0.08 m/s) so the
    // proportionality is visible rather than clipped at the rate ceiling.
    expect(at(0.0004)).toBeCloseTo(2 * at(0.0002), 6);
  });

  it("a robot advertising twice the speed gets half the rate for the same motion", () => {
    // This is the anti-staleness property: change task_linear_mps on the robot
    // and the client follows, instead of silently mis-scaling as it did here.
    const fast = { jog_scale: { task: { x: 0.16, y: 0.16, z: 0.16 } } };
    expect(at(0.0002, fast)).toBeCloseTo(at(0.0002) / 2, 6);
  });

  it("a hand move the robot cannot cover in one frame clamps at full rate", () => {
    // 5 cm in one frame is far past 0.15 m/s; the rate saturates rather than
    // wrapping or going negative.
    expect(at(0.05)).toBe(1);
  });

  it("falls back to an A3-shaped step when jog_scale carries no task speed", () => {
    // Never the L2 constants — those describe a different robot.
    const bare = { jog_scale: { task: {} } };
    expect(at(0.0002, bare)).toBeGreaterThan(0);
    expect(at(0.0002, bare)).toBeLessThanOrEqual(1);
  });
});

describe("VR arm vocabulary — the gate itself", () => {
  it("a descriptor WITHOUT jog_scale.task keeps the legacy keys", () => {
    // Every L2 daemon: it sends a descriptor, just never a task vocabulary.
    expect(Object.keys(moveBy(FORWARD, { jog_scale: { joints: {} } })).sort())
      .toEqual(["gripper", "pitch", "shoulder_pan", "wrist_roll", "x", "y"]);
  });

  it("switching vocabulary mid-session needs no re-clutch", () => {
    // robotInfo() refreshes on daemon reconnect, so the session re-reads this every
    // frame; a vocabulary change must not strand a held clutch.
    const m = new VrJogMapper();
    m.map({ left: hand([0, 0, 0]) });
    m.map({ left: hand([0, 0.05, 0]) });
    m.setDescriptor(A3 as never);
    const arm = m.map({ left: hand([0, 0.1, 0]) }).jog?.left_arm ?? {};
    expect(arm.z).toBeGreaterThan(0);
  });

  it("isCartesian reports the active vocabulary", () => {
    const m = new VrJogMapper();
    expect(m.isCartesian).toBe(false);
    m.setDescriptor(A3 as never);
    expect(m.isCartesian).toBe(true);
  });
});
