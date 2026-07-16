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

import type { CameraLayout, RemoteTeleop, TelemetryView } from "@nori/sdk";

// FileReader → "data:image/jpeg;base64,…" (the exact shape the /act endpoint and
// the old canvas.toDataURL path produced).
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

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

// Inference-time execution knobs for an ACT rollout (never affect training).
// Sent to /nori/rollout/load; applied in nori_rollout.py::_apply_act_execution.
export interface ExecutionParams {
  /** e.g. 0.01 → closed-loop temporal ensembling; null → disabled. */
  temporal_ensemble_coeff: number | null;
  /** Open-loop horizon (1..chunk_size) when not ensembling; null → checkpoint default. */
  n_action_steps: number | null;
}

export type ExecutionMode = "smooth" | "balanced" | "fast";

/** Friendly presets → raw ACT knobs. `smooth` (temporal ensembling, 0.01) is the
 *  default — best for fine/bimanual tasks and low control rates. */
export const EXECUTION_PRESETS: Record<ExecutionMode, ExecutionParams> = {
  smooth: { temporal_ensemble_coeff: 0.01, n_action_steps: null },
  balanced: { temporal_ensemble_coeff: null, n_action_steps: 25 },
  fast: { temporal_ensemble_coeff: null, n_action_steps: 100 },
};

export const EXECUTION_MODE_LABELS: Record<ExecutionMode, { label: string; hint: string }> = {
  smooth: { label: "Smooth", hint: "Closed-loop temporal ensembling — smoothest, best for fine/bimanual tasks & low fps" },
  balanced: { label: "Balanced", hint: "Re-plan every ~25 steps — snappier, slight boundary jerk" },
  fast: { label: "Fast", hint: "Full chunk open-loop — most reactive-feeling, can drift" },
};

// Every image feature is grabbed off the ONE composite track the robot sends,
// via teleop.captureFrame() (ImageCapture.grabFrame — reads the live track
// directly, no <video> element). A per-role feature (e.g. "left_wrist") passes
// its role so captureFrame crops that tile; "remote"/"composite" passes no role
// (full frame → role === null). We deliberately do NOT use a <video> sink +
// canvas: an offscreen/hidden video is not reliably frame-decoded on Chrome
// (videoWidth stayed 0), and cameraView()'s captureStream had the same problem.
interface FrameSource {
  featureKey: string;
  role: string | null; // layout tile to crop, or null for the full composite
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
  private skipLog = 0; // throttles the "tick skipped before /act" diagnostic

  ref: string | null = null;
  onPhase: (p: PolicyRunPhase) => void = () => {};

  constructor(baseUrl: string, getTel: () => TelemetryView) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.getTel = getTel;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  async start(teleop: RemoteTeleop, ref: string, exec?: ExecutionParams): Promise<void> {
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
      // Inference-time execution knobs (ACT); omitted keys fall back to the
      // checkpoint's saved values. See executionMode.ts / nori_rollout.py.
      body: JSON.stringify({
        ref,
        joints,
        temporal_ensemble_coeff: exec?.temporal_ensemble_coeff ?? null,
        n_action_steps: exec?.n_action_steps ?? null,
      }),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail;
      const message = detail ?? `load failed: HTTP ${res.status}`;
      this.onPhase({ kind: "error", message });
      throw new Error(message);
    }
    const loaded = (await res.json()) as { image_keys: Record<string, number[]>; fps: number };

    // Diagnostic: what cameras does the policy require vs what tiles the session's
    // camera layout actually exposes? A missing/renamed tile → cameraView returns
    // an empty (0x0) crop and the tick loop skips forever ("driving, nothing
    // happens"). Logs the needed roles + the live layout so a mismatch is obvious.
    {
      const neededRoles = Object.keys(loaded.image_keys).map((k) =>
        k.replace(/^observation\.images\./, ""),
      );
      const t = teleop as unknown as {
        cameraLayoutInfo?: () => unknown;
        cameraLayout?: () => unknown;
      };
      const layout = t.cameraLayoutInfo?.() ?? t.cameraLayout?.() ?? "(no layout / single-camera)";
      console.warn("[policyRun] policy needs cameras:", neededRoles, "| session camera layout:", layout);

      // Ground truth: is the composite video track actually LIVE right now? Every
      // per-camera crop is derived from this one track — if it reports 0x0 / muted /
      // ended, no crop can ever produce a frame, and the fix is about the composite
      // itself streaming on this page, not the cropping.
      const vs = teleop.videoStream();
      const vtracks = vs?.getVideoTracks() ?? [];
      console.warn(
        "[policyRun] composite track state:",
        vtracks.length
          ? vtracks.map((tr) => ({
              readyState: tr.readyState,
              enabled: tr.enabled,
              muted: tr.muted,
              settings: tr.getSettings(),
            }))
          : "(no video track on videoStream)",
      );
    }

    // Validate each requested camera against the live composite layout up front,
    // so a missing tile fails loudly here instead of silently skipping every tick.
    const layout =
      (teleop as unknown as { cameraLayoutInfo?: () => CameraLayout | null }).cameraLayoutInfo?.() ??
      null;
    this.sources = [];
    for (const featureKey of Object.keys(loaded.image_keys)) {
      const rawRole = featureKey.replace(/^observation\.images\./, "");
      const isFull = rawRole === "remote" || rawRole === "composite";
      if (!isFull && !layout?.tiles.includes(rawRole)) {
        await this.unloadQuietly();
        const tiles = layout?.tiles.join(", ") || "(no layout / single-camera)";
        const message = `policy needs camera "${rawRole}" but the session layout has tiles [${tiles}]`;
        this.onPhase({ kind: "error", message });
        throw new Error(message);
      }
      this.sources.push({ featureKey, role: isFull ? null : rawRole });
    }

    this.teleop = teleop;
    this.ref = ref;
    this.ticks = 0;
    this.consecutiveFailures = 0;
    this.timer = setInterval(() => void this.tick(), Math.max(50, 1000 / (loaded.fps || 10)));
    this.onPhase({ kind: "running", ticks: 0 });
  }

  private async tick(): Promise<void> {
    if (this.inflight || !this.teleop || !this.timer) return;

    const tel = this.getTel();
    // Stop on a REPORTED unsafe state, but NOT on "-" — that's the telemetry's
    // default placeholder before/without a safety field (some robot/session
    // configs never populate it). Teleop drives the follower under the same "-",
    // and the daemon still gates every control frame we send (this is only a
    // belt-on-top). A real reported state (e.g. "latched") still halts us.
    if (tel.safety && tel.safety !== "ok" && tel.safety !== "-") {
      return void this.stop(`robot safety state: ${tel.safety}`);
    }
    if (tel.watchdog === "stop") return void this.stop("robot watchdog stopped motion");
    if (!tel.state || Object.keys(tel.state).length === 0) {
      if (this.skipLog++ % 15 === 0)
        console.warn("[policyRun] tick skipped: no joint state this tick (telemetry not flowing)");
      return; // stale tick — skip
    }

    // Claim the tick before any await — grabbing + inference is async now, and a
    // slow model must skip ticks, never overlap them.
    this.inflight = true;
    const teleop = this.teleop;
    try {
      // Grab each camera straight off the live track (ImageCapture.grabFrame), the
      // one path that reliably yields frames without a decoded <video> element.
      const images: Record<string, string> = {};
      for (const src of this.sources) {
        const blob = await teleop.captureFrame("image/jpeg", 0.85, src.role ?? undefined);
        if (!blob) {
          if (this.skipLog++ % 15 === 0)
            console.warn(
              `[policyRun] tick skipped: camera "${src.featureKey}" — no frame off the live ` +
                `track (ImageCapture.grabFrame returned null; role ${src.role ?? "composite"})`,
            );
          return; // no frame this tick — finally resets inflight, no failure counted
        }
        images[src.featureKey] = await blobToDataUrl(blob);
      }

      const res = await fetch(`${this.baseUrl}/nori/rollout/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: tel.state, images }),
      });
      if (!res.ok) throw new Error(`act HTTP ${res.status}`);
      const { action } = (await res.json()) as { action: Record<string, number> };
      // The one and only robot-bound artifact of this whole subsystem:
      teleop.sendAction(action);
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
