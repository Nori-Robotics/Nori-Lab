// Anatomical wrist decomposition for VR. CLIENT-SIDE ON PURPOSE.
//
// The A3 wrist is a human wrist. Measured from the URDF (2026-09-06):
//
//     forearm_yaw   rotates about Z   = pronation / supination
//     wrist_pitch   rotates about Y   = flexion / extension
//     wrist_roll    rotates about X   = radial / ulnar deviation
//
// Despite the name, wrist_roll does not roll — it deviates. forearm_yaw is the
// roll, and it is anatomically correct that it is: twisting a human hand is
// forearm pronation, not a wrist joint.
//
// Because the chain is Z then Y then X, the three joint angles ARE the intrinsic
// ZYX Euler decomposition of the hand's orientation relative to the forearm.
// That is the whole idea here. The previous mapper assigned controller axes to
// joints BY NAME and carried three independent sign constants, one of which its
// own comment called "the single remaining unknown" — and the assignment was
// only ever correct at one roll angle, because wrist_pitch and wrist_roll are
// tool-frame tilts that rotate WITH forearm_yaw (it precedes them in the chain).
// That is what the operator saw as "inverted, but sometimes it wraps around and
// starts rotating the correct way": not a sign error, which would be constant,
// but a frame error, which is a function of how far you have rolled.
//
// Decomposing in one consistent frame makes the assignment fall out of the frame
// definition. Three sign constants collapse into ONE basis rotation.
//
// Nothing here integrates. Every frame recomputes the angle from the current
// quaternion, so there is no accumulation, no drift, and no gravity ratchet —
// the failure mode that every integrate-and-leash lane on this robot shares and
// that the leader arm, which does not integrate, has never shown.

export type Quat = { x: number; y: number; z: number; w: number };

/** The three wrist joints, in chain order. Keys are the descriptor's shorts. */
export const WRIST_JOINTS = ["forearm_yaw", "wrist_pitch", "wrist_roll"] as const;
export type WristJoint = (typeof WRIST_JOINTS)[number];

/** Wrist angles in radians, keyed by joint short. */
export type WristAngles = Record<WristJoint, number>;

// --- quaternion helpers (local: this module must stay independently testable) --

function qConj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function qMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function qNorm(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(n > 0)) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

// --- the forearm basis ------------------------------------------------------
//
// WebXR grip space is +X right, +Y up, and −Z the direction the hand POINTS when
// holding the controller like a torch — so −Z is the forearm's long axis.
//
// The robot's wrist frame wants Z along the forearm, Y as the flexion axis and X
// as the deviation axis. Holding a controller with the palm inboard, flexion
// (bending the hand up and down) turns about the grip's X, and deviation
// (waggling it left and right) turns about the grip's Y. So:
//
//     forearm Z = grip −Z      (pronation axis, along the forearm)
//     forearm Y = grip  X      (flexion axis)
//     forearm X = grip  Y      (deviation axis)
//
// Right-handed: X × Y = gripY × gripX = −gripZ = Z. That basis change is a 180°
// rotation about (1,1,0)/√2.
//
// NOTE — this constant is THE thing to confirm on hardware. It replaces the
// three independent sign constants the old mapper carried, so a wrong wrist is
// now one frame to fix rather than a sign hunt across three axes. It also
// predicts that the old mapper had flexion and deviation SWAPPED: it read the
// hand's X-axis rotation (`flex = -rv[0]`) and sent it to wrist_pitch, which is
// the Y-axis joint. Confirm with one poke per axis before trusting the signs.
const R2 = Math.SQRT1_2;
export const GRIP_TO_FOREARM: Quat = { x: R2, y: R2, z: 0, w: 0 };

/**
 * Re-express a rotation given in grip coordinates in the forearm frame.
 * Conjugation, not composition: the rotation is the same physical motion, only
 * its coordinates change.
 */
function toForearmFrame(q: Quat): Quat {
  return qMul(qMul(qConj(GRIP_TO_FOREARM), q), GRIP_TO_FOREARM);
}

// Gimbal lock: intrinsic ZYX degenerates as flexion approaches ±90°, where
// pronation and deviation stop being separable — only their sum is determined,
// and a naive decomposition spins wildly. Human wrist flexion reaches about 80°
// and the robot's wrist_pitch limit is exactly 90°, so this WILL be approached
// in normal use. It is not a theoretical corner.
//
// cos(flexion) below this is treated as degenerate; 0.1 rad ≈ 5.7° from the pole.
const GIMBAL_COS_FLOOR = Math.sin(0.1);

export type WristDecomposition = {
  /** Joint angles, radians, relative to the reference orientation. */
  angles: WristAngles;
  /**
   * True when the decomposition passed within ~6° of the flexion pole, where
   * pronation and deviation are not separable. The caller should hold its last
   * good values for those two rather than trusting these.
   */
  gimbal: boolean;
};

/**
 * Decompose a hand orientation into the robot's three wrist angles.
 *
 * `hand` and `reference` are both grip-space orientations in the SAME parent
 * space (WebXR reference space). The result is the rotation from `reference` to
 * `hand`, expressed as the robot's Z-Y-X wrist chain.
 *
 * Pure: no state, no accumulation. Feeding the same pair always yields the same
 * angles, which is what makes this immune to the drift and ratchet failures of
 * the delta-integrating path it replaces.
 */
export function wristAngles(hand: Quat, reference: Quat): WristDecomposition {
  // Body-frame increment: where the hand is now, relative to where it was
  // anchored. Reference-inverse FIRST — the delta is expressed in the
  // reference's own frame, not the world's.
  const rel = toForearmFrame(qNorm(qMul(qConj(qNorm(reference)), qNorm(hand))));
  const { x, y, z, w } = rel;

  // Intrinsic ZYX (z, then y', then x''), taken straight from the quaternion.
  const sinPitch = 2 * (w * y - z * x);
  const clamped = Math.max(-1, Math.min(1, sinPitch));
  const pitch = Math.asin(clamped);
  const gimbal = Math.abs(clamped) > 1 - GIMBAL_COS_FLOOR * GIMBAL_COS_FLOOR / 2
    || Math.cos(pitch) < GIMBAL_COS_FLOOR;

  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));

  return {
    angles: { forearm_yaw: yaw, wrist_pitch: pitch, wrist_roll: roll },
    gimbal,
  };
}

/**
 * Compose absolute joint targets from a clutch anchor and a hand delta.
 *
 * `anchor` is the robot's MEASURED wrist angles at the moment the clutch
 * engaged. Anchoring rather than mapping absolutely is what stops the arm
 * lurching on the first frame — sendAction applies targets with no server-side
 * slew, so an unanchored first target would snap the wrist from wherever the
 * robot was to wherever the operator's hand happened to be. It also dissolves
 * the "controller held aloft is not the robot's zero" problem without any
 * hard-coded ready offset on either side: the correspondence is established
 * wherever the operator clutches.
 *
 * Anchoring costs nothing that matters here. The delta is recomputed from the
 * current quaternion every frame, never accumulated, so this is still absolute
 * control — the anchor is captured once, not integrated.
 */
export function wristTargets(
  anchor: WristAngles, delta: WristAngles, limits?: Partial<Record<WristJoint, readonly [number, number]>>,
): WristAngles {
  const out = {} as WristAngles;
  for (const joint of WRIST_JOINTS) {
    let v = anchor[joint] + delta[joint];
    const lim = limits?.[joint];
    if (lim) v = Math.max(lim[0], Math.min(lim[1], v));
    out[joint] = v;
  }
  return out;
}

// --- human ROM gain ---------------------------------------------------------
//
// A strict 1:1 anatomical map is right in principle and wrong on one axis in
// practice, because the human wrist's three DOF are wildly unequal while the
// robot's are not. Measured against noriA3-0's own calibration (2026-09-07):
//
//   gesture              human ROM   joint span (L)   reachable at 1:1
//   pronation            +/-85 deg     310.4 deg          55%
//   flexion/extension    80 / 70       183.7              82%
//   radial/ulnar dev.    20 / 30       149.9              33%   <-- and 25% (R)
//
// Radial/ulnar deviation is the most restricted joint in the human wrist: about
// +/-25 deg against +/-85 of pronation. Mapped 1:1 it produces a third of the
// motion the other two do, on a movement the wrist can barely make — which is
// exactly how it was reported from the headset ("roll and pitch seem ok, but
// yaw is definitely not", 2026-09-07). It is not a sign or an axis error; the
// basis is right-handed and the other two axes verified correct on hardware,
// which leaves the third determined.
//
// So deviation alone is amplified. Pronation and flexion stay 1:1 because they
// already match well and were confirmed good on hardware — this costs nothing
// on the two axes that work.
//
// The gain is fixed rather than derived per-arm from ranges_si on purpose: left
// wrist_roll is +/-75 deg and right is +/-101, and a per-arm gain would make the
// two hands feel different in two-handed work. 3.0 fills the TIGHTER arm
// (25 * 3 = 75) and leaves the wider one with margin.
export const HUMAN_ROM_RAD: WristAngles = {
  forearm_yaw: (85 * Math.PI) / 180,
  wrist_pitch: (75 * Math.PI) / 180,
  wrist_roll: (25 * Math.PI) / 180,
};

/** Per-axis amplification from human ROM to joint range. 1 = strict 1:1. */
export const WRIST_GAIN: WristAngles = {
  forearm_yaw: 1,
  wrist_pitch: 1,
  wrist_roll: 3,
};

/**
 * Scale a decomposed hand delta by the per-axis ROM gain.
 *
 * Deliberately separate from wristTargets: composing an anchor with a delta is
 * kinematics and belongs to the robot, whereas how far a human gesture should
 * throw a joint is CONTROL POLICY and belongs to this client. Keeping them apart
 * means the gain can be retuned, or set to all-ones for a strict anatomical
 * mirror, without touching the geometry.
 */
export function applyRomGain(
  angles: WristAngles, gain: WristAngles = WRIST_GAIN,
): WristAngles {
  const out = {} as WristAngles;
  for (const joint of WRIST_JOINTS) out[joint] = angles[joint] * gain[joint];
  return out;
}

/** Zero angles — the identity decomposition, and the value at clutch engage. */
export function zeroWristAngles(): WristAngles {
  return { forearm_yaw: 0, wrist_pitch: 0, wrist_roll: 0 };
}
