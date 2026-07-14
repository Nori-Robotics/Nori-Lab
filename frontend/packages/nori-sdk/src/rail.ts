// nori-sdk core — Z-lift (rail) telemetry reading. Pure: no three.js, no React, so the 2D
// rail gauge (TeleopStatus.RailHeight), the desktop 3D schematic and the in-VR 3D robot all
// derive the carriage height from ONE place and can't drift apart.
//
// RAIL_TRAVEL_MM = full downward travel = the gauge's full scale. Per robot variant:
// 950 mm (tall) / 650 mm (short) — the Pi's NORI_LIFT_TRAVEL_MM. Not carried in telemetry
// yet, so it's a tunable constant here; default to the TALL variant since most of the fleet
// is 950. On a short 650 unit the gauge/3D just tops out at ~68% of the bar (mm text stays
// exact) — the safe direction, unlike 650-on-a-950 which pins the visual at "bottom" with
// 300 mm of real travel left and makes motion read ~1.5x too fast. (When the Pi starts
// publishing travel_mm, consume that instead of this constant.)
export const RAIL_TRAVEL_MM = 950;

// Shared reading. `depthMm` = distance below the top (>=0), `frac` = fraction of full travel
// descended (0 = at top/home, 1 = at bottom).
//
// The Pi publishes <lift>.pos ALREADY in this frame — 0 at the top of the rail, positive
// downward (nori_protocol_schema.md). We take it at face value and CLAMP a negative reading
// to 0 rather than folding it with Math.abs().
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
export function railReading(
  state: Record<string, number>,
  key: string
): { known: boolean; depthMm: number; frac: number } {
  const h = state[key];
  if (typeof h !== "number") return { known: false, depthMm: 0, frac: 0 };
  const depthMm = Math.min(RAIL_TRAVEL_MM, Math.max(0, h));
  return { known: true, depthMm, frac: depthMm / RAIL_TRAVEL_MM };
}

// True when any arm/lift joint keys are present in telemetry — callers use this to show a
// "waiting" hint while the scene has nothing live to pose.
export function hasJointTelemetry(state: Record<string, number>): boolean {
  return Object.keys(state).some(
    (k) => k.endsWith("_arm_shoulder_pan.pos") || k.endsWith("_lift.pos")
  );
}
