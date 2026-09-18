// NORI: Additive. The A3 shape for the SDK mock (`@nori/sdk/mock`), whose built-in default
// is L2-shaped (shoulder_pan / elbow_flex, six joints per arm, two lifts). The published
// URDF (public/nori-urdf/nori.urdf) is the A3, so a mock that should pose THAT model has
// to speak its vocabulary: seven arm joints + gripper per side, ONE lift, four cameras.
//
// Every joint key here round-trips through liveJointPose.ts:
//   "{side}_arm_{short}.pos"  ->  "{side}_{short}_joint"   (URDF joint names, verbatim)
//   "lift.pos" (mm)           ->  "lift_extension_joint"   (metres, clamped to the limit)
//
// `ranges_si` is the URDF limit table. Publishing it on the descriptor does two things at
// once: the viewer's normalized->radian mapping prefers it over the URDF limits it would
// otherwise read (identical numbers, but now explicit), and the geometric mock
// (a3MockSim.ts) uses the SAME table for its radian->normalized inverse — so what the sim
// solves and what the viewer draws agree by construction, not by two conversions that
// happen to match today.

import type { RobotDescriptor } from "@nori/sdk";
import type { MockSimOptions } from "@nori/sdk/mock";

export const A3_SIDES = ["left", "right"] as const;
export type A3Side = (typeof A3_SIDES)[number];

/** Arm joints in URDF chain order, then the gripper. Same list as robotModels.A3_ARM_SHORTS. */
export const A3_ARM_JOINTS = [
  "shoulder_pitch", "shoulder_roll", "bicep_yaw", "elbow_pitch",
  "forearm_yaw", "wrist_pitch", "wrist_roll",
] as const;

/** URDF joint limits, radians (nori.urdf). gripper is 0..pi/2 on a 0..100 normalized key. */
const URDF_LIMITS_RAD: Record<(typeof A3_ARM_JOINTS)[number] | "gripper", [number, number]> = {
  shoulder_pitch: [-Math.PI, Math.PI],
  shoulder_roll: [-Math.PI / 2, Math.PI / 2],
  bicep_yaw: [-Math.PI, Math.PI],
  elbow_pitch: [-Math.PI / 2, Math.PI / 2],
  forearm_yaw: [-Math.PI, Math.PI],
  wrist_pitch: [-Math.PI / 2, Math.PI / 2],
  wrist_roll: [-Math.PI / 2, Math.PI / 2],
  gripper: [0, Math.PI / 2],
};

/** Lift travel, millimetres on the wire (the A-series lift key is already physical). */
export const A3_LIFT_RANGE_MM: [number, number] = [0, 720];

export const armKey = (side: A3Side, joint: string) => `${side}_arm_${joint}.pos`;

/** Camera roles in the order the composite video tiles them (2x2, row-major). Matches
 *  simRuntime.CAMERA_VIEWS so tile i of the mock's camera_layout is CAMERA_VIEWS[i]. */
export const A3_MOCK_CAMERAS = ["front", "overhead", "left_wrist", "right_wrist"] as const;

export function a3MockDescriptor(): RobotDescriptor {
  const joints: string[] = [];
  const ranges: Record<string, [number, number]> = {};
  const rangesSi: Record<string, [number, number]> = {};
  for (const side of A3_SIDES) {
    for (const j of A3_ARM_JOINTS) {
      const key = armKey(side, j);
      joints.push(key);
      ranges[key] = [-100, 100];
      rangesSi[key] = [...URDF_LIMITS_RAD[j]];
    }
    const g = armKey(side, "gripper");
    joints.push(g);
    ranges[g] = [0, 100];
    rangesSi[g] = [...URDF_LIMITS_RAD.gripper];
  }
  ranges["lift.pos"] = [...A3_LIFT_RANGE_MM];
  return {
    buses: ["bus1", "bus2"],
    joints,
    base: ["x.vel", "theta.vel"],
    aux: ["lift"],
    cameras: [...A3_MOCK_CAMERAS],
    ranges,
    ranges_si: rangesSi,
    jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08, pitch: 0.5, yaw: 0.5 } },
  };
}

/** Normalized (-100..100, or 0..100 for the gripper) -> radians, via the descriptor's SI
 *  bounds. Exactly liveJointPose's arithmetic for a key with a `ranges_si` entry. */
export function normToRad(descriptor: RobotDescriptor, key: string, norm: number): number {
  const si = descriptor.ranges_si?.[key];
  const r = descriptor.ranges?.[key] ?? [-100, 100];
  if (!si) throw new Error(`no ranges_si for ${key}`);
  const fraction = (norm - r[0]) / (r[1] - r[0]);
  return si[0] + fraction * (si[1] - si[0]);
}

/** Radians -> normalized. The inverse of normToRad; NOT clamped (the caller decides whether
 *  an out-of-range answer is a limit refusal or a clamp). */
export function radToNorm(descriptor: RobotDescriptor, key: string, rad: number): number {
  const si = descriptor.ranges_si?.[key];
  const r = descriptor.ranges?.[key] ?? [-100, 100];
  if (!si) throw new Error(`no ranges_si for ${key}`);
  const fraction = (rad - si[0]) / (si[1] - si[0]);
  return r[0] + fraction * (r[1] - r[0]);
}

/** The URDF zero pose (every joint at 0, grippers part-open, lift 100 mm). Kept at zero so
 *  the viewer and the sim start from the same unambiguous configuration. */
export function a3MockInitialState(): Record<string, number> {
  const st: Record<string, number> = {};
  for (const side of A3_SIDES) {
    for (const j of A3_ARM_JOINTS) st[armKey(side, j)] = 0;
    st[armKey(side, "gripper")] = 30;
  }
  st["lift.pos"] = 100;
  return st;
}

/** Everything `new MockDaemonSim(opts)` / `new A3MockSim(opts)` needs to be an A3. */
export function a3MockSimOptions(extra?: Partial<MockSimOptions>): MockSimOptions {
  return {
    descriptor: a3MockDescriptor(),
    initialState: a3MockInitialState(),
    ...extra,
  };
}
