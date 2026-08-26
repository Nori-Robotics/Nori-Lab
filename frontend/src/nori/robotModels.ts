// Client-side product gate for which robot models this Lab build lets a customer use.
//
// UX GUARDRAIL ONLY — deliberately NOT enforced server-side (product decision
// 2026-08-13). A determined user can still pair/connect a blocked model by calling the
// backend API directly; this just keeps the shipped (notarized) customer app from
// offering it. To open a model up later, remove it from BLOCKED_ROBOT_MODELS — no other
// change needed.
import type { RobotDescriptor } from "@nori/sdk";

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

/**
 * Servo case-temperature thresholds, per model. These differ by GENERATION and
 * getting them from the wire is not possible today — the `ack` carries no model
 * field — so they are derived from the serial, like every other model-keyed
 * behaviour in this file.
 *
 *   L2  torque cuts at 58 C: the daemon's own software latch (SAFETY.md
 *       2026-08-07). Warn from 50, red from 56.
 *   A3  torque cuts at 60 C: a SOFTWARE policy in the supervisor/driver,
 *       deliberately independent of the servo's EEPROM Max_Temperature_Limit
 *       (tools/bringup/recovery.md "Phase 4e"). The robot also warns at 58, so
 *       red starts there; amber keeps L2's 8 C lead-in, from 52.
 *
 * Unknown serials get the L2 numbers on purpose: the lowest cut point warns
 * EARLIEST. Guessing high on an unknown robot would warn too late, which is the
 * one error that costs a servo.
 */
export interface ServoThermalThresholds {
  /** Start listing a joint at all (amber). */
  warnC: number;
  /** Red — the cut is imminent. */
  hotC: number;
  /** Where torque is actually lost. */
  cutC: number;
}

const L2_SERVO_THERMAL: ServoThermalThresholds = { warnC: 50, hotC: 56, cutC: 58 };
const A3_SERVO_THERMAL: ServoThermalThresholds = { warnC: 52, hotC: 58, cutC: 60 };

export function servoThermalThresholds(
  serial: string | null | undefined,
): ServoThermalThresholds {
  if (!serial) return L2_SERVO_THERMAL;
  return serialModelCode(serial)?.startsWith("A")
    ? A3_SERVO_THERMAL
    : L2_SERVO_THERMAL;
}

/**
 * DISPLAY-ONLY descriptor stand-in for an A-series robot before the session ack
 * arrives, so the mode label and keybind legend read "cartesian" with the same
 * serial-keyed logic as the schematic/thermal gates above. Values mirror what
 * the A3 gateway advertises in jog_scale.task; nothing here drives the wire —
 * the SDK's armKeymap() only ever uses the REAL ack descriptor.
 */
const A3_TASK_DISPLAY_DESCRIPTOR = {
  jog_scale: { task: { x: 0.08, y: 0.08, z: 0.08, pitch: 0.5, yaw: 0.5 } },
} as RobotDescriptor;

/**
 * The descriptor UI surfaces should render from: the live ack descriptor when
 * connected, else a serial-derived stand-in. Same inverse-shape rule as
 * usesStylisedSchematic — only a known L2 gets the legacy (null → cylindrical)
 * rendering; unknown serials show the current-generation (cartesian) UI.
 */
export function displayDescriptor(
  descriptor: RobotDescriptor | null | undefined,
  serial: string | null | undefined,
): RobotDescriptor | null {
  if (descriptor) return descriptor;
  return usesStylisedSchematic(serial) ? null : A3_TASK_DISPLAY_DESCRIPTOR;
}

/** True when this serial's model is blocked in this app build. Unknown / non-fleet
 * serials are NEVER blocked — the gate only stops KNOWN disallowed models (e.g. L3),
 * so it can't accidentally reject a legacy or dev serial it doesn't recognize. */
export function isRobotModelBlocked(serial: string): boolean {
  const code = serialModelCode(serial);
  return code !== null && BLOCKED_ROBOT_MODELS.includes(code);
}
