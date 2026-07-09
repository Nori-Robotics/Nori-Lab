// NORI: Additive file. C6 — a lightweight 3D visual of the robot for fully-remote teleop,
// driven live off the telemetry `state` dict (the same keys the TelemetryPanel / RailHeight
// consume). The arm pose is TRUE forward kinematics in the daemon's own convention
// (NoriTeleop rpi5/nori_core_agent kinematics.cpp / control.cpp):
//
//   * Joint values in `state` are lerobot-normalized ([-100,100]; grippers [0,100]). The
//     daemon's IK conflates normalized units ≈ degrees (inherited from lerobot), so we do
//     the same conversion here — the scene then shows exactly the pose the daemon believes
//     the arm is in, which is what the operator is steering. (Accuracy caveat: as good as
//     the per-unit calibration ranges being roughly symmetric ±100°, the daemon's own
//     assumption.)
//   * Each joint is a plain revolute rotation with the SO101 zero-offsets baked into the
//     daemon's angle convention: shoulder world pitch th1 = rad(90 − sl) − T1O, elbow bend
//     th2 = rad(ef + 90) − T2O (0 = straight), wrist relative = rad(wf) + (T2O − T1O).
//     With those, the daemon's wrist coupling identity (wf = −sl − ef + pitch) makes the
//     gripper's WORLD pitch = −rad(sl + ef + wf) automatically — a level gripper renders
//     level regardless of arm pose. At normalized zero the pose is the real SO101 rest:
//     upper arm pitched up ~76°, forearm horizontal (NOT a straight horizontal arm).
//   * Rail Z uses railReading() from TeleopStatus so this scene and the Rail-height gauge
//     always agree: boot pose = TOP, carriage descends by |mm|.
//
// Stack: @react-three/fiber + drei (already project deps). No external assets (CSP-safe).
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { railReading } from "./TeleopStatus";
import type { ArmSide } from "@nori/sdk";

// Clamped normalized joint value (≈ degrees, see header). Missing key -> 0 (rest pose).
function jointDeg(state: Record<string, number>, key: string): number {
  const n = state[key];
  return typeof n === "number" ? Math.max(-100, Math.min(100, n)) : 0;
}
const DEG = Math.PI / 180;

// SO101 planar geometry, verbatim from the daemon's kinematics.cpp: link lengths and the
// two link-bend offsets its angle convention bakes in.
const L1_M = 0.1159; // shoulder_lift axis -> elbow axis (m)
const L2_M = 0.135;  // elbow axis -> wrist_flex axis (m)
const T1O = Math.atan2(0.028, 0.11257);
const T2O = Math.atan2(0.0052, 0.1349) + T1O;

// Scene geometry. The travel band is chosen so the carriage starts just under the shoulder
// plate (y 1.45) and at FULL descent its bottom edge (carriage is 0.08 tall) lands exactly
// on the base platform top (y ~0.62) instead of sinking into it.
const RAIL_TOP_Y = 1.34;
const RAIL_LEN = 0.68; // vertical distance the carriage sweeps across full travel
// Visual gain on the rail depth fraction. Was 4 to compensate for the Pi UNDER-reporting
// height ~4x (mm_per_rev mis-scale). Fixed at the source 2026-07-03 (NORI_LIFT_MM_PER_REV
// 28.455 -> 115.6), so the Pi now reports true mm across the full travel — the full
// range already maps to the full sweep. Keep at 1 (true tracking); a gain >1 now just clips
// the lower travel. Raise only if you deliberately want an exaggerated view.
const RAIL_VIS_GAIN = 1;
// Arm link lengths at REAL proportions (L1:L2 from the daemon, wrist/gripper measured
// ~60/~90 mm), scaled by ARM_SCALE scene-units/m. That's ~2x the rail's scale
// (RAIL_LEN / 0.95 m travel ≈ 0.72 u/m): fully proportional arms read too small on
// screen next to 950 mm of rail travel, so the arm keeps a legibility boost while its
// segments stay true to each other.
const ARM_SCALE = 1.45;
const UPPER_LEN = L1_M * ARM_SCALE;  // ≈0.168
const FORE_LEN = L2_M * ARM_SCALE;   // ≈0.196
const WRIST_LEN = 0.06 * ARM_SCALE;  // wrist_flex axis -> roll/jaw root ≈0.087
const GRIP_LEN = 0.09 * ARM_SCALE;   // jaws ≈0.13

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

  // Joint angles — true FK in the daemon's convention (see file header). Segments extend
  // +Z; a POSITIVE group rotation.x tips the child chain DOWN, so world pitch-up = −rot.x.
  // Pan is NOT mirrored per side: its axis is vertical, so mounting the arms on opposite
  // sides of the column can't flip the rotation direction, and calibration writes
  // drive_mode 0 for every motor — +joint yaws BOTH arms the same world direction. (The
  // old per-side `-sign` mirror rendered the right arm panning into the body while the
  // real one panned away.) Global -1: the SO101 URDF's Rotation joint axis is (0,0,-1)
  // in the Z-up base frame (rpy roll of -pi), i.e. +joint = clockwise from above, while
  // scene +rot.y is counterclockwise from above.
  const sl = jointDeg(state, `${p}shoulder_lift.pos`);
  const ef = jointDeg(state, `${p}elbow_flex.pos`);
  const wf = jointDeg(state, `${p}wrist_flex.pos`);
  const pan = jointDeg(state, `${p}shoulder_pan.pos`) * DEG * -1;
  const lift = -((90 - sl) * DEG - T1O); // −th1: shoulder pitched UP th1 from horizontal
  const elbow = (ef + 90) * DEG - T2O;   // th2: elbow bend, 0 = straight
  const wristFlex = wf * DEG + (T2O - T1O); // revolute wrist; world gripper pitch = −(sl+ef+wf)°
  const wristRoll = jointDeg(state, `${p}wrist_roll.pos`) * DEG;
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
