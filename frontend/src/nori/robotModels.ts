// Client-side product gate for which robot models this Lab build lets a customer use.
//
// UX GUARDRAIL ONLY — deliberately NOT enforced server-side (product decision
// 2026-08-13). A determined user can still pair/connect a blocked model by calling the
// backend API directly; this just keeps the shipped (notarized) customer app from
// offering it. To open a model up later, remove it from BLOCKED_ROBOT_MODELS — no other
// change needed.
export const BLOCKED_ROBOT_MODELS: readonly string[] = ["L3"];

/** Fleet-serial model code: "NORI-L3-0007" -> "L3". Non-fleet / unrecognized serials
 * (e.g. dev rooms, legacy formats) -> null. Casing-insensitive, matches the backend's
 * _FLEET_SERIAL parse. */
export function serialModelCode(serial: string): string | null {
  const m = /^NORI-(L\d+)/i.exec(serial.trim());
  return m ? m[1].toUpperCase() : null;
}

/** True when this serial's model is blocked in this app build. Unknown / non-fleet
 * serials are NEVER blocked — the gate only stops KNOWN disallowed models (e.g. L3),
 * so it can't accidentally reject a legacy or dev serial it doesn't recognize. */
export function isRobotModelBlocked(serial: string): boolean {
  const code = serialModelCode(serial);
  return code !== null && BLOCKED_ROBOT_MODELS.includes(code);
}
