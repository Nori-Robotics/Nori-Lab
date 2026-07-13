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
export function railReading(
  state: Record<string, number>,
  key: string
): { known: boolean; depthMm: number; frac: number } {
  const h = state[key];
  if (typeof h !== "number") return { known: false, depthMm: 0, frac: 0 };
  const depthMm = Math.min(RAIL_TRAVEL_MM, Math.abs(h));
  return { known: true, depthMm, frac: depthMm / RAIL_TRAVEL_MM };
}

// True when any arm/lift joint keys are present in telemetry — callers use this to show a
// "waiting" hint while the scene has nothing live to pose.
export function hasJointTelemetry(state: Record<string, number>): boolean {
  return Object.keys(state).some(
    (k) => k.endsWith("_arm_shoulder_pan.pos") || k.endsWith("_lift.pos")
  );
}
