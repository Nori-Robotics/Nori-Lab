// nori-sdk — public entry (core). Robot-local teleop client for the Nori daemon, speaking the
// versioned nori-protocol over a WebRTC data channel. Framework-agnostic; zero runtime deps.
//
// This CORE entry pulls in nothing beyond the browser's WebRTC APIs — no Supabase, no three.js.
// Two heavier capabilities live behind their own subpath imports so you only pay for what you use:
//   * `@nori/sdk/vr`       — VR (WebXR) jog mapping + session   (peer dep: three)
//   * `@nori/sdk/supabase` — the reference Supabase signaling transport (peer dep: @supabase/supabase-js)
//
// SAFETY: the daemon defends itself (clamp / watchdog / E-STOP / torque lifecycle are all on the
// robot). No message an SDK client can send makes the robot unsafe — see docs/SDK_DIRECTION.md.

// RemoteTeleop + its option/telemetry/keybind types + the control-key maps + keybindLegend.
export * from "./teleop";
// Z-lift (rail) telemetry reading — pure, shared by the 2D gauge and the 3D robot model.
export * from "./rail";
// The signaling transport contract (bring your own, or use @nori/sdk/supabase).
export * from "./signaling";
// The nori-protocol version this SDK targets + the compat policy.
export * from "./version";
