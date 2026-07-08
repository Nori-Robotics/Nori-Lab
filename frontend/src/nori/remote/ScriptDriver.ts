// NORI: Additive file. Tier-1 script executor (docs/llm_integration_plan.md, Phase A).
//
// ScriptDriver is the ONLY thing that touches the live RemoteTeleop on behalf of a pasted /
// LLM-generated script. The script itself runs in a Web Worker (scriptWorker.ts) with no reach
// to the RTCDataChannel; the worker posts `{op,args}` and this main-thread driver translates
// each op into the daemon's exact jog vocabulary (`ExternalJog`). That structural split is what
// enforces "SDK-or-nothing": the worker cannot move the robot except through an op this driver
// validates. It is the jog-based sibling of LeaderDriver (which feeds setLeaderAction) — same
// lifecycle idioms: options-object ctor, self-serial op queue, idempotent stop() that releases
// to null.
//
// Heartbeat (G4) is free: RemoteTeleop's own 50 Hz setInterval re-ships `this.externalJog`
// verbatim every 20 ms, so we never run our own send loop — we just set the *current* jog. We
// hold `{}` (a defined zero jog) between ops rather than `null` so the daemon watchdog
// (t_stop_ms) never trips mid-script; `null` is reserved for stop() to hand control back to the
// keyboard. Motion completion is OPEN-LOOP timing until protocol G1 (action-completion) lands —
// a jog is held for `ms` then zeroed; the driver cannot yet tell arrived / stalled / clamped
// apart. Say so in the UI.

import type { RemoteTeleop, ExternalJog, ArmSide, TelemetryView } from "@nori/sdk";
import { TASK_KEYS, JOINT_KEYS, BASE_KEYS } from "@nori/sdk";
import { playAudioUrl, type ClipHandle } from "./audioClip";

// The real DOF vocabulary, derived from the SDK's exported keybind maps so it can never drift
// from what the daemon actually accepts. TASK_* = cylindrical mode, JOINT_* = per-joint mode.
const CYLINDRICAL_DOFS = new Set(Object.values(TASK_KEYS).map(([dof]) => dof));
const JOINT_DOFS = new Set(Object.values(JOINT_KEYS).map(([dof]) => dof));
const BASE_DOFS = new Set(Object.values(BASE_KEYS).map(([dof]) => dof));

// Gripper sign convention for the grip() convenience op. Positive opens, negative closes — this
// mirrors TASK_KEYS/JOINT_KEYS (the `t`/`y` keys are +1). Flip here if a unit is wired opposite.
const GRIP_RATE = 1;

// Hard bound on any single hold/wait so one op can't run away; the session enforces the
// whole-script wall-clock cap on top of this. 60 s is well past any sane single motion span.
const MAX_HOLD_MS = 60_000;

// moveTo (absolute joint targets). The daemon applies `action` with NO server-side slew — a
// far-from-current target would lurch — so moveTo ramps the target here, from the current
// telemetry pose toward the goal at a bounded rate. ~60 u/s traverses the full [-100,100] range in
// ~3.3 s; opts.slew tunes it, clamped to MAX_MOVE_SLEW so a bad value can't cause a lurch.
const DEFAULT_MOVE_SLEW = 60; // normalized units / second
const MAX_MOVE_SLEW = 120;
const MOVE_TICK_MS = 40; // action-frame cadence (the daemon P-controls between updates)

// moveTo arrival detection (9c-lite — client-side, from existing telemetry; no daemon change).
// "done" = every target joint's actual .pos is within POS_TOL of its goal. "blocked" = the daemon
// latched (estop/thermal) or a target motor draws >= STALL_CURRENT with no arrival for STALL_FRAMES.
// "timeout" = neither within ARRIVAL_TIMEOUT_MS of finishing the ramp. The authoritative version
// (daemon-emitted action_status) is Phase E proper; see docs/phase_e_action_completion.md.
const POS_TOL = 2.0; // normalized units
const ARRIVAL_TIMEOUT_MS = 3000;
// Client-side, moveTo-ONLY (independent of the daemon's NORI_STALL_CURRENT). Set a touch below the
// daemon's 90 so moveTo reports "blocked" a bit before the daemon latches — hardware-tuned 2026-07-07
// (a gentle hand-block reads ~80, and 5 frames @40ms ≈ 200ms is responsive without false trips).
const STALL_CURRENT = 80; // raw Present_Current
const STALL_FRAMES = 5; // consecutive high-current, not-arrived polls before calling it blocked
// Follow-error clamp (safety): the commanded target may never lead the ACTUAL telemetry position by
// more than this. On a free move the arm keeps up (no effect); on an obstruction the target can't
// outrun the arm, so the daemon's P-control error — and thus the push force — is BOUNDED to this
// margin instead of escalating toward a far goal. ~10 units is comfortably above the natural
// following lag at these slews, so it doesn't throttle legitimate moves.
const FOLLOW_MARGIN = 10;

export interface ScriptDriverOptions {
  teleop: RemoteTeleop;
  // Half-speed session cap (plan §Containment): every op's rate magnitude is clamped to this
  // before setExternalJog. Advisory only until protocol G6 — the daemon clamp is the real
  // boundary — but it keeps supervised scripts gentle. Default 0.5.
  capRate?: number;
  // How long grip("open"|"close") holds the gripper jog, ms. Default 800.
  gripMs?: number;
  onLog?: (message: string) => void;
  onError?: (message: string) => void;
}

// A number in [-1,1]; anything else is a bug in the script or a bad LLM output. We clamp rather
// than reject so a slightly-out-of-range value degrades to the boundary instead of aborting.
function clampRate(v: number, cap: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-cap, Math.min(cap, v));
}

// Validate + clamp an arm DOF dict against the allowed vocabulary for the mode. Throws on an
// unknown DOF (a clear error beats silently dropping motion the operator asked for).
function buildArmDofs(
  dofs: Record<string, number>, allowed: Set<string>, cap: number, label: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [dof, rate] of Object.entries(dofs)) {
    if (!allowed.has(dof)) {
      throw new Error(`${label}: unknown DOF "${dof}" (allowed: ${[...allowed].join(", ")})`);
    }
    out[dof] = clampRate(rate, cap);
  }
  return out;
}

export class ScriptDriver {
  private readonly teleop: RemoteTeleop;
  private readonly capRate: number;
  private readonly gripMs: number;
  private readonly onLog?: (m: string) => void;
  private readonly onError?: (m: string) => void;

  private started = false;
  private stopped = false;
  // Serial op queue: every enqueue()d op runs after the previous one settles, so overlapping jog
  // spans can't fight even if a script fires ops without awaiting them.
  private tail: Promise<void> = Promise.resolve();
  // The in-flight cancellable sleep, so stop() can cut a held jog short.
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private activeReject: ((e: Error) => void) | null = null;
  // Latest telemetry snapshot, fed by the page's onTelemetry; robot.telemetry() reads it.
  private lastTelemetry: TelemetryView | null = null;
  // A running audio clip (bypasses the motion queue — audio rides a separate transceiver and
  // composes freely with motion). Tracked so stop()/E-STOP kills it alongside motion.
  private activeClip: ClipHandle | null = null;

  constructor(opts: ScriptDriverOptions) {
    this.teleop = opts.teleop;
    this.capRate = opts.capRate ?? 0.5;
    this.gripMs = opts.gripMs ?? 800;
    this.onLog = opts.onLog;
    this.onError = opts.onError;
  }

  // Begin the zero-hold. RemoteTeleop's 50 Hz timer immediately starts shipping `{}`, feeding the
  // watchdog before the first op and between ops.
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.teleop.setExternalJog({});
    this.onLog?.("[script] driver started (half-speed cap, open-loop timing)");
  }

  // Idempotent hard-ish stop: cut any in-flight hold, kill audio, release jog to the keyboard.
  // Does NOT send E-STOP — that is the panel's louder, separate tri-action (command("estop") +
  // worker.terminate() + driver.stop()). This is the clean stop.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.activeTimer !== null) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
    if (this.activeReject) {
      const reject = this.activeReject;
      this.activeReject = null;
      reject(new Error("script stopped"));
    }
    if (this.activeClip) {
      this.activeClip.stop();
      this.activeClip = null;
    }
    this.teleop.setExternalJog(null);
    this.onLog?.("[script] driver stopped");
  }

  // The page pushes every telemetry frame here (from its existing onTelemetry). This is
  // proprioception (the robot's own joints); exteroception (what it SEES) rides the separate
  // perception channel, read straight off the teleop via the perceive op (Phase F / G3).
  setTelemetry(t: TelemetryView): void {
    this.lastTelemetry = t;
  }

  // Bridge entry point: run one op from the worker and resolve/reject its result. Motion ops go
  // through the serial queue; telemetry/log/playAudio/estop are immediate.
  exec(op: string, args: unknown[]): Promise<unknown> {
    switch (op) {
      case "reach":
        return this.enqueue(() => this.arm("reach", CYLINDRICAL_DOFS, args));
      case "joint":
        return this.enqueue(() => this.arm("joint", JOINT_DOFS, args));
      case "grip":
        return this.enqueue(() => this.grip(args));
      case "base":
        return this.enqueue(() => this.base(args));
      case "lift":
        return this.enqueue(() => this.lift(args));
      case "wait":
        return this.enqueue(() => this.wait(args));
      case "moveTo":
        return this.enqueue(() => this.moveTo(args));
      case "telemetry":
        return Promise.resolve(this.lastTelemetry);
      case "perceive":
        // Structured world-state from the daemon perception process (Phase F). Immediate, like
        // telemetry — returns null if no detector frame has arrived, so scripts guard for it.
        return Promise.resolve(this.teleop.perceive());
      case "playAudio":
        return this.playAudio(args); // bypasses the motion queue on purpose
      case "reset":
        // Re-sync the daemon's task-space (IK) cursor to the current joint positions. Enqueued
        // so it runs AFTER any prior joint holds settle — the point is to reset before a reach()
        // that follows joint() moves (which leave the x/y cursor stale). Also clears a latch.
        return this.enqueue(() => { this.teleop.command("reset"); return Promise.resolve(undefined); });
      case "estop":
        this.teleop.command("estop");
        return Promise.resolve(undefined);
      default:
        return Promise.reject(new Error(`unknown op "${op}"`));
    }
  }

  // Chain fn after the current queue tail. The tail swallows errors so one failing op doesn't
  // wedge the queue; the caller still sees this op's rejection.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      if (this.stopped) throw new Error("script stopped");
      return fn();
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Hold a jog payload for `ms`, then zero it. On stop() the sleep rejects and we skip the zero
  // (stop() already released to null).
  private async hold(payload: ExternalJog, ms: number): Promise<void> {
    this.teleop.setExternalJog(payload);
    try {
      await this.sleep(ms);
    } finally {
      if (!this.stopped) this.teleop.setExternalJog({});
    }
  }

  private sleep(ms: number): Promise<void> {
    const dur = Math.min(MAX_HOLD_MS, Number.isFinite(ms) && ms > 0 ? ms : 0);
    return new Promise((resolve, reject) => {
      this.activeReject = reject;
      this.activeTimer = setTimeout(() => {
        this.activeTimer = null;
        this.activeReject = null;
        resolve();
      }, dur);
    });
  }

  private arm(label: string, allowed: Set<string>, args: unknown[]): Promise<void> {
    const [side, dofs, ms] = args as [ArmSide, Record<string, number>, number];
    const clamped = buildArmDofs(dofs, allowed, this.capRate, label);
    return this.hold({ [`${side}_arm`]: clamped }, ms);
  }

  private grip(args: unknown[]): Promise<void> {
    const [side, action] = args as [ArmSide, "open" | "close"];
    if (action !== "open" && action !== "close") {
      return Promise.reject(new Error(`grip: expected "open"|"close", got "${action}"`));
    }
    const rate = clampRate(action === "open" ? GRIP_RATE : -GRIP_RATE, this.capRate);
    return this.hold({ [`${side}_arm`]: { gripper: rate } }, this.gripMs);
  }

  private base(args: unknown[]): Promise<void> {
    const [vec, ms] = args as [{ linear?: number; angular?: number }, number];
    const dofs = buildArmDofs(
      { linear: vec.linear ?? 0, angular: vec.angular ?? 0 }, BASE_DOFS, this.capRate, "base",
    );
    return this.hold({ base: dofs }, ms);
  }

  private lift(args: unknown[]): Promise<void> {
    const [side, dir, ms] = args as [ArmSide, number, number];
    const rate = clampRate(dir, this.capRate);
    return this.hold({ [`${side}_lift`]: rate }, ms);
  }

  private wait(args: unknown[]): Promise<void> {
    const [ms] = args as [number];
    return this.sleep(ms); // heartbeat already holds zero; just idle
  }

  // Move arm joints to ABSOLUTE normalized targets, hold them, and REPORT ARRIVAL — while never
  // pushing harder than the FOLLOW_MARGIN. The daemon's `action` path has no slew or force guard:
  // it P-controls toward whatever target it holds, so a target that outruns an obstructed joint
  // makes the push escalate. To bound that, each tick we (1) advance the commanded target toward the
  // goal at `slew` u/s, then (2) CLAMP it to within FOLLOW_MARGIN of the ACTUAL telemetry position —
  // so on an obstruction the target can't lead the arm, and the push force stays bounded. The jog
  // heartbeat keeps running ({}); a zero-jog doesn't cancel the held target. Terminal states:
  //   done    — every joint's ACTUAL pos reached its goal (closed-loop).
  //   blocked — daemon latch (estop/thermal) or a target motor draws stall current not arriving.
  //   timeout — didn't arrive within the ramp budget + slack.
  // On ANY non-done exit (blocked/timeout/stop) we FREEZE: re-seat the target at the current actual
  // position, so the arm STOPS leaning on an obstruction instead of holding the unreachable goal.
  // (9c-lite, client-side; the authoritative version is Phase E / action_status.)
  private async moveTo(args: unknown[]): Promise<string> {
    const [side, targets, opts] =
      args as [ArmSide, Record<string, number>, { slew?: number; timeoutMs?: number } | undefined];
    if (!this.lastTelemetry) throw new Error("moveTo: no telemetry yet (is the session connected?)");
    const slew = Math.min(MAX_MOVE_SLEW, Math.max(1, opts?.slew ?? DEFAULT_MOVE_SLEW));
    const state0 = this.lastTelemetry.state ?? {};
    const plan = Object.entries(targets).map(([joint, to]) => {
      if (!JOINT_DOFS.has(joint)) {
        throw new Error(`moveTo: unknown joint "${joint}" (allowed: ${[...JOINT_DOFS].join(", ")})`);
      }
      const [lo, hi] = joint === "gripper" ? [0, 100] : [-100, 100];
      const posKey = `${side}_arm_${joint}.pos`;
      const curKey = `${side}_arm_${joint}`; // currents are keyed by bare motor name
      const start = Number.isFinite(state0[posKey]) ? state0[posKey] : (Number.isFinite(to) ? to : 0);
      const goal = Number.isFinite(to) ? Math.max(lo, Math.min(hi, to)) : start;
      return { posKey, curKey, goal, cmd: start }; // cmd = the commanded (ramping) target
    });

    // Deadline = expected ramp time (farthest joint) + arrival slack, so a legit long move isn't cut
    // short but an obstructed one (which never arrives) still terminates.
    const maxDist = Math.max(...plan.map((p) => Math.abs(p.goal - p.cmd)), 0);
    const deadline = (maxDist / slew) * 1000 + (opts?.timeoutMs ?? ARRIVAL_TIMEOUT_MS);
    const maxStep = slew * (MOVE_TICK_MS / 1000);

    let waited = 0;
    let stall = 0;
    for (;;) {
      if (this.stopped) { this.freezeAt(plan); return "stopped"; }
      if (this.motionLatched()) { this.freezeAt(plan); return "blocked"; }
      const state = this.lastTelemetry?.state ?? {};
      let arrived = true;
      const action: Record<string, number> = {};
      for (const p of plan) {
        const actual = Number.isFinite(state[p.posKey]) ? state[p.posKey] : p.cmd;
        // (1) advance the commanded target toward the goal…
        const remaining = p.goal - p.cmd;
        if (Math.abs(remaining) > 0.5) p.cmd += Math.sign(remaining) * Math.min(maxStep, Math.abs(remaining));
        else p.cmd = p.goal;
        // (2) …then clamp it to stay within FOLLOW_MARGIN of the ACTUAL position (bounded push).
        p.cmd = Math.max(actual - FOLLOW_MARGIN, Math.min(actual + FOLLOW_MARGIN, p.cmd));
        action[p.posKey] = Math.round(p.cmd * 100) / 100;
        if (!(Number.isFinite(actual) && Math.abs(actual - p.goal) <= POS_TOL)) arrived = false;
      }
      this.teleop.sendAction(action);
      if (arrived) return "done";
      stall = this.drawingStallCurrent(plan) ? stall + 1 : 0;
      if (stall >= STALL_FRAMES) { this.freezeAt(plan); return "blocked"; }
      if (waited >= deadline) { this.freezeAt(plan); return "timeout"; }
      try { await this.sleep(MOVE_TICK_MS); } catch { this.freezeAt(plan); return "stopped"; }
      waited += MOVE_TICK_MS;
    }
  }

  // Re-seat each joint's target at its CURRENT actual position, so the daemon's P-control error goes
  // to ~0 and the arm stops pushing — instead of holding an unreachable goal and leaning on an
  // obstruction indefinitely. Called on every non-done moveTo exit.
  private freezeAt(plan: { posKey: string; cmd: number }[]): void {
    const state = this.lastTelemetry?.state ?? {};
    const action: Record<string, number> = {};
    for (const p of plan) {
      const actual = Number.isFinite(state[p.posKey]) ? state[p.posKey] : p.cmd;
      action[p.posKey] = Math.round(actual * 100) / 100;
    }
    this.teleop.sendAction(action);
  }

  // A hard motion latch (E-STOP or thermal hold) — the daemon reports it in telemetry `safety`.
  private motionLatched(): boolean {
    return this.lastTelemetry?.safety === "latched";
  }

  // A planned joint is drawing stall-level current (proxy for "obstructed"). Absent currents (mock /
  // unsupported) just means we fall back to the timeout rather than reporting "blocked".
  private drawingStallCurrent(plan: { curKey: string }[]): boolean {
    const currents = this.lastTelemetry?.currents ?? {};
    return plan.some((p) => Number.isFinite(currents[p.curKey]) && Math.abs(currents[p.curKey]) >= STALL_CURRENT);
  }

  // Fetch/decode/stream a clip to the robot speaker via the main-thread helper. Runs OUTSIDE the
  // motion queue so audio and motion compose. Output level is capped ON THE ROBOT
  // (NORI_SPEAKER_GAIN) — the script can't reach past it. Basic scheme guard here doubles as SSRF
  // protection since this main thread is what actually fetches.
  private async playAudio(args: unknown[]): Promise<void> {
    const [url] = args as [string];
    if (this.stopped) throw new Error("script stopped");
    if (!/^(blob:|data:|https?:)/.test(url)) {
      throw new Error(`playAudio: unsupported URL scheme for "${url}"`);
    }
    const clip = await playAudioUrl(this.teleop, url);
    this.activeClip = clip;
    try {
      await clip.done;
    } finally {
      if (this.activeClip === clip) this.activeClip = null;
    }
  }
}
