// nori-sdk core — Z-lift (rail) telemetry reading. Pure: no three.js, no React, so the 2D
// rail gauge (TeleopStatus.RailHeight), the desktop 3D schematic and the in-VR 3D robot all
// derive the carriage height from ONE place and can't drift apart.
//
// TWO LIFT SHAPES exist in the fleet and they are not interchangeable:
//
//   L-series  one lift PER ARM. Telemetry keys "left_lift.pos" / "right_lift.pos".
//   A-series  ONE central telescoping column. Telemetry key is the BARE "lift.pos".
//
// A robot says which it has in ack descriptor.aux (["left_lift","right_lift"] vs ["lift"]),
// so `liftAxes()` below is the single place that resolves it. Everything else must call that
// rather than matching key names itself — hand-derived key lists are exactly how the A-series
// went unsupported here for weeks while the Python SDK already spoke it.
//
// Verified against the LIVE descriptor from NORI-A3-0000 (2026-08-21): aux ["lift"],
// ranges["lift.pos"] = [0, 720].

import type { RobotDescriptor } from "./teleop";

// Fallback full travel, in mm, for a robot that advertises no range for its lift — which in
// practice means the frozen L-series fleet, whose ack carries no descriptor at all.
// Per variant: 950 (tall) / 650 (short), the Pi's NORI_LIFT_TRAVEL_MM. Default to TALL since
// most of that fleet is 950: on a short 650 unit the gauge tops out at ~68% of the bar and
// the mm text stays exact, which is the safe direction — unlike 650-on-a-950, which pins the
// visual at "bottom" with 300 mm of real travel left and makes motion read ~1.5x too fast.
//
// A robot that DOES advertise ranges["<lift>.pos"] no longer uses this: liftAxes() reads the
// real travel from the descriptor, which is what the original TODO here asked for.
export const RAIL_TRAVEL_MM = 950;

// One lift column, resolved from the robot's own descriptor.
export interface LiftAxis {
  key: string;                        // telemetry key: "lift.pos" | "<side>_lift.pos"
  label: string;                      // for a gauge: "Rail" | "L rail" | "R rail"
  travelMm: number;                   // full travel, from the descriptor when it says
  side: "left" | "right" | null;      // null = the single central column (A-series)
  advertised: boolean;                // false = travelMm is the RAIL_TRAVEL_MM guess
}

const L_SERIES_FALLBACK = ["left_lift", "right_lift"];

function labelFor(side: "left" | "right" | null, count: number): string {
  if (side === null) return "Rail";
  // "L rail"/"R rail" only earn their prefix when there are two to tell apart.
  return count > 1 ? (side === "left" ? "L rail" : "R rail") : "Rail";
}

// Every lift this robot actually has, in a stable order. Empty when the robot advertises a
// descriptor with no lift at all — which is a real answer (some units ship without one) and
// must render as "no rail", never as a rail stuck at zero.
//
// With NO descriptor we assume the L-series pair, because a legacy robot that sends no
// descriptor is by definition an L-series unit and that is what it has.
export function liftAxes(descriptor?: RobotDescriptor): LiftAxis[] {
  const aux = descriptor?.aux;
  const names = descriptor
    ? (aux ?? []).filter((a) => a === "lift" || a.endsWith("_lift"))
    : L_SERIES_FALLBACK;

  return names.map((name) => {
    const key = `${name}.pos`;
    const span = descriptor?.ranges?.[key];
    const side = name === "lift" ? null : name.startsWith("left") ? "left" : "right";
    return {
      key,
      label: labelFor(side, names.length),
      // Travel is the SPAN, not the max: a lift whose range starts off zero still has only
      // (high - low) of usable travel, and dividing by `high` would under-read the fraction.
      travelMm: span ? Math.abs(span[1] - span[0]) : RAIL_TRAVEL_MM,
      side,
      advertised: Boolean(span),
    };
  });
}

// The JOG-namespace key for this robot's lift, given which arm the operator has selected.
//
// Note the namespace: a jog addresses the lift as "left_lift" / "right_lift" / "lift" with NO
// ".pos" suffix, while telemetry and `ranges` use "<name>.pos". Mixing them up sends a key the
// robot does not recognise, which it ignores in SILENCE — the operator presses the lift key and
// simply nothing happens.
//
// Returns null when the robot advertises no lift, so a caller can omit the key rather than
// invent one.
export function liftJogKey(
  descriptor: RobotDescriptor | undefined,
  side: "left" | "right"
): string | null {
  const axes = liftAxes(descriptor);
  const axis = axes.find((a) => a.side === side) ?? axes.find((a) => a.side === null);
  return axis ? axis.key.replace(/\.pos$/, "") : null;
}

// The lift keys present in a telemetry dict, for callers that have `state` but no descriptor.
// Prefer liftAxes(descriptor) when you have one — it also gives you the real travel. This
// exists because "find the lift key yourself" kept getting written as `endsWith("_lift.pos")`,
// which silently skips the A-series bare "lift.pos" — including in a call site whose own
// comment said the key differs per generation.
export function liftKeysInState(state: Record<string, number>): string[] {
  return Object.keys(state).filter((k) => k === "lift.pos" || k.endsWith("_lift.pos"));
}

// Shared reading. `depthMm` = distance below the top (>=0), `frac` = fraction of full travel
// descended (0 = at top/home, 1 = at bottom).
//
// The robot publishes <lift>.pos ALREADY in this frame — 0 at the top of the rail, positive
// downward. We take it at face value and CLAMP a negative reading to 0 rather than folding it
// with Math.abs().
//
// This used to be `Math.abs(h)`, on the reasoning that the rail starts at the top so the only
// possible direction is down, making the magnitude unambiguous. That was defensive against
// the Pi's lift direction being unverified — but it also meant a robot with its rail
// direction configured BACKWARDS still rendered a perfectly plausible gauge, which removed
// the last place a human might have noticed. As of 2026-07-14 direction is a calibrated,
// verified per-unit value on the Pi (lift.hpp), so a negative depth is now a real signal —
// the carriage is above its zero, i.e. the axis desynced or was zeroed mid-travel — and it
// should read as a pinned, obviously-wrong 0 instead of being quietly mirrored into a
// believable number.
//
// Pass `travelMm` from the matching LiftAxis. It defaults to the L-series constant only so
// existing two-argument callers keep working; on an A-series robot that default is 950 against
// a real 720 and every fraction reads ~24% short.
export function railReading(
  state: Record<string, number>,
  key: string,
  travelMm: number = RAIL_TRAVEL_MM
): { known: boolean; depthMm: number; frac: number } {
  const h = state[key];
  if (typeof h !== "number") return { known: false, depthMm: 0, frac: 0 };
  const travel = travelMm > 0 ? travelMm : RAIL_TRAVEL_MM;
  const depthMm = Math.min(travel, Math.max(0, h));
  return { known: true, depthMm, frac: depthMm / travel };
}

// True when telemetry carries any posable arm or lift joint — callers use this to show a
// "waiting" hint while the scene has nothing live to pose.
//
// Matched STRUCTURALLY, not against a joint-name list. The previous version tested for
// "_arm_shoulder_pan.pos" or "_lift.pos", and an A-series robot has NEITHER: its arms are
// 7-DOF (shoulder_pitch, no shoulder_pan) and its lift is the bare "lift.pos". So a fully
// live A3 reported false and the operator saw a permanent "waiting for telemetry" hint.
export function hasJointTelemetry(state: Record<string, number>): boolean {
  return Object.keys(state).some(
    (k) =>
      (k.includes("_arm_") && k.endsWith(".pos")) ||
      k === "lift.pos" ||
      k.endsWith("_lift.pos")
  );
}
