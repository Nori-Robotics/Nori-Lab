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
//   each hand:  A/X = that arm's lift UP            B/Y = that arm's lift DOWN
//   right only: thumbstick = base drive             thumbstick-press (hold 1.5s) = reset latch
//               thumbstick-press (double-tap)        = recenter (video panel -> current facing)
//   left only:  thumbstick-press = E-STOP (latches + re-clutch) (R13: the operator is
//               in-headset seeing live video, satisfying the confirmation gate)

import * as THREE from "three";
import { VrJogMapper, type VrControllerFrame, type VrFrame } from "./vr";
import type { RemoteTeleop } from "./teleop";

const RESET_HOLD_MS = 1500;
// Recenter = a quick DOUBLE-TAP of the reset button (right thumbstick press). It's cleanly
// separable from the hold-to-reset gesture on the same button: a hold is one long press
// (recenter never sees a second edge); a double-tap is two short presses (reset's hold timer
// never elapses). Costs no extra button in an already-full binding map.
const RECENTER_DBLTAP_MS = 400;
const PANEL_DIST = 2.0; // metres in front of the operator the video panel sits after recenter
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
  leftLiftUp?: VrButtonRef;
  leftLiftDown?: VrButtonRef;
  rightLiftUp?: VrButtonRef;
  rightLiftDown?: VrButtonRef;
  estop?: VrButtonRef;
  reset?: VrButtonRef; // hold this for RESET_HOLD_MS
}

// Dual-arm default: grip=clutch, trigger=gripper. Each controller's face buttons drive its
// OWN arm's lift (left X/Y = left lift up/down; right A/B = right lift up/down). E-STOP and
// reset moved onto the thumbstick PRESS (index 3) to free the face buttons for the lifts:
// left stick-press = E-STOP; right stick-press (hold 1.5s) = reset.
export const DEFAULT_BINDINGS: VrBindings = {
  clutch: { left: 1, right: 1 },
  gripper: { left: 0, right: 0 },
  leftLiftUp: { hand: "left", index: 4 },    // X
  leftLiftDown: { hand: "left", index: 5 },  // Y
  rightLiftUp: { hand: "right", index: 4 },  // A
  rightLiftDown: { hand: "right", index: 5 }, // B
  estop: { hand: "left", index: 3 },   // left thumbstick press
  reset: { hand: "right", index: 3 },  // right thumbstick press (hold)
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
  private panel: THREE.Mesh | null = null;
  private session: XRSession | null = null;
  private currents: Record<string, number> = {};
  private resetHeldSince = 0;
  private resetFired = false;
  // Recenter gesture state: edge + last-tap timestamp for the double-tap detector, and a
  // one-shot flag serviced on the next frame that has a viewer pose.
  private resetPrev = false;
  private lastResetTapAt = 0;
  private recenterPending = false;
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
    panel.position.set(0, 1.4, -PANEL_DIST);
    scene.add(panel);
    this.panel = panel;

    const session = await xr.requestSession(mode, {
      optionalFeatures: ["local-floor", "bounded-floor"],
    });
    this.session = session;
    session.addEventListener("end", () => this.handleEnd());
    await renderer.xr.setSession(session);

    this.running = true;
    this.o.onLog(
      `${mode === "immersive-ar" ? "AR (passthrough)" : "VR"} session started — ` +
        "grip to engage clutch, A/X & B/Y = that arm's lift up/down, "
          + "left stick-press = E-STOP, hold right stick-press = reset, "
          + "double-tap right stick-press = recenter"
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
    this.panel = null;
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
          leftLiftUp: this.buttonDown(this.b.leftLiftUp, sources),
          leftLiftDown: this.buttonDown(this.b.leftLiftDown, sources),
          rightLiftUp: this.buttonDown(this.b.rightLiftUp, sources),
          rightLiftDown: this.buttonDown(this.b.rightLiftDown, sources),
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
        const resetHeld = this.buttonDown(this.b.reset, sources);
        this.detectRecenterTap(resetHeld); // double-tap of the same button = recenter
        this.handleResetHold(resetHeld);   // sustained hold of it = reset_latch
        if (this.recenterPending) this.serviceRecenter(frame, refSpace);
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

  // Recenter on demand (public so the page could bind it too). Serviced on the next frame
  // that has a viewer pose, so it always has a fresh head transform to face the panel to.
  recenter() {
    this.recenterPending = true;
  }

  // Double-tap detector on the reset button's rising edge. Two rising edges within
  // RECENTER_DBLTAP_MS => recenter. A single press (or a long hold) never triggers it.
  private detectRecenterTap(pressed: boolean) {
    if (pressed && !this.resetPrev) {
      const now = performance.now();
      if (this.lastResetTapAt && now - this.lastResetTapAt < RECENTER_DBLTAP_MS) {
        this.recenter();
        this.lastResetTapAt = 0; // consume so a third tap starts a fresh pair
        this.o.onLog("recenter — video panel moved to your current facing");
      } else {
        this.lastResetTapAt = now;
      }
    }
    this.resetPrev = pressed;
  }

  // Reposition the video panel PANEL_DIST metres in front of where the operator is now
  // facing (horizontal yaw only), at their current eye height, turned to face them. Lets an
  // operator who has physically turned re-orient the robot's view without walking back.
  private serviceRecenter(frame: XRFrame, refSpace: XRReferenceSpace) {
    const panel = this.panel;
    if (!panel) return;
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return; // no head pose this frame — retry next frame (flag stays set)
    this.recenterPending = false;
    const p = pose.transform.position;
    const q = pose.transform.orientation;
    // forward = head orientation applied to -Z, flattened to the horizontal plane.
    const fwd = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); // looking straight up/down -> keep prior facing
    fwd.normalize();
    panel.position.set(p.x + fwd.x * PANEL_DIST, p.y, p.z + fwd.z * PANEL_DIST);
    panel.lookAt(p.x, p.y, p.z); // face the operator (same height keeps it vertical)
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
