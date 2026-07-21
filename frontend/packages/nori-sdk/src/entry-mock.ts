// NORI: Additive file (SDK v1 mock mode). Entry point for `@nori/sdk/mock` — develop against a
// fake robot with zero hardware, zero cloud, zero network. Kept out of the core entry so the
// mock never ships weight into production bundles (same pattern as ./vr and ./supabase).
//
//   import { RemoteTeleop } from "@nori/sdk";
//   import { createMockRobot } from "@nori/sdk/mock";
//
//   const robot = createMockRobot();
//   const teleop = new RemoteTeleop({ signaling: robot.signaling, ... });
//   await teleop.start();   // real SDK path: handshake, WebRTC, video, telemetry, jog
export { createMockRobot } from "./mock/robot";
export type { MockRobotOptions, MockRobotHandle } from "./mock/robot";
export { MockDaemonSim } from "./mock/sim";
export type { MockSimOptions } from "./mock/sim";
export { createLoopbackSignaling } from "./mock/loopback-signaling";
export type { MockRobotSignalingPort, LoopbackSignalingOptions } from "./mock/loopback-signaling";
