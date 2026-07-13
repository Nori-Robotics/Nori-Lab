// nori-sdk/vr — the C6 robot schematic as a plain three.js Object3D, so the SAME model can be
// mounted in BOTH renderers:
//
//   * desktop remote UI  — react-three-fiber mounts `root` via <primitive object={root} />
//   * in-VR panel cluster — VrSession adds `root` straight to its panelGroup
//
// It has to be framework-agnostic because those two can't share a renderer: R3F owns its own
// WebGLRenderer, and a WebXR session can only be driven by one. Previously this geometry lived
// as JSX inside Robot3D.tsx, which made it structurally impossible to show in the headset.
//
// The pose is TRUE forward kinematics in the daemon's own convention (NoriTeleop
// rpi5/nori_core_agent kinematics.cpp / control.cpp):
//
//   * Joint values in `state` are lerobot-normalized ([-100,100]; grippers [0,100]). The
//     daemon's IK conflates normalized units ≈ degrees (inherited from lerobot), so we do the
//     same conversion here — the scene then shows exactly the pose the daemon believes the arm
//     is in, which is what the operator is steering. (Accuracy caveat: as good as the per-unit
//     calibration ranges being roughly symmetric ±100°, the daemon's own assumption.)
//   * Each joint is a plain revolute rotation with the SO101 zero-offsets baked into the
//     daemon's angle convention: shoulder world pitch th1 = rad(90 − sl) − T1O, elbow bend
//     th2 = rad(ef + 90) − T2O (0 = straight), wrist relative = rad(wf) + (T2O − T1O). With
//     those, the daemon's wrist coupling identity (wf = −sl − ef + pitch) makes the gripper's
//     WORLD pitch = −rad(sl + ef + wf) automatically — a level gripper renders level regardless
//     of arm pose. At normalized zero the pose is the real SO101 rest: upper arm pitched up
//     ~76°, forearm horizontal (NOT a straight horizontal arm).
//   * Rail Z uses railReading() so this scene and the 2D Rail-height gauge always agree:
//     boot pose = TOP, carriage descends by |mm|.
//
// No external assets (CSP-safe) — every part is a box/cylinder primitive.
import * as THREE from "three";
import { railReading } from "./rail";
import type { ArmSide } from "./teleop";

// Clamped normalized joint value (≈ degrees, see header). Missing key -> 0 (rest pose).
function jointDeg(state: Record<string, number>, key: string): number {
  const n = state[key];
  return typeof n === "number" ? Math.max(-100, Math.min(100, n)) : 0;
}
const DEG = Math.PI / 180;

// SO101 planar geometry, verbatim from the daemon's kinematics.cpp: link lengths and the two
// link-bend offsets its angle convention bakes in.
const L1_M = 0.1159; // shoulder_lift axis -> elbow axis (m)
const L2_M = 0.135; // elbow axis -> wrist_flex axis (m)
const T1O = Math.atan2(0.028, 0.11257);
const T2O = Math.atan2(0.0052, 0.1349) + T1O;

// Scene geometry. The travel band is chosen so the carriage starts just under the shoulder
// plate (y 1.45) and at FULL descent its bottom edge (carriage is 0.08 tall) lands exactly on
// the base platform top (y ~0.62) instead of sinking into it.
const RAIL_TOP_Y = 1.34;
const RAIL_LEN = 0.68; // vertical distance the carriage sweeps across full travel
// Visual gain on the rail depth fraction. Was 4 to compensate for the Pi UNDER-reporting height
// ~4x (mm_per_rev mis-scale). Fixed at the source 2026-07-03 (NORI_LIFT_MM_PER_REV 28.455 ->
// 115.6), so the Pi now reports true mm across the full travel — the full range already maps to
// the full sweep. Keep at 1 (true tracking); a gain >1 now just clips the lower travel.
const RAIL_VIS_GAIN = 1;
// Arm link lengths at REAL proportions (L1:L2 from the daemon, wrist/gripper measured ~60/~90
// mm), scaled by ARM_SCALE scene-units/m. That's ~2x the rail's scale (RAIL_LEN / 0.95 m travel
// ≈ 0.72 u/m): fully proportional arms read too small next to 950 mm of rail travel, so the arm
// keeps a legibility boost while its segments stay true to each other.
const ARM_SCALE = 1.45;
const UPPER_LEN = L1_M * ARM_SCALE; // ≈0.168
const FORE_LEN = L2_M * ARM_SCALE; // ≈0.196
const WRIST_LEN = 0.06 * ARM_SCALE; // wrist_flex axis -> roll/jaw root ≈0.087
const GRIP_LEN = 0.09 * ARM_SCALE; // jaws ≈0.13

// Both arms white; the arm being teleoperated right now is highlighted green.
const ARM_ACTIVE = 0xa1d873;
const ARM_IDLE = 0xdee0e3;

// Per-arm mutable handles: update() writes joint rotations / carriage height into these.
interface ArmParts {
  carriage: THREE.Object3D;
  shoulder: THREE.Object3D; // pan (Y) + root of the chain
  upper: THREE.Object3D; // lift (X)
  fore: THREE.Object3D; // elbow (X)
  wrist: THREE.Object3D; // wrist flex (X) + roll (Z)
  jaws: [THREE.Object3D, THREE.Object3D];
  mat: THREE.MeshStandardMaterial; // shared by the arm's links; recolored on active change
}

/**
 * Which arm(s) render in the green "you are driving this" highlight.
 *
 * The desktop passes its single `settings.arm` (the keyboard drives one arm at a time). VR is
 * DUAL-arm — each controller drives its own arm — so it has no single active arm and instead
 * passes whichever clutches are engaged, which can be neither or both.
 */
export type ArmHighlight = ArmSide | "both" | "none";

export interface RobotModel {
  /** Mount this in any three.js scene (or R3F via <primitive object={root} />). */
  root: THREE.Group;
  /** Re-pose from a telemetry `state` dict. Cheap — writes rotations, allocates nothing. */
  update(state: Record<string, number>, highlight: ArmHighlight): void;
  /** Release GPU resources. Call when the owning scene tears down. */
  dispose(): void;
}

export interface RobotModelOptions {
  /** Floor grid under the robot. Nice for the desktop card; noisy floating in VR. */
  showGrid?: boolean;
}

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  pos: [number, number, number]
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(pos[0], pos[1], pos[2]);
  return m;
}

function cyl(
  r: number,
  h: number,
  color: number,
  pos: [number, number, number],
  mats: THREE.Material[]
): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color });
  mats.push(mat);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h), mat);
  m.position.set(pos[0], pos[1], pos[2]);
  m.rotation.set(0, 0, 1.55); // lay the wheel on its side
  return m;
}

// One schematic arm: a chain of boxes nested through the joint rotations. `side` selects the
// state keys and the base X offset / handedness.
function buildArm(side: ArmSide, mats: THREE.Material[]): { group: THREE.Group; parts: ArmParts } {
  // The model faces +Z (arm segments extend +Z), +Y up. For that frame the robot's LEFT is +X
  // (right = cross(forward,up) = cross(+Z,+Y) = -X). So the left arm sits at +X, right at -X.
  const sign = side === "left" ? 1 : -1;
  const mat = new THREE.MeshStandardMaterial({ color: ARM_IDLE });
  mats.push(mat);

  const group = new THREE.Group();
  group.position.set(sign * 0.15, 0, 0);

  // Vertical rail (static, purely visual) + carriage block that slides down it. The rail keeps
  // its span (y 0.40..1.40) independent of the carriage travel band above.
  const railMat = new THREE.MeshStandardMaterial({ color: 0x757c86 });
  const carriageMat = new THREE.MeshStandardMaterial({ color: 0xacb9cb });
  mats.push(railMat, carriageMat);
  group.add(box(0.04, 1.0, 0.04, railMat, [0, 0.9, 0]));

  const carriage = box(0.09, 0.08, 0.09, carriageMat, [sign * 0.015, RAIL_TOP_Y, 0]);
  group.add(carriage);

  // Articulated arm rooted at the carriage, with the shoulder pivot nudged outboard and forward
  // of it so panned poses stop clipping through the torso/carriage.
  const shoulder = new THREE.Group();
  shoulder.position.set(sign * 0.06, RAIL_TOP_Y, 0.05);
  group.add(shoulder);

  const upper = new THREE.Group(); // pitch about X at the shoulder
  upper.add(box(0.07, 0.07, UPPER_LEN, mat, [0, 0, UPPER_LEN / 2]));
  shoulder.add(upper);

  const fore = new THREE.Group(); // pitch about X at the elbow
  fore.position.set(0, 0, UPPER_LEN);
  fore.add(box(0.055, 0.055, FORE_LEN, mat, [0, 0, FORE_LEN / 2]));
  upper.add(fore);

  const wrist = new THREE.Group(); // flex about X, roll about Z
  wrist.position.set(0, 0, FORE_LEN);
  wrist.add(box(0.05, 0.05, WRIST_LEN, mat, [0, 0, WRIST_LEN / 2]));
  fore.add(wrist);

  // Gripper jaws — gap tracks gripper.pos.
  const jawRoot = new THREE.Group();
  jawRoot.position.set(0, 0, WRIST_LEN);
  wrist.add(jawRoot);
  const jawL = box(0.02, 0.075, GRIP_LEN, mat, [0, 0, 0.03]);
  const jawR = box(0.02, 0.075, GRIP_LEN, mat, [0, 0, 0.03]);
  jawRoot.add(jawL, jawR);

  return {
    group,
    parts: { carriage, shoulder, upper, fore, wrist, jaws: [jawL, jawR], mat },
  };
}

/**
 * Build the robot schematic. Returns a plain three.js object plus an `update()` that re-poses it
 * from a telemetry `state` dict — no React, no renderer assumptions.
 */
export function buildRobotModel(opts: RobotModelOptions = {}): RobotModel {
  const mats: THREE.Material[] = [];
  const root = new THREE.Group();

  const M = (color: number) => {
    const m = new THREE.MeshStandardMaterial({ color });
    mats.push(m);
    return m;
  };

  // base platform
  const shellMat = M(0xdee0e3);
  root.add(box(0.39, 0.2, 0.45, shellMat, [0, 0.51, -0.05]));
  root.add(box(0.35, 0.22, 0.42, M(0x444649), [0, 0.51, -0.05]));

  // wheels
  root.add(cyl(0.12, 0.05, 0xdee0e3, [0.23, 0.46, 0.1], mats));
  root.add(cyl(0.12, 0.05, 0xdee0e3, [-0.23, 0.46, 0.1], mats));
  root.add(cyl(0.13, 0.04, 0x2e2f30, [0.215, 0.46, 0.1], mats));
  root.add(cyl(0.13, 0.04, 0x202121, [-0.215, 0.46, 0.1], mats));
  root.add(cyl(0.05, 0.04, 0x2e2f30, [0.16, 0.379, -0.22], mats));
  root.add(cyl(0.05, 0.04, 0x202121, [-0.16, 0.379, -0.22], mats));

  // body
  root.add(box(0.25, 1.0, 0.1, M(0x5e6268), [0, 1.0, 0]));
  root.add(box(0.19, 0.22, 0.19, M(0x7a7e84), [0, 0.7, -0.12]));
  root.add(box(0.33, 0.12, 0.15, shellMat, [0, 1.45, 0]));
  root.add(box(0.15, 0.1, 0.1, shellMat, [0, 1.55, 0]));

  // head
  const headMat = M(0x5e6268);
  root.add(box(0.25, 0.16, 0.13, headMat, [0, 1.68, 0]));
  const eyeMat = M(0xfcfcfc);
  root.add(box(0.04, 0.08, 0.01, eyeMat, [-0.05, 1.68, 0.065]));
  root.add(box(0.04, 0.08, 0.01, eyeMat, [0.05, 1.68, 0.065]));
  const visor = box(0.25, 0.02, 0.2, headMat, [0, 1.75, 0.05]);
  visor.rotation.set(125, 0, 0); // verbatim from the JSX original (radians; a big spin, but it
  // is what the shipped card renders — keep the look identical)
  root.add(visor);

  const left = buildArm("left", mats);
  const right = buildArm("right", mats);
  root.add(left.group, right.group);

  let grid: THREE.GridHelper | null = null;
  if (opts.showGrid) {
    grid = new THREE.GridHelper(3, 12, 0xcdc1a8, 0xccc4b6);
    grid.position.set(0, 0.34, 0);
    root.add(grid);
  }

  const arms: Record<ArmSide, ArmParts> = { left: left.parts, right: right.parts };

  function poseArm(side: ArmSide, state: Record<string, number>, active: boolean) {
    const a = arms[side];
    const p = `${side}_arm_`;
    const sign = side === "left" ? 1 : -1;

    // Rail carriage height for this arm (0 = top, grows downward), clamped so it never
    // overruns the rail.
    const { frac } = railReading(state, `${side}_lift.pos`);
    const visFrac = Math.min(1, frac * RAIL_VIS_GAIN);
    const carriageY = RAIL_TOP_Y - visFrac * RAIL_LEN;
    a.carriage.position.set(sign * 0.015, carriageY, 0);
    a.shoulder.position.set(sign * 0.06, carriageY, 0.05);

    // Joint angles — true FK in the daemon's convention (see file header). Segments extend +Z;
    // a POSITIVE group rotation.x tips the child chain DOWN, so world pitch-up = −rot.x. Pan is
    // NOT mirrored per side: its axis is vertical, so mounting the arms on opposite sides of the
    // column can't flip the rotation direction, and calibration writes drive_mode 0 for every
    // motor — +joint yaws BOTH arms the same world direction. Global -1: the SO101 URDF's
    // Rotation joint axis is (0,0,-1) in the Z-up base frame (rpy roll of -pi), i.e. +joint =
    // clockwise from above, while scene +rot.y is counterclockwise from above.
    const sl = jointDeg(state, `${p}shoulder_lift.pos`);
    const ef = jointDeg(state, `${p}elbow_flex.pos`);
    const wf = jointDeg(state, `${p}wrist_flex.pos`);
    const pan = jointDeg(state, `${p}shoulder_pan.pos`) * DEG * -1;
    const lift = -((90 - sl) * DEG - T1O); // −th1: shoulder pitched UP th1 from horizontal
    const elbow = (ef + 90) * DEG - T2O; // th2: elbow bend, 0 = straight
    const wristFlex = wf * DEG + (T2O - T1O); // world gripper pitch = −(sl+ef+wf)°
    const wristRoll = jointDeg(state, `${p}wrist_roll.pos`) * DEG;

    a.shoulder.rotation.set(0, pan, 0);
    a.upper.rotation.set(lift, 0, 0);
    a.fore.rotation.set(elbow, 0, 0);
    a.wrist.rotation.set(wristFlex, 0, wristRoll);

    const gripN = state[`${p}gripper.pos`];
    const grip = typeof gripN === "number" ? Math.max(0, Math.min(100, gripN)) : 0;
    // Default CLOSED (jaws touching at grip=0), swinging wide as grip opens. Exaggerated range
    // so the open/close is obvious at a glance.
    const jaw = 0.006 + (grip / 100) * 0.1; // half-gap between the two jaw cubes
    a.jaws[0].position.x = -jaw;
    a.jaws[1].position.x = jaw;

    a.mat.color.setHex(active ? ARM_ACTIVE : ARM_IDLE);
  }

  // Pose once so the model is never a bare rest-frame T-pose before the first telemetry frame.
  poseArm("left", {}, false);
  poseArm("right", {}, false);

  return {
    root,
    update(state, highlight) {
      poseArm("left", state, highlight === "left" || highlight === "both");
      poseArm("right", state, highlight === "right" || highlight === "both");
    },
    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      grid?.dispose();
      mats.forEach((m) => m.dispose());
    },
  };
}
