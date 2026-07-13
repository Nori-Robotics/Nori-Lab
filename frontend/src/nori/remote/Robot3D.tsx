// NORI: C6 — a lightweight 3D visual of the robot for fully-remote teleop, driven live off the
// telemetry `state` dict (the same keys the TelemetryPanel / RailHeight consume).
//
// The geometry and the forward kinematics no longer live here: they moved to the SDK
// (packages/nori-sdk/src/robot-model.ts, buildRobotModel()) as a plain three.js Object3D so the
// SAME model can also be mounted inside the in-VR panel cluster (VrSession). It had to leave JSX
// to do that — react-three-fiber owns its own WebGLRenderer and a WebXR session can only be
// driven by one, so an <Arm> component was structurally unable to appear in the headset.
//
// What's left here is the desktop *presentation*: the card-sized canvas, the camera framing and
// the orbit controls. Change the robot itself in robot-model.ts and both views follow.
//
// Stack: @react-three/fiber + drei (already project deps). No external assets (CSP-safe).
import { useEffect, useLayoutEffect, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { buildRobotModel } from "@nori/sdk/vr";
import type { ArmSide } from "@nori/sdk";

// Re-exported so the page keeps importing it from here (it also gates the "waiting for joint
// telemetry…" hint). Source of truth is the SDK, shared with the in-VR model.
export { hasJointTelemetry } from "@nori/sdk";

function RobotModelMesh({ state, activeArm }: { state: Record<string, number>; activeArm: ArmSide }) {
  // Built once and mutated in place — rebuilding the scene graph on every telemetry frame would
  // churn geometries/materials at the telemetry rate.
  const model = useMemo(() => buildRobotModel({ showGrid: true }), []);
  useLayoutEffect(() => {
    model.update(state, activeArm);
  }, [model, state, activeArm]);
  useEffect(() => () => model.dispose(), [model]);
  return <primitive object={model.root} />;
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
        <RobotModelMesh state={state} activeArm={activeArm} />
        {/* target height centers the frame on the robot's midline — raise it to show less
            empty floor, lower it to show more. */}
        <OrbitControls enablePan={true} minDistance={0.9} maxDistance={9} target={[0, 1.1, 0]} />
      </Canvas>
    </div>
  );
}
