// NORI: Additive file (SDK v1 mock mode — docs/sdk_v1_finalization.md item 1).
// MockDaemonSim: a pure, deterministic emulation of the daemon+bridge WIRE BEHAVIOR — the
// frames a client sees, not the physics. It speaks the nori-protocol vocabulary (ack /
// telemetry / action_status, consuming control / command), integrates jog rates into a
// plausible joint state, honors ranges by clamping (the daemon's clamp-don't-reject rule),
// and emulates E-STOP latching and the per-connection watchdog so error paths are testable.
//
// Deliberately NOT kinematically accurate: cylindrical task-space dofs (x/y/pitch) nudge a
// fixed joint mapping so telemetry visibly responds — good enough for UI/3D/dev-loop work,
// never for training or motion validation. Time is caller-supplied (no Date.now/Math.random)
// so tests are reproducible; "randomness" is a seeded LCG.
//
// Environment: pure TS — no DOM, no WebRTC, no timers. Safe to import and unit-test in Node.
// The browser shell around it is mock/robot.ts.

import type { RobotDescriptor, WatchdogProfile } from "../teleop";

export interface MockSimOptions {
  descriptor?: RobotDescriptor;
  watchdog?: WatchdogProfile;
  initialState?: Record<string, number>;
  protocolVersion?: number;
  seed?: number;
  // Full-rate jog speed in normalized units/s (state units are lerobot-normalized, ~degrees).
  jogUnitsPerS?: number;
  // Slew speed for absolute `action` targets, units/s.
  actionUnitsPerS?: number;
}

// The SO101-shaped default: 2 arms x 6 joints, diff base, two lifts, four cameras — mirrors
// the nori-protocol ack golden fixture, extended to the full camera rig.
const ARM_JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];

function defaultDescriptor(): RobotDescriptor {
  const joints: string[] = [];
  const ranges: Record<string, [number, number]> = {};
  for (const side of ["left", "right"]) {
    for (const j of ARM_JOINTS) {
      const key = `${side}_arm_${j}.pos`;
      joints.push(key);
      ranges[key] = j === "gripper" ? [0, 100] : [-100, 100];
    }
  }
  ranges["left_lift.pos"] = [0, 600];
  ranges["right_lift.pos"] = [0, 600];
  return {
    buses: ["bus1", "bus2"],
    joints,
    base: ["x.vel", "theta.vel"],
    aux: ["left_lift", "right_lift"],
    cameras: ["front", "left_wrist", "right_wrist", "overhead"],
    ranges,
  };
}

// Cylindrical task-space dofs the real daemon resolves through IK. The mock maps them onto
// single joints so motion is VISIBLE, with no claim of geometric truth.
const TASK_DOF_TO_JOINT: Record<string, string> = {
  x: "elbow_flex",
  y: "shoulder_lift",
  pitch: "wrist_flex",
};

interface PendingAction {
  id: string;
  targets: Record<string, number>; // key -> clamped target
  clamped: boolean;
  announcedActive: boolean;
}

type Frame = Record<string, unknown>;

export class MockDaemonSim {
  readonly descriptor: RobotDescriptor;
  readonly watchdog: WatchdogProfile;
  readonly protocolVersion: number;

  private st: Record<string, number> = {};
  private initial: Record<string, number> = {};
  private jog: Frame | null = null;
  private pending: PendingAction[] = [];
  private safety: "ok" | "latched" = "ok";
  private latchReason: string | null = null;
  private lastControlMs: number | null = null;
  private lastTickMs: number | null = null;
  private moved = new Set<string>(); // joints that moved last tick (drives fake currents)
  private rng: number;
  private readonly jogRate: number;
  private readonly actionRate: number;
  // Motor whose idle holding current is always reported; null on a jointless descriptor.
  private readonly idleCurrentMotor: string | null;

  constructor(opts?: MockSimOptions) {
    this.descriptor = opts?.descriptor ?? defaultDescriptor();
    this.watchdog = opts?.watchdog ?? { t_warn_ms: 300, t_stop_ms: 1000 };
    this.protocolVersion = opts?.protocolVersion ?? 1;
    this.rng = (opts?.seed ?? 42) >>> 0 || 42;
    this.jogRate = opts?.jogUnitsPerS ?? 60;
    this.actionRate = opts?.actionUnitsPerS ?? 120;

    const joints = this.descriptor.joints ?? [];
    this.idleCurrentMotor = joints.length ? joints[joints.length - 1].replace(/\.pos$/, "") : null;
    for (const j of joints) this.st[j] = j.includes("gripper") ? 30 : 0;
    for (const b of this.descriptor.base ?? []) this.st[b] = 0;
    for (const a of this.descriptor.aux ?? []) this.st[`${a}.pos`] = 100;
    Object.assign(this.st, opts?.initialState);
    this.initial = { ...this.st };
  }

  // ---- frames the shell sends on channel open -------------------------------------------

  ackFrame(): Frame {
    return {
      type: "ack",
      accepted: true,
      protocol_version: this.protocolVersion,
      norm_mode: "range_m100_100",
      watchdog_profile: { ...this.watchdog },
      descriptor: JSON.parse(JSON.stringify(this.descriptor)),
      initial_state: { ...this.initial },
    };
  }

  cameraLayoutFrame(): Frame | null {
    const tiles = this.descriptor.cameras ?? [];
    if (tiles.length < 2) return null; // single-camera robots send no layout (matches the bridge)
    const cols = Math.ceil(Math.sqrt(tiles.length));
    return { type: "camera_layout", cols, rows: Math.ceil(tiles.length / cols), tiles: [...tiles] };
  }

  daemonStatusFrame(state: "online" | "offline" = "online"): Frame {
    return { type: "daemon_status", state };
  }

  // ---- inbound --------------------------------------------------------------------------

  // Consume one client frame; returns frames to send back immediately (may be empty).
  handleFrame(frame: Frame, nowMs: number): Frame[] {
    if (!frame || typeof frame !== "object") return [];
    const t = frame.type;
    if (t === "control") return this.handleControl(frame, nowMs);
    if (t === "command") return this.handleCommand(frame);
    // call / video / link / record / unknown: a real robot ignores unknown vocabulary too.
    return [];
  }

  private handleControl(frame: Frame, nowMs: number): Frame[] {
    this.lastControlMs = nowMs;
    const out: Frame[] = [];

    if (frame.jog && typeof frame.jog === "object") this.jog = frame.jog as Frame;

    if (frame.reset && typeof frame.reset === "object") {
      for (const [armKey, on] of Object.entries(frame.reset as Record<string, unknown>)) {
        if (!on) continue;
        const targets: Record<string, number> = {};
        for (const j of ARM_JOINTS) {
          const key = `${armKey}_${j}.pos`;
          if (key in this.initial) targets[key] = this.initial[key];
        }
        this.pending.push({ id: "", targets, clamped: false, announcedActive: true });
      }
    }

    if (frame.action && typeof frame.action === "object") {
      const id = typeof frame.action_id === "string" ? frame.action_id : "";
      if (this.safety === "latched") {
        if (id) out.push(this.actionStatus(id, "blocked", `latched:${this.latchReason ?? "estop"}`));
        return out;
      }
      const targets: Record<string, number> = {};
      let clamped = false;
      for (const [key, v] of Object.entries(frame.action as Record<string, unknown>)) {
        if (typeof v !== "number" || !(key in this.st)) continue;
        const c = this.clampKey(key, v);
        if (c !== v) clamped = true;
        if (key.endsWith(".vel")) this.st[key] = c; // velocities apply instantly
        else targets[key] = c;
      }
      this.pending.push({ id, targets, clamped, announcedActive: false });
      if (id) out.push(this.actionStatus(id, "accepted"));
    }
    return out;
  }

  private handleCommand(frame: Frame): Frame[] {
    // Two wire shapes exist: {name:"estop"} (protocol fixture) and {estop:true} (SDK keyboard
    // path); accept both, like the daemon does. NOT "reset": the SDK's reset command travels as
    // a control frame's `reset` field (handleControl), never as a command — listing it here
    // implied an emulation that doesn't exist.
    const name =
      typeof frame.name === "string"
        ? frame.name
        : ["estop", "reset_latch"].find((k) => frame[k] === true) ?? "";
    if (name === "estop") {
      this.safety = "latched";
      this.latchReason = "estop";
      this.jog = null;
      this.zeroVelocities();
      const out = this.pending
        .filter((p) => p.id)
        .map((p) => this.actionStatus(p.id, "blocked", "latched:estop"));
      this.pending = [];
      return out;
    }
    if (name === "reset_latch") {
      this.safety = "ok";
      this.latchReason = null;
    }
    return [];
  }

  // ---- time -----------------------------------------------------------------------------

  // Advance the sim to nowMs and return the frames due (one telemetry + any terminal
  // action_status). Call at your telemetry rate; dt is derived, so rate is caller's choice.
  tick(nowMs: number): Frame[] {
    const dt = this.lastTickMs === null ? 0 : Math.max(0, (nowMs - this.lastTickMs) / 1000);
    this.lastTickMs = nowMs;
    const out: Frame[] = [];
    this.moved.clear();

    // Watchdog: arrival-keyed like the real one — armed by the first control frame, trips on
    // silence. On stop, motion ceases (velocities zero, jog dropped) but nothing latches.
    let wd: "ok" | "warn" | "stop" = "ok";
    if (this.lastControlMs !== null) {
      const silence = nowMs - this.lastControlMs;
      if (silence > this.watchdog.t_stop_ms) {
        wd = "stop";
        this.jog = null;
        this.zeroVelocities();
      } else if (silence > this.watchdog.t_warn_ms) wd = "warn";
    }

    // Motion runs only when nothing is stopping it. Watchdog `stop` must halt EVERYTHING, not
    // just the jog: an in-flight `action` that kept slewing to completion after the control link
    // went silent would report `done` on the mock while a real robot froze mid-move — teaching
    // link-loss recovery code the opposite of the truth. Pending actions are kept, not failed:
    // they resume if control returns, and freeze meanwhile.
    if (this.safety !== "latched" && wd !== "stop" && dt > 0) {
      this.integrateJog(dt);
      out.push(...this.slewActions(dt));
    }

    out.push(this.telemetryFrame(nowMs, wd));
    return out;
  }

  private integrateJog(dt: number) {
    if (!this.jog) return;
    for (const side of ["left_arm", "right_arm"]) {
      const arm = this.jog[side];
      if (!arm || typeof arm !== "object") continue;
      for (const [dof, rateU] of Object.entries(arm as Record<string, unknown>)) {
        const rate = typeof rateU === "number" ? Math.max(-1, Math.min(1, rateU)) : 0;
        if (!rate) continue;
        const key = `${side}_${dof}.pos`;
        const mapped = key in this.st ? key : `${side}_${TASK_DOF_TO_JOINT[dof] ?? ""}.pos`;
        if (!(mapped in this.st)) continue;
        this.setJoint(mapped, this.st[mapped] + rate * this.jogRate * dt);
      }
    }
    // Base velocities are re-commanded by every jog frame, so an ABSENT base key means "no base
    // command" = stop — not "keep the last one". The SDK's keyboard path omits `base` entirely
    // once no base key is held (teleop.ts jogTick), so treating absence as latch made a released
    // key drive the base forever: the exact runaway the real daemon is built to prevent.
    const base = this.jog.base;
    const b = (base && typeof base === "object" ? base : {}) as Record<string, unknown>;
    if ("x.vel" in this.st) this.st["x.vel"] = typeof b.linear === "number" ? b.linear : 0;
    if ("theta.vel" in this.st) this.st["theta.vel"] = typeof b.angular === "number" ? b.angular : 0;
    if (this.st["x.vel"] || this.st["theta.vel"]) this.moved.add("base");
    for (const lift of this.descriptor.aux ?? []) {
      const rate = this.jog[lift];
      if (typeof rate === "number" && rate) {
        this.setJoint(`${lift}.pos`, this.st[`${lift}.pos`] + Math.max(-1, Math.min(1, rate)) * 40 * dt);
      }
    }
  }

  private slewActions(dt: number): Frame[] {
    const out: Frame[] = [];
    const step = this.actionRate * dt;
    this.pending = this.pending.filter((p) => {
      let reached = true;
      for (const [key, target] of Object.entries(p.targets)) {
        const cur = this.st[key];
        const d = target - cur;
        if (Math.abs(d) <= step) this.setJoint(key, target);
        else {
          this.setJoint(key, cur + Math.sign(d) * step);
          reached = false;
        }
      }
      if (!reached && p.id && !p.announcedActive) {
        p.announcedActive = true;
        out.push(this.actionStatus(p.id, "active"));
      }
      if (reached && p.id) out.push(this.actionStatus(p.id, p.clamped ? "clamped" : "done"));
      return !reached;
    });
    return out;
  }

  private telemetryFrame(nowMs: number, wd: "ok" | "warn" | "stop"): Frame {
    const currents: Record<string, number> = {};
    for (const key of this.moved) {
      if (key === "base") continue;
      currents[key.replace(/\.pos$/, "")] = 60 + Math.floor(this.noise() * 80);
    }
    // One idle holding current so the field is never empty (real motors always draw something).
    // Keyed off a joint the DESCRIPTOR actually has — a hardcoded name invented a phantom
    // actuator on custom descriptors, which anything cross-checking currents against joints reads
    // as a real motor.
    if (this.idleCurrentMotor) currents[this.idleCurrentMotor] ??= 20 + Math.floor(this.noise() * 20);
    return {
      type: "telemetry",
      ts_ns: Math.round(nowMs * 1e6),
      state: Object.fromEntries(Object.entries(this.st).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      currents,
      loop_hz: Math.round((49.6 + this.noise() * 0.8) * 10) / 10,
      errors: 0,
      stalled: [],
      pi_temp_c: Math.round((54 + this.noise() * 4) * 10) / 10,
      throttle_flags: 0,
      status: {
        safety: this.safety,
        latch_reason: this.latchReason,
        link: "mock",
        watchdog: wd,
        rtt_ms: 1.0,
      },
    };
  }

  // ---- introspection (tests, canvas renderer) --------------------------------------------

  state(): Record<string, number> {
    return { ...this.st };
  }
  safetyState(): string {
    return this.safety;
  }

  // ---- helpers ---------------------------------------------------------------------------

  private actionStatus(id: string, state: string, reason?: string): Frame {
    const f: Frame = { type: "action_status", action_id: id, state, ts_ns: this.lastTickMs === null ? 0 : Math.round(this.lastTickMs * 1e6) };
    if (reason) f.reason = reason;
    return f;
  }

  private clampKey(key: string, v: number): number {
    const r = this.descriptor.ranges?.[key];
    return r ? Math.max(r[0], Math.min(r[1], v)) : v;
  }

  private setJoint(key: string, v: number) {
    const nv = this.clampKey(key, v);
    if (nv !== this.st[key]) this.moved.add(key);
    this.st[key] = nv;
  }

  private zeroVelocities() {
    for (const b of this.descriptor.base ?? []) if (b in this.st) this.st[b] = 0;
  }

  // Deterministic [0,1) noise (LCG) — seeded, so identical runs produce identical telemetry.
  private noise(): number {
    this.rng = (this.rng * 1664525 + 1013904223) >>> 0;
    return this.rng / 0x100000000;
  }
}
