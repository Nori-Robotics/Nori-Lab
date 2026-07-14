// NORI: Additive file. Browser half of laptop-side policy execution (see
// lelab/nori_rollout.py for the architecture contract). The policy runs in
// the local lelab process; this class ferries observations out of the live
// teleop session and hands the returned action to teleop.sendAction() — so
// the ONLY thing that reaches the robot is a standard {type:"control",
// action:{...}} frame, subject to every daemon-side safety layer exactly
// like a human keypress. Nothing is ever sent to or executed on the Pi.
//
// Observation sourcing mirrors dataset capture: joint state from telemetry,
// frames grabbed from the session video. A policy trained on a Nori browser
// capture expects the composite view under "observation.images.remote";
// per-role features are served from cameraView() crops when a policy asks
// for them.
//
// Safety posture (belt on top of the daemon's braces): the loop auto-stops
// on safety !== "ok", watchdog "stop", stale telemetry, control-channel
// loss, or repeated act failures — and never has more than one inference
// request in flight (a slow model skips ticks instead of queueing stale
// actions).

import type { RemoteTeleop, TelemetryView } from "@nori/sdk";

// Must mirror lelab/capture_export.py's exclusion — the training-side joint
// order and the inference-side joint order MUST be derived identically.
const EXCLUDE_STATE_KEY = /^(left_lift|right_lift)\.pos$|^(x|theta)\.vel$/;

export function jointOrderFromState(state: Record<string, number>): string[] {
  return Object.keys(state).filter((k) => !EXCLUDE_STATE_KEY.test(k)).sort();
}

export type PolicyRunPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "running"; ticks: number }
  | { kind: "stopped"; reason: string }
  | { kind: "error"; message: string };

interface FrameSource {
  featureKey: string;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  stop: () => void;
}

export class PolicyRunner {
  private baseUrl: string;
  private teleop: RemoteTeleop | null = null;
  private getTel: () => TelemetryView;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sources: FrameSource[] = [];
  private inflight = false;
  private consecutiveFailures = 0;
  private ticks = 0;

  ref: string | null = null;
  onPhase: (p: PolicyRunPhase) => void = () => {};

  constructor(baseUrl: string, getTel: () => TelemetryView) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.getTel = getTel;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  async start(teleop: RemoteTeleop, ref: string): Promise<void> {
    if (this.timer) await this.stop("restarted");
    this.onPhase({ kind: "loading" });

    const tel = this.getTel();
    const joints = jointOrderFromState(tel.state ?? {});
    if (joints.length === 0) {
      this.onPhase({ kind: "error", message: "no joint telemetry yet — is the session live?" });
      throw new Error("no telemetry");
    }

    const res = await fetch(`${this.baseUrl}/nori/rollout/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, joints }),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail;
      const message = detail ?? `load failed: HTTP ${res.status}`;
      this.onPhase({ kind: "error", message });
      throw new Error(message);
    }
    const loaded = (await res.json()) as { image_keys: Record<string, number[]>; fps: number };

    // Wire a frame source per image feature the policy demands.
    this.sources = [];
    for (const featureKey of Object.keys(loaded.image_keys)) {
      const role = featureKey.replace(/^observation\.images\./, "");
      let stream: MediaStream | null = null;
      let stopView = () => {};
      if (role === "remote" || role === "composite") {
        stream = teleop.videoStream();
      } else {
        const view = teleop.cameraView(role, { fps: loaded.fps });
        if (view) {
          stream = view.stream;
          stopView = () => view.stop();
        }
      }
      if (!stream) {
        await this.unloadQuietly();
        const message = `policy needs camera "${role}" but the session doesn't provide it (video on? layout arrived?)`;
        this.onPhase({ kind: "error", message });
        throw new Error(message);
      }
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      void video.play().catch(() => undefined);
      this.sources.push({ featureKey, video, canvas: document.createElement("canvas"), stop: stopView });
    }

    this.teleop = teleop;
    this.ref = ref;
    this.ticks = 0;
    this.consecutiveFailures = 0;
    this.timer = setInterval(() => void this.tick(), Math.max(50, 1000 / (loaded.fps || 10)));
    this.onPhase({ kind: "running", ticks: 0 });
  }

  private grab(src: FrameSource): string | null {
    const w = src.video.videoWidth;
    const h = src.video.videoHeight;
    if (!w || !h) return null;
    src.canvas.width = w;
    src.canvas.height = h;
    const ctx = src.canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src.video, 0, 0, w, h);
    return src.canvas.toDataURL("image/jpeg", 0.85);
  }

  private async tick(): Promise<void> {
    if (this.inflight || !this.teleop || !this.timer) return;

    const tel = this.getTel();
    if (tel.safety !== "ok") return void this.stop(`robot safety state: ${tel.safety}`);
    if (tel.watchdog === "stop") return void this.stop("robot watchdog stopped motion");
    if (!tel.state || Object.keys(tel.state).length === 0) return; // stale tick — skip

    const images: Record<string, string> = {};
    for (const src of this.sources) {
      const jpeg = this.grab(src);
      if (!jpeg) return; // video not ready this tick
      images[src.featureKey] = jpeg;
    }

    this.inflight = true;
    try {
      const res = await fetch(`${this.baseUrl}/nori/rollout/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: tel.state, images }),
      });
      if (!res.ok) throw new Error(`act HTTP ${res.status}`);
      const { action } = (await res.json()) as { action: Record<string, number> };
      // The one and only robot-bound artifact of this whole subsystem:
      this.teleop.sendAction(action);
      this.ticks += 1;
      this.consecutiveFailures = 0;
      if (this.ticks % 10 === 0) this.onPhase({ kind: "running", ticks: this.ticks });
    } catch {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= 5) void this.stop("inference kept failing (5 in a row)");
    } finally {
      this.inflight = false;
    }
  }

  async stop(reason = "stopped by user"): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const s of this.sources) {
      s.video.srcObject = null;
      s.stop();
    }
    this.sources = [];
    this.teleop = null;
    this.ref = null;
    await this.unloadQuietly();
    this.onPhase({ kind: "stopped", reason });
  }

  private async unloadQuietly(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/nori/rollout/unload`, { method: "POST" });
    } catch {
      /* lelab gone — nothing to unload */
    }
  }
}
