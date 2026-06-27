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
// meters (headset/local reference space); angles in degrees; trigger/squeeze in [0,1].
export interface VrControllerFrame {
  position: [number, number, number] | null;
  wristFlexDeg?: number | null;
  wristRollDeg?: number | null;
  trigger: number;   // analog gripper: 1 = close, 0 = open
  squeeze: number;   // grip button: the CLUTCH ("squeeze to move")
  thumbstick: { x: number; y: number };
}

// Discrete actions, already resolved from the (configurable) button bindings by the session
// layer — the mapper stays agnostic to which physical button/hand each came from. (reset is
// a hold-gesture handled in the session, so it isn't here.)
export interface VrControls {
  zUp?: boolean;
  zDown?: boolean;
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
const POS_GAIN_X = 220;   // m-delta -> internal units, per axis
const POS_GAIN_Y = 70;
const POS_GAIN_Z = 70;
const POS_SCALE = 0.01;
const DELTA_LIMIT = 0.01; // max cartesian motion per frame (m)
// Wrist scales/limits are PER-AXIS (verified on hardware 2026-06-25). Roll is deliberately
// much gentler than pitch — matches NoriTeleopReference VR_WRIST_* defaults.
const PITCH_SCALE = 4.0;  // VR_WRIST_PITCH_SCALE
const PITCH_LIMIT = 8.0;  // VR_WRIST_PITCH_LIMIT (also clamps the shoulder_pan delta)
const ROLL_SCALE = 1.0;   // VR_WRIST_ROLL_SCALE
const ROLL_LIMIT = 2.5;   // VR_WRIST_ROLL_LIMIT
const PAN_GAIN = 200.0;   // cartesian-x delta -> shoulder_pan deg
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

// Stateful per-hand integrator. One instance per controller; the mapper owns two.
class HandState {
  private prevPos: [number, number, number] | null = null;
  private prevFlex: number | null = null;
  private prevRoll: number | null = null;
  private engaged = false; // clutch latched on

  // Drop all baselines so a fresh squeeze re-establishes them with no jump (used on
  // clutch release AND on forced re-clutch after a safe-hold — re-clutch-on-resume).
  release() {
    this.engaged = false;
    this.prevPos = null;
    this.prevFlex = null;
    this.prevRoll = null;
  }

  // Returns the arm jog rates for this hand, or null when the clutch is released
  // (caller treats null as "no contribution"; an engaged-but-still hand returns zeros).
  step(f: VrControllerFrame | null | undefined): Record<string, number> | null {
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
    if (!wasEngaged || !this.prevPos) {
      this.prevPos = cur;
      if (f.wristFlexDeg != null) this.prevFlex = f.wristFlexDeg;
      if (f.wristRollDeg != null) this.prevRoll = f.wristRollDeg;
      return gripperOnly(f.trigger);
    }

    const vrX = (cur[0] - this.prevPos[0]) * POS_GAIN_X;
    const vrY = (cur[1] - this.prevPos[1]) * POS_GAIN_Y;
    const vrZ = (cur[2] - this.prevPos[2]) * POS_GAIN_Z;

    // Controller reconnect / tracking glitch -> reset baseline, hold this frame.
    if (Math.abs(vrX) > JUMP_POS || Math.abs(vrY) > JUMP_POS || Math.abs(vrZ) > JUMP_POS) {
      this.prevPos = cur;
      return gripperOnly(f.trigger);
    }
    this.prevPos = cur;

    const dx = clamp(vrX * POS_SCALE, -DELTA_LIMIT, DELTA_LIMIT);
    const dy = clamp(vrY * POS_SCALE, -DELTA_LIMIT, DELTA_LIMIT);
    const dz = clamp(vrZ * POS_SCALE, -DELTA_LIMIT, DELTA_LIMIT);

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

    // Wrist pitch from wrist_flex delta (rpi4 couples wrist_flex to pitch downstream).
    if (f.wristFlexDeg != null) {
      if (this.prevFlex == null) {
        this.prevFlex = f.wristFlexDeg;
      } else {
        let dp = (f.wristFlexDeg - this.prevFlex) * PITCH_SCALE;
        if (Math.abs(dp) > JUMP_ANGLE) dp = 0; // glitch guard
        else dp = clamp(dp, -PITCH_LIMIT, PITCH_LIMIT);
        arm.pitch = clamp1(dp / DEG_STEP);
        this.prevFlex = f.wristFlexDeg;
      }
    }

    // Wrist roll delta (gentler than pitch — separate scale/limit, matches reference).
    if (f.wristRollDeg != null) {
      if (this.prevRoll == null) {
        this.prevRoll = f.wristRollDeg;
      } else {
        let dr = (f.wristRollDeg - this.prevRoll) * ROLL_SCALE;
        if (Math.abs(dr) > JUMP_ANGLE) dr = 0;
        else dr = clamp(dr, -ROLL_LIMIT, ROLL_LIMIT);
        arm.wrist_roll = clamp1(dr / DEG_STEP);
        this.prevRoll = f.wristRollDeg;
      }
    }

    // Binary gripper (matches reference: 45 if trigger>0.5 else 0). Through the daemon's
    // jog accumulator/clamp, +1 drives toward closed and -1 toward open.
    arm.gripper = f.trigger > 0.5 ? 1 : -1;

    return arm;
  }
}

function zeroArm(): Record<string, number> {
  return { shoulder_pan: 0, x: 0, y: 0, pitch: 0, wrist_roll: 0, gripper: 0 };
}
function gripperOnly(trigger: number): Record<string, number> {
  const a = zeroArm();
  a.gripper = trigger > 0.5 ? 1 : -1; // binary, matches reference
  return a;
}

// Right thumbstick -> base velocity (rpi4 get_vr_base_action). Already normalized [-1,1].
function baseFromThumb(f: VrControllerFrame | null | undefined): Record<string, number> | null {
  if (!f) return null;
  const { x, y } = f.thumbstick;
  const linear = Math.abs(y) > THUMB_DEADZONE ? -y : 0; // stick up = forward
  const angular = Math.abs(x) > THUMB_DEADZONE ? -x : 0; // reference negates tx
  if (!linear && !angular) return null;
  return { linear: clamp1(linear), angular: clamp1(angular) };
}

// z-lift from the resolved semantic controls. +1 up / -1 down (verify sign on hardware).
function zLiftFromControls(c: VrControls | undefined): number {
  if (!c) return 0;
  if (c.zUp && !c.zDown) return 1;
  if (c.zDown && !c.zUp) return -1;
  return 0; // none, or both (conflict) -> hold
}

export class VrJogMapper {
  private readonly left = new HandState();
  private readonly right = new HandState();
  private estopPrev = false;

  // Force both hands to require a fresh squeeze before driving again. Call after any
  // safe-hold (link drop / E-STOP latch) so resume can't snap to a drifted pose.
  reclutch() {
    this.left.release();
    this.right.release();
  }

  // Map one VR frame to a jog payload. Left controller -> left arm, right -> right arm;
  // base comes from the right controller; z-lift + E-STOP come from the resolved controls.
  map(frame: VrFrame): VrMapResult {
    const lArm = this.left.step(frame.left);
    const rArm = this.right.step(frame.right);
    const base = baseFromThumb(frame.right);
    const z = zLiftFromControls(frame.controls);

    const estopNow = !!frame.controls?.estop;
    const estopEdge = estopNow && !this.estopPrev;
    this.estopPrev = estopNow;

    // Nothing engaged at all -> null (let the keyboard keep the stream).
    if (lArm == null && rArm == null && !base && !z) {
      return { jog: null, estop: estopEdge };
    }
    const jog: ExternalJog = {};
    if (lArm) jog.left_arm = lArm;
    if (rArm) jog.right_arm = rArm;
    if (base) jog.base = base;
    if (z) jog.z_lift = z;
    return { jog, estop: estopEdge };
  }
}
