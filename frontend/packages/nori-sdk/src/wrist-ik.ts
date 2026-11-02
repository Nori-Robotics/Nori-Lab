// Orientation-matching wrist for VR (A3). Replaces the anatomical decomposition
// in wrist-anatomy.ts as the mapper's wrist path (2026-11-02).
//
// What was wrong with the anatomical path, all three found against the URDF:
//
//  1. It never looked at the arm. It decomposed the hand's rotation since the
//     clutch into Z-Y-X angles and ADDED them to the measured joint angles.
//     Euler angles do not add: Rz(a+da)Ry(b+db)Rx(c+dc) is not
//     Rz(a)Ry(b)Rx(c) * Rz(da)Ry(db)Rx(dc) unless the wrist starts at zero, so
//     every axis bled into the others once the wrist was anywhere else.
//  2. It never looked at the side. shoulder_roll's origin is rpy
//     side_sign*pi/2, so the right chain is the left chain turned 180 degrees
//     about X from the shoulder down. The same hand gesture needs opposite
//     joint signs on one arm, and the old path sent both arms the same signs.
//  3. Its grip-to-forearm basis put the forearm +Z toward the HAND. In the
//     URDF every child sits at -Z, so +Z points back up the arm and pronation
//     came out inverted.
//
// This path removes all three by not mapping hand axes to joints at all. The
// gripper is told to rotate in the WORLD exactly as the controller did since the
// clutch engaged:
//
//     R_tool_target = D * R_tool_anchor
//     D             = C * scale(q_hand * q_hand_anchor^-1, gain) * C^T
//
// where C is the same VR-to-robot frame change armAbsolute uses for translation
// (robot +x = control forward, +y = left, +z = up), captured at the clutch, and
// scale() keeps the rotation's axis and multiplies its angle by `gain`. The
// three wrist joints are then SOLVED from the forearm the arm is actually in
// this frame, so the gripper keeps its world orientation while the arm moves
// underneath it.
//
// Magnification scales the ANGLE about the hand's own axis of rotation, never
// one joint. A per-joint gain (the old x3 on wrist_roll) multiplies a joint
// whose axis is not the hand's axis, which turns a pure tilt into a tilt about
// some other direction. Scaling the angle cannot change the direction, only how
// far it goes, so it is safe at any value; how much is purely feel.
//
// Nothing integrates. Each frame recomputes from the current quaternion and the
// clutch anchor, so there is no drift and no ratchet. The only state is the
// previous solution, used to pick the continuous one of the two Z-Y-X branches.
import { type ArmQ } from "./arm-kinematics";
import { WRIST_JOINTS, type WristAngles } from "./wrist-anatomy";

/** Row-major 3x3 rotation. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

export function transpose(a: Mat3): Mat3 {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

export function rx(t: number): Mat3 {
  const c = Math.cos(t), s = Math.sin(t);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function ry(t: number): Mat3 {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rz(t: number): Mat3 {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export type Quat4 = [number, number, number, number];

/**
 * Rotation from `anchor` to `now` in the parent (VR reference) frame,
 * now * anchor^-1, on the quaternion hemisphere continuous with `prev`. The sign
 * choice matters only once gain != 1: q and -q are the same rotation, but scaled
 * they are not, and picking the shortest arc every frame would make a hand that
 * turns past 180 degrees from the clutch flip the magnified target.
 */
export function handDelta(now: Quat4, anchor: Quat4, prev: Quat4 | null): Quat4 {
  const [ax, ay, az, aw] = anchor;
  const [bx, by, bz, bw] = now;
  // now * conj(anchor)
  let d: Quat4 = [
    -bw * ax + bx * aw - by * az + bz * ay,
    -bw * ay + bx * az + by * aw - bz * ax,
    -bw * az - bx * ay + by * ax + bz * aw,
    bw * aw + bx * ax + by * ay + bz * az,
  ];
  const n = Math.hypot(...d) || 1;
  d = d.map((v) => v / n) as Quat4;
  const ref = prev ?? ([0, 0, 0, 1] as Quat4);
  const dot = d[0] * ref[0] + d[1] * ref[1] + d[2] * ref[2] + d[3] * ref[3];
  return dot < 0 ? (d.map((v) => -v) as Quat4) : d;
}

/** Same axis, angle multiplied by `gain`. The angle is read in [0, 2pi) without
 *  forcing w >= 0, so it stays continuous with handDelta's hemisphere. */
export function scaleRotation(q: Quat4, gain: number): Quat4 {
  if (gain === 1) return q;
  const s = Math.hypot(q[0], q[1], q[2]);
  if (s < 1e-12) return [0, 0, 0, 1];
  const theta = 2 * Math.atan2(s, q[3]) * gain;
  const k = Math.sin(theta / 2) / s;
  return [q[0] * k, q[1] * k, q[2] * k, Math.cos(theta / 2)];
}

/** WebXR quaternion [x, y, z, w] to a rotation matrix. */
export function quatToMat(q: readonly [number, number, number, number]): Mat3 {
  let [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * The VR-reference-to-robot frame change at control yaw `yaw`. Same mapping as
 * armAbsolute: robot x = -(sin*vx + cos*vz), y = -(cos*vx - sin*vz), z = vy.
 * A proper rotation (det +1), so it conjugates rotations without mirroring.
 */
export function vrToRobot(yaw: number): Mat3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [-s, 0, -c, -c, 0, s, 0, 1, 0];
}

const PI = Math.PI;
// Fixed origin rotation on the wrist_roll joint (rpy 0 0 pi). Its axis is -X in
// that rotated frame, and Rz(pi)Rx(-c) = Rx(c)Rz(pi), which is why the three
// wrist joints decompose as a plain intrinsic Z-Y-X once Rz(pi) is peeled off.
const RZ_PI = rz(PI);

/**
 * Rotation of the forearm_yaw joint's parent frame (elbow_pitch_link) in the
 * arm-mount frame, from the four proximal joints. Same chain arm-kinematics.ts
 * uses for the wrist point: Rz(pi) Ry(q1) Rx(q2 - sign*pi/2) Rz(q3) Ry(q4).
 * `sign` is arm-kinematics' sideSign (+1 left, -1 right).
 */
export function forearmRotation(q: ArmQ, sign: number): Mat3 {
  let m = mul(rz(PI), ry(q[0]));
  m = mul(m, rx(q[1] - sign * PI / 2));
  m = mul(m, rz(q[2]));
  return mul(m, ry(q[3]));
}

/** wrist_roll_link rotation in the arm-mount frame. The gripper is a fixed
 *  offset from this, which cancels out of every delta below. */
export function toolRotation(q: ArmQ, w: WristAngles, sign: number): Mat3 {
  let m = mul(forearmRotation(q, sign), rz(w.forearm_yaw));
  m = mul(m, ry(w.wrist_pitch));
  m = mul(m, RZ_PI);
  return mul(m, rx(-w.wrist_roll));
}

type Limits = Partial<Record<(typeof WRIST_JOINTS)[number], readonly [number, number]>>;

// cos(wrist_pitch) below this is reported as the flexion pole (diagnostic only;
// the solver below needs no special case there).
const GIMBAL_COS_FLOOR = Math.sin(0.1);
// Damped least squares. LAMBDA bounds the joint speed the solver will use near
// the pole (at most 1/(2*LAMBDA) = 10x the tool's rotation); away from it the
// damping costs nothing measurable, so the solve converges to the exact angles.
const LAMBDA = 0.05;
const MAX_ITERS = 60;
const MAX_STEP_RAD = 0.3; // per iteration, keeps a large first error from overshooting
const TOL_RAD = 1e-12;

/** Rotation vector (axis * angle, radians) of R, shortest arc. */
function rotvec(R: Mat3): [number, number, number] {
  const tr = R[0] + R[4] + R[8];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    w = 0.25 * S; x = (R[7] - R[5]) / S; y = (R[2] - R[6]) / S; z = (R[3] - R[1]) / S;
  } else if (R[0] > R[4] && R[0] > R[8]) {
    const S = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
    w = (R[7] - R[5]) / S; x = 0.25 * S; y = (R[1] + R[3]) / S; z = (R[2] + R[6]) / S;
  } else if (R[4] > R[8]) {
    const S = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
    w = (R[2] - R[6]) / S; x = (R[1] + R[3]) / S; y = 0.25 * S; z = (R[5] + R[7]) / S;
  } else {
    const S = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
    w = (R[3] - R[1]) / S; x = (R[2] + R[6]) / S; y = (R[5] + R[7]) / S; z = 0.25 * S;
  }
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-15) return [0, 0, 0];
  const ang = 2 * Math.atan2(s, w);
  return [(x / s) * ang, (y / s) * ang, (z / s) * ang];
}

/** Solve a 3x3 system A x = e (A symmetric positive definite here). */
function solve3(A: number[], e: number[]): [number, number, number] {
  const [a, b, c, d, f, g, h, i, j] = A;
  const det = a * (f * j - g * i) - b * (d * j - g * h) + c * (d * i - f * h);
  const inv = [
    f * j - g * i, c * i - b * j, b * g - c * f,
    g * h - d * j, a * j - c * h, c * d - a * g,
    d * i - f * h, b * h - a * i, a * f - b * d,
  ].map((v) => v / det);
  return [
    inv[0] * e[0] + inv[1] * e[1] + inv[2] * e[2],
    inv[3] * e[0] + inv[4] * e[1] + inv[5] * e[2],
    inv[6] * e[0] + inv[7] * e[1] + inv[8] * e[2],
  ];
}

export type WristSolution = {
  /** Joint targets to command: `free`, clamped to the limits. */
  angles: WristAngles;
  /** The continuous, UNCLAMPED solution. Feed this back as `prev` next frame. */
  free: WristAngles;
  /** True within ~6 deg of the flexion pole (diagnostic). */
  gimbal: boolean;
};

/**
 * The wrist joints that put the tool at `target`, given the forearm the arm is
 * in, found by damped least squares starting from `prev`.
 *
 * Two properties matter, both found in review (2026-11-02):
 *
 *  - CONTINUITY THROUGH THE POLE. A closed-form Z-Y-X split has to special-case
 *    the flexion pole, and freezing forearm_yaw there let the frozen value snap
 *    to the true one on the frame the wrist left the pole. Stepping from the
 *    previous solution follows the one continuous solution straight through it.
 *  - NO WRAP AT A LIMIT. `prev` is the UNCLAMPED solution, and only the output
 *    is clamped. Re-solving from a clamped value and re-wrapping to it let a
 *    joint pushed half a turn past its limit jump to the OPPOSITE limit. Now
 *    the joint holds at the limit and comes off it exactly when the hand
 *    returns, while the other joints keep their true values.
 */
export function solveWrist(
  forearm: Mat3, target: Mat3, prev: WristAngles, limits?: Limits,
): WristSolution {
  // W = Rz(a) Ry(b) Rx(c), with a = forearm_yaw, b = wrist_pitch, c = wrist_roll.
  const W = mul(mul(transpose(forearm), target), transpose(RZ_PI));
  let a = prev.forearm_yaw, b = prev.wrist_pitch, c = prev.wrist_roll;
  for (let it = 0; it < MAX_ITERS; it++) {
    const cur = mul(mul(rz(a), ry(b)), rx(c));
    const e = rotvec(mul(W, transpose(cur)));
    if (Math.hypot(...e) < TOL_RAD) break;
    // Joint axes in W's parent frame: z for a, Rz(a)y for b, Rz(a)Ry(b)x for c.
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const J = [
      [0, -sa, ca * cb],
      [0, ca, sa * cb],
      [1, 0, -sb],
    ];
    const A: number[] = [];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) {
      A.push(J[r][0] * J[k][0] + J[r][1] * J[k][1] + J[r][2] * J[k][2] + (r === k ? LAMBDA * LAMBDA : 0));
    }
    const y = solve3(A, e);
    let dq = [0, 1, 2].map((col) => J[0][col] * y[0] + J[1][col] * y[1] + J[2][col] * y[2]);
    const big = Math.max(...dq.map(Math.abs));
    if (big > MAX_STEP_RAD) dq = dq.map((v) => (v * MAX_STEP_RAD) / big);
    a += dq[0]; b += dq[1]; c += dq[2];
  }
  const free = { forearm_yaw: a, wrist_pitch: b, wrist_roll: c };
  const angles = { ...free };
  for (const j of WRIST_JOINTS) {
    const lim = limits?.[j];
    if (lim) angles[j] = Math.max(lim[0], Math.min(lim[1], angles[j]));
  }
  return { angles, free, gimbal: Math.abs(Math.cos(b)) < GIMBAL_COS_FLOOR };
}

/**
 * The tool orientation the hand is asking for: the anchored tool, rotated in the
 * robot frame by `delta` (handDelta, already scaled), with C taken at the
 * control yaw captured on the clutch edge.
 */
export function targetTool(anchorTool: Mat3, delta: Quat4, controlYaw: number): Mat3 {
  const C = vrToRobot(controlYaw);
  const d = mul(mul(C, quatToMat(delta)), transpose(C));
  return mul(d, anchorTool);
}
