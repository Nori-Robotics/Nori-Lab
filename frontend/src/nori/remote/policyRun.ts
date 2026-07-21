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

import { cameraTileRect, type CameraLayout, type RemoteTeleop, type TelemetryView } from "@nori/sdk";

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

// Cloud-VLA rollout params (provider="cloud"): the policy runs on a remote
// endpoint (MolmoAct2 on a HF Space / AWS g5) instead of a local ACT bundle.
// lelab owns the endpoint URL + bearer token and the chunk queue — the browser
// loop is otherwise identical. `instruction` conditions the VLA; `views` names
// the camera feeds to grab, in the order the model expects them.
export interface CloudParams {
  instruction: string;
  numSteps?: number;
  views?: string[];
  /** Which arm a single-arm VLA drives; omit to use the server default (NORI_INFER_ARM). */
  arm?: "left" | "right";
  /** Safety dry-run: compute + log actions each tick but send NOTHING to the robot.
   *  Use for the first on-hardware check — watch the predicted joint targets before
   *  letting an unproven cloud policy actually drive the arm. */
  observeOnly?: boolean;
}

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

// Every image feature is drawn from the ONE composite video the robot sends. A
// per-role feature (e.g. "left_wrist") crops its tile out of that composite via
// cameraTileRect + the live layout; "remote"/"composite" is the full frame
// (role === null). We deliberately do NOT go through teleop.cameraView()'s
// captureStream crop — that secondary canvas→stream→video hop never produced
// frames on Chrome, so we crop straight from the decoded composite instead.
interface FrameSource {
  featureKey: string;
  role: string | null; // layout tile to crop, or null for the full composite
  canvas: HTMLCanvasElement;
}

export class PolicyRunner {
  private baseUrl: string;
  private teleop: RemoteTeleop | null = null;
  private getTel: () => TelemetryView;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sources: FrameSource[] = [];
  private composite: HTMLVideoElement | null = null; // the single decoded feed
  private compositeWrap: HTMLDivElement | null = null; // its on-screen preview box
  private layout: CameraLayout | null = null; // tile → crop-rect mapping
  private inflight = false;
  private consecutiveFailures = 0;
  private ticks = 0;
  private skipLog = 0; // throttles the "tick skipped before /act" diagnostic
  private observeOnly = false; // safety dry-run: log actions, don't drive the robot
  // Encoder gate state as we FOUND it, so stop() restores rather than force-pauses
  // (force-pausing froze the preview of a page that was still on screen).
  private videoWasPaused = false;

  ref: string | null = null;
  onPhase: (p: PolicyRunPhase) => void = () => {};

  constructor(baseUrl: string, getTel: () => TelemetryView) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.getTel = getTel;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  async start(
    teleop: RemoteTeleop,
    ref: string,
    exec?: ExecutionParams,
    cloud?: CloudParams,
  ): Promise<void> {
    if (this.timer) await this.stop("restarted");
    this.observeOnly = cloud?.observeOnly ?? false;
    this.onPhase({ kind: "loading" });

    const tel = this.getTel();
    const joints = jointOrderFromState(tel.state ?? {});
    if (joints.length === 0) {
      this.onPhase({ kind: "error", message: "no joint telemetry yet — is the session live?" });
      throw new Error("no telemetry");
    }

    // The robot pauses its video ENCODER whenever no page is showing video (the
    // remote/vr pages resume on mount and pause on unmount; TeleopSessionContext
    // pauses too). Running a policy from any other page would therefore get a
    // black/frozen feed — the real cause of the 0x0 / grabFrame-null failures.
    // Explicitly resume before we load so a fresh keyframe is on its way by the
    // time we start ticking. Remember what we found so stop() can put it BACK —
    // blindly pausing on stop froze the preview of a page still showing video.
    this.videoWasPaused = teleop.isVideoPaused?.() ?? false;
    teleop.resumeVideo();

    // Hand the arms to the policy: the 50 Hz jog/leader heartbeat otherwise
    // out-votes our ~10 Hz sendAction() and the arm never reaches the commanded
    // pose (valid actions, no motion). Released in stop().
    teleop.setPolicyDriving(true);

    const res = await fetch(`${this.baseUrl}/nori/rollout/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Inference-time execution knobs (ACT); omitted keys fall back to the
      // checkpoint's saved values. See executionMode.ts / nori_rollout.py.
      // Cloud fields are additive: sent only for a cloud VLA rollout, ignored by
      // the local ACT path (provider defaults to "local" server-side).
      body: JSON.stringify({
        ref,
        joints,
        temporal_ensemble_coeff: exec?.temporal_ensemble_coeff ?? null,
        n_action_steps: exec?.n_action_steps ?? null,
        ...(cloud
          ? {
              provider: "cloud",
              instruction: cloud.instruction,
              num_steps: cloud.numSteps ?? null,
              views: cloud.views ?? null,
              arm: cloud.arm ?? null,
            }
          : {}),
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

    // ONE composite video that every image feature is cropped from at grab-time.
    // It MUST be genuinely rendered on screen: Chrome does not decode a hidden or
    // offscreen <video> (a 1px/opacity:0 element stayed 0x0 forever), and
    // ImageCapture.grabFrame() throws on WebRTC-sourced tracks. A visible element
    // is the only path that reliably decodes — proven by the remote page's feed.
    // So we show it as a small labelled preview (also handy: it's what the policy
    // sees). videoWidth is the intrinsic 640x480 regardless of the CSS size, so the
    // crop is full-resolution.
    this.layout =
      (teleop as unknown as { cameraLayoutInfo?: () => CameraLayout | null }).cameraLayoutInfo?.() ??
      null;
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;bottom:12px;right:12px;z-index:2147483647;width:240px;border-radius:8px;" +
      "overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.35);background:#000;font:11px system-ui;";
    const composite = document.createElement("video");
    composite.muted = true;
    composite.playsInline = true;
    composite.srcObject = teleop.videoStream();
    composite.style.cssText = "display:block;width:100%;height:auto;";
    const label = document.createElement("div");
    label.textContent = "policy camera view";
    label.style.cssText = "color:#fff;background:rgba(0,0,0,.6);padding:3px 6px;text-align:center;";
    wrap.appendChild(composite);
    wrap.appendChild(label);
    document.body.appendChild(wrap);
    void composite.play().catch(() => undefined);
    this.composite = composite;
    this.compositeWrap = wrap;

    this.sources = [];
    for (const featureKey of Object.keys(loaded.image_keys)) {
      const rawRole = featureKey.replace(/^observation\.images\./, "");
      const isFull = rawRole === "remote" || rawRole === "composite";
      // A per-role feature must correspond to a tile in the live layout, else we
      // have no crop rect for it — fail loudly with the tiles we DO have.
      if (!isFull && !this.layout?.tiles.includes(rawRole)) {
        await this.unloadQuietly();
        const tiles = this.layout?.tiles.join(", ") || "(no layout / single-camera)";
        const message = `policy needs camera "${rawRole}" but the session layout has tiles [${tiles}]`;
        this.onPhase({ kind: "error", message });
        throw new Error(message);
      }
      this.sources.push({
        featureKey,
        role: isFull ? null : rawRole,
        canvas: document.createElement("canvas"),
      });
    }

    this.teleop = teleop;
    this.ref = ref;
    this.ticks = 0;
    this.consecutiveFailures = 0;
    this.timer = setInterval(() => void this.tick(), Math.max(50, 1000 / (loaded.fps || 10)));
    this.onPhase({ kind: "running", ticks: 0 });
  }

  private grab(src: FrameSource): string | null {
    const video = this.composite;
    if (!video) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    // Full composite (role === null), or this tile's source-crop rect from the
    // live layout (recomputed each frame so it survives an encode-res change).
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;
    if (src.role) {
      const r = this.layout && cameraTileRect(this.layout, src.role, vw, vh);
      if (!r) return null;
      ({ sx, sy, sw, sh } = r);
    }
    const cw = Math.max(2, Math.round(sw));
    const ch = Math.max(2, Math.round(sh));
    src.canvas.width = cw;
    src.canvas.height = ch;
    const ctx = src.canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
    return src.canvas.toDataURL("image/jpeg", 0.85);
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

    const images: Record<string, string> = {};
    for (const src of this.sources) {
      const jpeg = this.grab(src);
      if (!jpeg) {
        if (this.skipLog++ % 15 === 0)
          console.warn(
            `[policyRun] tick skipped: camera "${src.featureKey}" has no frame ` +
              `(composite ${this.composite?.videoWidth ?? 0}x${this.composite?.videoHeight ?? 0}, ` +
              `readyState ${this.composite?.readyState ?? 0})`,
          );
        return; // video not ready this tick
      }
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
      const { action, warming } = (await res.json()) as {
        action: Record<string, number> | null;
        warming?: boolean;
      };
      // Cloud VLA cold start: the chunk queue isn't primed yet (first call
      // compiles a CUDA graph, ~3.6s). The server returns action:null — skip this
      // tick like a dropped frame; it is NOT a failure (don't trip the watchdog).
      // A hard cloud error comes back as a non-2xx and takes the catch path below.
      if (!action) {
        if (warming && this.skipLog++ % 15 === 0)
          console.warn("[policyRun] cloud queue warming — skipping tick");
        this.consecutiveFailures = 0;
        return;
      }
      // COMMANDED vs ACHIEVED, per joint. The action_status channel can't answer
      // "is this joint actually moving?" for a streaming policy — a tracked action
      // never converges, so it never terminalises. This does answer it: `action` is
      // what we asked for, tel.state is what the arm reports. A joint whose command
      // varies while its observation stays flat is being dropped or overridden
      // downstream; a joint whose COMMAND is itself flat is an upstream (model)
      // problem. Logged once a second so the two are directly comparable.
      if (this.ticks % 10 === 0) {
        const obs = tel.state ?? {};
        const row = Object.keys(action)
          .filter((k) => k in obs)
          .map((k) => `${k.replace(/^(left|right)_arm_/, "").replace(/\.pos$/, "")}` +
                      ` cmd=${action[k].toFixed(1)} obs=${obs[k].toFixed(1)}`)
          .join("  ");
        console.info(`[policyRun] cmd-vs-obs | ${row}`);
      }
      // The one and only robot-bound artifact of this whole subsystem — SKIPPED
      // in observe-only mode (log the predicted targets, drive nothing).
      if (this.observeOnly) {
        if (this.ticks % 5 === 0) console.info("[policyRun] OBSERVE-ONLY predicted action:", action);
      } else {
        // Sample the daemon's verdict on our own commands. Without an action_id the
        // daemon's ActionTracker returns immediately (`if (id_.empty()) return`), so a
        // joint that is stall-latched or whose target saturated its range is reported
        // as nothing at all — the policy loop drives blind. We can't id EVERY tick:
        // the tracker is single-slot, so a fresh id each tick would evict the previous
        // before it reaches a terminal state and we'd never see a verdict. Sample one
        // tick per second instead and let that action run to terminal.
        if (this.ticks % 10 === 0) {
          const id = this.teleop.nextActionId();
          this.teleop.sendAction(action, id);
          void this.teleop.awaitAction(id, { timeoutMs: 1500 }).then((st) => {
            // "done" is the boring case; everything else names a real problem
            // (blocked -> "stall:<joint>", clamped -> a target hit its range limit).
            if (st.state === "done") return;
            // A streaming policy rewrites setpoints every ~100 ms, so a tracked
            // action almost never CONVERGES -> "done"/"clamped" are rare and a
            // client-fallback timeout is expected. That timeout is not evidence the
            // daemon is quiet: "blocked" (incl. stall) is checked before the
            // convergence test and would have fired promptly. Report the last
            // non-terminal status too, so a silent daemon (null: no Phase-E support
            // or status not reaching us) is distinguishable from a live one that
            // simply never terminalised.
            // stop() nulls this.teleop, and this resolves up to timeoutMs later — so
            // ending a run mid-flight would otherwise throw out of a floating promise.
            const last = this.teleop?.actionStatus(id) ?? null;
            const seen = last ? `${last.state}${last.reason ? ` (${last.reason})` : ""}` : "NONE";
            console.warn(`[policyRun] daemon verdict: ${st.state}`,
                         st.reason ? `(${st.reason})` : "", `| last status seen: ${seen}`);
          });
        } else {
          this.teleop.sendAction(action);
        }
      }
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
    if (this.composite) {
      this.composite.srcObject = null;
      this.composite = null;
    }
    if (this.compositeWrap) {
      this.compositeWrap.remove();
      this.compositeWrap = null;
    }
    this.layout = null;
    // Hand the arms back to keyboard/leader control, and put the encoder gate back
    // the way we found it. We must NOT blindly pause: if a page is still showing
    // video (the normal case — you stop the policy from the remote page), pausing
    // freezes its preview until something re-resumes.
    this.teleop?.setPolicyDriving(false);
    if (this.videoWasPaused) this.teleop?.pauseVideo();
    else this.teleop?.resumeVideo();
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
