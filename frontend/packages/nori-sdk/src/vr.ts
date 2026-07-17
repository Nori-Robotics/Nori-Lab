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

import type { ExternalJog } from "./teleop";

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

export interface VrMapResult {
  jog: ExternalJog | null; // null only before any clutch has engaged on either hand
  estop: boolean;          // rising edge of the designated E-STOP button this frame
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
const capRate = (v: number) => clamp(v, -VR_MAX_RATE, VR_MAX_RATE);

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
// Trigger held = + = open (tunable); released = − = close (1.5× open, capped at full).
const gripperRate = (trigger: number, t: ResolvedTuning) => {
  const close = Math.min(1, t.gripperOpenRate * GRIPPER_CLOSE_FACTOR);
  return trigger > 0.5 ? t.gripperOpenRate : -close;
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
function wristStepDeg(cur: Quat, prev: Quat): { flex: number; roll: number } {
  const rv = qRotvecDeg(qMul(qConj(prev), cur));
  return { flex: -rv[0], roll: rv[2] };
}

// Stateful per-hand integrator. One instance per controller; the mapper owns two.
class HandState {
  private prevPos: [number, number, number] | null = null;
  private prevQuat: Quat | null = null; // last frame's orientation (body-frame increments)
  private engaged = false; // clutch latched on

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
  }

  // Returns the arm jog rates for this hand, or null when the clutch is released
  // (caller treats null as "no contribution"; an engaged-but-still hand returns zeros).
  // controlYaw = the control frame's yaw in reference-space radians (see setControlYaw).
  step(
    f: VrControllerFrame | null | undefined,
    controlYaw: number,
    tuning: ResolvedTuning,
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
    if (!cur) return zeroArm();

    // First engaged frame (or first frame after re-engage): establish baseline, hold.
    // Wrist motion integrates per-frame increments from here, so it starts at rest no
    // matter what pose the hand had when the clutch engaged.
    if (!wasEngaged || !this.prevPos) {
      this.prevPos = cur;
      this.prevQuat = (f.orientation as Quat | null | undefined) ?? null;
      return gripperOnly(f.trigger, tuning);
    }

    // World-frame metre deltas, rotated into the CONTROL frame (yaw set at recenter) before
    // the per-axis gains — the gains belong to robot axes, not room axes. With yaw θ the
    // control forward is (−sinθ, 0, −cosθ) (θ=0 = reference-space forward, matching the
    // panel's spawn pose), so hand motion toward the video panel is always robot-reach
    // regardless of which way the operator has turned. Height (Y) is yaw-invariant.
    const wx = cur[0] - this.prevPos[0];
    const wz = cur[2] - this.prevPos[2];
    const cosY = Math.cos(controlYaw), sinY = Math.sin(controlYaw);
    const vrX = (wx * cosY - wz * sinY) * POS_GAIN_X;
    const vrY = (cur[1] - this.prevPos[1]) * POS_GAIN_Y;
    const vrZ = (wx * sinY + wz * cosY) * POS_GAIN_Z;

    // Controller reconnect / tracking glitch -> reset baseline, hold this frame.
    if (Math.abs(vrX) > JUMP_POS || Math.abs(vrY) > JUMP_POS || Math.abs(vrZ) > JUMP_POS) {
      this.prevPos = cur;
      return gripperOnly(f.trigger, tuning);
    }
    this.prevPos = cur;

    // User sensitivity scales the deltas AFTER the jump guard above (the guard watches raw
    // tracking, not preference) but BEFORE the per-frame limits (which stay absolute caps).
    const sens = tuning.sensitivity;
    const dx = clamp(vrX * POS_SCALE * sens, -DELTA_LIMIT, DELTA_LIMIT);
    const dy = clamp(vrY * POS_SCALE * sens, -DELTA_LIMIT, DELTA_LIMIT);
    const dz = clamp(vrZ * POS_SCALE * sens, -DELTA_LIMIT, DELTA_LIMIT);

    const arm = zeroArm();
    // rpi4 reference, sign-for-sign: current_x += -delta_z (Z flipped), current_y += delta_y.
    // (Any genuine motor-direction inversion belongs in calibration/daemon so keyboard and
    // VR agree — not flipped here, which would desync VR from the reference + keyboard.)
    arm.x = clamp1(-dz / XY_STEP);
    arm.y = clamp1(dy / XY_STEP);

    // rpi4: delta_pan = clamp(delta_x * 200, ±8) deg, applied above a small deadband.
    if (Math.abs(dx) > 0.001) {
      arm.shoulder_pan = clamp1(clamp(dx * PAN_GAIN, -PITCH_LIMIT, PITCH_LIMIT) / DEG_STEP);
    }

    // Wrist steps: this frame's rotation increment in the CONTROLLER's own frame
    // (flex = −rotvec.x — tilt about the hand's pitch axis; roll = −rotvec.z — twist
    // about the handle). Same scale/limit/step pipeline as the reference's
    // handle_vr_input, fed body-frame increments instead of world-frame angle diffs.
    if (f.orientation && this.prevQuat) {
      const step = wristStepDeg(f.orientation as Quat, this.prevQuat);

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
    this.prevQuat = (f.orientation as Quat | null | undefined) ?? this.prevQuat;

    // Cap top speed on the continuous motion DOFs (the gripper has its own per-direction
    // rates above).
    for (const k of Object.keys(arm)) if (k !== "gripper") arm[k] = capRate(arm[k]);

    // Binary gripper trigger (reference: 45 if trigger>0.5 else 0). Through the daemon's
    // jog accumulator/clamp, + drives toward the 45° target (jaws open), − toward 0 (closed).
    arm.gripper = gripperRate(f.trigger, tuning);

    return arm;
  }
}

function zeroArm(): Record<string, number> {
  return { shoulder_pan: 0, x: 0, y: 0, pitch: 0, wrist_roll: 0, gripper: 0 };
}
function gripperOnly(trigger: number, tuning: ResolvedTuning): Record<string, number> {
  const a = zeroArm();
  a.gripper = gripperRate(trigger, tuning); // binary trigger, per-direction rates
  return a;
}

// Right thumbstick -> base velocity (rpi4 get_vr_base_action). Already normalized [-1,1].
function baseFromThumb(f: VrControllerFrame | null | undefined): Record<string, number> | null {
  if (!f) return null;
  const { x, y } = f.thumbstick;
  const linear = Math.abs(y) > THUMB_DEADZONE ? -y : 0; // stick up = forward
  // Stick RIGHT = turn right. This used to be `-x`, copied from the rpi4 reference's "negate
  // tx", which left VR steering MIRRORED: the jog we emit here goes onto the wire verbatim
  // (teleop.ts sends externalJog untouched), whereas the keyboard/script paths negate angular
  // on the way out to correct for the firmware turning opposite our "+angular = left"
  // convention (teleop.ts BASE_KEYS / ScriptDriver.base). Those two got the fix; VR didn't, so
  // it inherited the raw firmware sign and steered backwards. Sending +x lines VR up with the
  // wire convention the other two already send.
  const angular = Math.abs(x) > THUMB_DEADZONE ? x : 0;
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
  // Yaw (radians, reference space) of the control frame the arm TRANSLATIONS are expressed
  // in. 0 = reference-space forward (the panel's spawn facing). The session updates this on
  // every recenter so "toward the video panel" always means robot-forward, even after the
  // operator physically turns. Wrist rates are body-frame (facing-independent) and the base
  // is thumbstick-driven (robot-relative), so neither consumes this.
  private controlYaw = 0;

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
  map(frame: VrFrame): VrMapResult {
    const lArm = this.left.step(frame.left, this.controlYaw, this.tuning);
    const rArm = this.right.step(frame.right, this.controlYaw, this.tuning);
    const base = baseFromThumb(frame.right);
    const c = frame.controls;
    const leftLift = liftFromControls(c?.leftLiftUp, c?.leftLiftDown);
    const rightLift = liftFromControls(c?.rightLiftUp, c?.rightLiftDown);

    const estopNow = !!c?.estop;
    const estopEdge = estopNow && !this.estopPrev;
    this.estopPrev = estopNow;

    // Nothing engaged at all -> null (let the keyboard keep the stream).
    if (lArm == null && rArm == null && !base && !leftLift && !rightLift) {
      return { jog: null, estop: estopEdge };
    }
    const jog: ExternalJog = {};
    if (lArm) jog.left_arm = lArm;
    if (rArm) jog.right_arm = rArm;
    if (base) jog.base = base;
    if (leftLift) jog.left_lift = leftLift;
    if (rightLift) jog.right_lift = rightLift;
    return { jog, estop: estopEdge };
  }
}
