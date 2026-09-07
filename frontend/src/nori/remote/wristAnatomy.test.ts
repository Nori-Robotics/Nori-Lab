// NORI: Additive. Anatomical wrist decomposition.
//
// The property under test is the one the previous mapper got wrong: the robot's
// wrist_pitch and wrist_roll axes are carried by forearm_yaw (it precedes them
// in the chain), so an axis-by-name assignment is only correct at one roll
// angle. The decisive case is `pronation then flexion` — flexion must still come
// out as pure flexion no matter how far the hand has already rolled.
import { describe, it, expect } from "vitest";
import {
  wristAngles, wristTargets, zeroWristAngles, GRIP_TO_FOREARM,
  type Quat,
} from "@nori/sdk/vr";

const IDENT: Quat = { x: 0, y: 0, z: 0, w: 1 };
const DEG = Math.PI / 180;

function axisAngle(ax: number, ay: number, az: number, rad: number): Quat {
  const n = Math.hypot(ax, ay, az) || 1;
  const s = Math.sin(rad / 2);
  return { x: (ax / n) * s, y: (ay / n) * s, z: (az / n) * s, w: Math.cos(rad / 2) };
}

function qMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
const qConj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

// Express a forearm-frame rotation back in grip coordinates, so tests can state
// intent in the robot's own axes and feed the function what a headset would send.
const fromForearm = (q: Quat): Quat =>
  qMul(qMul(GRIP_TO_FOREARM, q), qConj(GRIP_TO_FOREARM));

// Forearm-frame primitives, named for the anatomy they represent.
const pronate = (rad: number) => axisAngle(0, 0, 1, rad); // about Z
const flex = (rad: number) => axisAngle(0, 1, 0, rad);    // about Y
const deviate = (rad: number) => axisAngle(1, 0, 0, rad); // about X

const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe("wristAngles", () => {
  it("returns zero when the hand is at the reference", () => {
    const { angles, gimbal } = wristAngles(IDENT, IDENT);
    expect(angles).toEqual(zeroWristAngles());
    expect(gimbal).toBe(false);
  });

  it("is relative to the reference, not the world", () => {
    // A hand and a reference both rotated by the same arbitrary amount is still
    // a zero delta. This is what makes the clutch anchor work.
    const world = axisAngle(0.3, -0.7, 0.2, 1.1);
    const { angles } = wristAngles(world, world);
    near(angles.forearm_yaw, 0);
    near(angles.wrist_pitch, 0);
    near(angles.wrist_roll, 0);
  });

  it("maps pronation to forearm_yaw alone", () => {
    const { angles } = wristAngles(fromForearm(pronate(40 * DEG)), IDENT);
    near(angles.forearm_yaw, 40 * DEG);
    near(angles.wrist_pitch, 0);
    near(angles.wrist_roll, 0);
  });

  it("maps flexion to wrist_pitch alone", () => {
    const { angles } = wristAngles(fromForearm(flex(35 * DEG)), IDENT);
    near(angles.forearm_yaw, 0);
    near(angles.wrist_pitch, 35 * DEG);
    near(angles.wrist_roll, 0);
  });

  it("maps deviation to wrist_roll alone", () => {
    const { angles } = wristAngles(fromForearm(deviate(25 * DEG)), IDENT);
    near(angles.forearm_yaw, 0);
    near(angles.wrist_pitch, 0);
    near(angles.wrist_roll, 25 * DEG);
  });

  // THE REGRESSION. Under the old by-name mapping the tilt axes rotate with the
  // roll, so flexion after a large pronation leaked into the other tilt axis and
  // inverted past 90 degrees. Here it must stay clean at every roll angle.
  it("keeps flexion pure at every pronation angle", () => {
    for (const pron of [-170, -90, -45, 0, 45, 90, 170]) {
      const rel = qMul(pronate(pron * DEG), flex(30 * DEG));
      const { angles } = wristAngles(fromForearm(rel), IDENT);
      near(angles.forearm_yaw, pron * DEG, 1e-8);
      near(angles.wrist_pitch, 30 * DEG, 1e-8);
      near(angles.wrist_roll, 0, 1e-8);
    }
  });

  it("keeps deviation pure at every pronation angle", () => {
    for (const pron of [-170, -90, -45, 0, 45, 90, 170]) {
      const rel = qMul(pronate(pron * DEG), deviate(20 * DEG));
      const { angles } = wristAngles(fromForearm(rel), IDENT);
      near(angles.forearm_yaw, pron * DEG, 1e-8);
      near(angles.wrist_pitch, 0, 1e-8);
      near(angles.wrist_roll, 20 * DEG, 1e-8);
    }
  });

  it("recovers a full three-axis pose", () => {
    const rel = qMul(qMul(pronate(-75 * DEG), flex(40 * DEG)), deviate(-15 * DEG));
    const { angles, gimbal } = wristAngles(fromForearm(rel), IDENT);
    near(angles.forearm_yaw, -75 * DEG, 1e-8);
    near(angles.wrist_pitch, 40 * DEG, 1e-8);
    near(angles.wrist_roll, -15 * DEG, 1e-8);
    expect(gimbal).toBe(false);
  });

  it("flags the gimbal pole and not ordinary flexion", () => {
    // Human flexion tops out near 80 deg; the robot's wrist_pitch limit is 90.
    expect(wristAngles(fromForearm(flex(80 * DEG)), IDENT).gimbal).toBe(false);
    expect(wristAngles(fromForearm(flex(89.9 * DEG)), IDENT).gimbal).toBe(true);
    expect(wristAngles(fromForearm(flex(-89.9 * DEG)), IDENT).gimbal).toBe(true);
  });

  it("is pure — the same inputs always give the same answer", () => {
    // No accumulation anywhere, which is what makes this immune to the drift and
    // gravity-ratchet failures of the delta-integrating path it replaces.
    const hand = fromForearm(qMul(pronate(1.0), flex(0.4)));
    const first = wristAngles(hand, IDENT).angles;
    for (let i = 0; i < 100; i++) wristAngles(hand, IDENT);
    expect(wristAngles(hand, IDENT).angles).toEqual(first);
  });
});

describe("wristTargets", () => {
  it("adds the delta to the clutch anchor", () => {
    const anchor = { forearm_yaw: 0.5, wrist_pitch: -0.2, wrist_roll: 0.1 };
    const out = wristTargets(anchor, { forearm_yaw: 0.25, wrist_pitch: 0.1, wrist_roll: -0.3 });
    near(out.forearm_yaw, 0.75);
    near(out.wrist_pitch, -0.1);
    near(out.wrist_roll, -0.2);
  });

  it("commands the anchor exactly when the hand has not moved", () => {
    // The no-lurch property: sendAction has no server-side slew, so the first
    // frame after clutch must equal where the robot already is.
    const anchor = { forearm_yaw: -1.4, wrist_pitch: 0.3, wrist_roll: 0.9 };
    expect(wristTargets(anchor, zeroWristAngles())).toEqual(anchor);
  });

  it("clamps to the robot's joint limits", () => {
    const lim = {
      forearm_yaw: [-Math.PI, Math.PI] as const,
      wrist_pitch: [-Math.PI / 2, Math.PI / 2] as const,
      wrist_roll: [-Math.PI / 2, Math.PI / 2] as const,
    };
    const out = wristTargets(
      { forearm_yaw: 0, wrist_pitch: 1.5, wrist_roll: -1.5 },
      { forearm_yaw: 0, wrist_pitch: 1.0, wrist_roll: -1.0 }, lim,
    );
    near(out.wrist_pitch, Math.PI / 2);
    near(out.wrist_roll, -Math.PI / 2);
  });
});
