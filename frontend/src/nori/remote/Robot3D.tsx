// NORI: Additive file. C6 (basic) — a lightweight 3D "cube" visual of the robot for
// fully-remote teleop, driven live off the telemetry `state` dict (the same keys the
// TelemetryPanel / RailHeight consume). Deliberately SCHEMATIC, not a calibrated model:
//
//   * Joint values in `state` are lerobot-NORMALIZED ([-100,100]; grippers [0,100]), NOT
//     degrees, and the true link geometry + kinematic convention live on the Pi (per-unit
//     calibration). Real forward kinematics is the follow-up C6 sub-item ("run FK off the
//     joint angles / Pi publishes degrees"). Until then we map each normalized joint linearly
//     to a plausible angle so the operator gets a live, directionally-correct pose picture —
//     enough to see "left arm reaching, right gripper closed, both rails near the top."
//   * Rail Z uses railReading() from TeleopStatus so this scene and the Rail-height gauge
//     always agree: boot pose = TOP, carriage descends by |mm|.
//
// Stack: @react-three/fiber + drei (already project deps). No external assets (CSP-safe).
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useMemo } from "react";
import { railReading } from "./TeleopStatus";
import type { ArmSide } from "@nori/sdk";

// Normalized [-100,100] -> radians, clamped, scaled to `spanDeg` of half-travel each way.
function jointRad(state: Record<string, number>, key: string, spanDeg: number): number {
  const n = state[key];
  const v = typeof n === "number" ? Math.max(-100, Math.min(100, n)) : 0;
  return (v / 100) * (spanDeg * Math.PI) / 180;
}

// Scene geometry (arbitrary units; ~1 unit ≈ the rail travel). Tuned for legibility, not scale.
const RAIL_TOP_Y = 1.5;
const RAIL_LEN = 1.15; // vertical distance the carriage sweeps across full travel
// Visual gain on the rail depth fraction. Was 4 to compensate for the Pi UNDER-reporting
// height ~4x (mm_per_rev mis-scale). Fixed at the source 2026-07-03 (NORI_LIFT_MM_PER_REV
// 28.455 -> 115.6), so the Pi now reports true mm across the full 0..650 mm travel — the full
// range already maps to the full sweep. Keep at 1 (true tracking); a gain >1 now just clips
// the lower travel. Raise only if you deliberately want an exaggerated view.
const RAIL_VIS_GAIN = 1;
const UPPER_LEN = 0.40;
const FORE_LEN = 0.35;
const WRIST_LEN = 0.12;
const GRIP_LEN = 0.10;

// One schematic arm: a chain of boxes nested through the joint rotations. `side` selects the
// state keys and the base X offset / handedness.
function Arm({ state, side, active }: { state: Record<string, number>; side: "left" | "right"; active: boolean }) {
  const p = `${side}_arm_`;
  // The model faces +Z (arm segments extend +Z), +Y up. For that frame the robot's LEFT is +X
  // (right = cross(forward,up) = cross(+Z,+Y) = -X). So the left arm sits at +X, right at -X.
  // (Was inverted, which drew the left_arm_* chain — and its green "active" highlight — on the
  // robot's right side, so selecting "left" lit the wrong arm.)
  const sign = side === "left" ? 1 : -1;

  // Rail carriage height for this arm (0 = top, grows downward). Amplified for a punchier
  // visual (see RAIL_VIS_GAIN); clamped so it never overruns the rail.
  const { frac } = railReading(state, `${side}_lift.pos`);
  const visFrac = Math.min(1, frac * RAIL_VIS_GAIN);
  const carriageY = RAIL_TOP_Y - visFrac * RAIL_LEN;

  // Joint angles (schematic mapping; see file header).
  // `-sign`: pan yaw was inverted vs. the real joint; the -1 flips the direction while keeping
  // the left/right mirror (the arms are mirror-mounted, so +joint yaws them opposite ways).
  const pan = jointRad(state, `${p}shoulder_pan.pos`, 90) * -sign;
  const lift = jointRad(state, `${p}shoulder_lift.pos`, 90);
  const elbow = jointRad(state, `${p}elbow_flex.pos`, 90);
  const wristFlex = jointRad(state, `${p}wrist_flex.pos`, 90);
  const wristRoll = jointRad(state, `${p}wrist_roll.pos`, 180);
  const gripN = state[`${p}gripper.pos`];
  const grip = typeof gripN === "number" ? Math.max(0, Math.min(100, gripN)) : 0;
  // Default CLOSED (jaws touching at grip=0), swinging wide as grip opens. Exaggerated range
  // so the open/close is obvious at a glance.
  const jaw = 0.006 + (grip / 100) * 0.1; // half-gap between the two jaw cubes

  // Both arms white; the arm being teleoperated right now is highlighted green.
  const color = active ? "#57d753" : "#f1f5f9";

  return (
    <group position={[sign * 0.28, 0, 0]}>
      {/* Vertical rail (static) + carriage block that slides down it */}
      <mesh position={[0, RAIL_TOP_Y - RAIL_LEN / 2, 0]}>
        <boxGeometry args={[0.04, RAIL_LEN + 0.1, 0.04]} />
        <meshStandardMaterial color="#334155" />
      </mesh>
      <mesh position={[0, carriageY, 0]}>
        <boxGeometry args={[0.12, 0.08, 0.12]} />
        <meshStandardMaterial color="#94a3b8" />
      </mesh>

      {/* Articulated arm rooted at the carriage */}
      <group position={[0, carriageY, 0]} rotation={[0, pan, 0]}>
        {/* upper arm: pitch about X at the shoulder */}
        <group rotation={[lift, 0, 0]}>
          <mesh position={[0, 0, UPPER_LEN / 2]}>
            <boxGeometry args={[0.07, 0.07, UPPER_LEN]} />
            <meshStandardMaterial color={color} />
          </mesh>
          {/* forearm: pitch about X at the elbow */}
          <group position={[0, 0, UPPER_LEN]} rotation={[elbow, 0, 0]}>
            <mesh position={[0, 0, FORE_LEN / 2]}>
              <boxGeometry args={[0.055, 0.055, FORE_LEN]} />
              <meshStandardMaterial color={color} />
            </mesh>
            {/* wrist: flex about X, roll about Z */}
            <group position={[0, 0, FORE_LEN]} rotation={[wristFlex, 0, wristRoll]}>
              <mesh position={[0, 0, WRIST_LEN / 2]}>
                <boxGeometry args={[0.05, 0.05, WRIST_LEN]} />
                <meshStandardMaterial color={color} />
              </mesh>
              {/* gripper jaws — gap tracks gripper.pos */}
              <group position={[0, 0, WRIST_LEN]}>
                {[-1, 1].map((s) => (
                  <mesh key={s} position={[s * jaw, 0, 0.03]}>
                    <boxGeometry args={[0.02, 0.05, GRIP_LEN]} />
                    <meshStandardMaterial color={color} />
                  </mesh>
                ))}
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

export function Robot3D({ state, activeArm }: { state: Record<string, number>; activeArm: ArmSide }) {
  // Only render arms whose lift/joint keys are actually present in telemetry.
  const hasAny = useMemo(
    () => Object.keys(state).some((k) => k.endsWith("_arm_shoulder_pan.pos") || k.endsWith("_lift.pos")),
    [state]
  );

  return (
    <div className="relative h-56 w-full overflow-hidden rounded-md border bg-[#0b1220]">
      {!hasAny && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-muted-foreground">
          waiting for joint telemetry…
        </div>
      )}
      <Canvas camera={{ position: [0.9, 1.1, 1.4], fov: 45 }} dpr={[1, 2]}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[2, 4, 3]} intensity={0.9} />
        {/* base platform */}
        <mesh position={[0, 0.38, 0]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.8, 0.06, 0.4]} />
          <meshStandardMaterial color="#1e293b" />
        </mesh>
        <Arm state={state} side="left" active={activeArm === "left"} />
        <Arm state={state} side="right" active={activeArm === "right"} />
        <gridHelper args={[3, 12, "#1f2937", "#1f2937"]} position={[0, 0.34, 0]} />
        <OrbitControls enablePan={false} minDistance={0.9} maxDistance={4} target={[0, 0.9, 0]} />
      </Canvas>
      <p className="pointer-events-none absolute bottom-1 left-2 text-[9px] text-muted-foreground/70">
        schematic — normalized joint angles, not calibrated FK (C6 basic)
      </p>
    </div>
  );
}
