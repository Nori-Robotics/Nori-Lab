// Client-side product gate for which robot models this Lab build lets a customer use.
//
// UX GUARDRAIL ONLY — deliberately NOT enforced server-side (product decision
// 2026-08-13). A determined user can still pair/connect a blocked model by calling the
// backend API directly; this just keeps the shipped (notarized) customer app from
// offering it. To open a model up later, remove it from BLOCKED_ROBOT_MODELS — no other
// change needed.
export const BLOCKED_ROBOT_MODELS: readonly string[] = ["L3"];

/** Fleet-serial model code: "NORI-L3-0007" -> "L3", "NORI-A3-0000" -> "A3". Non-fleet /
 * unrecognized serials (e.g. dev rooms, legacy formats) -> null. Casing-insensitive,
 * matches the backend's _FLEET_SERIAL parse.
 *
 * Matches any <letter><digits> code, not just L-series: the A-series exists now, and an
 * L-only pattern silently returned null for every A3. That was harmless for
 * isRobotModelBlocked (A3 is not on the blocked list either way) but wrong for anything
 * else keying off the model. */
export function serialModelCode(serial: string): string | null {
  const m = /^NORI-([A-Z]\d+)/i.exec(serial.trim());
  return m ? m[1].toUpperCase() : null;
}

/** True when this serial is an A-series robot, which has a published URDF to render.
 * Everything else falls back to the stylised model on the remote page. */
export function hasUrdfModel(serial: string | null | undefined): boolean {
  if (!serial) return false;
  const code = serialModelCode(serial);
  return code !== null && code.startsWith("A");
}

/**
 * True when this serial should get the OLD stylised model rather than the A3
 * description, on the remote page's 3D schematic.
 *
 * Deliberately the inverse shape of hasUrdfModel above. That one asks "does
 * this model ship a URDF", and answers no for anything it does not recognise —
 * right for the pairing page, which is showing you a picture of the robot you
 * just paired. This one asks "is this specifically an L2", because the current
 * robot is the A3 and an unrecognised or not-yet-known serial should show the
 * current robot, not the previous generation.
 *
 * Note this means an L3 gets the A3 render. L3 is on BLOCKED_ROBOT_MODELS so it
 * cannot be paired from this build at all; if that ever changes, it wants its
 * own case here.
 */
export function usesStylisedSchematic(serial: string | null | undefined): boolean {
  return !!serial && serialModelCode(serial) === "L2";
}

/** True when this serial's model is blocked in this app build. Unknown / non-fleet
 * serials are NEVER blocked — the gate only stops KNOWN disallowed models (e.g. L3),
 * so it can't accidentally reject a legacy or dev serial it doesn't recognize. */
export function isRobotModelBlocked(serial: string): boolean {
  const code = serialModelCode(serial);
  return code !== null && BLOCKED_ROBOT_MODELS.includes(code);
}
