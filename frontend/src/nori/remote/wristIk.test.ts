// NORI: Additive. Regression guard for the VR WRIST on cartesian robots (A3).
//
// The old anatomical path added hand Euler angles to the measured joints with
// one sign set for both arms, so the wrist read "inverted or strange": wrong on
// the mirrored arm, cross-coupled whenever the wrist started away from zero,
// and drifting off the hand as the arm moved. These tests pin the replacement's
// contract through forward kinematics rather than per-joint signs: the gripper
// must rotate in the robot frame exactly as the controller rotated in the VR
// frame, on BOTH arms, from a non-zero wrist, and while the arm moves.
import { describe, it, expect } from "vitest";
import {
  VrJogMapper, SOLVED_JOINTS, toolRotation, solveWrist, forearmRotation,
  vrToRobot, quatToMat, pickPokeZone, type Mat3, type VrControllerFrame, type ArmQ,
} from "@nori/sdk/vr";

type Q = [number, number, number, number];
const axisAngle = (ax: [number, number, number], t: number): Q => {
  const n = Math.hypot(...ax), s = Math.sin(t / 2);
  return [(ax[0] / n) * s, (ax[1] / n) * s, (ax[2] / n) * s, Math.cos(t / 2)];
};
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const matMul = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};
const T = (a: Mat3): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const expectMat = (a: Mat3, b: Mat3, tol = 1e-6) => {
  for (let i = 0; i < 9; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
};

const SIDES = [["left", 1], ["right", -1]] as const;
// Wide wrist bounds so the solver is never clamped in these checks.
const RANGES = (side: string): Record<string, [number, number]> => ({
  [`${side}_arm_shoulder_pitch.pos`]: [-Math.PI, Math.PI],
  [`${side}_arm_shoulder_roll.pos`]: [-1.6581, 1.6581],
  [`${side}_arm_bicep_yaw.pos`]: [-Math.PI, Math.PI],
  [`${side}_arm_elbow_pitch.pos`]: [-1.6581, 1.6581],
  [`${side}_arm_forearm_yaw.pos`]: [-2.7089, 2.7089],
  [`${side}_arm_wrist_pitch.pos`]: [-1.6022, 1.6022],
  [`${side}_arm_wrist_roll.pos`]: [-1.7, 1.7],
});
const Q0: ArmQ = [0.3, 0.9, 0.2, 0.8];
// Deliberately NOT zero: Euler-angle addition is only right at zero, which is
// how the old path passed a zero-anchored test and failed on the robot.
const W0 = { forearm_yaw: 0.6, wrist_pitch: -0.5, wrist_roll: 0.4 };

function frame(pos: [number, number, number], q: Q): VrControllerFrame {
  return { position: pos, orientation: q, trigger: 0, squeeze: 1, thumbstick: { x: 0, y: 0 } };
}

// Engage at (pos0, qa), then move to (pos1, qb). Returns the commanded joints.
function mapper(side: "left" | "right", gain: number, ranges = RANGES(side), wrist = W0) {
  const m = new VrJogMapper();
  m.setDescriptor({ jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08 } }, ranges_si: ranges } as never);
  m.setTuning({ wristGain: gain });
  const meas = { wrist, q: Q0 };
  m.setMeasured(side === "left" ? meas : null, side === "right" ? meas : null);
  const decode = (action: Record<string, number>) => {
    const get = (j: string) => {
      const [lo, hi] = ranges[`${side}_arm_${j}.pos`];
      return lo + ((action[`${side}_arm_${j}.pos`] + 100) / 200) * (hi - lo);
    };
    return {
      q: SOLVED_JOINTS.map(get) as ArmQ,
      wrist: { forearm_yaw: get("forearm_yaw"), wrist_pitch: get("wrist_pitch"), wrist_roll: get("wrist_roll") },
    };
  };
  return { m, decode };
}

// Strict 1:1 (gain 1) so the commanded rotation must EQUAL the hand's.
function drive(side: "left" | "right", qa: Q, qb: Q, pos1: [number, number, number] = [0, 0, 0]) {
  const ranges = RANGES(side);
  const m = new VrJogMapper();
  m.setDescriptor({ jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08 } }, ranges_si: ranges } as never);
  m.setTuning({ wristGain: 1 });
  const meas = { wrist: W0, q: Q0 };
  m.setMeasured(side === "left" ? meas : null, side === "right" ? meas : null);
  m.map({ [side]: frame([0, 0, 0], qa) });
  const action = m.map({ [side]: frame(pos1, qb) }).action;
  const get = (j: string) => {
    const [lo, hi] = ranges[`${side}_arm_${j}.pos`];
    return lo + ((action[`${side}_arm_${j}.pos`] + 100) / 200) * (hi - lo);
  };
  const q = SOLVED_JOINTS.map(get) as ArmQ;
  const wrist = { forearm_yaw: get("forearm_yaw"), wrist_pitch: get("wrist_pitch"), wrist_roll: get("wrist_roll") };
  return { q, wrist };
}

// An arbitrary, tilted engage pose for the controller.
const QA: Q = qmul(axisAngle([0.3, 1, -0.2], 0.7), axisAngle([1, 0, 0], -0.4));

describe("solveWrist", () => {
  it("recovers the wrist joints from the tool orientation, both arms", () => {
    for (const [, sign] of SIDES) {
      for (const a of [-1.5, -0.4, 0.3, 1.2]) for (const b of [-1.2, -0.3, 0.5, 1.1])
        for (const c of [-1.0, 0.2, 0.9]) {
          const w = { forearm_yaw: a, wrist_pitch: b, wrist_roll: c };
          const near = { forearm_yaw: a + 0.05, wrist_pitch: b - 0.05, wrist_roll: c + 0.05 };
          const got = solveWrist(forearmRotation(Q0, sign), toolRotation(Q0, w, sign), near).angles;
          expect(got.forearm_yaw).toBeCloseTo(a, 6);
          expect(got.wrist_pitch).toBeCloseTo(b, 6);
          expect(got.wrist_roll).toBeCloseTo(c, 6);
        }
    }
  });

  // Review finding B1 (2026-11-02): the closed-form solver froze forearm_yaw
  // within ~6 deg of the flexion pole and snapped it on the way out. Feed a real
  // joint path through the solver frame by frame, as the mapper does, and require
  // it to track that path: exact tool orientation and joint-sized steps only.
  function followPath(path: { forearm_yaw: number; wrist_pitch: number; wrist_roll: number }[]) {
    const F = forearmRotation(Q0, 1);
    let prev = path[0];
    let worstTool = 0, worstStep = 0;
    for (const w of path.slice(1)) {
      const r = solveWrist(F, toolRotation(Q0, w, 1), prev);
      worstTool = Math.max(worstTool, angleBetween(toolRotation(Q0, r.angles, 1), toolRotation(Q0, w, 1)));
      for (const j of ["forearm_yaw", "wrist_pitch", "wrist_roll"] as const)
        worstStep = Math.max(worstStep, Math.abs(r.free[j] - prev[j]));
      prev = r.free;
    }
    return { worstTool, worstStep, last: prev };
  }
  const D = Math.PI / 180;

  it("follows forearm_yaw at 87 deg of flexion and leaves the pole without a snap", () => {
    const path = [];
    for (let p = 0; p <= 87; p++) path.push({ forearm_yaw: 0, wrist_pitch: p * D, wrist_roll: 0 });
    for (let y = 1; y <= 40; y++) path.push({ forearm_yaw: y * D, wrist_pitch: 87 * D, wrist_roll: 0 });
    for (let p = 86; p >= 70; p--) path.push({ forearm_yaw: 40 * D, wrist_pitch: p * D, wrist_roll: 0 });
    const r = followPath(path);
    expect(r.worstTool).toBeLessThan(1e-6);
    expect(r.worstStep).toBeLessThan(1.5 * D); // the path itself moves 1 deg per frame
    expect(r.last.forearm_yaw).toBeCloseTo(40 * D, 6);
  });

  it("passes straight through the pole itself", () => {
    const path = [];
    for (let p = 75; p <= 105; p += 0.5) path.push({ forearm_yaw: 0.5, wrist_pitch: p * D, wrist_roll: 0.3 });
    const r = followPath(path);
    // Exactly at 90 deg one tool direction is unreachable for one frame, so allow
    // a hair of error there; nothing may jump.
    expect(r.worstTool).toBeLessThan(0.01);
    expect(r.worstStep).toBeLessThan(2 * D);
    expect(r.last.wrist_pitch).toBeCloseTo(105 * D, 4);
  });
});

describe("VR wrist matches the controller's world rotation", () => {
  for (const [side, sign] of SIDES) {
    it(`${side}: an unmoved hand commands exactly the measured wrist (no lurch)`, () => {
      const { wrist } = drive(side, QA, QA);
      expect(wrist.forearm_yaw).toBeCloseTo(W0.forearm_yaw, 9);
      expect(wrist.wrist_pitch).toBeCloseTo(W0.wrist_pitch, 9);
      expect(wrist.wrist_roll).toBeCloseTo(W0.wrist_roll, 9);
    });

    for (const [name, ax] of [
      ["yaw (about vertical)", [0, 1, 0]],
      ["roll (about forward)", [0, 0, -1]],
      ["pitch (about right)", [1, 0, 0]],
      ["an oblique axis", [0.5, -0.7, 0.4]],
    ] as const) {
      it(`${side}: hand ${name} turns the gripper the same way in the robot frame`, () => {
        const dq = axisAngle(ax as [number, number, number], 0.35);
        const { q, wrist } = drive(side, QA, qmul(dq, QA));
        const anchorTool = toolRotation(Q0, W0, sign);
        const C = vrToRobot(0);
        const D = matMul(matMul(C, quatToMat(dq)), T(C));
        expectMat(toolRotation(q, wrist, sign), matMul(D, anchorTool));
      });
    }

    it(`${side}: turning the hand left about vertical turns the gripper left about robot +z`, () => {
      const t = 0.3;
      const { q, wrist } = drive(side, QA, qmul(axisAngle([0, 1, 0], t), QA));
      const c = Math.cos(t), s = Math.sin(t);
      const RzT: Mat3 = [c, -s, 0, s, c, 0, 0, 0, 1];
      expectMat(toolRotation(q, wrist, sign), matMul(RzT, toolRotation(Q0, W0, sign)));
    });

    it(`${side}: the gripper keeps its world orientation while the arm moves`, () => {
      const { q, wrist } = drive(side, QA, QA, [0, 0, -0.001]);
      expect(q.some((v, i) => Math.abs(v - Q0[i]) > 1e-6)).toBe(true); // the arm did move
      expectMat(toolRotation(q, wrist, sign), toolRotation(Q0, W0, sign));
    });
  }
});

const angleBetween = (a: Mat3, b: Mat3) => {
  let tr = 0; for (let i = 0; i < 9; i++) tr += a[i] * b[i];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
};

describe("VR wrist magnification and edge cases", () => {
  it("defaults to a strict mirror (gain 1)", () => {
    const m = new VrJogMapper();
    m.setDescriptor({ jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08 } }, ranges_si: RANGES("left") } as never);
    const meas = { wrist: W0, q: Q0 };
    m.setMeasured(meas, null);
    const dq = axisAngle([0.5, -0.7, 0.4], 0.3);
    m.map({ left: frame([0, 0, 0], QA) });
    const action = m.map({ left: frame([0, 0, 0], qmul(dq, QA)) }).action;
    const ranges = RANGES("left");
    const get = (j: string) => {
      const [lo, hi] = ranges[`left_arm_${j}.pos`];
      return lo + ((action[`left_arm_${j}.pos`] + 100) / 200) * (hi - lo);
    };
    const q = SOLVED_JOINTS.map(get) as ArmQ;
    const wrist = { forearm_yaw: get("forearm_yaw"), wrist_pitch: get("wrist_pitch"), wrist_roll: get("wrist_roll") };
    const C = vrToRobot(0);
    const D = matMul(matMul(C, quatToMat(dq)), T(C));
    expectMat(toolRotation(q, wrist, 1), matMul(D, toolRotation(Q0, W0, 1)));
  });

  for (const [side, sign] of SIDES) {
    it(`${side}: gain scales the angle about the SAME axis, never the direction`, () => {
      const { m, decode } = mapper(side, 1.5);
      const ax: [number, number, number] = [0.5, -0.7, 0.4];
      const dq = axisAngle(ax, 0.3);
      m.map({ [side]: frame([0, 0, 0], QA) });
      const { q, wrist } = decode(m.map({ [side]: frame([0, 0, 0], qmul(dq, QA)) }).action);
      const C = vrToRobot(0);
      const D = matMul(matMul(C, quatToMat(axisAngle(ax, 0.45))), T(C));
      expectMat(toolRotation(q, wrist, sign), matMul(D, toolRotation(Q0, W0, sign)));
    });

    it(`${side}: a magnified hand turning past 180 degrees from the clutch never jumps`, () => {
      const wide: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(RANGES(side))) wide[k] = /forearm|wrist/.test(k) ? [-20, 20] : v;
      const { m, decode } = mapper(side, 1.5, wide);
      m.map({ [side]: frame([0, 0, 0], QA) });
      let prev = toolRotation(Q0, W0, sign);
      for (let deg = 10; deg <= 230; deg += 10) {
        const dq = axisAngle([0, 1, 0], (deg * Math.PI) / 180);
        const { q, wrist } = decode(m.map({ [side]: frame([0, 0, 0], qmul(dq, QA)) }).action);
        const now = toolRotation(q, wrist, sign);
        // 10 deg of hand per frame at gain 1.5 is 15 deg of gripper, every frame.
        expect(angleBetween(prev, now) * 180 / Math.PI).toBeCloseTo(15, 3);
        prev = now;
      }
    });

    it(`${side}: pushing past the wrist_roll limit clamps it and leaves forearm_yaw smooth`, () => {
      // noriA3-0's real left wrist_roll bound is +/-1.309, the tightest wrist joint.
      const ranges = { ...RANGES(side), [`${side}_arm_wrist_roll.pos`]: [-1.309, 1.309] as [number, number] };
      const start = { forearm_yaw: 0.2, wrist_pitch: 0.3, wrist_roll: 1.1 };
      const { m, decode } = mapper(side, 1.5, ranges, start);
      m.map({ [side]: frame([0, 0, 0], QA) });
      const T0 = toolRotation(Q0, start, sign);
      const rollAxisRobot = [T0[0], T0[3], T0[6]]; // wrist_roll turns about tool X
      const C = vrToRobot(0);
      const vrAx = [0, 1, 2].map((i) => C[i] * rollAxisRobot[0] + C[3 + i] * rollAxisRobot[1] + C[6 + i] * rollAxisRobot[2]) as [number, number, number];
      let maxYawStep = 0, last = start.forearm_yaw;
      // Review finding B2 (2026-11-02): once the request passed limit + 180 deg the
      // old solver re-wrapped and the command jumped to the OPPOSITE limit. Sweep
      // out 240 deg of hand each way (360 deg of gripper at gain 1.5), which passes
      // limit + 180 deg in both directions from a 63 deg start, and back again.
      const sweep: number[] = [];
      for (const dir of [1, -1]) {
        for (let deg = 2; deg <= 240; deg += 2) sweep.push(dir * deg);
        for (let deg = 238; deg >= 0; deg -= 2) sweep.push(dir * deg);
      }
      let lastRoll = start.wrist_roll, maxRollStep = 0, maxOtherDrift = 0;
      for (const deg of sweep) {
        const { wrist } = decode(m.map({ [side]: frame([0, 0, 0], qmul(axisAngle(vrAx, (deg * Math.PI) / 180), QA)) }).action);
        maxYawStep = Math.max(maxYawStep, Math.abs(wrist.forearm_yaw - last));
        maxRollStep = Math.max(maxRollStep, Math.abs(wrist.wrist_roll - lastRoll));
        maxOtherDrift = Math.max(maxOtherDrift,
          Math.abs(wrist.forearm_yaw - start.forearm_yaw), Math.abs(wrist.wrist_pitch - start.wrist_pitch));
        last = wrist.forearm_yaw;
        lastRoll = wrist.wrist_roll;
        // Never inside Servo's 0.05 rad stopping band at the range end.
        expect(Math.abs(wrist.wrist_roll)).toBeLessThanOrEqual(1.309 - 0.06 + 1e-9);
      }
      expect(maxYawStep).toBeLessThan(0.2);
      expect(maxRollStep).toBeLessThan(0.1);      // never limit-to-limit
      expect(maxOtherDrift).toBeLessThan(1e-6);   // a pure roll request stays pure
      expect(lastRoll).toBeCloseTo(start.wrist_roll, 6); // and comes all the way back
    });

    it(`${side}: recentering mid-clutch does not move the wrist`, () => {
      const { m, decode } = mapper(side, 1.5);
      m.map({ [side]: frame([0, 0, 0], QA) });
      const turned = qmul(axisAngle([0.2, 1, 0.3], 0.4), QA);
      const before = decode(m.map({ [side]: frame([0, 0, 0], turned) }).action).wrist;
      m.setControlYaw(1.0);
      const after = decode(m.map({ [side]: frame([0, 0, 0], turned) }).action).wrist;
      expect(after.forearm_yaw).toBeCloseTo(before.forearm_yaw, 9);
      expect(after.wrist_pitch).toBeCloseTo(before.wrist_pitch, 9);
      expect(after.wrist_roll).toBeCloseTo(before.wrist_roll, 9);
    });
  }
});

describe("record panel poke hit-test", () => {
  // The session-phase layout with a take banked (vr-session.ts recZones()).
  const ZONES = [
    { id: "episode_start", x: 0, y: 0.005, w: 0.096, h: 0.035 },
    { id: "session_end", x: -0.037, y: -0.031, w: 0.058, h: 0.029 },
    { id: "episode_discard", x: 0.037, y: -0.031, w: 0.058, h: 0.029 },
  ];
  const M = 0.010;

  it("a tip inside the Record pill fires Record, even in its bottom corners", () => {
    // Review finding B3: nearest-CENTRE sent this point to Discard.
    expect(pickPokeZone(0.040, -0.008, ZONES, M)).toBe("episode_start");
    expect(pickPokeZone(-0.040, -0.008, ZONES, M)).toBe("episode_start");
    // Every point of Record's drawn rect.
    for (let x = -0.048; x <= 0.048; x += 0.002)
      for (let y = -0.0125; y <= 0.0225; y += 0.0025)
        expect(pickPokeZone(x, y, ZONES, M)).toBe("episode_start");
  });

  it("every point inside a drawn button fires that button", () => {
    for (const z of ZONES)
      for (let x = z.x - z.w / 2; x <= z.x + z.w / 2; x += 0.002)
        for (let y = z.y - z.h / 2; y <= z.y + z.h / 2; y += 0.002)
          expect(pickPokeZone(x, y, ZONES, M)).toBe(z.id);
  });

  it("the margin still catches a near miss, and the gap between Finish and Discard splits by edge", () => {
    expect(pickPokeZone(0, 0.005 + 0.0175 + 0.008, ZONES, M)).toBe("episode_start");
    expect(pickPokeZone(-0.007, -0.031, ZONES, M)).toBe("session_end");
    expect(pickPokeZone(0.007, -0.031, ZONES, M)).toBe("episode_discard");
    expect(pickPokeZone(0, 0.2, ZONES, M)).toBe("");
  });
});
