// NORI: Additive file. M2 Phase 1 — VR controller -> `jog` mapper (laptop-side).
//
// This is the *bulk of M2* (plan §4.1-A). It ports rpi4's delta-based VR math
// (teleop_server.py:512-612 handle_vr_input, :816-831 get_vr_base_action, originally
// 8_xlerobot_2wheels_teleop_vr.py) but with one deliberate architectural change decided
// 2026-06-24 (onboard_pi_plan.md §e, option a):
//
//   rpi4 ran IK on the Pi and sent absolute joint targets. We instead emit normalized
//   **jog rates** in the SAME vocabulary the keyboard uses, so the C++ daemon's
//   jog->IK->clamp->motor path is byte-for-byte unchanged. VR "queries the jogger";
//   it never touches the onboard C++. (The daemon scales each rate by its per-tick step,
//   so a per-frame cartesian/angle delta becomes rate = delta / step, clamped to ±1.)
//
// Pure + framework-agnostic: feed it a VrFrame each animation frame; it returns a ready
// ExternalJog payload (or null = nothing to drive) plus discrete E-STOP edges. The WebXR
// session glue (Phase 2) samples XRInputSource gamepads/poses into VrFrame and pipes the
// output into RemoteTeleop.setExternalJog / .command. No daemon or protocol change.

import type { ExternalJog, RobotDescriptor } from "./teleop";
import {
  wristAngles, wristTargets, zeroWristAngles, applyRomGain, WRIST_JOINTS,
  type WristAngles, type Quat as AnatQuat,
} from "./wrist-anatomy";
import {
  SwivelTracker, wristPoint, swivelOf, sideSign, SOLVED_JOINTS,
  UPPER_ARM_M, FOREARM_M, type ArmQ, type Vec3,
} from "./arm-kinematics";

// Hand travel -> wrist-point travel. The A3 arm is a 0.61-scale human arm
// (upper/forearm ratio 1.131 vs a human's ~1.11, matched to 2%), so a scaled
// map makes its posture a geometrically SIMILAR copy of the operator's rather
// than a distorted one, and keeps a full human reach inside the robot's 0.344 m
// workspace instead of over-running it constantly.
const WRIST_POINT_SCALE = 0.6;

// Per-controller state sampled from WebXR each frame. position is the grip-space pose in
// meters (headset/local reference space); orientation is the RAW grip quaternion [x,y,z,w]
// — the mapper derives the wrist angles from it (XLeVR-style, see HandState); trigger/
// squeeze in [0,1].
export interface VrControllerFrame {
  position: [number, number, number] | null;
  orientation?: [number, number, number, number] | null;
  trigger: number;   // analog gripper: 1 = close, 0 = open
  squeeze: number;   // grip button: the CLUTCH ("squeeze to move")
  thumbstick: { x: number; y: number };
}

// Discrete actions, already resolved from the (configurable) button bindings by the session
// layer — the mapper stays agnostic to which physical button/hand each came from. (reset is
// a hold-gesture handled in the session, so it isn't here.)
export interface VrControls {
  // One lift per arm (independent). Each controller's face buttons drive its
  // own arm's lift (resolved from bindings in the session layer).
  leftLiftUp?: boolean;
  leftLiftDown?: boolean;
  rightLiftUp?: boolean;
  rightLiftDown?: boolean;
  estop?: boolean;
}

export interface VrFrame {
  left?: VrControllerFrame | null;
  right?: VrControllerFrame | null;
  controls?: VrControls;
}

// What one unit of rate buys in ONE FRAME on this robot. The mapper divides the
// hand's per-frame motion by these, which is what makes the mapping positional:
// move the hand 5 mm, ask for 5 mm.
//
// The divisor is the VR FRAME period, not the robot's 50 Hz tick: rates are
// level-triggered, so the robot holds the last one until the next frame lands.
// Using the tick rate would over-command by (frameRate / 50) — 1.4x on a 72 Hz
// headset, 1.8x on a 90 Hz one.
export interface Steps {
  xy: number;        // metres per unit rate per frame (task lane)
  taskDeg: number;   // degrees per unit rate per frame (task pitch/yaw)
  wristDeg: number;  // degrees per unit rate per frame (wrist_roll joint)
}

export interface VrMapResult {
  jog: ExternalJog | null; // null only before any clutch has engaged on either hand
  estop: boolean;          // rising edge of the designated E-STOP button this frame
  // ABSOLUTE normalized joint targets for `control.action`, cartesian robots only
  // ({} on L2 and before the ack). These do NOT ride the jog frame: the wrist is
  // position-controlled and the rest of the arm is rate-controlled, and the
  // gateway is explicit that a latched action survives a zero-jog, so the two
  // coexist on the same channel. Empty means "send nothing", never "send zeros".
  action: Record<string, number>;
}

// --- ported gains (rpi4 8_xlerobot_2wheels_teleop_vr.py) ---------------------
// Position gains bumped 2026-07-15 (all axes ~+10%, reach +20% on top of that) — overall
// feel was slightly too insensitive on hardware, forward/back reach most of all.
const POS_GAIN_X = 265;   // m-delta -> internal units, per axis (was 220)
const POS_GAIN_Y = 77;    // (was 70)
const POS_GAIN_Z = 77;    // (was 70)
const POS_SCALE = 0.01;
const DELTA_LIMIT = 0.01; // max cartesian motion per frame (m)
// Wrist scales/limits are PER-AXIS (verified on hardware 2026-06-25). Roll is deliberately
// much gentler than pitch — matches NoriTeleopReference VR_WRIST_* defaults.
const PITCH_SCALE = 6.6;  // VR_WRIST_PITCH_SCALE (reference default 4.0 felt too
                          // insensitive on hardware — large controller tilt for little flex;
                          // 6.0 -> 6.6 in the 2026-07-15 ~+10% sensitivity pass)
const PITCH_LIMIT = 8.0;  // VR_WRIST_PITCH_LIMIT (also clamps the shoulder_pan delta)
const ROLL_SCALE = 2.75;  // VR_WRIST_ROLL_SCALE (reference 1.0 ≈ half-speed tracking —
                          // operators had to roll ~2× the wrist angle; hardware 2026-07-02.
                          // 2.5 -> 2.75 in the 2026-07-15 pass)
const ROLL_LIMIT = 5.0;   // VR_WRIST_ROLL_LIMIT (raised with the scale so it clamps at the
                          // same controller speed as before)
const PAN_GAIN = 220.0;   // cartesian-x delta -> shoulder_pan deg (200 -> 220, 2026-07-15)
// --- A3 cartesian vocabulary (descriptor-gated; see setDescriptor) ----------
// Tracking-glitch guard for the cartesian lane, in RAW METRES per frame. The
// legacy lane guards on its gain-scaled internal units (JUMP_POS); this lane
// works in metres, so it guards in metres. A controller that teleports on
// reconnect jumps far more than this; a human hand never does.
const JUMP_M = 0.25;
// Fallback per-frame steps for the cartesian lane when the robot advertises no
// jog_scale (so nothing can be derived). Deliberately NOT the L2 constants:
// those describe a different robot. These are the A3 commissioning values
// (0.08 m/s, 0.8 rad/s) at 72 Hz, which is at least the right order.
const FALLBACK_XY_STEP_M = 0.08 / 72;
const FALLBACK_WRIST_STEP_DEG = ((0.8 / 72) * 180) / Math.PI;
const FALLBACK_TASK_STEP_DEG = ((0.25 / 72) * 180) / Math.PI;
// +forearm_yaw spins the tool NEGATIVELY (URDF measurement in the cartesian
// branch below), so the hand's twist is negated. One character to flip.
const FOREARM_YAW_SIGN = -1;
// The two TILT axes. Measured from the URDF as rotation of the TOOL about its
// own axes, per +0.3 rad of joint (2026-09-07):
//     wrist_roll    tiltA -0.300  at EVERY pose — 100% efficient, no bleed
//     wrist_pitch   tiltB +0.299 / +0.251 / +0.260, some roll bleed
// So despite the names, wrist_roll and wrist_pitch are the arm's two tilt
// axes and forearm_yaw is its roll. All three tool DOF exist; only roll was
// wired, which is why the operator reported "the only motion that looks
// correct is roll — the other axes do nothing or bump roll".
//
// WHICH hand axis drives WHICH tilt is the one thing the URDF cannot answer:
// it depends on how the gripper's "up" reads on video, not on geometry. The
// naming-based assignment is used here (hand flex -> wrist_pitch, hand yaw ->
// wrist_roll) and is the single remaining unknown. If tilting your hand up
// makes the tool tilt sideways, these two are swapped; if it tilts the right
// way but backwards, flip that axis's sign. The VRLOG diagnostic resolves both
// in one session now that SENT is integrated.
const WRIST_PITCH_SIGN = 1;
const WRIST_ROLL_SIGN = 1;
// UNVERIFIED ON HARDWARE. Flex and roll BOTH turned out inverted against the
// reference (2026-07-02, 2026-07-16) and were fixed at their single source in
// wristStepDeg; yaw is the third of that family and has never had the check.
// Isolated here so the fix is one character.
const YAW_SIGN = 1;

const JUMP_POS = 50;      // reconnect guard on internal pos units
const JUMP_ANGLE = 30;    // reconnect guard on wrist angles (deg)
const THUMB_DEADZONE = 0.15;
const CLUTCH_ON = 0.6;    // squeeze >= this engages; hysteresis avoids chatter
const CLUTCH_OFF = 0.4;

// --- daemon per-tick full-rate steps (rate = delta / step) ------------------
// Keep in sync with nori_core_agent control.hpp: kXyStep / kDegreeStep.
const XY_STEP = 0.0081;
const DEG_STEP = 3.0;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp1 = (v: number) => clamp(v, -1, 1);
// Cap the top jog speed for the continuous motion DOFs (reach, pan, pitch, roll, base) so VR
// feels controlled — 0.7 = 70% of the daemon's full jog rate. Low-speed response is
// unchanged (only saturating, fast hand moves are limited). Z-lift stays full (discrete);
// the gripper has its own per-direction rates below.
const VR_MAX_RATE = 0.7;
// CARTESIAN vocabulary only (2026-09-03). The 0.7 cap predates the robot advertising its own
// full-deflection speed: it existed to make VR feel controlled when the only speed control
// WAS the client. An A3 gateway publishes jog_scale.task and takes task_linear_mps /
// task_angular_rad_s from its config, so the robot owns that decision — a client silently
// withholding 30% makes the advertised number a lie and hides every robot-side tuning change
// behind a constant nobody would think to look at. Slow an A3 down on the ROBOT.
//
// Deliberately NOT applied to the legacy path: the frozen L-series fleet has no such config,
// so raising its cap would make every deployed L2 headset 43% faster with no way to tune it
// back. vrL2Golden.test.ts caught exactly that when this was first written as one constant.
const VR_MAX_RATE_CARTESIAN = 1.0;
const capRate = (v: number, max: number = VR_MAX_RATE) => clamp(v, -max, max);

// Gripper rates (reworked 2026-07-16 after a hardware check). Binary trigger>0.5; through
// the daemon's jog accumulator, + drives toward the reference's 45° target (jaws OPEN) and
// − toward 0 (closed). The first cut of this had those two directions labeled backwards,
// so the "open" tuning landed on the close direction and opening stayed full-rate.
// OPEN is the user-tunable direction (it was the too-fast one); CLOSE always runs
// GRIPPER_CLOSE_FACTOR× the open rate (capped at the daemon's full rate), regardless of
// tuning. The daemon multiplies rate by its per-tick step, so these scale speed only —
// end positions are unchanged.
const GRIPPER_OPEN_RATE = 0.25;   // default open rate (fraction of full jog rate)
const GRIPPER_CLOSE_FACTOR = 1.5; // close speed = open speed × this, whatever the tuning
// Opening RAMP: the open rate tapers linearly with how far open the jaws already are
// (telemetry gripper.pos, 0 = closed .. 100 = fully open) — full tuned rate at closed,
// this floor × the tuned rate at fully open. The fine end of the travel (nearly open,
// where overshoot loses the object) is the slow end. Position unknown (no telemetry
// yet) -> no taper. Close is NOT ramped.
const GRIPPER_RAMP_FLOOR = 0.3;
// CARTESIAN only. At 0.3 a fully-open jaw crawled, and because the taper applies to OPENING
// only, opening ran ~3x slower than closing exactly where the operator was waiting on it.
// The taper still exists — the fine end of the travel is still the slow end, which is the
// point — it is just no longer the dominant term. Legacy keeps 0.3 (frozen fleet).
const GRIPPER_RAMP_FLOOR_CARTESIAN = 0.5;

// User-tunable sensitivity (the web UI exposes these as sliders — VrJogMapper.setTuning).
// Everything here scales the hardware-tuned constants above; the defaults reproduce them
// exactly, so an untouched slider changes nothing.
export interface VrTuning {
  // Master multiplier on the continuous motion DOFs (translation, pan, wrist). Applied to
  // the per-frame deltas BEFORE their per-axis limits, so it shapes low-speed response the
  // same way the hand-tuned gain passes did; DELTA/PITCH/ROLL limits and VR_MAX_RATE still
  // cap top speed.
  sensitivity?: number;
  // Fraction of the daemon's full jog rate for OPENING, (0..1]. Close is derived
  // (GRIPPER_CLOSE_FACTOR× this, capped at 1) — deliberately not tunable on its own.
  gripperOpenRate?: number;
}
type ResolvedTuning = Required<VrTuning>;
const DEFAULT_TUNING: ResolvedTuning = {
  sensitivity: 1,
  gripperOpenRate: GRIPPER_OPEN_RATE,
};
// Fill defaults + clamp. Shared by the mapper and the in-VR tuning panel (vr-session.ts),
// so a value can never exceed the daemon's full jog rate or zero out, whichever UI set it.
export function resolveTuning(t?: VrTuning): Required<VrTuning> {
  return {
    sensitivity: clamp(t?.sensitivity ?? DEFAULT_TUNING.sensitivity, 0.1, 3),
    gripperOpenRate: clamp(t?.gripperOpenRate ?? DEFAULT_TUNING.gripperOpenRate, 0.05, 1),
  };
}
// Trigger held = + = open (tunable, ramped by how open the jaws already are); released =
// − = close (1.5× the tuned open rate, capped at full, NOT ramped). gripperPos is the
// telemetry gripper.pos [0,100] for this hand's arm, or null when unknown.
const gripperRate = (
  trigger: number, t: ResolvedTuning, gripperPos: number | null, cartesian: boolean,
) => {
  if (trigger <= 0.5) return -Math.min(1, t.gripperOpenRate * GRIPPER_CLOSE_FACTOR);
  const openFrac = gripperPos == null ? 0 : clamp(gripperPos, 0, 100) / 100;
  const floor = cartesian ? GRIPPER_RAMP_FLOOR_CARTESIAN : GRIPPER_RAMP_FLOOR;
  return t.gripperOpenRate * (1 - (1 - floor) * openFrac);
};

// ---- wrist rates: per-frame BODY-FRAME angular increments -------------------
// Deliberate deviation from XLeVR (2026-07-02). The reference
// (vr_ws_server.py extract_pitch/roll_from_quaternion) reads rotvec components of the
// rotation since clutch engage composed as rel = current · origin⁻¹ — a WORLD-frame
// delta. Its X/Z components only mean "tilt"/"twist" while the hand faces the reference
// space's −Z: face 90° sideways and tilt registers as roll (and vice versa); and far from
// the engage pose the total-rotation rotvec cross-couples the axes even in the right
// frame. Both made the mapping feel indirect on hardware.
// Instead we differentiate the quaternion itself: each frame's increment in the
// CONTROLLER's own frame, delta = prev⁻¹ · current. Per-frame increments are tiny, so the
// rotvec is the body-frame angular velocity — x = tilt about the hand's own pitch axis,
// z = twist about the handle — independent of facing direction and travel since engage.
//     flex step = −deg(rotvec.x)   (sign flipped vs XLeVR — inverted on our hardware)
//     roll step = +deg(rotvec.z)   (sign flipped vs XLeVR 2026-07-16 — same story as flex:
//                                   the reference sign twisted the wrist opposite the
//                                   controller on hardware, both arms, leaders correct)
// Quats are [x,y,z,w], Hamilton (same as scipy). Do NOT copy quest_vr_bridge.py's
// aerospace euler (asin = Y axis) — that unverified path never registered flex at all.
type Quat = [number, number, number, number];
const qConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
// quat -> rotation vector (axis·angle), degrees. Shortest arc (w >= 0).
function qRotvecDeg(q: Quat): [number, number, number] {
  let [x, y, z, w] = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [0, 0, 0];
  const k = ((2 * Math.atan2(s, w)) / s) * (180 / Math.PI);
  return [x * k, y * k, z * k];
}
// This frame's wrist steps (degrees) from the body-frame increment prev⁻¹ · cur.
// BOTH signs are flipped vs the reference here, at the single source the wrist delta
// pipelines read. Flex (2026-07-02): the reference's +rotvec.x drove the wrist opposite
// the controller (tilt down moved the wrist up). Roll (2026-07-16): same inversion —
// −rotvec.z twisted the wrist opposite the controller on both arms (leader arms, which
// share the daemon's target convention, were correct — so the fix belongs in VR sensing).
function wristStepDeg(
  cur: Quat, prev: Quat,
): { flex: number; roll: number; yaw: number; rv: [number, number, number] } {
  const rv = qRotvecDeg(qMul(qConj(prev), cur));
  // `rv` is carried through raw for the axis diagnostic (VrJogMapper.wristProbe).
  // Which grip-space axis is the handle's twist has now been guessed wrong
  // twice, so the mapping is being MEASURED rather than reasoned about.
  return { flex: -rv[0], roll: rv[2], yaw: YAW_SIGN * rv[1], rv };
}

// Stateful per-hand integrator. One instance per controller; the mapper owns two.
class HandState {
  private prevPos: [number, number, number] | null = null;
  private prevQuat: Quat | null = null; // last frame's orientation (body-frame increments)
  private engaged = false; // clutch latched on
  // Accumulated raw rotation about each of the controller's OWN axes since the
  // clutch engaged, degrees. Diagnostic only — never drives the robot.
  probe: [number, number, number] = [0, 0, 0];
  // Accumulated hand TRANSLATION since the clutch engaged, metres, in the
  // CONTROL frame and already sign-corrected to read as [forward, left, up] —
  // the same words the robot's axes use, so the two halves of the diagnostic
  // can be compared without anyone doing sign arithmetic in their head.
  posProbe: [number, number, number] = [0, 0, 0];
  // --- anatomical wrist, absolute path (cartesian robots only) ---------------
  // Captured ONCE on the clutch engage edge: the operator's hand orientation,
  // and the robot's own measured wrist angles at that instant. Every frame after
  // that, the target is anchorJoints + wristAngles(now, anchorRef) — recomputed
  // from the current quaternion, never accumulated. That is what makes this
  // immune to the drift, the wrap-around, and the gravity ratchet that every
  // integrate-and-leash path on this robot shares.
  //
  // Anchoring rather than mapping absolutely is the no-lurch guard: the gateway
  // applies `action` with no server-side slew, so an unanchored first frame
  // would snap the wrist from wherever the robot was to wherever the hand
  // happened to be. It also dissolves the "controller held aloft is not the
  // robot's zero" problem with no hard-coded ready offset on either side — the
  // correspondence is established wherever the operator clutches.
  private anchorRef: AnatQuat | null = null;
  private anchorJoints: WristAngles | null = null;
  // Last decomposition clear of the flexion pole. AT the pole pronation and
  // deviation are not separable, so those two hold here rather than spin.
  private lastGoodWrist: WristAngles = zeroWristAngles();
  // --- absolute arm (cartesian robots only) ---------------------------------
  // The operator's HAND drives the robot's WRIST POINT, not its TCP. That is the
  // whole of step 2 (2026-09-07): the A3 wrist is not spherical -- 180 mm from
  // wrist point to TCP -- so commanding a TCP pose forces the arm to spend up to
  // 52% of its 344 mm reach compensating for the operator's own wrist rotation.
  // Measured on hardware: orientation relaxations rose 5x per session and
  // forward reach became impossible while the wrist stayed responsive.
  //
  // Driving the wrist point removes the coupling completely, because the wrist
  // point is independent of the three wrist joints by construction. It also
  // needs no TCP transform at all -- the 180 mm lever simply leaves the loop.
  // The gripper ends up where the anatomy puts it, which is what a human arm
  // does and what "match my motion" actually means.
  private anchorHandPos: [number, number, number] | null = null;
  private anchorWristPoint: Vec3 | null = null;
  private armSeed: ArmQ | null = null;
  private swivel: SwivelTracker | null = null;
  /** Why the arm held this frame, "" when it moved. Surfaced in the HUD. */
  armHold = "";
  // Diagnostic only: last raw hand delta and last commanded target, DEGREES.
  // The robot journal cannot see the wrist any more (it rides `action`, which
  // main does not log), so this is how the axes get checked — in the headset.
  lastWristDeltaDeg: WristAngles = zeroWristAngles();
  lastWristTargetDeg: WristAngles = zeroWristAngles();

  // Is this hand's clutch latched right now? (Post-hysteresis — the same state that decides
  // whether step() contributes jog, so a UI reading this shows exactly what's driving.)
  get isEngaged(): boolean {
    return this.engaged;
  }

  // Drop all baselines so a fresh squeeze re-establishes them with no jump (used on
  // clutch release AND on forced re-clutch after a safe-hold — re-clutch-on-resume).
  release() {
    this.engaged = false;
    this.prevPos = null;
    this.prevQuat = null;
    this.probe = [0, 0, 0];      // each squeeze measures one gesture
    this.posProbe = [0, 0, 0];
    this.anchorRef = null;       // next squeeze re-anchors the wrist
    this.anchorJoints = null;
    this.lastGoodWrist = zeroWristAngles();
    this.anchorHandPos = null;   // ...and the arm
    this.anchorWristPoint = null;
    this.armSeed = null;
    this.swivel = null;
    this.armHold = "";
  }

  /**
   * Absolute joint targets for the four proximal joints, or null when this hand
   * is not driving an arm. Returns the PREVIOUS solution when the solver refuses
   * (out of reach, or a step it cannot take smoothly through a singularity) so
   * the arm holds rather than going limp -- the operator then steers around it,
   * which is what they would do with their own arm.
   */
  armAbsolute(
    cur: [number, number, number] | null | undefined,
    controlYaw: number, dt: number, sens: number,
  ): ArmQ | null {
    if (!this.engaged || !cur || !this.anchorHandPos || !this.anchorWristPoint
        || !this.swivel) return null;
    // Hand travel since the clutch, rotated into the control frame, exactly as
    // the legacy path does -- but ABSOLUTE from the anchor rather than a
    // per-frame delta, so there is nothing to accumulate or drift.
    const wx = cur[0] - this.anchorHandPos[0];
    const wz = cur[2] - this.anchorHandPos[2];
    const cosY = Math.cos(controlYaw), sinY = Math.sin(controlYaw);
    const lat = wx * cosY - wz * sinY;        // +RIGHT
    const fwdBack = wx * sinY + wz * cosY;    // +BACKWARD
    const up = cur[1] - this.anchorHandPos[1];
    const k = WRIST_POINT_SCALE * sens;
    // Arm-mount frame is REP-103: +x forward, +y left, +z up. Same sign
    // convention the jog vocabulary used, so "forward" keeps meaning forward.
    const target: Vec3 = [
      this.anchorWristPoint[0] + -fwdBack * k,
      this.anchorWristPoint[1] + -lat * k,
      this.anchorWristPoint[2] + up * k,
    ];
    const r = this.swivel.solve(target, this.swivel.value, dt, this.armSeed);
    if (!r) {
      const reach = Math.hypot(
        target[0] - this.anchorWristPoint[0],
        target[1] - this.anchorWristPoint[1],
        target[2] - this.anchorWristPoint[2]);
      this.armHold = this.swivel.blockedBy === null
        ? `unreachable (${reach.toFixed(2)}m from anchor)`
        : `singular (needs ${(this.swivel.blockedBy * 180 / Math.PI).toFixed(0)} deg step)`;
      return this.armSeed;
    }
    this.armHold = "";
    this.armSeed = r.q;
    return r.q;
  }

  /** Anchor the absolute arm to this hand pose and the robot's measured joints. */
  anchorArm(handPos: [number, number, number], q: ArmQ | null, sign: number) {
    this.anchorHandPos = handPos;
    if (!q) { this.anchorWristPoint = null; this.armSeed = null; this.swivel = null; return; }
    this.anchorWristPoint = wristPoint(q[0], q[1], q[2], q[3], sign);
    this.armSeed = [...q] as ArmQ;
    // Seeded from the elbow the arm is ALREADY in, so squeezing the clutch does
    // not snap the elbow to a nominal swivel.
    this.swivel = new SwivelTracker(swivelOf(q, sign), sign);
  }

  /**
   * Absolute wrist targets in radians, or null when this hand is not driving a
   * wrist (not engaged, no anchor yet, or the robot never reported its measured
   * wrist so there is nothing to anchor to — commanding a guessed absolute
   * angle is exactly the lurch this design exists to avoid).
   */
  wristAbsolute(
    cur: Quat | null | undefined,
    limits?: Partial<Record<(typeof WRIST_JOINTS)[number], readonly [number, number]>>,
  ): WristAngles | null {
    if (!this.engaged || !cur || !this.anchorRef || !this.anchorJoints) return null;
    const { angles, gimbal } = wristAngles(
      { x: cur[0], y: cur[1], z: cur[2], w: cur[3] }, this.anchorRef);
    if (gimbal) {
      angles.forearm_yaw = this.lastGoodWrist.forearm_yaw;
      angles.wrist_roll = this.lastGoodWrist.wrist_roll;
    } else {
      this.lastGoodWrist = angles;
    }
    // ROM gain BEFORE composing: deviation is amplified to cover a joint range
    // the human wrist cannot reach 1:1 (see applyRomGain).
    this.lastWristDeltaDeg = {
      forearm_yaw: (angles.forearm_yaw * 180) / Math.PI,
      wrist_pitch: (angles.wrist_pitch * 180) / Math.PI,
      wrist_roll: (angles.wrist_roll * 180) / Math.PI,
    };
    const out = wristTargets(this.anchorJoints, applyRomGain(angles), limits);
    this.lastWristTargetDeg = {
      forearm_yaw: (out.forearm_yaw * 180) / Math.PI,
      wrist_pitch: (out.wrist_pitch * 180) / Math.PI,
      wrist_roll: (out.wrist_roll * 180) / Math.PI,
    };
    return out;
  }

  // Returns the arm jog rates for this hand, or null when the clutch is released
  // (caller treats null as "no contribution"; an engaged-but-still hand returns zeros).
  // controlYaw = the control frame's yaw in reference-space radians (see setControlYaw).
  step(
    f: VrControllerFrame | null | undefined,
    controlYaw: number,
    tuning: ResolvedTuning,
    gripperPos: number | null,
    cartesian: boolean,
    steps: Steps,
    wristAnchor: WristAngles | null,
    armAnchor: ArmQ | null,
    sign: number,
  ): Record<string, number> | null {
    if (!f) { this.release(); return null; }

    // Clutch with hysteresis. Released -> hold (zero) and forget baselines so the next
    // engage doesn't snap the robot to wherever the hand drifted.
    const wasEngaged = this.engaged;
    if (this.engaged) {
      if (f.squeeze < CLUTCH_OFF) this.release();
    } else if (f.squeeze >= CLUTCH_ON) {
      this.engaged = true;
    }
    if (!this.engaged) return null;

    const cur = f.position;
    if (!cur) return zeroArm(cartesian);

    // First engaged frame (or first frame after re-engage): establish baseline, hold.
    // Wrist motion integrates per-frame increments from here, so it starts at rest no
    // matter what pose the hand had when the clutch engaged.
    if (!wasEngaged || !this.prevPos) {
      this.prevPos = cur;
      this.prevQuat = (f.orientation as Quat | null | undefined) ?? null;
      // Anchor the anatomical wrist to THIS hand pose and the robot's measured
      // wrist right now, so the first commanded target equals where the arm
      // already is and the correspondence starts wherever the operator clutched.
      const q = (f.orientation as Quat | null | undefined) ?? null;
      this.anchorRef = q ? { x: q[0], y: q[1], z: q[2], w: q[3] } : null;
      this.anchorJoints = wristAnchor;
      this.lastGoodWrist = zeroWristAngles();
      // ...and the arm, to the wrist point the robot is ALREADY at, so the first
      // commanded target is exactly where it stands.
      this.anchorArm(cur, armAnchor, sign);
      return gripperOnly(f.trigger, tuning, gripperPos, cartesian);
    }

    // World-frame metre deltas, rotated into the CONTROL frame (yaw set at recenter) before
    // the per-axis gains — the gains belong to robot axes, not room axes. With yaw θ the
    // control forward is (−sinθ, 0, −cosθ) (θ=0 = reference-space forward, matching the
    // panel's spawn pose), so hand motion toward the video panel is always robot-reach
    // regardless of which way the operator has turned. Height (Y) is yaw-invariant.
    const wx = cur[0] - this.prevPos[0];
    const wz = cur[2] - this.prevPos[2];
    const cosY = Math.cos(controlYaw), sinY = Math.sin(controlYaw);
    // Control-frame components, still metres: lat = +RIGHT, fwdBack = +BACKWARD
    // (WebXR faces −Z), up = +UP.
    const latM = wx * cosY - wz * sinY;
    const fwdBackM = wx * sinY + wz * cosY;
    const upM = cur[1] - this.prevPos[1];
    // The lateral gain depends on what lateral DRIVES. In the legacy vocabulary
    // it drives shoulder_pan — a rotation — and POS_GAIN_X (265) was hand-tuned
    // for that. In the cartesian vocabulary it is a translation (`y`), so it
    // takes the same gain as the other two translation axes; keeping 265 would
    // make sideways hand motion ~3.4x more sensitive than forward or vertical.
    //
    // Side effect worth knowing: the JUMP_POS guard below reads these scaled
    // values, so the lateral tracking-glitch threshold moves from ~0.19 m to
    // ~0.65 m — the same threshold forward and vertical have always had.
    // Diagnostic accumulation, in robot words: forward is -fwdBackM (which is
    // +backward), left is -latM (which is +right), up is upM.
    this.posProbe[0] += -fwdBackM;
    this.posProbe[1] += -latM;
    this.posProbe[2] += upM;
    const vrX = latM * (cartesian ? POS_GAIN_Y : POS_GAIN_X);
    const vrY = upM * POS_GAIN_Y;
    const vrZ = fwdBackM * POS_GAIN_Z;

    // Controller reconnect / tracking glitch -> reset baseline, hold this frame.
    // Cartesian guards in raw metres (JUMP_M); legacy in its gain-scaled units.
    const glitch = cartesian
      ? (Math.abs(latM) > JUMP_M || Math.abs(fwdBackM) > JUMP_M
         || Math.abs(upM) > JUMP_M)
      : (Math.abs(vrX) > JUMP_POS || Math.abs(vrY) > JUMP_POS
         || Math.abs(vrZ) > JUMP_POS);
    if (glitch) {
      this.prevPos = cur;
      return gripperOnly(f.trigger, tuning, gripperPos, cartesian);
    }
    this.prevPos = cur;

    // User sensitivity scales the deltas AFTER the jump guard above (the guard watches raw
    // tracking, not preference) but BEFORE the per-frame limits (which stay absolute caps).
    const sens = tuning.sensitivity;
    const dx = clamp(vrX * POS_SCALE * sens, -DELTA_LIMIT, DELTA_LIMIT);
    const dy = clamp(vrY * POS_SCALE * sens, -DELTA_LIMIT, DELTA_LIMIT);
    const dz = clamp(vrZ * POS_SCALE * sens, -DELTA_LIMIT, DELTA_LIMIT);

    const arm = zeroArm(cartesian);
    if (cartesian) {
      // POSITION CONTROL, in raw metres. The rate that makes the robot travel
      // exactly as far as the hand did this frame is `metres / step`, where
      // step is what one unit of rate buys in one frame — derived from the
      // robot's advertised jog_scale (see Steps). The gain/POS_SCALE/
      // DELTA_LIMIT pipeline the legacy branch uses is deliberately skipped:
      // every one of those constants was calibrated against the L2 daemon's
      // step, and reusing them here is what made a whole-arm sweep move the
      // tool a few centimetres (measured ~26% hand tracking, 2026-09-03).
      //
      // REP-103 base frame: +x FORWARD, +y LEFT, +z UP.
      const sensed = tuning.sensitivity;
      // NOTHING HERE ANY MORE (2026-09-07). Translation left the jog lane for
      // absolute wrist-point targets solved client-side — see armAbsolute().
      // The gateway's task cursor is no longer used by VR at all, which is what
      // removes the TCP-compensation coupling that made forward reach
      // impossible once the wrist became responsive.
    } else {
      // rpi4 reference, sign-for-sign: current_x += -delta_z (Z flipped), current_y += delta_y.
      // (Any genuine motor-direction inversion belongs in calibration/daemon so keyboard and
      // VR agree — not flipped here, which would desync VR from the reference + keyboard.)
      arm.x = clamp1(-dz / XY_STEP);
      arm.y = clamp1(dy / XY_STEP);

      // rpi4: delta_pan = clamp(delta_x * 200, ±8) deg, applied above a small deadband.
      if (Math.abs(dx) > 0.001) {
        arm.shoulder_pan = clamp1(clamp(dx * PAN_GAIN, -PITCH_LIMIT, PITCH_LIMIT) / DEG_STEP);
      }
    }

    // Wrist steps: this frame's rotation increment in the CONTROLLER's own frame
    // (flex = −rotvec.x — tilt about the hand's pitch axis; roll = −rotvec.z — twist
    // about the handle). Same scale/limit/step pipeline as the reference's
    // handle_vr_input, fed body-frame increments instead of world-frame angle diffs.
    if (f.orientation && this.prevQuat) {
      const step = wristStepDeg(f.orientation as Quat, this.prevQuat);
      // Integrate the RAW body-frame increment while clutched. Per-frame values
      // are far too small and noisy to read; the accumulated total over a
      // deliberate gesture is what identifies the axis.
      this.probe[0] += step.rv[0];
      this.probe[1] += step.rv[1];
      this.probe[2] += step.rv[2];

      if (cartesian) {
        // NO TASK-SPACE ROTATION (2026-09-04). pitch/yaw are task DOFs, so every
        // frame of hand rotation became an IK constraint on the cursor -- and
        // the solver spent a whole session refusing them. Measured in one
        // 60-minute session on noriA3-0: 151 refusal events (87 "no IK
        // solution", 64 discarded solutions, 59 orientation relaxations).
        //
        // That is why the operator reported straight X/Y/Z moves working while
        // SWEPT motion did not: a straight reach with a steady hand holds the
        // orientation constant, so only position is asked for and it solves. A
        // sweep rotates the hand as it travels, which adds pitch/yaw, which
        // makes the cursor demand an orientation the arm cannot reach -- and
        // the WHOLE command is refused, translation included. One poisoned
        // channel stalls the other two.
        //
        // So until the absolute-wrist lane lands, hand rotation drives ONE
        // joint. That costs pitch and yaw control and is a deliberate,
        // temporary trade: partial wrist control that WORKS beats full wrist
        // control that refuses and takes translation down with it.
        //
        // That joint is forearm_yaw, NOT wrist_roll (2026-09-04). Measured from
        // the URDF, per +0.3 rad of each joint, as rotation about the TOOL's
        // own long axis:
        //     forearm_yaw   -0.273 rad   <- 91% efficient: this is the roll
        //     wrist_pitch   +0.024 rad
        //     wrist_roll    -0.006 rad   <- does not spin the tool at all
        // Despite the name, wrist_roll TILTS the gripper: the tool extends
        // ~112 mm along that joint's -Z while the joint turns about X, so it
        // swings the tool rather than spinning it. Mapping twist to it was
        // reported from a headset as "twisting the controller sometimes caused
        // tilting" -- which is exactly what the geometry says it would do.
        //
        // forearm_yaw is also the anatomically right answer: twisting a human
        // hand is forearm pronation, not a wrist joint. And it moves the wrist
        // point by exactly 0 m, so it never disturbs the position solve.
        //
        // Sign: +forearm_yaw gives NEGATIVE tool spin (same measurement), so
        // the hand's twist is negated. Evidence rather than a guess, but the
        // first hardware run is still what confirms it.
        // All three wrist DOF, all on the JOINT lane — the wrist_direct solver
        // never writes these, so nothing contends for them.
        // NOTHING HERE ANY MORE (2026-09-06). The wrist left the jog lane for
        // absolute anatomical targets — see wristAbsolute() below and
        // wrist-anatomy.ts. The three sign constants above are retained only
        // for the legacy branch and the probe diagnostic; the cartesian wrist
        // no longer reads them, and no longer integrates anything.
      } else {
        // Wrist pitch from the flex step (rpi4 couples wrist_flex to pitch downstream).
        // Sensitivity multiplies after the glitch guard, same reasoning as translation.
        let dp = step.flex * PITCH_SCALE;
        if (Math.abs(dp) > JUMP_ANGLE) dp = 0; // glitch guard
        else dp = clamp(dp * sens, -PITCH_LIMIT, PITCH_LIMIT);
        arm.pitch = clamp1(dp / DEG_STEP);

        // Wrist roll step (gentler than pitch — separate scale/limit).
        let dr = step.roll * ROLL_SCALE;
        if (Math.abs(dr) > JUMP_ANGLE) dr = 0;
        else dr = clamp(dr * sens, -ROLL_LIMIT, ROLL_LIMIT);
        arm.wrist_roll = clamp1(dr / DEG_STEP);
      }
    }
    this.prevQuat = (f.orientation as Quat | null | undefined) ?? this.prevQuat;

    // Cap top speed on the continuous motion DOFs (the gripper has its own per-direction
    // rates above).
    // Cap the continuous DOFs. The cartesian vocabulary lets the robot's configured speed
    // through at full deflection; the legacy one keeps the client-side 0.7 (see VR_MAX_RATE).
    const cap = cartesian ? VR_MAX_RATE_CARTESIAN : VR_MAX_RATE;
    for (const k of Object.keys(arm)) if (k !== "gripper") arm[k] = capRate(arm[k], cap);

    // Binary gripper trigger (reference: 45 if trigger>0.5 else 0). Through the daemon's
    // jog accumulator/clamp, + drives toward the 45° target (jaws open), − toward 0 (closed).
    arm.gripper = gripperRate(f.trigger, tuning, gripperPos, cartesian);

    return arm;
  }
}

// The key set for one arm, per vocabulary. The gateway routes by NAME: shorts in
// its TASK_SHORTS (x/y/z/pitch/yaw, plus the shoulder_pan alias) drive the
// task-space lane, everything else the per-joint lane. So the key set IS the
// axis mapping — sending a legacy key to an A3 does not fail, it moves a
// different axis. Hence the descriptor gate rather than a best guess.
function zeroArm(cartesian: boolean): Record<string, number> {
  return cartesian
    ? { gripper: 0 }
    : { shoulder_pan: 0, x: 0, y: 0, pitch: 0, wrist_roll: 0, gripper: 0 };
}
function gripperOnly(
  trigger: number, tuning: ResolvedTuning, gripperPos: number | null,
  cartesian: boolean,
): Record<string, number> {
  const a = zeroArm(cartesian);
  a.gripper = gripperRate(trigger, tuning, gripperPos, cartesian); // binary, ramped
  return a;
}

// Right thumbstick -> base velocity (rpi4 get_vr_base_action). Already normalized [-1,1].
function baseFromThumb(f: VrControllerFrame | null | undefined): Record<string, number> | null {
  if (!f) return null;
  const { x, y } = f.thumbstick;
  const linear = Math.abs(y) > THUMB_DEADZONE ? -y : 0; // stick up = forward
  // Stick RIGHT = turn right = NEGATIVE angular: this mapper emits spec REP-103 (+angular =
  // left), like every other jog producer. It used to emit +x here — the negated legacy wire
  // convention directly — because teleop.ts sent externalJog verbatim while the keyboard/
  // script paths negated on the way out. All three now speak REP-103 and the one robot that
  // genuinely turns opposite (the frozen L2 fleet, angular only) gets its flip in
  // RemoteTeleop.wireJog behind a positive model match, so this function stays sign-blind
  // to which robot is connected.
  const angular = Math.abs(x) > THUMB_DEADZONE ? -x : 0;
  if (!linear && !angular) return null;
  return { linear: capRate(linear), angular: capRate(angular) };
}

// lift from a resolved up/down button pair. +1 = UP, -1 = DOWN — and the robot now honours
// that on every unit: the Pi applies each rail's calibrated assembly direction to the jog
// (lift_jog_to_raw), so +1 raises the carriage regardless of how the lift is built. This
// comment used to say "verify sign on hardware"; that verification is now a bench step
// (manual_calibrate.py --lift) rather than a thing each client guesses at.
function liftFromControls(up?: boolean, down?: boolean): number {
  if (up && !down) return 1;
  if (down && !up) return -1;
  return 0; // none, or both (conflict) -> hold
}

export class VrJogMapper {
  private readonly left = new HandState();
  private readonly right = new HandState();
  private estopPrev = false;
  private tuning: ResolvedTuning = { ...DEFAULT_TUNING };
  // Latest telemetry gripper positions ([0,100], null = unknown) for the opening ramp.
  private gripperPos: { left: number | null; right: number | null } = { left: null, right: null };
  // Latest telemetry wrist angles in RADIANS, per side, or null when unknown.
  // Read once per clutch to anchor the absolute wrist — never per frame, so the
  // 15 Hz telemetry rate against a 50 Hz robot state does not matter here.
  private measured: {
    left: { wrist: WristAngles; q: ArmQ } | null;
    right: { wrist: WristAngles; q: ArmQ } | null;
  } = { left: null, right: null };
  // Yaw (radians, reference space) of the control frame the arm TRANSLATIONS are expressed
  // in. 0 = reference-space forward (the panel's spawn facing). The session updates this on
  // every recenter so "toward the video panel" always means robot-forward, even after the
  // operator physically turns. Wrist rates are body-frame (facing-independent) and the base
  // is thumbstick-driven (robot-relative), so neither consumes this.
  private controlYaw = 0;
  // Which arm vocabulary to emit. False = the legacy cylindrical keys every L2
  // expects; true = the A3 cartesian keys. Set from the robot's ack descriptor,
  // never from a model string — see setDescriptor.
  private cartesian = false;
  private descriptor: RobotDescriptor | null = null;
  // Smoothed frame period. A single frame's dt is noisy (a dropped frame
  // doubles it) and it divides straight into the commanded rate, so a raw
  // value would show up as a velocity spike. EMA over ~half a second.
  private frameDt = 1 / 72;

  // Select the arm vocabulary from the robot's ack descriptor. Gated on the
  // PRESENCE of `jog_scale.task`, exactly like teleop.ts's taskKeymapFor for the
  // keyboard — never on a model string, and never assumed: a robot that does not
  // advertise the task vocabulary (every L2, and any pre-ack frame) keeps the
  // legacy keys byte-for-byte, so deployed units are unaffected.
  //
  // Safe to call every frame; the session does, so a mid-session robot restart
  // that re-handshakes takes effect without a re-clutch. Changing vocabulary
  // does not need one — both are per-frame rate streams with no latched state
  // on this side.
  setDescriptor(descriptor: RobotDescriptor | null | undefined) {
    this.descriptor = descriptor ?? null;
    this.cartesian = !!descriptor?.jog_scale?.task;
  }

  // Full-deflection speed of one arm joint in rad/s, recovered from the
  // descriptor. jog_scale.joints is in norm_mode units/s across a [-100,100]
  // span, and ranges_si carries the matching SI bounds, so the physical rate is
  // normPerSec * span / 200. Returns null when either half is missing (an older
  // gateway, or a robot that never sends ranges_si) — the caller then falls back.
  private jointRadPerSec(side: string, short: string): number | null {
    const key = `${side}_arm_${short}.pos`;
    const normPerSec = this.descriptor?.jog_scale?.joints?.[key];
    const si = this.descriptor?.ranges_si?.[key];
    if (typeof normPerSec !== "number" || !si) return null;
    const span = Math.abs(si[1] - si[0]);
    if (!(span > 0)) return null;
    return (normPerSec * span) / 200;
  }

  // Per-frame steps for one arm. Legacy keeps the L2 daemon's constants
  // byte-for-byte (they describe that robot correctly); cartesian derives from
  // whatever THIS robot advertises, so a bench change to task_linear_mps or the
  // joint rates is picked up without touching the client.
  private stepsFor(side: string): Steps {
    if (!this.cartesian) {
      return { xy: XY_STEP, taskDeg: DEG_STEP, wristDeg: DEG_STEP };
    }
    const linear = this.descriptor?.jog_scale?.task?.x;
    const wristRadS = this.jointRadPerSec(side, "wrist_pitch")
      ?? this.jointRadPerSec(side, "wrist_roll");
    const taskRadS = this.descriptor?.jog_scale?.task?.pitch;
    return {
      xy: typeof linear === "number" && linear > 0
        ? linear * this.frameDt : FALLBACK_XY_STEP_M,
      taskDeg: typeof taskRadS === "number" && taskRadS > 0
        ? (taskRadS * this.frameDt * 180) / Math.PI
        : FALLBACK_TASK_STEP_DEG,
      wristDeg: wristRadS != null && wristRadS > 0
        ? (wristRadS * this.frameDt * 180) / Math.PI
        : FALLBACK_WRIST_STEP_DEG,
    };
  }

  // Whether the mapper is currently emitting the cartesian vocabulary. For UI
  // and logs (the in-VR HUD says which axes the sticks and hands drive).
  get isCartesian(): boolean {
    return this.cartesian;
  }

  // Called by the session whenever recenter re-aims the panel cluster (same yaw it applies
  // to the panel group). Deliberately does NOT force a re-clutch: translation is per-frame
  // deltas, so a mid-hold yaw change can't jump — future motion just maps through the new
  // frame.
  setControlYaw(yawRad: number) {
    this.controlYaw = yawRad;
  }

  // User sensitivity settings (web sliders or the in-VR panel). Safe to call mid-session —
  // takes effect on the next frame. Unset fields fall back to the hardware-tuned defaults.
  setTuning(t: VrTuning) {
    this.tuning = resolveTuning(t);
  }

  // Telemetry gripper positions (gripper.pos [0,100], null = unknown), fed by the session
  // each frame so the opening ramp knows how far open each arm's jaws already are.
  // Telemetry wrist angles (radians), fed by the session. Null for a side whose
  // angles the robot has not reported: that side then drives no absolute wrist
  // rather than anchoring to a guess.
  setMeasured(
    left: { wrist: WristAngles; q: ArmQ } | null,
    right: { wrist: WristAngles; q: ArmQ } | null,
  ) {
    this.measured = { left, right };
  }

  // This robot's calibrated wrist bounds (radians), from the ack descriptor.
  // Undefined when it does not advertise them — targets then go out unclamped
  // and the gateway's own calibration clamp is the backstop, which it always is.
  private wristLimits(side: string) {
    const out: Record<string, readonly [number, number]> = {};
    for (const joint of WRIST_JOINTS) {
      const si = this.descriptor?.ranges_si?.[`${side}_arm_${joint}.pos`];
      if (si) out[joint] = [si[0], si[1]] as const;
    }
    return out as Partial<Record<(typeof WRIST_JOINTS)[number], readonly [number, number]>>;
  }

  // One hand's absolute wrist as normalized `control.action` keys. Empty unless
  // this robot speaks the cartesian vocabulary AND advertises ranges_si: without
  // the SI bounds a normalized target would command an arbitrary real angle,
  // which is the one failure mode worth refusing outright.
  private wristActionFor(
    side: "left" | "right", hand: HandState, f: VrControllerFrame | null | undefined,
  ): Record<string, number> {
    if (!this.cartesian) return {};
    const out: Record<string, number> = {};
    const put = (joint: string, radians: number) => {
      const key = `${side}_arm_${joint}.pos`;
      const si = this.descriptor?.ranges_si?.[key];
      if (!si) return;
      const span = si[1] - si[0];
      if (!span) return;
      const norm = ((radians - si[0]) / span) * 200 - 100;
      out[key] = Math.max(-100, Math.min(100, norm));
    };
    const targets = hand.wristAbsolute(
      (f?.orientation as Quat | null | undefined) ?? null, this.wristLimits(side));
    if (targets) for (const joint of WRIST_JOINTS) put(joint, targets[joint]);
    // The four proximal joints, solved client-side from the wrist-point target.
    // Sent in the SAME action frame as the wrist so the arm and the hand arrive
    // together — split across two frames they would be one tick out of step,
    // which at 50 Hz is a visible wobble at the gripper.
    const q = hand.armAbsolute(
      f?.position ?? null, this.controlYaw, this.frameDt, this.tuning.sensitivity ?? 1);
    if (q) SOLVED_JOINTS.forEach((joint, i) => put(joint, q[i]));
    return out;
  }

  // Last raw hand delta and last commanded wrist target for one side, DEGREES.
  // Diagnostic only. This exists because the robot journal can no longer see the
  // wrist at all — it rides `control.action`, and the gateway on main logs only
  // jog — so the axis check has to happen in the headset.
  wristDiag(side: "left" | "right") {
    const h = side === "left" ? this.left : this.right;
    return { hand: h.lastWristDeltaDeg, cmd: h.lastWristTargetDeg, hold: h.armHold };
  }

  setGripperPos(left: number | null, right: number | null) {
    this.gripperPos = { left, right };
  }

  // Accumulated rotation about each controller axis since the clutch engaged,
  // in degrees, per hand: [x, y, z] of the grip frame. Squeeze, make ONE
  // deliberate gesture, and read which component moved — that identifies which
  // axis is the handle twist without anyone having to guess. Resets on release.
  wristProbe(): { left: [number, number, number]; right: [number, number, number] } {
    return { left: this.left.probe, right: this.right.probe };
  }

  // Hand TRANSLATION since the clutch engaged, metres, as [forward, left, up].
  handProbe(): { left: [number, number, number]; right: [number, number, number] } {
    return { left: this.left.posProbe, right: this.right.posProbe };
  }

  // Which arms are under active clutch this frame. VR is dual-arm (each controller drives its
  // own arm), so unlike the keyboard's single `settings.arm` there's no one "active" arm —
  // the 3D robot highlights whichever arm(s) you're actually commanding.
  engagedArms(): { left: boolean; right: boolean } {
    return { left: this.left.isEngaged, right: this.right.isEngaged };
  }

  // Force both hands to require a fresh squeeze before driving again. Call after any
  // safe-hold (link drop / E-STOP latch) so resume can't snap to a drifted pose.
  reclutch() {
    this.left.release();
    this.right.release();
  }

  // Map one VR frame to a jog payload. Left controller -> left arm, right -> right arm;
  // base comes from the right controller; z-lift + E-STOP come from the resolved controls.
  map(frame: VrFrame, dtSeconds?: number): VrMapResult {
    // Track the real frame period when the caller supplies it. Clamped to a
    // sane window so a stalled tab or a first-frame zero cannot divide the
    // commanded rate into a spike.
    if (typeof dtSeconds === "number" && dtSeconds > 0) {
      const dt = clamp(dtSeconds, 1 / 144, 1 / 30);
      this.frameDt += (dt - this.frameDt) * 0.03; // EMA, ~0.5 s settle
    }
    const lArm = this.left.step(
      frame.left, this.controlYaw, this.tuning, this.gripperPos.left,
      this.cartesian, this.stepsFor("left"), this.measured.left?.wrist ?? null,
      this.measured.left?.q ?? null, sideSign("left"));
    const rArm = this.right.step(
      frame.right, this.controlYaw, this.tuning, this.gripperPos.right,
      this.cartesian, this.stepsFor("right"), this.measured.right?.wrist ?? null,
      this.measured.right?.q ?? null, sideSign("right"));
    // Absolute wrist, independent of the jog frame above. Computed after step()
    // so the clutch edge has already anchored.
    const action = {
      ...this.wristActionFor("left", this.left, frame.left),
      ...this.wristActionFor("right", this.right, frame.right),
    };
    const base = baseFromThumb(frame.right);
    const c = frame.controls;
    const leftLift = liftFromControls(c?.leftLiftUp, c?.leftLiftDown);
    const rightLift = liftFromControls(c?.rightLiftUp, c?.rightLiftDown);

    const estopNow = !!c?.estop;
    const estopEdge = estopNow && !this.estopPrev;
    this.estopPrev = estopNow;

    // Nothing engaged at all -> null (let the keyboard keep the stream).
    if (lArm == null && rArm == null && !base && !leftLift && !rightLift) {
      return { jog: null, estop: estopEdge, action };
    }
    const jog: ExternalJog = {};
    if (lArm) jog.left_arm = lArm;
    if (rArm) jog.right_arm = rArm;
    if (base) jog.base = base;
    if (leftLift) jog.left_lift = leftLift;
    if (rightLift) jog.right_lift = rightLift;
    return { jog, estop: estopEdge, action };
  }
}
