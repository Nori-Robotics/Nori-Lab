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
//   each hand:  B/Y = that arm's lift UP            A/X = that arm's lift DOWN
//   right only: thumbstick = base drive             thumbstick-press (hold 1.5s) = reset latch
//   left only:  thumbstick-press = E-STOP (latches + re-clutch) (R13: the operator is
//               in-headset seeing live video, satisfying the confirmation gate)
//   Recenter (move the panel cluster to the operator's current facing) = an IN-VR "Recenter"
//               button that floats above the LEFT controller and is activated by POKING it
//               with the right controller. It's hand-anchored so it's always reachable even
//               after the operator turns around; poke (not ray+trigger) because both triggers
//               are already the grippers. -> VrSession.recenter().

import * as THREE from "three";
import { VrJogMapper, resolveTuning, type VrControllerFrame, type VrFrame, type VrTuning } from "./vr";
import { buildRobotModel, type ArmHighlight, type RobotModel } from "./robot-model";
import type { RemoteTeleop, TelemetryView } from "./teleop";

const RESET_HOLD_MS = 1500;
// Recenter is triggered by an in-VR button anchored above the LEFT controller, poked with
// the right controller — see the recenter-button fields + updateRecenterButton() below.
const PANEL_DIST = 2.0; // metres in front of the operator the panel cluster sits (recenter)
// Uniform shrink applied to the whole in-VR UI (video + HUD panel cluster + recenter button).
// 0.8 = 80% of the original size; distance/anchoring are unchanged, panels just read smaller.
const UI_SCALE = 0.8;
// The 3D robot schematic (C6), mounted to the RIGHT of the telemetry HUD so the instruments
// read left-to-right: video | telemetry | robot. Unlike the video/HUD panels this is NOT a
// textured plane — it's the real articulated model in the scene, so it has genuine stereo
// depth: lean or step sideways and you see around it.
//   X — HUD spans 0.85..1.35 (0.5 wide at x=1.10); this sits just outboard of it. (Both
//       pulled inboard 2026-07-16 with the HUD shrink, so the whole cluster reads narrower.)
//   Y — the model stands on y=0 and is ~1.5 units tall centred ~1.08, so scaling by
//       ROBOT_SCALE and dropping it by ROBOT_Y centres it vertically on the panel row.
//   Z — pushed toward the operator, OFF the panel plane, so it reads as a hologram in front
//       of the instruments rather than a sticker on them (+Z is toward the viewer after
//       recenter — see serviceRecenter).
//   YAW — the model faces +Z (at the operator); this yaws it to the same 3/4 view the desktop
//       card frames, so you see the front and one flank instead of a flat head-on silhouette.
const ROBOT_X = 1.55;
const ROBOT_Y = -0.96;
const ROBOT_Z = 0.35;
const ROBOT_SCALE = 0.7;
const ROBOT_YAW = -0.6;
// Turntable spin: the LEFT thumbstick's X axis yaws the 3D robot so the operator can look at a
// pose from any side. That stick's axes are the only unbound input left on either controller
// (its PRESS is E-STOP, but the axes were unused; the base drive is on the RIGHT stick), which
// is why it wins over a point-and-grab: grip/trigger/A-X/B-Y are all bound to real robot motion,
// so "grab" would have to borrow a button that commands the arm. Push right = the robot's front
// swings right, like spinning a turntable. Rate is per-SECOND (scaled by real frame dt) so the
// feel doesn't change between a 72 Hz and a 90 Hz headset.
const ROBOT_SPIN_DEADZONE = 0.15; // ignore stick slop / resting thumb
const ROBOT_SPIN_RATE = 2.2; // rad/s at full deflection (~2.9 s for a full turn)
// The same stick's Y axis pushes/pulls the whole UI cluster (video + HUD + 3D robot) along
// the head→panels line — stick up = further away, down = closer (matches the right stick's
// up-is-forward). Complements recenter, which re-AIMS the cluster; the chosen distance
// survives recenter (serviceRecenter reads panelDist).
const PANEL_DIST_RATE = 1.2; // m/s at full deflection
const PANEL_DIST_MIN = 0.9;  // never pulled into the operator's face
const PANEL_DIST_MAX = 4.0;
// Controls cheat-sheet: a card anchored to the left controller, revealed by GLANCING at it —
// rotate your wrist so the controller's face turns toward you, like checking a watch. Hidden the
// rest of the time, so it costs no screen space during teleop and spends no button.
//
// The test is the dot product of the controller's local UP axis with the direction from the
// controller to the head: hand held out to drive -> up axis points at the ceiling, dot ~0;
// wrist rolled toward your face -> up axis swings toward you, dot -> 1. SHOW/HIDE differ
// (hysteresis) so a hand hovering exactly at the threshold can't strobe the card.
const CARD_UP = 0.17; // metres above the left controller — clear of the Recenter button (0.06)
const CARD_W = 0.19;
const CARD_H = 0.152; // 1.25 aspect, matches the 640x512 canvas
const CARD_SHOW_DOT = 0.6;
const CARD_HIDE_DOT = 0.45;
const CARD_FADE_PER_S = 8; // opacity units/sec — fades instead of popping
// Recenter poke button geometry (metres). The button floats this far above the left
// controller, and fires when the right controller tip enters POKE_FIRE_R of it; it must
// then leave POKE_REARM_R before it can fire again (hysteresis, no repeat-fire). NEAR_R
// just drives the highlight.
const RC_BTN_UP = 0.06;      // button offset above the left controller — low enough that its
                             // top edge clears the controls card's bottom (card spans
                             // 0.17 ± 0.061 scaled; at 0.09 the two overlapped)
const RC_POKE_FIRE_R = 0.045;
const RC_POKE_REARM_R = 0.08;
const RC_POKE_NEAR_R = 0.11;
// In-VR sensitivity panel — the wrist-glance card's mirror image, on the RIGHT wrist:
// glance at the right controller (its clutch released) and a two-row −/+ panel appears
// above it; poke a zone with the LEFT controller tip to step the value. Hidden while the
// right clutch is engaged, since driving rolls that wrist through the glance pose
// constantly. Changes apply on the next mapped frame and are reported via onTuningChange
// so the page can persist them alongside its sliders.
const TUNE_UP = 0.17;        // metres above the right controller (mirrors CARD_UP)
// Panel sized so its 640x256 canvas lands at ~3200 px/m — the same pixel density as the
// controls card (640 px over 0.19 m), so the two wrist surfaces read at one text size.
// Width is deliberately generous relative to the two rows: it spreads the − / + poke
// zones apart (they were too easy to cross-poke at 0.16 m; 2026-07-16).
const TUNE_W = 0.2;
const TUNE_H = 0.08;         // 2.5:1 aspect, matches the 640x256 canvas
const TUNE_SENS_STEP = 0.25; // one poke, on the web slider's 0.25..2 range
const TUNE_GRIP_STEP = 0.1;  // one poke, on the web slider's 0.05..1 range
// Poke zones in the panel plane's LOCAL metres (x right, y up, origin center):
// row 0 = motion sensitivity, row 1 = gripper-open rate; dir = which way the poke steps.
const TUNE_ZONES = [
  { x: -(TUNE_W / 2 - 0.03), y: TUNE_H / 4, row: 0, dir: -1 },
  { x: TUNE_W / 2 - 0.03, y: TUNE_H / 4, row: 0, dir: 1 },
  { x: -(TUNE_W / 2 - 0.03), y: -TUNE_H / 4, row: 1, dir: -1 },
  { x: TUNE_W / 2 - 0.03, y: -TUNE_H / 4, row: 1, dir: 1 },
];
// gripper Present_Current -> rumble. Raw sign-magnitude ints; tune on hardware.
// Tuned stronger 2026-07-02 (was hard to feel): lower the contact threshold, reach full
// rumble much sooner, and floor any real contact at HAPTIC_MIN so light grips still register.
// Haptics thresholds are DELTAS above a per-arm adaptive baseline, not absolute currents:
// the two gripper motors idle at different holding currents (one arm buzzed constantly at
// any fixed threshold that felt right on the other; 2026-07-02). The baseline tracks each
// gripper's idle draw — snaps down instantly, creeps up slowly — so "contact" means current
// above THAT arm's own idle.
const HAPTIC_IDLE = 50;   // delta above baseline = no contact below this, no buzz
const HAPTIC_FULL = 250;  // delta at/above this = full-strength rumble
const HAPTIC_MIN = 0.3;   // any contact above idle buzzes at least this hard (0.45 slammed
                          // on too hard right at the threshold)
const HAPTIC_BASE_RISE = 3; // baseline upward creep (units/s): slow enough that a real grip
                            // (deltas of hundreds) keeps buzzing for minutes, fast enough to
                            // absorb idle-current drift
const HAPTIC_PULSE_MS = 100; // longer pulse per frame -> a more solid, continuous buzz (was 60)
const CURRENT_FULL = 600; // Present_Current mapped to a full HUD bar (matches TeleopStatus)
const TEL_STALE_MS = 1500; // no telemetry for this long -> HUD control row reads "disconnected"
const HUD_REDRAW_MS = 250;  // repaint cadence so staleness updates even without new frames

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
// OWN arm's lift (left Y/X = left lift up/down; right B/A = right lift up/down — the UPPER
// face button raises, the LOWER one lowers, matching the physical layout). E-STOP and
// reset moved onto the thumbstick PRESS (index 3) to free the face buttons for the lifts:
// left stick-press = E-STOP; right stick-press (hold 1.5s) = reset.
export const DEFAULT_BINDINGS: VrBindings = {
  clutch: { left: 1, right: 1 },
  gripper: { left: 0, right: 0 },
  leftLiftUp: { hand: "left", index: 5 },    // Y (upper button)
  leftLiftDown: { hand: "left", index: 4 },  // X (lower button)
  rightLiftUp: { hand: "right", index: 5 },  // B (upper button)
  rightLiftDown: { hand: "right", index: 4 }, // A (lower button)
  estop: { hand: "left", index: 3 },   // left thumbstick press
  reset: { hand: "right", index: 3 },  // right thumbstick press (hold)
};

export interface VrSessionOptions {
  teleop: RemoteTeleop;
  videoEl: HTMLVideoElement; // the same element RemoteTeleop attaches the remote stream to
  onLog: (msg: string) => void;
  onEnd: () => void;
  bindings?: VrBindings; // defaults to DEFAULT_BINDINGS
  tuning?: VrTuning; // initial sensitivity settings (live-updatable via setTuning)
  // Fired when the operator changes tuning from INSIDE VR (the right-wrist poke panel),
  // with the full resolved values — the page persists them so its sliders stay in sync.
  onTuningChange?: (t: Required<VrTuning>) => void;
}

// Wrist angles are NOT derived here anymore (2026-07-01). The session forwards the RAW
// grip quaternion; VrJogMapper computes flex/roll the XLeVR-verified way — rotation
// RELATIVE to the clutch-engage origin, rotation-vector components (see vr.ts). The old
// code here replicated quest_vr_bridge.py's world-frame euler, which turned out to be an
// UNVERIFIED reimplementation: its asin term tracks the Y axis, so pointing the controller
// down never registered as wrist flex. The hardware-verified stack is XLeVR
// (XLeRobot/XLeVR vr_ws_server.py extract_pitch/roll_from_quaternion).

export class VrSession {
  private o: VrSessionOptions;
  private readonly b: VrBindings;
  private readonly mapper = new VrJogMapper();
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private texture: THREE.VideoTexture | null = null;
  // The video + HUD panels live in one group so recenter moves them together and later
  // displays (multi-camera feeds, 3D cube view) can be added as more children.
  private panelGroup: THREE.Group | null = null;
  // The C6 robot schematic — a real articulated three.js model (not a texture), re-posed from
  // telemetry every frame. Same builder the desktop card mounts, so the two can't drift.
  private robot: RobotModel | null = null;
  // Operator-controlled turntable yaw of that model (left thumbstick X), radians. Survives
  // recenter: it's relative to the panel group, so re-aiming the cluster doesn't spin the robot.
  private robotYaw = ROBOT_YAW;
  private lastFrameAt = 0; // for the per-second spin rate
  // Operator-chosen distance of the panel cluster (left stick Y). Recenter re-aims the
  // cluster but keeps this distance.
  private panelDist = PANEL_DIST;
  private session: XRSession | null = null;
  private currents: Record<string, number> = {};
  // Per-gripper adaptive idle-current baseline for haptics (see applyHaptics).
  private hapticBase: Record<string, number> = {};
  private lastHapticAt = 0;
  // Telemetry HUD (mirrors the keyboard TelemetryPanel + GripForce): a 2D canvas painted
  // with the same stats, uploaded as a texture on a panel beside the video.
  private tel: TelemetryView | null = null;
  private lastTelAt = 0;
  private motorsOnline = true;
  private hudCanvas: HTMLCanvasElement | null = null;
  private hudCtx: CanvasRenderingContext2D | null = null;
  private hudTexture: THREE.CanvasTexture | null = null;
  private lastHudDraw = 0;
  private resetHeldSince = 0;
  private resetFired = false;
  // Recenter is a one-shot flag set by the in-VR poke button (recenter()) and serviced on
  // the next frame that has a viewer pose.
  private recenterPending = false;
  // In-VR "Recenter" poke button: a small labeled plane anchored above the left controller.
  private rcBtn: THREE.Mesh | null = null;
  private rcBtnCanvas: HTMLCanvasElement | null = null;
  private rcBtnCtx: CanvasRenderingContext2D | null = null;
  private rcBtnTexture: THREE.CanvasTexture | null = null;
  // Wrist-glance controls card (left controller). Static art — painted once; only its opacity
  // changes, so there's no per-frame canvas upload.
  private card: THREE.Mesh | null = null;
  private cardCanvas: HTMLCanvasElement | null = null;
  private cardCtx: CanvasRenderingContext2D | null = null;
  private cardTexture: THREE.CanvasTexture | null = null;
  private cardMat: THREE.MeshBasicMaterial | null = null;
  private cardShown = false; // hysteresis latch: is the glance currently "open"?
  private cardOpacity = 0;
  private rcPoked = false;      // armed-state: true between fire and re-arm (hysteresis)
  private rcBtnHot = false;     // last painted highlight state (redraw only on change)
  // In-VR sensitivity panel (right-wrist glance, see TUNE_* constants). Same
  // canvas-texture-on-a-plane pattern as the controls card; repainted on value/highlight
  // changes only.
  private tuning: Required<VrTuning>;
  private tuneBtn: THREE.Mesh | null = null;
  private tuneCanvas: HTMLCanvasElement | null = null;
  private tuneCtx: CanvasRenderingContext2D | null = null;
  private tuneTexture: THREE.CanvasTexture | null = null;
  private tuneMat: THREE.MeshBasicMaterial | null = null;
  private tuneShown = false;   // glance hysteresis latch (mirrors cardShown)
  private tuneOpacity = 0;
  private tunePoked = false;   // between fire and re-arm (mirrors rcPoked)
  private tuneHotZone = -1;    // highlighted zone index, -1 = none (redraw only on change)
  private running = false;

  constructor(opts: VrSessionOptions) {
    this.o = opts;
    this.b = opts.bindings ?? DEFAULT_BINDINGS;
    this.tuning = resolveTuning(opts.tuning);
    this.mapper.setTuning(this.tuning);
  }

  // Live sensitivity updates while in VR (the page's sliders call this on change).
  setTuning(t: VrTuning) {
    this.tuning = resolveTuning(t);
    this.mapper.setTuning(this.tuning);
    this.drawTunePanel(); // keep the in-VR panel's numbers in sync with the web sliders
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

  // Latest telemetry for the in-VR HUD (the page wires RemoteTeleop.onTelemetry here). Same
  // TelemetryView the keyboard panel renders — so the headset shows the same stats.
  setTelemetry(t: TelemetryView) {
    this.tel = t;
    this.lastTelAt = performance.now();
  }

  // The robot's motor-control health (the page wires RemoteTeleop.onDaemonStatus here). The HUD's
  // "control" row needs it for the same reason the 2D chip does: the command channel can be open
  // and the media bridge healthy while motor control behind them is dead. Default true so a robot
  // that never reports health isn't shown as offline — telemetry staleness still catches that.
  setMotorsOnline(ok: boolean) {
    this.motorsOnline = ok;
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

    // Panel cluster ~2 m ahead at standing eye height. The video panel is intentionally
    // smaller than before (1.6×1.2, was 2.0×1.5) to leave room to the right for the HUD now
    // and multi-camera / 3D-cube panels later. DoubleSide so it stays visible regardless of
    // how recenter orients the group.
    const group = new THREE.Group();
    group.position.set(0, 1.4, -PANEL_DIST);
    group.scale.setScalar(UI_SCALE); // shrink the whole panel cluster together (video + HUD)
    scene.add(group);
    this.panelGroup = group;

    const texture = new THREE.VideoTexture(this.o.videoEl);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.texture = texture;
    const video = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 1.2),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.DoubleSide })
    );
    video.position.set(0, 0, 0);
    group.add(video);

    // Telemetry HUD panel to the right of the video. 0.5x1.0 m — a uniform shrink of the
    // original 0.6x1.2 (same 0.5 aspect as the 512x1024 canvas, so nothing distorts; text
    // reads ~17% smaller) to keep the whole 2D cluster narrower. A 2D canvas painted with
    // the keyboard stats + grip-force bars, uploaded as a CanvasTexture.
    const hudCanvas = document.createElement("canvas");
    hudCanvas.width = 512;
    hudCanvas.height = 1024; // 0.5 aspect -> matches a 0.6×1.2 panel
    this.hudCanvas = hudCanvas;
    this.hudCtx = hudCanvas.getContext("2d");
    const hudTexture = new THREE.CanvasTexture(hudCanvas);
    hudTexture.colorSpace = THREE.SRGBColorSpace;
    this.hudTexture = hudTexture;
    const hud = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 1.0),
      new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true, side: THREE.DoubleSide })
    );
    hud.position.set(1.1, 0, 0); // right of the 1.6 m video panel, small gap
    group.add(hud);
    this.drawHud(); // paint once so it's not blank before the first telemetry frame

    // The 3D robot schematic, right of the HUD. A genuine articulated model in the scene —
    // stereo depth, parallax, walk-around — not a 2D viewport rendered to a texture. Its grid
    // is off: a 3-unit floor plane looks right in the desktop card but would punch through the
    // panel cluster here. Lit by the directional light added below (the hemisphere light alone
    // renders the MeshStandardMaterial links flat and shapeless).
    const robot = buildRobotModel({ showGrid: false });
    robot.root.position.set(ROBOT_X, ROBOT_Y, ROBOT_Z);
    robot.root.rotation.set(0, ROBOT_YAW, 0);
    robot.root.scale.setScalar(ROBOT_SCALE);
    group.add(robot.root);
    this.robot = robot;
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(2, 4, 3); // same key as the desktop card, so the model shades alike
    scene.add(keyLight);

    // In-VR "Recenter" poke button — a small labeled plane added straight to the SCENE (not
    // the panel group): it's hand-anchored (repositioned each frame above the left controller)
    // so it stays reachable no matter where the operator turns. depthTest off + a high render
    // order so it's never occluded by the panels.
    const rcCanvas = document.createElement("canvas");
    rcCanvas.width = 256;
    rcCanvas.height = 128;
    this.rcBtnCanvas = rcCanvas;
    this.rcBtnCtx = rcCanvas.getContext("2d");
    const rcTex = new THREE.CanvasTexture(rcCanvas);
    rcTex.colorSpace = THREE.SRGBColorSpace;
    this.rcBtnTexture = rcTex;
    const rcBtn = new THREE.Mesh(
      new THREE.PlaneGeometry(0.1, 0.05),
      new THREE.MeshBasicMaterial({
        map: rcTex, transparent: true, side: THREE.DoubleSide, depthTest: false,
      })
    );
    rcBtn.renderOrder = 999;
    rcBtn.visible = false; // shown once the left controller is tracked
    rcBtn.scale.setScalar(UI_SCALE); // match the rest of the UI (billboarding preserves scale)
    scene.add(rcBtn);
    this.rcBtn = rcBtn;
    this.drawRecenterButton(false);

    // Controls cheat-sheet, hand-anchored like the Recenter button (same reason: it has to stay
    // reachable/readable wherever the operator turns) but revealed only on a wrist glance. Starts
    // fully transparent — updateControlsCard() fades it in.
    const cardCanvas = document.createElement("canvas");
    cardCanvas.width = 640;
    cardCanvas.height = 512;
    this.cardCanvas = cardCanvas;
    this.cardCtx = cardCanvas.getContext("2d");
    const cardTex = new THREE.CanvasTexture(cardCanvas);
    cardTex.colorSpace = THREE.SRGBColorSpace;
    this.cardTexture = cardTex;
    const cardMat = new THREE.MeshBasicMaterial({
      map: cardTex, transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: false,
    });
    this.cardMat = cardMat;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), cardMat);
    card.renderOrder = 998; // above the panels, just under the Recenter button
    card.visible = false;
    card.scale.setScalar(UI_SCALE);
    scene.add(card);
    this.card = card;
    this.drawControlsCard(); // static content — painted once, never repainted

    // Sensitivity tuning panel — the card's right-wrist mirror (see TUNE_* constants).
    const tuneCanvas = document.createElement("canvas");
    tuneCanvas.width = 640;
    tuneCanvas.height = 256;
    this.tuneCanvas = tuneCanvas;
    this.tuneCtx = tuneCanvas.getContext("2d");
    const tuneTex = new THREE.CanvasTexture(tuneCanvas);
    tuneTex.colorSpace = THREE.SRGBColorSpace;
    this.tuneTexture = tuneTex;
    const tuneMat = new THREE.MeshBasicMaterial({
      map: tuneTex, transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: false,
    });
    this.tuneMat = tuneMat;
    const tuneBtn = new THREE.Mesh(new THREE.PlaneGeometry(TUNE_W, TUNE_H), tuneMat);
    tuneBtn.renderOrder = 998; // same layer as the controls card
    tuneBtn.visible = false;
    tuneBtn.scale.setScalar(UI_SCALE);
    scene.add(tuneBtn);
    this.tuneBtn = tuneBtn;
    this.drawTunePanel();

    const session = await xr.requestSession(mode, {
      optionalFeatures: ["local-floor", "bounded-floor"],
    });
    this.session = session;
    session.addEventListener("end", () => this.handleEnd());
    await renderer.xr.setSession(session);

    this.running = true;
    // Auto-recenter on the first frame with a viewer pose: the panel spawn pose assumes the
    // operator faces the reference space's forward, which is only sometimes true. This makes
    // session start and mid-session recenter the same path — panel AND control frame align
    // with wherever the operator is actually facing when the session begins.
    this.recenterPending = true;
    this.o.onLog(
      `${mode === "immersive-ar" ? "AR (passthrough)" : "VR"} session started — ` +
        "grip to engage clutch, B/Y & A/X = that arm's lift up/down, "
          + "right stick = drive the base, left stick = spin the 3D robot (↔) "
          + "/ move the UI closer-further (↕), "
          + "left stick-press = E-STOP, hold right stick-press = reset, "
          + "poke the Recenter button above your left hand to recenter the view, "
          + "glance at your right wrist for sensitivity tuning"
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
    this.hudTexture?.dispose();
    this.rcBtnTexture?.dispose();
    this.cardTexture?.dispose();
    this.tuneTexture?.dispose();
    this.robot?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.texture = null;
    this.panelGroup = null;
    this.robot = null;
    this.robotYaw = ROBOT_YAW; // next session starts from the default 3/4 view
    this.panelDist = PANEL_DIST; // and from the default cluster distance
    this.lastFrameAt = 0;
    this.hudTexture = null;
    this.hudCanvas = null;
    this.hudCtx = null;
    this.rcBtn = null;
    this.rcBtnTexture = null;
    this.rcBtnCanvas = null;
    this.rcBtnCtx = null;
    this.card = null;
    this.cardCanvas = null;
    this.cardCtx = null;
    this.cardTexture = null;
    this.cardMat = null;
    this.cardShown = false;
    this.cardOpacity = 0;
    this.rcPoked = false;
    this.rcBtnHot = false;
    this.tuneBtn = null;
    this.tuneCanvas = null;
    this.tuneCtx = null;
    this.tuneTexture = null;
    this.tuneMat = null;
    this.tuneShown = false;
    this.tuneOpacity = 0;
    this.tunePoked = false;
    this.tuneHotZone = -1;
    this.tel = null;
    this.motorsOnline = true;
    this.session = null;
    this.o.onLog("VR session ended");
    this.o.onEnd();
  }

  private onXRFrame(frame: XRFrame | undefined) {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return;

    // Seconds since the previous XR frame. Clamped so a hitch (or the headset being taken off
    // and put back on) can't integrate one enormous step and fling the robot's spin.
    const nowMs = performance.now();
    const dt = this.lastFrameAt ? Math.min(0.1, (nowMs - this.lastFrameAt) / 1000) : 0;
    this.lastFrameAt = nowMs;

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
        // Left stick X spins the 3D robot (see ROBOT_SPIN_RATE). Read straight off the sampled
        // frame — the mapper never consumes this axis, so it drives nothing on the real robot.
        const spinX = vrFrame.left?.thumbstick.x ?? 0;
        if (Math.abs(spinX) > ROBOT_SPIN_DEADZONE) {
          this.robotYaw += spinX * ROBOT_SPIN_RATE * dt;
        }
        // Left stick Y pushes/pulls the whole UI cluster (up = away, like the right stick's
        // up-is-forward). Adjusts from the cluster's ACTUAL current distance — not the
        // stored one — so it never snaps if the operator has walked since placing it.
        const distY = vrFrame.left?.thumbstick.y ?? 0;
        if (Math.abs(distY) > ROBOT_SPIN_DEADZONE && this.panelGroup) {
          const head = new THREE.Vector3();
          renderer.xr.getCamera().getWorldPosition(head);
          const dir = this.panelGroup.position.clone().sub(head);
          dir.y = 0;
          if (dir.lengthSq() > 1e-6) {
            const cur = dir.length();
            dir.normalize();
            this.panelDist = Math.min(
              PANEL_DIST_MAX,
              Math.max(PANEL_DIST_MIN, cur - distY * PANEL_DIST_RATE * dt),
            );
            this.panelGroup.position.setX(head.x + dir.x * this.panelDist);
            this.panelGroup.position.setZ(head.z + dir.z * this.panelDist);
          }
        }

        const res = this.mapper.map(vrFrame);
        // null = nothing engaged this frame -> hand the stream back to the keyboard.
        this.o.teleop.setExternalJog(res.jog);
        if (res.estop) {
          this.o.teleop.command("estop");
          this.mapper.reclutch();
          this.o.onLog("E-STOP — re-squeeze grip to resume");
        }
        const resetHeld = this.buttonDown(this.b.reset, sources);
        this.handleResetHold(resetHeld);   // sustained hold of the reset button = reset_latch
        this.updateRecenterButton(vrFrame); // in-VR poke button -> recenter()
        this.updateControlsCard(vrFrame, dt); // wrist-glance controls cheat-sheet
        this.updateTunePanel(vrFrame, dt); // right-wrist glance sensitivity panel
        if (this.recenterPending) this.serviceRecenter(frame, refSpace);
        this.applyHaptics(session);
      }
    }
    // Re-pose the 3D robot EVERY frame (unlike the HUD's slow repaint below): it's live motion,
    // not text, so a 4 Hz cadence would visibly judder. It only writes joint rotations into the
    // existing scene graph — no allocation, no texture upload — so it's cheap enough to run at
    // headset rate. VR is dual-arm, so the green highlight tracks the engaged clutch(es)
    // rather than the keyboard's single "active arm".
    if (this.robot) {
      const eng = this.mapper.engagedArms();
      const highlight: ArmHighlight =
        eng.left && eng.right ? "both" : eng.left ? "left" : eng.right ? "right" : "none";
      this.robot.update(this.tel?.state ?? {}, highlight);
      this.robot.root.rotation.y = this.robotYaw; // operator turntable (left stick X)
    }
    // Repaint the HUD on a slow cadence (keeps staleness/values fresh without redrawing text
    // every 72–90 Hz frame).
    if (performance.now() - this.lastHudDraw > HUD_REDRAW_MS) this.drawHud();
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
    let orientation: [number, number, number, number] | null = null;
    const space = src.gripSpace ?? src.targetRaySpace; // reference falls back to the ray space
    if (space) {
      const pose = frame.getPose(space, refSpace);
      if (pose) {
        const p = pose.transform.position;
        position = [p.x, p.y, p.z];
        const q = pose.transform.orientation;
        orientation = [q.x, q.y, q.z, q.w]; // raw quat; mapper does the XLeVR angle math
      }
    }
    const val = (i: number) => gp.buttons[i]?.value ?? 0;
    return {
      position,
      orientation,
      trigger: val(this.b.gripper[hand]), // gripper trigger (grip is the clutch, kept separate)
      squeeze: val(this.b.clutch[hand]),  // clutch (squeeze to move)
      // Touch controllers report the stick on axes[2]/[3]; fall back to [0]/[1] like the reference.
      thumbstick: { x: gp.axes[2] ?? gp.axes[0] ?? 0, y: gp.axes[3] ?? gp.axes[1] ?? 0 },
    };
  }

  // Recenter on demand — fired by poking the in-VR Recenter button (updateRecenterButton),
  // and public so a caller could bind it too. Serviced on the next frame that has a viewer
  // pose, so it always has a fresh head transform to face the panel to.
  recenter() {
    this.recenterPending = true;
    this.o.onLog("recenter — video panel moving to your current facing");
  }

  // Reposition the panel cluster PANEL_DIST metres in front of where the operator is now
  // facing (horizontal yaw only), at their current eye height, turned to face them. Lets an
  // operator who has physically turned re-orient the robot's view without walking back.
  private serviceRecenter(frame: XRFrame, refSpace: XRReferenceSpace) {
    const group = this.panelGroup;
    if (!group) return;
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
    // panelDist, not the PANEL_DIST constant: recenter re-aims the cluster but keeps the
    // distance the operator chose with the left stick.
    group.position.set(p.x + fwd.x * this.panelDist, p.y, p.z + fwd.z * this.panelDist);
    // Face the operator: rotate the group so its panels' +Z (their front face) points back
    // toward the head, i.e. along -fwd. (yaw only; matches the initial fwd=(0,0,-1) -> yaw 0.)
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    group.rotation.set(0, yaw, 0);
    // The control frame follows the panel: after recenter, hand motion toward the video is
    // robot-forward again, so an operator who turned with the robot keeps an intuitive map.
    this.mapper.setControlYaw(yaw);
  }

  // Anchor the in-VR "Recenter" button above the left controller (so it travels with the
  // operator when they turn), billboard it to face the head, and fire recenter() when the
  // right controller pokes it. Hysteresis (FIRE_R enter -> REARM_R exit) prevents repeats.
  private updateRecenterButton(f: VrFrame) {
    const btn = this.rcBtn;
    const camera = this.camera;
    if (!btn || !camera) return;
    const lp = f.left?.position;
    if (!lp) { btn.visible = false; return; } // left hand not tracked -> hide the button
    const lq = f.left?.orientation;
    // Offset straight up in the left controller's local frame, so it floats above the hand.
    const off = new THREE.Vector3(0, RC_BTN_UP, 0);
    if (lq) off.applyQuaternion(new THREE.Quaternion(lq[0], lq[1], lq[2], lq[3]));
    btn.position.set(lp[0] + off.x, lp[1] + off.y, lp[2] + off.z);
    btn.visible = true;
    // Billboard toward the head so the label always reads (XR camera = head pose).
    const head = new THREE.Vector3();
    this.renderer?.xr.getCamera().getWorldPosition(head);
    btn.lookAt(head);

    // Poke test against the right controller.
    const rp = f.right?.position;
    let hot = false;
    if (rp) {
      const d = Math.hypot(rp[0] - btn.position.x, rp[1] - btn.position.y, rp[2] - btn.position.z);
      hot = d < RC_POKE_NEAR_R;
      if (!this.rcPoked && d < RC_POKE_FIRE_R) {
        this.rcPoked = true;
        this.recenter();
      } else if (this.rcPoked && d > RC_POKE_REARM_R) {
        this.rcPoked = false; // moved away -> ready to fire again
      }
    }
    // Redraw only when the highlight state flips (canvas upload isn't free).
    if (hot !== this.rcBtnHot) { this.rcBtnHot = hot; this.drawRecenterButton(hot); }
  }

  // Anchor + reveal the controls card. Mirrors updateRecenterButton's hand-anchoring, but instead
  // of a poke test it runs the wrist-glance dot product (see CARD_SHOW_DOT).
  private updateControlsCard(f: VrFrame, dt: number) {
    const card = this.card;
    const mat = this.cardMat;
    if (!card || !mat) return;

    const lp = f.left?.position;
    const lq = f.left?.orientation;
    if (!lp) {
      // Left hand not tracked: fade out rather than snapping the card away mid-read.
      this.cardShown = false;
    } else {
      // Float it above the controller in the controller's OWN frame, so it rolls with the wrist.
      const off = new THREE.Vector3(0, CARD_UP, 0);
      const q = lq ? new THREE.Quaternion(lq[0], lq[1], lq[2], lq[3]) : null;
      if (q) off.applyQuaternion(q);
      card.position.set(lp[0] + off.x, lp[1] + off.y, lp[2] + off.z);

      const head = new THREE.Vector3();
      this.renderer?.xr.getCamera().getWorldPosition(head);

      // Glance test: how much does the controller's up axis point at the head?
      if (q) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const toHead = head.clone().sub(card.position).normalize();
        const facing = up.dot(toHead);
        // Hysteresis — open above SHOW, stay open until we drop below HIDE.
        if (!this.cardShown && facing > CARD_SHOW_DOT) this.cardShown = true;
        else if (this.cardShown && facing < CARD_HIDE_DOT) this.cardShown = false;
      }
      card.lookAt(head); // billboard, same as the Recenter button
    }

    // Fade toward the target so the card doesn't pop in and out as the wrist crosses threshold.
    const target = this.cardShown ? 1 : 0;
    const step = CARD_FADE_PER_S * dt;
    this.cardOpacity =
      this.cardOpacity < target
        ? Math.min(target, this.cardOpacity + step)
        : Math.max(target, this.cardOpacity - step);
    mat.opacity = this.cardOpacity;
    card.visible = this.cardOpacity > 0.01; // fully faded -> skip drawing it entirely
  }

  // Anchor + reveal the sensitivity panel above the RIGHT controller (the controls card's
  // mirror image), and step the values when the LEFT controller tip pokes a −/+ zone.
  private updateTunePanel(f: VrFrame, dt: number) {
    const btn = this.tuneBtn;
    const mat = this.tuneMat;
    if (!btn || !mat) return;

    const rp = f.right?.position;
    const rq = f.right?.orientation;
    if (!rp) {
      this.tuneShown = false; // right hand not tracked: fade out (mirrors the card)
    } else {
      const off = new THREE.Vector3(0, TUNE_UP, 0);
      const q = rq ? new THREE.Quaternion(rq[0], rq[1], rq[2], rq[3]) : null;
      if (q) off.applyQuaternion(q);
      btn.position.set(rp[0] + off.x, rp[1] + off.y, rp[2] + off.z);

      const head = new THREE.Vector3();
      this.renderer?.xr.getCamera().getWorldPosition(head);

      // Same glance test as the controls card, on the other wrist — but never while the
      // right clutch is engaged: driving rolls that wrist straight through the glance pose.
      if (this.mapper.engagedArms().right) {
        this.tuneShown = false;
      } else if (q) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const toHead = head.clone().sub(btn.position).normalize();
        const facing = up.dot(toHead);
        if (!this.tuneShown && facing > CARD_SHOW_DOT) this.tuneShown = true;
        else if (this.tuneShown && facing < CARD_HIDE_DOT) this.tuneShown = false;
      }
      btn.lookAt(head); // billboard, same as the other hand-anchored UI
    }

    // Fade like the controls card so it never pops.
    const target = this.tuneShown ? 1 : 0;
    const step = CARD_FADE_PER_S * dt;
    this.tuneOpacity =
      this.tuneOpacity < target
        ? Math.min(target, this.tuneOpacity + step)
        : Math.max(target, this.tuneOpacity - step);
    mat.opacity = this.tuneOpacity;
    btn.visible = this.tuneOpacity > 0.01;

    // Poke test only while the panel is (nearly) fully shown — no blind fires mid-fade.
    let hot = -1;
    const lp = f.left?.position;
    if (btn.visible && this.tuneOpacity > 0.8 && lp) {
      btn.updateMatrixWorld();
      const tip = new THREE.Vector3(lp[0], lp[1], lp[2]);
      let best = -1;
      let bestD = Infinity;
      TUNE_ZONES.forEach((z, i) => {
        const d = tip.distanceTo(btn.localToWorld(new THREE.Vector3(z.x, z.y, 0)));
        if (d < bestD) { bestD = d; best = i; }
      });
      if (bestD < RC_POKE_NEAR_R) hot = best;
      // Same fire/re-arm hysteresis as the Recenter button, against the NEAREST zone only.
      if (!this.tunePoked && bestD < RC_POKE_FIRE_R) {
        this.tunePoked = true;
        this.applyTuneStep(best);
      } else if (this.tunePoked && bestD > RC_POKE_REARM_R) {
        this.tunePoked = false;
      }
    }
    if (hot !== this.tuneHotZone) { this.tuneHotZone = hot; this.drawTunePanel(); }
  }

  // One poke on zone `i`: step that row's value, clamp to the web sliders' ranges, apply
  // to the mapper, and tell the page so it persists (keeps the 2D sliders in sync too).
  private applyTuneStep(i: number) {
    const z = TUNE_ZONES[i];
    if (!z) return;
    const t = { ...this.tuning };
    if (z.row === 0) {
      t.sensitivity = Math.min(2, Math.max(0.25, t.sensitivity + z.dir * TUNE_SENS_STEP));
    } else {
      t.gripperOpenRate = Math.min(1, Math.max(0.05, t.gripperOpenRate + z.dir * TUNE_GRIP_STEP));
    }
    // Kill float-step residue (0.35000000000000003) before it reaches the UI/persistence.
    t.sensitivity = Math.round(t.sensitivity * 100) / 100;
    t.gripperOpenRate = Math.round(t.gripperOpenRate * 100) / 100;
    this.tuning = resolveTuning(t);
    this.mapper.setTuning(this.tuning);
    this.drawTunePanel();
    this.o.onLog(
      `tuning: motion ${Math.round(this.tuning.sensitivity * 100)}% · ` +
        `grip open ${Math.round(this.tuning.gripperOpenRate * 100)}%`
    );
    this.o.onTuningChange?.(this.tuning);
  }

  // Paint the sensitivity panel: two rows (motion / grip open), each a − and + zone with
  // the current value between them. Zone canvas positions derive from TUNE_ZONES so the
  // hit-test and the artwork can't drift apart.
  private drawTunePanel() {
    const ctx = this.tuneCtx;
    const cv = this.tuneCanvas;
    if (!ctx || !cv) return;
    const W = cv.width, H = cv.height;
    // plane-local metres -> canvas px (canvas y grows downward)
    const px = (x: number) => (0.5 + x / TUNE_W) * W;
    const py = (y: number) => (0.5 - y / TUNE_H) * H;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "rgba(15,23,42,0.92)";
    this.roundRect(ctx, 4, 4, W - 8, H - 8, 26);
    ctx.fill();
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 4;
    this.roundRect(ctx, 4, 4, W - 8, H - 8, 26);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const rows: [string, number][] = [
      ["motion", this.tuning.sensitivity],
      ["grip open", this.tuning.gripperOpenRate],
    ];
    // Font sizes track the controls card's 28-30px range — at this panel's matched pixel
    // density that's the same physical text size on both wrists.
    TUNE_ZONES.forEach((z, i) => {
      const hot = i === this.tuneHotZone;
      ctx.fillStyle = hot ? "rgba(34,197,94,0.92)" : "rgba(51,65,85,0.95)";
      ctx.beginPath();
      ctx.arc(px(z.x), py(z.y), 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f1f5f9";
      ctx.font = "bold 40px system-ui, sans-serif";
      ctx.fillText(z.dir > 0 ? "+" : "−", px(z.x), py(z.y) + 2);
    });
    rows.forEach(([label, value], row) => {
      const y = py(row === 0 ? TUNE_H / 4 : -TUNE_H / 4);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "bold 24px system-ui, sans-serif";
      ctx.fillText(label.toUpperCase(), W / 2, y - 22);
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "bold 32px system-ui, sans-serif";
      ctx.fillText(`${Math.round(value * 100)}%`, W / 2, y + 14);
    });
    ctx.textAlign = "start"; // restore shared-ctx defaults, same as drawRecenterButton
    if (this.tuneTexture) this.tuneTexture.needsUpdate = true;
  }

  // Paint the controls cheat-sheet. Static — called once at session start. Keep the rows in sync
  // with DEFAULT_BINDINGS above and with the session-start log line.
  private drawControlsCard() {
    const ctx = this.cardCtx;
    const cv = this.cardCanvas;
    if (!ctx || !cv) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "rgba(15,23,42,0.92)";
    this.roundRect(ctx, 4, 4, W - 8, H - 8, 26);
    ctx.fill();
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 4;
    this.roundRect(ctx, 4, 4, W - 8, H - 8, 26);
    ctx.stroke();

    ctx.textBaseline = "middle";
    ctx.textAlign = "start";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 30px system-ui, sans-serif";
    ctx.fillText("CONTROLS", 36, 52);

    const rows: [string, string][] = [
      ["grip", "hold = clutch (move arm)"],
      ["trigger", "that arm's gripper"],
      ["B/Y · A/X", "that arm's lift up / down"],
      ["right stick", "drive the base"],
      ["left stick ↔", "spin the 3D robot"],
      ["left stick ↕", "UI closer / further"],
      ["left press", "E-STOP"],
      ["right press", "hold = reset"],
      ["poke ⟳", "recenter the view"],
    ];
    // 44 px pitch (was 48) so the ninth row still fits the 512-high canvas.
    let y = 108;
    for (const [key, what] of rows) {
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.fillText(key, 36, y);
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "28px system-ui, sans-serif";
      ctx.fillText(what, 250, y);
      y += 44;
    }
    if (this.cardTexture) this.cardTexture.needsUpdate = true;
  }

  // Paint the Recenter button canvas. `hot` = right controller is near / poking -> highlight.
  private drawRecenterButton(hot: boolean) {
    const ctx = this.rcBtnCtx;
    const cv = this.rcBtnCanvas;
    if (!ctx || !cv) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = hot ? "rgba(34,197,94,0.92)" : "rgba(30,41,59,0.88)"; // green when hot
    this.roundRect(ctx, 4, 4, W - 8, H - 8, 22);
    ctx.fill();
    ctx.strokeStyle = hot ? "#bbf7d0" : "#64748b";
    ctx.lineWidth = 4;
    this.roundRect(ctx, 4, 4, W - 8, H - 8, 22);
    ctx.stroke();
    ctx.fillStyle = "#f1f5f9";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 44px system-ui, sans-serif";
    ctx.fillText("⟳ Recenter", W / 2, H / 2 + 2);
    ctx.textAlign = "start"; // restore (shared 2D ctx defaults elsewhere assume left align)
    if (this.rcBtnTexture) this.rcBtnTexture.needsUpdate = true;
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

  // Paint the telemetry HUD canvas (same stats as the keyboard TelemetryPanel + GripForce)
  // and flag its texture for re-upload. Cheap 2D canvas draw, throttled to HUD_REDRAW_MS.
  private drawHud() {
    const ctx = this.hudCtx;
    const cv = this.hudCanvas;
    if (!ctx || !cv) return;
    this.lastHudDraw = performance.now();
    const W = cv.width, H = cv.height;
    const GREEN = "#22c55e", AMBER = "#f59e0b", RED = "#ef4444", FG = "#e5e7eb", DIM = "#9ca3af";

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(16,18,22,0.82)";
    this.roundRect(ctx, 0, 0, W, H, 28);
    ctx.fill();

    const pad = 34;
    let y = pad + 30;
    ctx.textBaseline = "alphabetic";
    ctx.font = "bold 40px system-ui, sans-serif";
    ctx.fillStyle = FG;
    ctx.fillText("TELEMETRY", pad, y);
    y += 20;

    const t = this.tel;
    const stale = !!t?.active && performance.now() - this.lastTelAt > TEL_STALE_MS;

    // One label/value row; value tone-coloured like the 2D panel.
    const row = (label: string, value: string, color = FG) => {
      y += 54;
      ctx.font = "26px system-ui, sans-serif";
      ctx.fillStyle = DIM;
      ctx.fillText(label, pad, y);
      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.fillStyle = color;
      const vw = ctx.measureText(value).width;
      ctx.fillText(value, W - pad - vw, y);
    };

    if (!t) {
      y += 54;
      ctx.font = "28px system-ui, sans-serif";
      ctx.fillStyle = DIM;
      ctx.fillText("waiting for telemetry…", pad, y);
    } else {
      const hzTone = !t.active || stale ? DIM : t.loopHz >= 45 ? GREEN : t.loopHz >= 30 ? AMBER : RED;
      const s = t.safety.toLowerCase();
      const safetyTone = s === "-" || s === "" ? DIM
        : ["ok", "normal", "nominal", "clear"].includes(s) ? GREEN : AMBER;
      const tempTone = t.tempC >= 80 ? RED : t.tempC >= 70 ? AMBER : FG;
      // Same three-signal rule as the 2D chip (TeleopStatus.tsx) — keep them in lockstep.
      const controlOk = t.active && !stale && this.motorsOnline;
      row("control", controlOk ? "connected" : "disconnected", controlOk ? GREEN : RED);
      row("path", t.linkMode ? t.linkMode.toUpperCase() : "—",
        t.linkMode === "lan" ? GREEN : t.linkMode === "wan" ? AMBER : DIM);
      row("loop", `${t.loopHz.toFixed(1)} Hz`, hzTone);
      row("safety", t.safety, safetyTone);
      row("watchdog", t.watchdog, t.watchdog === "-" ? DIM : AMBER);
      row("temp", t.tempC > 0 ? `${t.tempC.toFixed(0)}°C` : "—", tempTone);

      // Grip-force bars (grippers first) — the virtual tactile signal, same source as haptics.
      const currents = t.currents ?? {};
      const keys = Object.keys(currents);
      const grippers = keys.filter((k) => k.includes("gripper")).sort();
      const rest = keys.filter((k) => !k.includes("gripper")).sort();
      const ordered = [...grippers, ...rest];
      if (ordered.length) {
        y += 60;
        ctx.font = "bold 28px system-ui, sans-serif";
        ctx.fillStyle = FG;
        ctx.fillText("GRIP FORCE", pad, y);
        for (const k of ordered) {
          y += 46;
          const mag = Math.abs(currents[k] ?? 0);
          const frac = Math.min(1, mag / CURRENT_FULL);
          ctx.font = "22px system-ui, sans-serif";
          ctx.fillStyle = k.includes("gripper") ? FG : DIM;
          ctx.fillText(this.shortMotor(k), pad, y - 6);
          const barX = pad, barY = y + 4, barW = W - pad * 2, barH = 16;
          ctx.fillStyle = "rgba(255,255,255,0.12)";
          this.roundRect(ctx, barX, barY, barW, barH, 8); ctx.fill();
          ctx.fillStyle = frac >= 0.8 ? RED : frac >= 0.4 ? AMBER : GREEN;
          this.roundRect(ctx, barX, barY, Math.max(2, barW * frac), barH, 8); ctx.fill();
          y += barH;
        }
      }
    }

    if (this.hudTexture) this.hudTexture.needsUpdate = true;
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // "right_arm_gripper" -> "R gripper" (compact HUD label; mirrors TeleopStatus.shortMotor).
  private shortMotor(key: string): string {
    return key
      .replace(/^left_arm_/, "L ").replace(/^right_arm_/, "R ")
      .replace(/^left_/, "L ").replace(/^right_/, "R ")
      .replace(/_/g, " ");
  }

  // gripper current (virtual tactile signal) -> that hand's controller rumble.
  // Contact is measured as current above a PER-ARM adaptive baseline (see HAPTIC_* consts):
  // the baseline snaps down to any lower reading instantly and creeps up at HAPTIC_BASE_RISE,
  // so it settles on each motor's own idle holding current and rides out slow drift, while a
  // real grip (a fast rise of hundreds of units) stays above it for minutes.
  private applyHaptics(session: XRSession) {
    const now = performance.now();
    const dt = this.lastHapticAt ? Math.min((now - this.lastHapticAt) / 1000, 0.25) : 0;
    this.lastHapticAt = now;
    for (const src of session.inputSources) {
      if (!src.gamepad || !src.handedness) continue;
      const key = src.handedness === "left" ? "left_arm_gripper" : "right_arm_gripper";
      const cur = Math.abs(this.currents[key] ?? 0);
      const prev = this.hapticBase[key];
      if (prev === undefined) { this.hapticBase[key] = cur; continue; } // first reading = idle
      const base = cur < prev ? cur : Math.min(cur, prev + HAPTIC_BASE_RISE * dt);
      this.hapticBase[key] = base;
      // No contact -> silent. Any contact above idle -> at least HAPTIC_MIN so it's felt,
      // ramping to full by HAPTIC_FULL.
      const contact = cur - base;
      if (contact <= HAPTIC_IDLE) continue;
      const frac = THREE.MathUtils.clamp(
        (contact - HAPTIC_IDLE) / (HAPTIC_FULL - HAPTIC_IDLE), 0, 1
      );
      const intensity = HAPTIC_MIN + (1 - HAPTIC_MIN) * frac;
      const act = (src.gamepad as Gamepad & { hapticActuators?: GamepadHapticActuator[] })
        .hapticActuators?.[0] as (GamepadHapticActuator & { pulse?: (v: number, ms: number) => void }) | undefined;
      act?.pulse?.(intensity, HAPTIC_PULSE_MS);
    }
  }
}
