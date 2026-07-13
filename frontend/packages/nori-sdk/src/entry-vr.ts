// nori-sdk/vr — VR (WebXR) subpath entry. Maps controller poses to jog frames and drives a
// RemoteTeleop from an immersive session. Kept out of the core entry because it pulls three.js;
// import this only if you're building a VR client. Peer dependency: `three`.

// Pure controller->jog mapper (no three.js of its own).
export * from "./vr";
// The WebXR session that runs the mapper and feeds a RemoteTeleop (uses three.js math).
export * from "./vr-session";
// The robot schematic as a plain three.js Object3D — mounted BOTH in the desktop R3F canvas
// and in the VR panel cluster, so the two can never drift apart.
export * from "./robot-model";
