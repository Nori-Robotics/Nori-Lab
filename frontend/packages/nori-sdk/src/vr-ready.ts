// Ready-wrist offset for VR. CLIENT-SIDE ON PURPOSE.
//
// A controller held naturally aloft does not correspond to the robot's wrist at
// zero — zero is arms-at-sides. With rate control there is no neutral (the
// clutch anchors wherever the arm already is), so the correspondence has to
// come from the pose the wrist STARTS in.
//
// This lives in the client, not the robot, because it is a VR ergonomic
// preference and nothing else. An earlier attempt put it in the robot's READY
// constant, which was wrong three ways: that pose was SEARCHED for conditioning
// and table clearance rather than hand comfort, it is shared with commissioning
// and leader bring-up, and it lives in a deprecated package whose direct
// trajectory publish may not even survive the arbiter (known issue 28).
//
// It rides `sendAction` — absolute normalized joint targets, the same path the
// physical leader arms use — so it goes THROUGH the arbiter rather than around
// it, and needs no robot-side change at all.
import type { RemoteTeleop, RobotDescriptor } from "./teleop";

/** Wrist offsets, degrees, for the LEFT arm. The right arm mirrors. */
export const READY_WRIST_DEG = {
  forearm_yaw: -80,
  wrist_roll: 80,
} as const;

// 80 rather than 90 deliberately: wrist_roll stops at ±95°, and a joint parked
// within a few degrees of its stop is what failed the arm bounds gate for 20
// minutes on 2026-09-04. 80 leaves 15° of margin.

/**
 * Normalized [-100,100] value for a joint angle in radians, using the robot's
 * own calibrated bounds. Returns null when the descriptor cannot place it —
 * guessing a normalized target would command an arbitrary real angle.
 */
export function normalizeJoint(
  descriptor: RobotDescriptor | null | undefined, key: string, radians: number,
): number | null {
  const si = descriptor?.ranges_si?.[key];
  if (!si) return null;
  const [lo, hi] = si;
  const span = hi - lo;
  if (!span) return null;
  const norm = ((radians - lo) / span) * 200 - 100;
  return Math.max(-100, Math.min(100, norm));
}

/**
 * Command both wrists to the ready offset. Returns the keys actually sent.
 *
 * No-ops when the robot is not armed (the gateway refuses with `not_armed`) or
 * when the descriptor lacks ranges_si, rather than sending a target derived
 * from a guessed range.
 */
export function sendReadyWrist(
  teleop: RemoteTeleop | null,
  descriptor: RobotDescriptor | null | undefined,
  arms: readonly string[] = ["left", "right"],
): string[] {
  if (!teleop) return [];
  const action: Record<string, number> = {};
  for (const side of arms) {
    // The arms are mirrored, so the right takes the opposite sign. Flagged
    // rather than measured: if the right wrist ends up rolled the wrong way,
    // this is the line.
    const mirror = side === "right" ? -1 : 1;
    for (const [joint, deg] of Object.entries(READY_WRIST_DEG)) {
      const key = `${side}_arm_${joint}.pos`;
      const norm = normalizeJoint(descriptor, key, (deg * mirror * Math.PI) / 180);
      if (norm !== null) action[key] = norm;
    }
  }
  const keys = Object.keys(action);
  if (keys.length) teleop.sendAction(action);
  return keys;
}
