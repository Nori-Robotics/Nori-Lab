// Live telemetry → URDF joint angles for the A3 3D viewer.
//
// Telemetry frames carry NORMALIZED positions (17 keys at 15 Hz):
//   - "{side}_arm_{short}.pos"    7 arm joints per side, norm_mode range_m100_100 (-100..100)
//   - "{side}_arm_gripper.pos"    0..100
//   - "lift.pos"                  millimetres (0..720)
// The descriptor's `ranges` are normalized spans, NOT radians — so the radian
// span comes from the URDF joint limits themselves. If a future daemon ships a
// `ranges_rad` field on the descriptor, that is preferred over the URDF limits.
//
// Mimic joints ({side}_gripper_idler_joint ×-1, lift_middle_joint ×0.5) must
// never be driven directly: urdf-loader applies mimics automatically when the
// master joint moves. This mapper only ever targets master joints, and skips
// anything urdf-loader marks as a mimic as a belt-and-braces guard.

import type { RobotDescriptor } from "@nori/sdk";

/** The slice of urdf-loader's URDFJoint this mapper reads. */
export interface UrdfJointInfo {
  jointType?: string;
  limit?: { lower?: number; upper?: number };
  /** Set by urdf-loader on mimic joints (the master they follow). */
  mimicJoint?: unknown;
}

const ARM_KEY = /^(left|right)_arm_([a-z0-9_]+)\.pos$/;
const LIFT_KEY = "lift.pos";

// Warn once per unknown key, per session — telemetry arrives at 15 Hz and a
// console flooded at that rate is worse than no warning at all.
const warned = new Set<string>();

const clamp01 = (f: number) => (f < 0 ? 0 : f > 1 ? 1 : f);

/**
 * Map a telemetry state dict onto URDF joint angles (radians / metres).
 *
 * Only keys present in the frame are mapped (absent joints hold their last
 * value). Unknown keys, non-finite values, mimic joints and continuous joints
 * (no usable limits) are skipped — never thrown on.
 */
export function liveStateToJointRadians(
  state: Record<string, number>,
  joints: Record<string, UrdfJointInfo>,
  descriptor?: RobotDescriptor
): Record<string, number> {
  const out: Record<string, number> = {};
  // Future-proofing: radian ranges straight from the robot, if the daemon ever
  // ships them. Not in the current RobotDescriptor type, hence the cast.
  const rangesRad = (descriptor as { ranges_rad?: Record<string, [number, number]> } | undefined)
    ?.ranges_rad;

  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;

    let jointName: string;
    let fraction: number; // 0..1 across the joint's radian span
    if (key === LIFT_KEY) {
      jointName = "lift_extension_joint";
      fraction = NaN; // handled below: mm → metres, clamped to the limit
    } else {
      const m = ARM_KEY.exec(key);
      if (!m) continue; // not a joint key (base odometry etc.) — not ours
      const [, side, short] = m;
      jointName = `${side}_${short}_joint`;
      fraction =
        short === "gripper"
          ? clamp01(value / 100) // 0..100
          : clamp01((value + 100) / 200); // -100..100
    }

    const joint = joints[jointName];
    if (!joint) {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`liveJointPose: telemetry key "${key}" has no URDF joint "${jointName}"`);
      }
      continue;
    }
    if (joint.mimicJoint) continue; // never drive a mimic directly

    const range = rangesRad?.[key];
    const lower = range ? range[0] : joint.limit?.lower;
    const upper = range ? range[1] : joint.limit?.upper;
    if (typeof lower !== "number" || typeof upper !== "number" || !(upper > lower)) {
      continue; // continuous (0..0) or malformed limits — nothing to map onto
    }

    out[jointName] =
      key === LIFT_KEY
        ? Math.min(upper, Math.max(lower, value / 1000)) // mm → m, clamped
        : lower + fraction * (upper - lower);
  }
  return out;
}
