// NORI: Additive file. Pure-math forward kinematics for the L-series (SO101) arm — no three.js,
// so it can ship in the main SDK entry (robot-model.ts, which renders, imports the constants
// from here so the schematic and this FK can never disagree).
//
// Purpose: a cheap, token-light "where is the gripper, in millimetres" readout for the agent
// loop's grounding (see frontend poseSummary.ts). It is NOT a motion planner: it reuses the
// daemon's own approximations (normalized units ≈ degrees, kinematics.cpp link geometry), so it
// is exactly as right — or as approximately right — as the pose the daemon believes it is in.
//
// Frame convention (matches the task-space jog and REP-103): +x forward, +y robot-left, +z up.
// Origin: the arm's shoulder_pan axis with the rail at its TOP. z subtracts the rail descent
// ("<side>_lift.pos", millimetres below rail-top) when telemetry carries it.

// SO101 planar geometry, verbatim from the daemon's kinematics.cpp: link lengths and the two
// link-bend offsets its angle convention bakes in. (Moved here from robot-model.ts.)
export const SO101_L1_M = 0.1159; // shoulder_lift axis -> elbow axis (m)
export const SO101_L2_M = 0.135; // elbow axis -> wrist_flex axis (m)
export const SO101_T1O = Math.atan2(0.028, 0.11257);
export const SO101_T2O = Math.atan2(0.0052, 0.1349) + SO101_T1O;
// wrist_flex axis -> roll/jaw root, and jaw root -> fingertip midpoint (measured, robot-model.ts)
export const SO101_WRIST_M = 0.06;
export const SO101_GRIP_M = 0.09;

const DEG = Math.PI / 180;

/** A gripper position in millimetres, in the frame documented in the file header. */
export interface GripperPointMm {
  x: number;
  y: number;
  z: number;
}

// Clamped normalized joint value (≈ degrees — the daemon's own conflation, see robot-model.ts
// header). Missing key -> 0 (rest pose).
function jointDeg(state: Record<string, number>, key: string): number {
  const n = state[key];
  return typeof n === "number" ? Math.max(-100, Math.min(100, n)) : 0;
}

/**
 * Gripper-tip position of one L-series arm from a telemetry `state` dict, in mm.
 *
 * Returns null when the arm isn't in the telemetry at all (no `<side>_arm_shoulder_pan.pos`
 * key) — e.g. a robot without that arm — rather than reporting a fictitious rest pose.
 *
 * Planar chain in the daemon's angle convention (robot-model.ts header): shoulder world pitch
 * th1 = rad(90 − sl) − T1O; elbow bend th2 = rad(ef + 90) − T2O (0 = straight, + bends down);
 * gripper WORLD pitch = −rad(sl + ef + wf). Pan: the SO101 URDF Rotation axis is (0,0,−1) in
 * the Z-up base frame, so +pan yaws the arm CLOCKWISE from above = toward robot-RIGHT (−y).
 */
export function l2GripperMm(state: Record<string, number>, side: "left" | "right"): GripperPointMm | null {
  const p = `${side}_arm_`;
  if (typeof state[`${p}shoulder_pan.pos`] !== "number") return null;

  const sl = jointDeg(state, `${p}shoulder_lift.pos`);
  const ef = jointDeg(state, `${p}elbow_flex.pos`);
  const wf = jointDeg(state, `${p}wrist_flex.pos`);
  const pan = jointDeg(state, `${p}shoulder_pan.pos`) * DEG;

  const th1 = (90 - sl) * DEG - SO101_T1O; // upper-link pitch above horizontal
  const th2 = (ef + 90) * DEG - SO101_T2O; // elbow bend, 0 = straight
  const ag = -(sl + ef + wf) * DEG; // gripper world pitch above horizontal
  const tip = SO101_WRIST_M + SO101_GRIP_M;

  const r = SO101_L1_M * Math.cos(th1) + SO101_L2_M * Math.cos(th1 - th2) + tip * Math.cos(ag);
  let z = SO101_L1_M * Math.sin(th1) + SO101_L2_M * Math.sin(th1 - th2) + tip * Math.sin(ag);

  // Lift offset: real mm, 0 at the TOP of the rail and positive DOWNWARD (rail.ts railReading),
  // so descent SUBTRACTS from z. Key omitted while the Pi's tracker isn't valid — treat absence
  // as "at boot height" (z stays arm-only).
  const lift = state[`${side}_lift.pos`] ?? state["lift.pos"];
  if (typeof lift === "number") z -= Math.max(0, lift) / 1000;

  const mm = (m: number) => Math.round(m * 1000) + 0; // +0 folds Math.round's -0 to 0
  return {
    x: mm(r * Math.cos(pan)),
    y: mm(-r * Math.sin(pan)), // +pan = clockwise from above = robot-right
    z: mm(z),
  };
}
