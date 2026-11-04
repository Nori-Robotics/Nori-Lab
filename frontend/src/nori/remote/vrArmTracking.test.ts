// NORI: Additive. The VR arm must TRACK the hand, never freeze (2026-11-02).
//
// On 1005 the absolute arm held in ~2 of every 3 engaged seconds: the exact
// solver refused steps near a straight elbow ("singular") and past the reach
// sphere ("unreachable"), the arm stood still, then rushed to catch up once a
// solution reappeared. These pin the replacement: every frame makes progress
// toward the hand within the per-tick joint ceiling, an out-of-reach hand pulls
// the arm out toward it, and nothing commanded leaves the calibrated range.
import { describe, it, expect } from "vitest";
import {
  VrJogMapper, wristPoint, SOLVED_JOINTS, dampedWristPointStep, MAX_JOINT_SPEED_RAD_S,
  type VrControllerFrame, type ArmQ,
} from "@nori/sdk/vr";

const hand = (pos: [number, number, number]): VrControllerFrame => ({
  position: pos, orientation: [0, 0, 0, 1], trigger: 0, squeeze: 1, thumbstick: { x: 0, y: 0 },
});
const RANGES: Record<string, [number, number]> = {
  "left_arm_shoulder_pitch.pos": [-2.92, 2.92],
  "left_arm_shoulder_roll.pos": [-1.47, 1.69],   // 1005's calibrated bounds
  "left_arm_bicep_yaw.pos": [-2.64, 2.64],
  "left_arm_elbow_pitch.pos": [-1.79, 1.79],
  "left_arm_forearm_yaw.pos": [-2.65, 2.65],
  "left_arm_wrist_pitch.pos": [-1.62, 1.62],
  "left_arm_wrist_roll.pos": [-1.30, 1.30],
};
const DESC = { jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08 } }, ranges_si: RANGES };
const decode = (action: Record<string, number>) => SOLVED_JOINTS.map((j) => {
  const [lo, hi] = RANGES[`left_arm_${j}.pos`];
  return lo + ((action[`left_arm_${j}.pos`] + 100) / 200) * (hi - lo);
}) as ArmQ;
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const DT = 1 / 72;
const CEILING = MAX_JOINT_SPEED_RAD_S * DT;

// Drive the mapper with the hand moving along `path` (metres from the clutch
// point, one entry per frame). Returns the commanded joints per frame.
// The first entry is the clutch frame itself, which must equal q0.
function drive(q0: ArmQ, path: [number, number, number][]) {
  const m = new VrJogMapper();
  m.setDescriptor(DESC as never);
  m.setMeasured({ wrist: { forearm_yaw: 0, wrist_pitch: 0, wrist_roll: 0 }, q: q0 }, null);
  const engage = decode(m.map({ left: hand([0, 0, 0]) }, DT).action);
  return [engage, ...path.map((p) => decode(m.map({ left: hand(p) }, DT).action))];
}

describe("dampedWristPointStep", () => {
  it("moves toward the target from a straight elbow, within the step cap", () => {
    const seed: ArmQ = [0.3, 0.9, 0.2, 0.001];   // elbow straight: singular
    const from = wristPoint(...seed, 1);
    const target: [number, number, number] = [from[0] - 0.03, from[1] + 0.02, from[2] + 0.02];
    const q = dampedWristPointStep(seed, target, CEILING, 1);
    expect(dist(wristPoint(...q, 1), target)).toBeLessThan(dist(from, target));
    for (let j = 0; j < 4; j++) expect(Math.abs(q[j] - seed[j])).toBeLessThanOrEqual(CEILING + 1e-12);
  });

  it("converges onto a reachable target given enough room", () => {
    const seed: ArmQ = [0.3, 0.9, 0.2, 0.8];
    const from = wristPoint(...seed, 1);
    const target: [number, number, number] = [from[0] + 0.01, from[1], from[2] - 0.01];
    const q = dampedWristPointStep(seed, target, 0.5, 1);
    expect(dist(wristPoint(...q, 1), target)).toBeLessThan(1e-3);
  });
});

describe("VR arm tracks instead of freezing", () => {
  it("from a straight elbow, every frame moves the arm toward the hand", () => {
    // 1005's right arm sat at elbow -0.002 rad and held ("singular") for seconds.
    const q0: ArmQ = [0.3, 0.9, 0.2, 0.002];
    const path: [number, number, number][] = [];
    for (let k = 1; k <= 60; k++) path.push([0.002 * k, 0.0015 * k, -0.001 * k]); // hand drifts in and up
    const qs = drive(q0, path);
    const start = wristPoint(...q0, 1);
    // A clutch at full extension commands exactly the measured pose.
    qs[0].forEach((v, j) => expect(v).toBeCloseTo(q0[j], 9));
    let prevQ = qs[0], prevErr = Infinity, stalls = 0;
    for (let k = 1; k < qs.length; k++) {
      for (let j = 0; j < 4; j++) expect(Math.abs(qs[k][j] - prevQ[j])).toBeLessThanOrEqual(CEILING + 1e-9);
      const moved = Math.max(...qs[k].map((v, j) => Math.abs(v - prevQ[j])));
      if (moved < 1e-6) stalls++;
      prevQ = qs[k];
    }
    // The commanded wrist point ends up following the hand, not parked at rest.
    expect(dist(wristPoint(...qs[qs.length - 1], 1), start)).toBeGreaterThan(0.02);
    expect(stalls).toBe(0);
    void prevErr;
  });

  it("an out-of-reach hand pulls the arm out toward it, never freezing short", () => {
    const q0: ArmQ = [0.3, 0.9, 0.2, 0.8];
    const start = wristPoint(...q0, 1);
    // Hand 1 m forward over 50 frames: at the 0.3 scale, still past the 0.344 m reach.
    const path: [number, number, number][] = [];
    for (let k = 1; k <= 200; k++) path.push([0, 0, -Math.min(1, k * 0.02)]);
    const qs = drive(q0, path);
    const xs = qs.map((q) => wristPoint(...q, 1)[0]);
    // Forward (+x) grows until the arm is fully out. With the elbow held at its
    // bend, the last frames swing the straight arm toward the target's direction,
    // which can trade a fraction of a millimetre of x; never a backward jerk.
    for (let k = 1; k < xs.length; k++) expect(xs[k]).toBeGreaterThanOrEqual(xs[k - 1] - 1e-3);
    expect(xs[xs.length - 1] - start[0]).toBeGreaterThan(0.1);
  });

  it("never commands a solved joint outside the calibrated range minus the Servo margin", () => {
    const q0: ArmQ = [0.3, 1.5, 0.2, 0.8];   // shoulder_roll near its 1.69 calibrated top
    const path: [number, number, number][] = [];
    for (let k = 1; k <= 120; k++) path.push([0.003 * k, 0.004 * k, -0.002 * k]);
    for (const q of drive(q0, path)) {
      SOLVED_JOINTS.forEach((j, i) => {
        const [lo, hi] = RANGES[`left_arm_${j}.pos`];
        expect(q[i]).toBeGreaterThanOrEqual(lo + 0.06 - 1e-9);
        expect(q[i]).toBeLessThanOrEqual(hi - 0.06 + 1e-9);
      });
    }
  });
});
