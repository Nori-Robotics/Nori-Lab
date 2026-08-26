// NORI: Additive file. Token-light gripper world-coordinate grounding for the agent loop.
//
// The agent's biggest spatial handicap is that it sees single stills with no metric depth and
// no body sense beyond raw normalized joint numbers. This module turns the telemetry it already
// has into ONE line of text per turn — each gripper's position in millimetres in an explicit
// robot frame — so the model can reason about motion in real units ("the cup is ~200mm further
// forward than my gripper") instead of guessing from pixels. It is grounding, not a planner:
// every output is labelled approximate.
//
// Two FK backends, chosen by what the robot's descriptor says its joints are:
//   * L-series (…shoulder_lift…): the SDK's pure-math SO101 FK (fk.ts — the daemon's own link
//     geometry and units≈degrees convention). Frame: that arm's shoulder-pan axis, rail at top.
//   * A-series (…shoulder_pitch…): true FK through the shipped URDF (/nori-urdf/nori.urdf, the
//     same file the viewer + sim use) via urdf-loader's scene graph — meshes are stubbed out, so
//     the load is a few hundred KB of XML, once. Frame: base_footprint (floor under the base
//     center), REP-103 like the pose-target wire: +x forward, +y left, +z up.
//
// A-series accuracy caveat: telemetry .pos values are lerobot-normalized; like the L2 daemon we
// treat 1 unit ≈ 1 degree unless the handshake says normMode "degrees". If the A3 gateway's
// calibration ranges aren't ≈ symmetric ±100°, the readout drifts — verify against the real arm
// before trusting it (the line says "approximate" for exactly this reason).

import URDFLoader from "urdf-loader";
import type { URDFRobot } from "urdf-loader";
import * as THREE from "three";
import { l2GripperMm, liftAxes, railReading, type RemoteTeleop } from "@nori/sdk";

const URDF_PATH = "/nori-urdf/nori.urdf";
const DEG = Math.PI / 180;

export type PoseSummarizer = (state: Record<string, number>) => string | null;

const fmt = (side: string, p: { x: number; y: number; z: number }) =>
  `${side} gripper ≈ (x ${p.x}, y ${p.y}, z ${p.z}) mm`;

// ---- A-series: URDF scene-graph FK -------------------------------------------

// Parse the URDF once per page life (module-level cache — the geometry is static). Meshes are
// skipped: loadMeshCb hands back an empty Object3D, so no STL fetches ever start.
let a3Robot: URDFRobot | null = null; // set once the (async) load lands; read synchronously per turn
let a3RobotPromise: Promise<URDFRobot | null> | null = null;
function loadA3Robot(): Promise<URDFRobot | null> {
  if (!a3RobotPromise) {
    a3RobotPromise = fetch(URDF_PATH)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${URDF_PATH}: ${r.status}`))))
      .then((xml) => {
        const loader = new URDFLoader();
        loader.loadMeshCb = (_path, _manager, done) => done(new THREE.Object3D());
        return loader.parse(xml);
      })
      .catch(() => null) // no URDF → summarizer stays silent rather than erroring the loop
      .then((r) => (a3Robot = r));
  }
  return a3RobotPromise;
}

function a3Summary(
  robot: URDFRobot,
  state: Record<string, number>,
  degreesNative: boolean,
  lift: { key: string; travelMm: number } | null,
): string | null {
  // Arm joints: telemetry "<side>_arm_<name>.pos" -> URDF "<side>_<name>_joint". Grippers are
  // [0,100] jaw opening, not an angle, and don't move the TCP — skip them.
  for (const [key, v] of Object.entries(state)) {
    const m = /^(left|right)_arm_(\w+)\.pos$/.exec(key);
    if (!m || m[2] === "gripper" || typeof v !== "number") continue;
    const deg = degreesNative ? v : Math.max(-100, Math.min(100, v));
    robot.joints[`${m[1]}_${m[2]}_joint`]?.setJointValue(deg * DEG);
  }
  // Lift: telemetry is mm of DESCENT below rail-top; the URDF prismatic is metres of EXTENSION
  // above its lower stop — extension = travel − descent. (lift_middle_joint mimics at 0.5x.)
  if (lift) {
    const { known, depthMm } = railReading(state, lift.key, lift.travelMm);
    if (known) robot.joints["lift_extension_joint"]?.setJointValue((lift.travelMm - depthMm) / 1000);
  }
  robot.updateMatrixWorld(true);

  const v = new THREE.Vector3();
  const parts: string[] = [];
  for (const side of ["left", "right"] as const) {
    const tcp = robot.links[`${side}_gripper_tcp_link`];
    if (!tcp || typeof state[`${side}_arm_shoulder_pitch.pos`] !== "number") continue;
    tcp.getWorldPosition(v); // robot root is unparented at identity → world = base_footprint frame
    parts.push(fmt(side, { x: Math.round(v.x * 1000), y: Math.round(v.y * 1000), z: Math.round(v.z * 1000) }));
  }
  if (!parts.length) return null;
  return (
    parts.join("; ") +
    " — robot frame: origin on the floor under the base center, +x forward, +y robot-left, +z up." +
    " Approximate FK from joint telemetry; verify visually before contact."
  );
}

// ---- entry --------------------------------------------------------------------

/**
 * Build a pose summarizer for the connected robot. Synchronous per call (the agent loop calls it
 * every turn); the A-series URDF loads in the background on creation and the summarizer returns
 * null until it's ready — the grounding line simply appears from the first turn after load.
 */
export function createPoseSummarizer(teleop: RemoteTeleop): PoseSummarizer {
  return (state) => {
    const info = teleop.robotInfo();
    const joints = info?.descriptor?.joints ?? Object.keys(state);
    const isA3 = joints.some((j) => j.includes("shoulder_pitch"));

    if (isA3) {
      void loadA3Robot(); // kick off (or no-op if already loading/loaded)
      if (!a3Robot) return null; // still loading → grounding line appears from the next turn
      const axis = liftAxes(info?.descriptor).find((a) => a.side === null) ?? null;
      return a3Summary(a3Robot, state, info?.normMode === "degrees", axis && { key: axis.key, travelMm: axis.travelMm });
    }

    // L-series: pure-math FK, per-arm shoulder frame.
    const parts: string[] = [];
    for (const side of ["left", "right"] as const) {
      const p = l2GripperMm(state, side);
      if (p) parts.push(fmt(side, p));
    }
    if (!parts.length) return null;
    return (
      parts.join("; ") +
      " — frame per arm: origin at that arm's shoulder-pan axis with its rail at the top," +
      " +x forward, +y robot-left, +z up. Approximate FK from joint telemetry; verify visually before contact."
    );
  };
}
