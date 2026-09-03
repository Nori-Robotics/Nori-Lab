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
  it("emits the A3 cartesian key set, with no shoulder_pan", () => {
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
    const arm = moveBy(RIGHT, A3);
    expect(arm.y).toBeLessThan(0);
    // and it is a TRANSLATION now, not the yaw shoulder_pan used to produce
    expect(arm.yaw).toBe(0);
  });

  it("lateral is no more sensitive than the other translations", () => {
    // The legacy lateral gain (265) was tuned to drive a ROTATION. Reused for a
    // translation it would make sideways ~3.4x faster than forward or vertical.
    const lateral = Math.abs(moveBy(RIGHT, A3).y);
    expect(lateral).toBeCloseTo(Math.abs(moveBy(UP, A3).z), 6);
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
