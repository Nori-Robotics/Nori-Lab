// NORI: Additive file. M2 Phase 2 — WebXR immersive session glue (laptop-side).
//
// Owns the `immersive-vr` session: it renders the robot's live WebRTC video as a panel in
// a three.js scene the operator sees in the Quest, samples both controllers each XR frame,
// runs them through VrJogMapper, and feeds the result into an existing RemoteTeleop via
// setExternalJog / command — the daemon path is unchanged (see vr.ts header).
//
// Connection model (onboard_pi_plan.md §e): the Quest browser loads this app over
// `localhost` (reached via `adb reverse tcp:8080 tcp:8080` to the laptop's Vite), which is
// a secure context, so navigator.xr + crypto.subtle work with no cert pain. The WebRTC /
// Supabase session is the same one keyboard remote mode uses.
//
// Control map (v1 — exactly the keyboard DOF, per §e "one canonical command set"):
//   each hand:  grip = CLUTCH (squeeze to move)   trigger = that arm's gripper
//               move/tilt/twist the controller -> that arm's x/y/pitch/roll + shoulder_pan
//   right only: thumbstick = base drive           A / B = z-lift up / down
//   left only:  X = E-STOP (latches + re-clutch)  Y (hold 1.5s) = reset latch (R13: the
//               operator is in-headset seeing live video, satisfying the confirmation gate)

import * as THREE from "three";
import { VrJogMapper, type VrControllerFrame, type VrFrame } from "./vr";
import type { RemoteTeleop } from "./teleop";

const RESET_HOLD_MS = 1500;
// gripper Present_Current -> rumble. Raw sign-magnitude ints; tune on hardware.
const HAPTIC_IDLE = 60;   // below this = no contact, no buzz
const HAPTIC_FULL = 600;  // at/above this = full-strength rumble

type Hand = "left" | "right";
// A physical button on one controller: {hand, gamepad button index}. xr-standard indices:
// 0 trigger, 1 grip/squeeze, 3 thumbstick-press, 4 A/X, 5 B/Y.
export interface VrButtonRef { hand: Hand; index: number; }

// Maps logical VR actions onto physical buttons so they can be moved (e.g. to free the
// left X/Y for a left-arm z-rail when going dual-arm). Per-hand for the analog grips.
export interface VrBindings {
  clutch: Record<Hand, number>;  // grip button = squeeze-to-move (default 1 both hands)
  gripper: Record<Hand, number>; // trigger = that arm's gripper (default 0 both hands)
  zUp?: VrButtonRef;
  zDown?: VrButtonRef;
  estop?: VrButtonRef;
  reset?: VrButtonRef; // hold this for RESET_HOLD_MS
}

// Single-right-arm default (M2 bring-up): grip=clutch, trigger=gripper, right A/B = z-lift,
// left X = E-STOP, hold left Y = reset. For dual-arm, move E-STOP/reset off left X/Y.
export const DEFAULT_BINDINGS: VrBindings = {
  clutch: { left: 1, right: 1 },
  gripper: { left: 0, right: 0 },
  zUp: { hand: "right", index: 4 },   // A
  zDown: { hand: "right", index: 5 }, // B
  estop: { hand: "left", index: 4 },  // X
  reset: { hand: "left", index: 5 },  // Y (hold)
};

export interface VrSessionOptions {
  teleop: RemoteTeleop;
  videoEl: HTMLVideoElement; // the same element RemoteTeleop attaches the remote stream to
  onLog: (msg: string) => void;
  onEnd: () => void;
  bindings?: VrBindings; // defaults to DEFAULT_BINDINGS
}

// Quaternion -> {flex, roll} in degrees. Replicates NoriTeleopReference's quatToEulerDeg
// EXACTLY (its handPayload maps roll=e.roll -> wrist_roll_deg, pitch=e.pitch -> wrist_flex_deg)
// so the same physical twist produces the same flex/roll deltas the tested mapping expects.
const DEG = 180 / Math.PI;
function controllerAngles(o: DOMPointReadOnly): { flex: number; roll: number } {
  const x = o.x, y = o.y, z = o.z, w = o.w;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
  return { flex: pitch * DEG, roll: roll * DEG };
}

export class VrSession {
  private o: VrSessionOptions;
  private readonly b: VrBindings;
  private readonly mapper = new VrJogMapper();
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private texture: THREE.VideoTexture | null = null;
  private session: XRSession | null = null;
  private currents: Record<string, number> = {};
  private resetHeldSince = 0;
  private resetFired = false;
  private running = false;

  constructor(opts: VrSessionOptions) {
    this.o = opts;
    this.b = opts.bindings ?? DEFAULT_BINDINGS;
  }

  static async isSupported(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) return false;
    try {
      // Either is fine: AR gives passthrough behind the video panel, VR is the fallback.
      return (
        (await xr.isSessionSupported("immersive-ar")) ||
        (await xr.isSessionSupported("immersive-vr"))
      );
    } catch { return false; }
  }

  // Latest per-motor currents (the page wires RemoteTeleop.onCurrents here for haptics).
  setCurrents(c: Record<string, number>) {
    this.currents = c;
  }

  // Force a fresh squeeze before driving resumes (after any safe-hold). The page calls
  // this when the link drops; E-STOP calls it inline.
  reclutch() {
    this.mapper.reclutch();
  }

  async start() {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error("WebXR not available in this browser");

    // Prefer immersive-ar so the Quest's passthrough shows around the video panel; fall
    // back to immersive-vr (black) where AR isn't available.
    const ar = await xr.isSessionSupported("immersive-ar").catch(() => false);
    const mode: "immersive-ar" | "immersive-vr" = ar ? "immersive-ar" : "immersive-vr";

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    renderer.setClearAlpha(0); // transparent clear -> passthrough shows through in AR
    this.renderer = renderer;

    const scene = new THREE.Scene();
    // Transparent in AR (passthrough behind the panel); dark in the VR fallback.
    scene.background = mode === "immersive-ar" ? null : new THREE.Color(0x101216);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 50);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));

    // Robot video as a 2m-wide panel ~2m ahead at standing eye height.
    const texture = new THREE.VideoTexture(this.o.videoEl);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.texture = texture;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 1.5),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
    );
    panel.position.set(0, 1.4, -2.0);
    scene.add(panel);

    const session = await xr.requestSession(mode, {
      optionalFeatures: ["local-floor", "bounded-floor"],
    });
    this.session = session;
    session.addEventListener("end", () => this.handleEnd());
    await renderer.xr.setSession(session);

    this.running = true;
    this.o.onLog(
      `${mode === "immersive-ar" ? "AR (passthrough)" : "VR"} session started — ` +
        "grip to engage clutch, left X = E-STOP, hold left Y = reset"
    );
    renderer.setAnimationLoop((_t, frame) => this.onXRFrame(frame));
  }

  async stop() {
    if (this.session) {
      try { await this.session.end(); } catch { /* already ending */ }
    } else {
      this.handleEnd();
    }
  }

  private handleEnd() {
    if (!this.running && !this.renderer) return;
    this.running = false;
    // release the control stream back to the keyboard and hold the robot
    try { this.o.teleop.setExternalJog(null); } catch { /* noop */ }
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      try { this.renderer.dispose(); } catch { /* noop */ }
    }
    this.texture?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.texture = null;
    this.session = null;
    this.o.onLog("VR session ended");
    this.o.onEnd();
  }

  private onXRFrame(frame: XRFrame | undefined) {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return;

    if (frame) {
      const refSpace = renderer.xr.getReferenceSpace();
      const session = renderer.xr.getSession();
      if (refSpace && session) {
        const sources = [...session.inputSources];
        const vrFrame: VrFrame = {};
        for (const src of sources) {
          if (!src.gamepad || !src.handedness) continue;
          const cf = this.sampleController(src, frame, refSpace);
          if (src.handedness === "left") vrFrame.left = cf;
          else if (src.handedness === "right") vrFrame.right = cf;
        }
        // Resolve the configurable discrete actions from their bound buttons.
        vrFrame.controls = {
          zUp: this.buttonDown(this.b.zUp, sources),
          zDown: this.buttonDown(this.b.zDown, sources),
          estop: this.buttonDown(this.b.estop, sources),
        };
        const res = this.mapper.map(vrFrame);
        // null = nothing engaged this frame -> hand the stream back to the keyboard.
        this.o.teleop.setExternalJog(res.jog);
        if (res.estop) {
          this.o.teleop.command("estop");
          this.mapper.reclutch();
          this.o.onLog("E-STOP — re-squeeze grip to resume");
        }
        this.handleResetHold(this.buttonDown(this.b.reset, sources));
        this.applyHaptics(session);
      }
    }
    renderer.render(scene, camera);
  }

  // Is the button referenced by `ref` currently pressed on its controller?
  private buttonDown(ref: VrButtonRef | undefined, sources: XRInputSource[]): boolean {
    if (!ref) return false;
    for (const s of sources) {
      if (s.handedness === ref.hand && s.gamepad) {
        return s.gamepad.buttons[ref.index]?.pressed ?? false;
      }
    }
    return false;
  }

  private sampleController(
    src: XRInputSource,
    frame: XRFrame,
    refSpace: XRReferenceSpace
  ): VrControllerFrame {
    const gp = src.gamepad!;
    const hand = src.handedness as Hand;
    let position: [number, number, number] | null = null;
    let flex: number | null = null;
    let roll: number | null = null;
    const space = src.gripSpace ?? src.targetRaySpace; // reference falls back to the ray space
    if (space) {
      const pose = frame.getPose(space, refSpace);
      if (pose) {
        const p = pose.transform.position;
        position = [p.x, p.y, p.z];
        const a = controllerAngles(pose.transform.orientation);
        flex = a.flex;
        roll = a.roll;
      }
    }
    const val = (i: number) => gp.buttons[i]?.value ?? 0;
    return {
      position,
      wristFlexDeg: flex,
      wristRollDeg: roll,
      trigger: val(this.b.gripper[hand]), // gripper trigger (grip is the clutch, kept separate)
      squeeze: val(this.b.clutch[hand]),  // clutch (squeeze to move)
      // Touch controllers report the stick on axes[2]/[3]; fall back to [0]/[1] like the reference.
      thumbstick: { x: gp.axes[2] ?? gp.axes[0] ?? 0, y: gp.axes[3] ?? gp.axes[1] ?? 0 },
    };
  }

  // Reset latch = hold the bound reset button for RESET_HOLD_MS. R13: the operator is
  // in-headset watching live video, satisfying the "see the scene before clearing" gate.
  private handleResetHold(held: boolean) {
    if (!held) { this.resetHeldSince = 0; this.resetFired = false; return; }
    const now = performance.now();
    if (this.resetHeldSince === 0) this.resetHeldSince = now;
    if (!this.resetFired && now - this.resetHeldSince >= RESET_HOLD_MS) {
      this.resetFired = true;
      this.o.teleop.command("reset_latch");
      this.mapper.reclutch();
      this.o.onLog("reset_latch (held) — re-squeeze grip to resume");
    }
  }

  // gripper current (virtual tactile signal) -> that hand's controller rumble.
  private applyHaptics(session: XRSession) {
    for (const src of session.inputSources) {
      if (!src.gamepad || !src.handedness) continue;
      const key = src.handedness === "left" ? "left_arm_gripper" : "right_arm_gripper";
      const cur = Math.abs(this.currents[key] ?? 0);
      const intensity = THREE.MathUtils.clamp(
        (cur - HAPTIC_IDLE) / (HAPTIC_FULL - HAPTIC_IDLE), 0, 1
      );
      if (intensity <= 0.02) continue;
      const act = (src.gamepad as Gamepad & { hapticActuators?: GamepadHapticActuator[] })
        .hapticActuators?.[0] as (GamepadHapticActuator & { pulse?: (v: number, ms: number) => void }) | undefined;
      act?.pulse?.(intensity, 60);
    }
  }
}
