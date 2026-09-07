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
import {
  VrJogMapper, wristPoint, SOLVED_JOINTS, type VrControllerFrame,
} from "@nori/sdk/vr";

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
  it("emits the gripper only — translation and the wrist both left the jog lane", () => {
    // pitch/yaw are IK constraints and were refused 151 times in one session on
    // noriA3-0 (2026-09-04), taking translation down with them. They are still
    // absent.
    //
    // The three WRIST joints left this frame on 2026-09-06 for absolute
    // anatomical targets on `control.action` (wrist-anatomy.ts). Their absence
    // here is load-bearing, not incidental: a wrist key present in the jog frame
    // would enter the gateway's `_jog_active`, and its park-at-measured on
    // release would then clobber the action target every time the hand paused.
    // Translation followed the wrist out on 2026-09-07: the client now solves
    // the four proximal joints from a WRIST-POINT target and sends all seven
    // joints as absolute `action`. The gateway's task cursor is not used by VR
    // at all any more — which is what removes the TCP-compensation coupling
    // that made forward reach impossible once the wrist became responsive.
    expect(Object.keys(moveBy(FORWARD, A3)).sort()).toEqual(["gripper"]);
  });

  // --- absolute wrist-point control (step 2, 2026-09-07) --------------------
  // Translation is no longer a jog rate. The client solves the four proximal
  // joints from a WRIST-POINT target and sends absolute joint angles, so these
  // assert through FORWARD KINEMATICS: decode the action back to radians, run
  // the solver's own FK, and check the wrist point went where the hand did.
  // That exercises the whole chain — frame conversion, scale, IK, normalization
  // — rather than a single scalar.

  const RANGES: Record<string, [number, number]> = {
    "left_arm_shoulder_pitch.pos": [-Math.PI, Math.PI],
    "left_arm_shoulder_roll.pos": [-1.6581, 1.6581],
    "left_arm_bicep_yaw.pos": [-Math.PI, Math.PI],
    "left_arm_elbow_pitch.pos": [-1.6581, 1.6581],
    // Wrist bounds are noriA3-0's real calibrated values (left arm).
    "left_arm_forearm_yaw.pos": [-2.7089, 2.7089],
    "left_arm_wrist_pitch.pos": [-1.6022, 1.6022],
    "left_arm_wrist_roll.pos": [-1.3090, 1.3090],
  };
  const A3F = { jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08 } }, ranges_si: RANGES };
  // A mid-workspace pose — away from the elbow-straight and shoulder-roll-zero
  // singularities, where the solver legitimately refuses steps.
  const Q0 = [0.3, 0.9, 0.2, 0.8] as [number, number, number, number];
  const MEAS = {
    wrist: { forearm_yaw: 0, wrist_pitch: 0, wrist_roll: 0 },
    q: Q0,
  };

  function armAction(delta: [number, number, number]) {
    const m = new VrJogMapper();
    m.setDescriptor(A3F as never);
    m.setMeasured(MEAS, null);
    m.map({ left: hand([0, 0, 0]) });   // clutch engages, anchors here
    return m.map({ left: hand(delta) }).action;
  }

  const denorm = (key: string, norm: number) => {
    const [lo, hi] = RANGES[key];
    return lo + ((norm + 100) / 200) * (hi - lo);
  };

  // The commanded wrist point, recovered from the action frame.
  function commandedWristPoint(action: Record<string, number>) {
    const q = SOLVED_JOINTS.map((j) => denorm(`left_arm_${j}.pos`, action[`left_arm_${j}.pos`]));
    return wristPoint(q[0], q[1], q[2], q[3], 1);
  }

  // 1 mm of hand travel. Deliberately small: the solver enforces a per-tick
  // joint-step ceiling (MAX_JOINT_SPEED_RAD_S x dt), and a 5 cm jump in ONE
  // frame is correctly refused as a discontinuity rather than executed.
  const MM: number = 0.001;
  const anchor = wristPoint(Q0[0], Q0[1], Q0[2], Q0[3], 1);

  it("sends all seven joints, not a jog rate", () => {
    const a = armAction([0, 0, -MM]);
    expect(Object.keys(a).sort()).toEqual([
      "left_arm_bicep_yaw.pos", "left_arm_elbow_pitch.pos",
      "left_arm_forearm_yaw.pos", "left_arm_shoulder_pitch.pos",
      "left_arm_shoulder_roll.pos", "left_arm_wrist_pitch.pos",
      "left_arm_wrist_roll.pos",
    ]);
  });

  it("forward hand motion moves the wrist point forward (+x, REP-103)", () => {
    const p = commandedWristPoint(armAction([0, 0, -MM]));
    expect(p[0]).toBeGreaterThan(anchor[0]);
  });

  it("upward hand motion moves the wrist point up (+z), not sideways", () => {
    const p = commandedWristPoint(armAction([0, MM, 0]));
    expect(p[2]).toBeGreaterThan(anchor[2]);
    expect(Math.abs(p[1] - anchor[1])).toBeLessThan(1e-6);
  });

  it("hand right moves the wrist point −y, since REP-103 +y is LEFT", () => {
    const p = commandedWristPoint(armAction([MM, 0, 0]));
    expect(p[1]).toBeLessThan(anchor[1]);
  });

  it("travel is proportional to hand travel", () => {
    const d1 = commandedWristPoint(armAction([0, 0, -MM]))[0] - anchor[0];
    const d2 = commandedWristPoint(armAction([0, 0, -2 * MM]))[0] - anchor[0];
    expect(d2).toBeCloseTo(2 * d1, 9);
  });

  it("is scaled DOWN — the arm is a 0.61-scale human arm", () => {
    // A 1:1 map would over-run the robot's 0.344 m reach constantly. Scaling
    // makes its posture a geometrically similar copy of the operator's.
    const d = commandedWristPoint(armAction([0, 0, -MM]))[0] - anchor[0];
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(MM);
  });

  it("is ABSOLUTE — the target depends on where the hand IS, not how it got there", () => {
    // The property that makes this immune to the drift and gravity-ratchet
    // failures of every integrate-and-leash path on this robot. Two different
    // routes to the same hand pose must command the same joints.
    const m = new VrJogMapper();
    m.setDescriptor(A3F as never);
    m.setMeasured(MEAS, null);
    m.map({ left: hand([0, 0, 0]) });
    m.map({ left: hand([0, 0, -MM]) });
    m.map({ left: hand([MM, MM, -MM]) });
    const viaPath = m.map({ left: hand([0, 0, -2 * MM]) }).action;

    const direct = armAction([0, 0, -2 * MM]);
    for (const k of Object.keys(direct)) {
      expect(viaPath[k]).toBeCloseTo(direct[k], 6);
    }
  });

  it("LAGS toward a hand jump instead of refusing it", () => {
    // 5 cm in a single frame is far past the per-tick joint ceiling. The arm
    // must still make progress — taking the largest fraction of the step that
    // fits — rather than holding. Refusing outright is what made the arm look
    // dead on nori-a3-0003 (2026-09-07).
    const p = commandedWristPoint(armAction([0, 0, -0.05]));
    const moved = Math.hypot(p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]);
    expect(moved).toBeGreaterThan(0);          // it moved
    expect(moved).toBeLessThan(0.6 * 0.05);    // but not the whole way
    expect(p[0]).toBeGreaterThan(anchor[0]);   // and in the right direction
  });

  it("still moves from the PARK pose, at 99.9% extension — the 0003 bug", () => {
    // The robot rests fully extended with the elbow at ~5 deg, where one
    // millimetre of wrist-point travel costs 2.92 deg of joint motion and the
    // per-frame ceiling allows only 0.54 mm. Every frame was refused, so the
    // arm never moved from rest while the wrist kept working — reported as
    // "the IK did not work, only wrist moved".
    const PARK = [0.3, 0.9, 0.2, 0.087] as [number, number, number, number];
    const m = new VrJogMapper();
    m.setDescriptor(A3F as never);
    m.setMeasured({ wrist: MEAS.wrist, q: PARK }, null);
    m.map({ left: hand([0, 0, 0]) });
    const parkAnchor = wristPoint(PARK[0], PARK[1], PARK[2], PARK[3], 1);
    const p = commandedWristPoint(m.map({ left: hand([0, 0, -0.005]) }).action);
    const moved = Math.hypot(
      p[0] - parkAnchor[0], p[1] - parkAnchor[1], p[2] - parkAnchor[2]);
    expect(moved).toBeGreaterThan(0);
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
    // The A3 vocabulary emits no translation jog at all now, so the observable
    // is that the legacy keys STOP: the jog frame drops to the gripper alone.
    const arm = m.map({ left: hand([0, 0.1, 0]) }).jog?.left_arm ?? {};
    expect(Object.keys(arm).sort()).toEqual(["gripper"]);
  });

  it("isCartesian reports the active vocabulary", () => {
    const m = new VrJogMapper();
    expect(m.isCartesian).toBe(false);
    m.setDescriptor(A3 as never);
    expect(m.isCartesian).toBe(true);
  });
});
