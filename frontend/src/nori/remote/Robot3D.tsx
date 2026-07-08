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
import { railReading } from "./TeleopStatus";
import type { ArmSide } from "@nori/sdk";

// Normalized [-100,100] -> radians, clamped, scaled to `spanDeg` of half-travel each way.
function jointRad(state: Record<string, number>, key: string, spanDeg: number): number {
  const n = state[key];
  const v = typeof n === "number" ? Math.max(-100, Math.min(100, n)) : 0;
  return (v / 100) * (spanDeg * Math.PI) / 180;
} 

// Scene geometry (arbitrary units). Tuned for legibility, not scale. The travel band is
// chosen so the carriage starts just under the shoulder plate (y 1.45) and at FULL descent
// its bottom edge (carriage is 0.08 tall) lands exactly on the base platform top (y ~0.62)
// instead of sinking into it.
const RAIL_TOP_Y = 1.34;
const RAIL_LEN = 0.68; // vertical distance the carriage sweeps across full travel
// Visual gain on the rail depth fraction. Was 4 to compensate for the Pi UNDER-reporting
// height ~4x (mm_per_rev mis-scale). Fixed at the source 2026-07-03 (NORI_LIFT_MM_PER_REV
// 28.455 -> 115.6), so the Pi now reports true mm across the full 0..650 mm travel — the full
// range already maps to the full sweep. Keep at 1 (true tracking); a gain >1 now just clips
// the lower travel. Raise only if you deliberately want an exaggerated view.
const RAIL_VIS_GAIN = 1;
const UPPER_LEN = 0.20;
const FORE_LEN = 0.14;
const WRIST_LEN = 0.12;
const GRIP_LEN = 0.15;

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
  const color = active ? "#a1d873" : "#dee0e3";

  return (
    <group position={[sign * 0.15, 0, 0]}>
      {/* Vertical rail (static, purely visual) + carriage block that slides down it. The
          rail keeps its original span (y 0.40..1.40) independent of the carriage travel
          band above — only the carriage/arm motion range was raised. */}
      <mesh position={[0, 0.9, 0]}>
        <boxGeometry args={[0.04, 1.0, 0.04]} />
        <meshStandardMaterial color="#757c86" />
      </mesh>
      <mesh position={[sign*0.015, carriageY, 0]}>
        <boxGeometry args={[0.09, 0.08, 0.09]} />
        <meshStandardMaterial color="#acb9cb" />
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
                    <boxGeometry args={[0.02, 0.075, GRIP_LEN]} />
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

// True when any arm/lift joint keys are present in telemetry — the page uses this to show
// a "waiting" hint next to the card heading while the scene has nothing live to pose.
export function hasJointTelemetry(state: Record<string, number>): boolean {
  return Object.keys(state).some((k) => k.endsWith("_arm_shoulder_pan.pos") || k.endsWith("_lift.pos"));
}

export function Robot3D({ state, activeArm }: { state: Record<string, number>; activeArm: ArmSide }) {
  return (
    <div className="relative h-64 w-full overflow-hidden rounded-md border bg-[#f6f4eb]">
      {/* Longer lens: lower fov + camera pulled back proportionally (~1.5x) for a flatter,
          less distorted view. maxDistance on the OrbitControls below must stay >= the start
          distance or the controls clamp the camera back in on first interaction. */}
      {/* Camera sits slightly BELOW the orbit target (y 0.7 vs 1.1) for a gentle low-angle
          look up at the robot; distance kept ~6.3 units so the framing matches the old view. */}
      <Canvas camera={{ position: [3.9, 2.8, 4.9], fov: 16 }} dpr={[1, 2]}>
        <ambientLight intensity={0.9} />
        <directionalLight position={[2, 4, 3]} intensity={1.2} />
        {/* base platform */}
        <mesh position={[0, 0.51, -0.05]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.39, 0.2, 0.45]} />
          <meshStandardMaterial color="#dee0e3" />
        </mesh>
        <mesh position={[0, 0.51, -0.05]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.35, 0.22, 0.42]} />
          <meshStandardMaterial color="#444649" />
        </mesh>
        {/* wheels */}
        <mesh position={[0.23, 0.46, 0.1]} rotation={[0, 0, 1.55]}>
          <cylinderGeometry args={[0.12, 0.12, 0.05]} />
          <meshStandardMaterial color="#dee0e3" />
        </mesh>
        <mesh position={[-0.23, 0.46, 0.1]} rotation={[0, 0, 1.55]}>
          <cylinderGeometry args={[0.12, 0.12, 0.05]} />
          <meshStandardMaterial color="#dee0e3" />
        </mesh>
        <mesh position={[0.215, 0.46, 0.1]} rotation={[0, 0, 1.55]}>
          <cylinderGeometry args={[0.13, 0.13, 0.04]} />
          <meshStandardMaterial color="#2e2f30" />
        </mesh>
        <mesh position={[-0.215, 0.46, 0.1]} rotation={[0, 0, 1.55]}>
          <cylinderGeometry args={[0.13, 0.13, 0.04]} />
          <meshStandardMaterial color="#202121" />
        </mesh>
        <mesh position={[0.16, 0.379, -0.22]} rotation={[0, 0, 1.55]}>
          <cylinderGeometry args={[0.05, 0.05, 0.04]} />
          <meshStandardMaterial color="#2e2f30" />
        </mesh>
        <mesh position={[-0.16, 0.379, -0.22]} rotation={[0, 0, 1.55]}>
          <cylinderGeometry args={[0.05, 0.05, 0.04]} />
          <meshStandardMaterial color="#202121" />
        </mesh>
        {/*body*/}
        <mesh position={[0, 1.0, 0]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.25, 1.0, 0.10]} />
          <meshStandardMaterial color="#5e6268" />
        </mesh>
        <mesh position={[0, 0.7, -0.12]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.19, 0.22, 0.19]} />
          <meshStandardMaterial color="#7a7e84" />
        </mesh>
        <mesh position={[0, 1.45, 0]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.33, 0.12, 0.15]} />
          <meshStandardMaterial color="#dee0e3" />
        </mesh>
        <mesh position={[0, 1.55, 0]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.15, 0.1, 0.10]} />
          <meshStandardMaterial color="#dee0e3" />
        </mesh>
        {/*head*/}
        <mesh position={[0, 1.68, 0]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.25, 0.16, 0.13]} />
          <meshStandardMaterial color="#5e6268" />
        </mesh>
        <mesh position={[-0.05, 1.68, 0.065]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.04, 0.08, 0.01]} />
          <meshStandardMaterial color="#fcfcfc" />
        </mesh>
        <mesh position={[0.05, 1.68, 0.065]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.04, 0.08, 0.01]} />
          <meshStandardMaterial color="#fcfcfc" />
        </mesh>
        <mesh position={[0, 1.75, 0.05]} rotation={[125, 0, 0]}>
          <boxGeometry args={[0.25, 0.02, 0.2]} />
          <meshStandardMaterial color="#5e6268" />
        </mesh>
        <Arm state={state} side="left" active={activeArm === "left"} />
        <Arm state={state} side="right" active={activeArm === "right"} />
        <gridHelper args={[3, 12, "#cdc1a8", "#ccc4b6"]} position={[0, 0.34, 0]} />
        {/* target height centers the frame on the robot's midline — raise it to show less
            empty floor, lower it to show more. */}
        <OrbitControls enablePan={true} minDistance={0.9} maxDistance={9} target={[0, 1.1, 0]} />
      </Canvas>
    </div>
  );
}
