// NORI: Additive file. Tier-1.5 agentic vision loop (docs/agentic_vision_loop.md, milestone 2).
//
// AgentSession is the browser half of the loop: it holds the Anthropic `messages[]` conversation,
// asks the server proxy (POST /nori/llm/agent) for the next turn, and EXECUTES each tool_use on the
// real robot via the SAME ScriptDriver the pasted-script path uses. The server only injects the
// system prompt + tools + the API key; the browser owns the conversation and every side effect, so
// this class is where the autonomy is bounded: step cap + wall-clock, confirm-before-first-motion,
// E-STOP, and last-N-image pruning all live here.
//
// It is the agentic sibling of ScriptSession — same lifecycle idioms (a ScriptDriver it start()s and
// stop()s, an idempotent finish(), an estop() tri-action). The one structural difference: there is no
// Worker. The model emits STRUCTURED tool calls, not arbitrary JS, so ScriptDriver's per-op arg
// validation is the whole guard — no sandbox needed (see the doc, "Reuses what's already shipped").
//
// The network transport is INJECTED (postTurn) rather than reached for directly, so this file has no
// dependency on the app's fetch/baseUrl wiring and is unit-testable with a fake transport + teleop.

import type { RemoteTeleop, TelemetryView } from "@nori/sdk";
import { ScriptDriver } from "./ScriptDriver";

// ---- wire types (mirror the server's /nori/llm/agent contract) ---------------

// An Anthropic content block. We only branch on `type`/`name`; the rest is passed through verbatim
// (back to the server as the assistant turn, or rendered in the transcript), so a loose shape is
// correct here — inventing a strict union would just drift from the API.
export type AgentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [k: string]: unknown;
};

export interface AgentTurn {
  stop_reason: string | null;
  content: AgentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
  // The customer's per-day agent token budget after this turn (cost governance, enforced in
  // Nori-Backend). `spent` = today's billable tokens, `warn` = the soft-warning threshold past which
  // the UI shows a "high usage" banner, `allowed`/`remaining` = the hard daily cap, `capped` = past
  // the cap (further turns are refused with 429). See lelab/server.py + Nori-Backend routes/agent.py.
  daily?: {
    spent: number;
    warn: number | null;
    allowed?: number | null;
    remaining?: number | null;
    capped?: boolean;
  };
}

// Thrown by postTurn when a turn is refused for cost reasons (HTTP 429) — the customer hit their
// per-day agent token cap (enforced in Nori-Backend). The loop ends cleanly as `budget` (not a red
// error). Exported for the page's postTurn. See lelab/server.py `/nori/llm/agent`.
export class AgentBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBudgetError";
  }
}

// The injected network call: one turn of the conversation. The page implements it with the app's
// fetchWithHeaders → POST {baseUrl}/nori/llm/agent. Kept abstract so the loop is testable headless.
export type PostTurn = (
  messages: AgentMessage[],
  robotState: Record<string, number> | undefined,
  cameraLayout: string | undefined,
) => Promise<AgentTurn>;

export type AgentMessage = { role: "user" | "assistant"; content: AgentBlock[] };

// ---- transcript events (consumed by the milestone-3 Agent panel) -------------

export type AgentEvent =
  | { kind: "assistant"; content: AgentBlock[]; usage?: AgentTurn["usage"] }
  | { kind: "tool_result"; tool: string; toolUseId: string; ok: boolean; text?: string; imageDataUrl?: string }
  | { kind: "budget"; spent: number; warn: number | null; allowed?: number | null; remaining?: number | null; capped?: boolean }
  | { kind: "status"; text: string }
  | { kind: "finished"; reason: FinishReason; detail?: string };

export type FinishReason =
  | "done" | "give_up" | "end_turn" | "stopped" | "estop" | "error" | "max_steps" | "wall_clock" | "not_confirmed" | "budget";

// ---- config ------------------------------------------------------------------

// The motion tools — the ones that actually command the robot. look/get_state/wait don't move it, so
// they never trip the confirm-before-first-motion gate. Keep in sync with the tool list in the doc.
const MOTION_TOOLS = new Set(["move_to", "reach", "grip", "base", "lift"]);

// Per-run caps. These bound a SINGLE run; the per-day cost ceiling is enforced server-side (the
// daily token budget), so these can be generous — they exist to stop a run that's wandering, not to
// control cost. Raised from 20/5min once the daily budget became the real spend guard.
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_WALL_CLOCK_MS = 10 * 60_000;
// How many of the most recent `look` frames to keep verbatim in the conversation; older image blocks
// are replaced with a text placeholder so a long run doesn't blow up context/upload/cost (the model
// still sees it looked, just not the pixels). 3 keeps "before/after + the current view" live.
const KEEP_LAST_IMAGES = 3;

export interface AgentSessionOptions {
  teleop: RemoteTeleop;
  postTurn: PostTurn;
  capRate?: number; // half-speed session cap, forwarded to ScriptDriver (default 0.5)
  maxSteps?: number; // hard step cap; loop aborts when reached (default 20)
  wallClockMs?: number; // hard wall-clock cap; loop aborts when reached (default 5 min)
  keepLastImages?: number; // image-pruning window (default 3)
  // Confirm-before-first-motion (ON by default). Called once, before the run's FIRST motion tool
  // executes; resolve false to abort the run. The operator can pass a resolver that auto-approves to
  // disable the gate per-run once they trust a task. Omit → gate is on and there's no way to approve,
  // which is wrong; the page always supplies this when the gate is on.
  confirmFirstMotion?: boolean; // default true
  onConfirmMotion?: (block: AgentBlock) => Promise<boolean>;
  onEvent?: (ev: AgentEvent) => void; // structured transcript for the UI
  onLog?: (line: string) => void; // plain text log (mirrors ScriptSession.onLog)
  onDone?: (reason: FinishReason) => void; // run ended (any reason)
}

export class AgentSession {
  private readonly o: AgentSessionOptions;
  private readonly driver: ScriptDriver;
  private readonly maxSteps: number;
  private readonly wallClockMs: number;
  private readonly keepLastImages: number;

  private messages: AgentMessage[] = [];
  private lastTelemetry: TelemetryView | null = null;
  private running = false;
  private finished = false;
  private stopped = false;
  private motionConfirmed = false; // becomes true after the first motion tool is approved
  private deadline = 0; // wall-clock cutoff (ms epoch), set at run()

  constructor(opts: AgentSessionOptions) {
    this.o = opts;
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.wallClockMs = opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    this.keepLastImages = opts.keepLastImages ?? KEEP_LAST_IMAGES;
    this.driver = new ScriptDriver({
      teleop: opts.teleop,
      capRate: opts.capRate,
      onLog: opts.onLog,
      onError: (m) => opts.onLog?.("⚠ " + m),
    });
  }

  // Feed telemetry through to the driver (so moveTo has a pose to ramp from) AND cache it here (so
  // get_state can answer). Same contract as ScriptSession.setTelemetry.
  setTelemetry(t: TelemetryView): void {
    this.lastTelemetry = t;
    this.driver.setTelemetry(t);
  }

  // Start the loop for `goal`. Idempotent-ish: one run at a time; call stop() before re-running.
  async run(goal: string): Promise<void> {
    if (this.running) throw new Error("agent already running; stop() first");
    this.running = true;
    this.finished = false;
    this.stopped = false;
    this.motionConfirmed = false;
    this.deadline = nowMs() + this.wallClockMs;
    this.messages = [{ role: "user", content: [{ type: "text", text: goal }] }];
    this.driver.start();
    this.o.onLog?.("[agent] started — goal: " + goal);

    try {
      await this.loop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A refused-for-budget turn is an expected stop, not a fault — finish cleanly so the UI can say
      // "daily budget reached" rather than flag a red error.
      if (e instanceof AgentBudgetError) {
        this.o.onLog?.("[agent] " + msg);
        this.finish("budget", msg);
        return;
      }
      this.o.onLog?.("⚠ [agent] " + msg);
      this.finish("error", msg);
    }
  }

  // Clean stop (no E-STOP): abort the loop, release jog to keyboard.
  stop(): void {
    this.stopped = true;
    this.finish("stopped");
  }

  // Tri-action hard preempt: latch the daemon AND abort the loop AND zero jog (driver.stop()).
  estop(): void {
    this.stopped = true;
    this.o.teleop.command("estop");
    this.finish("estop");
  }

  private async loop(): Promise<void> {
    for (let step = 0; step < this.maxSteps; step++) {
      if (this.stopped) return;
      if (nowMs() >= this.deadline) {
        this.o.onLog?.(`⚠ [agent] wall-clock cap (${Math.round(this.wallClockMs / 1000)}s) reached — stopping`);
        this.finish("wall_clock");
        return;
      }

      const turn = await this.o.postTurn(this.messages, this.robotState(), this.cameraLayout());
      if (this.stopped) return; // an E-STOP during the request
      this.messages.push({ role: "assistant", content: turn.content });
      this.o.onEvent?.({ kind: "assistant", content: turn.content, usage: turn.usage });
      if (turn.daily) {
        this.o.onEvent?.({ kind: "budget", ...turn.daily });
      }

      // A non-tool_use stop means the model spoke without acting (end_turn / max_tokens). Nudge it
      // once by leaving it to the next iteration only if it also gave tool calls; otherwise end — an
      // agent that stops calling tools is done talking, and looping would just re-bill the same turn.
      if (turn.stop_reason !== "tool_use") {
        this.finish("end_turn");
        return;
      }

      // Execute every tool_use block in order; `done`/`give_up` end the run immediately.
      const results: AgentBlock[] = [];
      for (const b of turn.content) {
        if (b.type !== "tool_use") continue;
        if (b.name === "done" || b.name === "give_up") {
          const detail = String((b.input?.summary ?? b.input?.reason ?? "") || "");
          this.o.onLog?.(`[agent] ${b.name}: ${detail}`);
          this.finish(b.name === "done" ? "done" : "give_up", detail);
          return;
        }
        // Confirm-before-first-motion gate (doc §Safety). Fires once, before the first motion tool.
        if (this.gateOn() && !this.motionConfirmed && MOTION_TOOLS.has(b.name ?? "")) {
          const ok = await this.o.onConfirmMotion!(b);
          if (this.stopped) return;
          if (!ok) {
            this.o.onLog?.("[agent] first motion not confirmed — stopping");
            this.finish("not_confirmed");
            return;
          }
          this.motionConfirmed = true;
          this.o.onLog?.("[agent] first motion confirmed — proceeding");
        }
        results.push(await this.execTool(b));
        if (this.stopped) return;
      }

      this.messages.push({ role: "user", content: results });
      this.pruneOldImages();
    }

    this.o.onLog?.(`⚠ [agent] step cap (${this.maxSteps}) reached — stopping`);
    this.finish("max_steps");
  }

  // Whether the confirm gate is active this run (default ON; only off if the caller both set the flag
  // false and there's nothing to ask). If the flag is on but no resolver was supplied, we still gate
  // and treat the missing resolver as "deny" via gateOn()+onConfirmMotion!—but the page always wires
  // a resolver when the gate is on, so that path is defensive only.
  private gateOn(): boolean {
    return (this.o.confirmFirstMotion ?? true) && !!this.o.onConfirmMotion;
  }

  // Execute one tool_use block on the robot and return its tool_result block. Never throws — a tool
  // failure comes back as an is_error tool_result so the model can see it and adapt (that's the loop
  // working as intended, not a crash).
  private async execTool(b: AgentBlock): Promise<AgentBlock> {
    const input = (b.input ?? {}) as Record<string, unknown>;
    try {
      switch (b.name) {
        case "look":
          return await this.doLook(b, input.camera as string | undefined);
        case "get_state":
          return this.textResult(b, JSON.stringify(this.lastTelemetry?.state ?? {}));
        case "move_to": {
          const state = await this.driver.exec("moveTo", [input.side, input.targets, { slew: input.slew }]);
          return this.textResult(b, String(state));
        }
        case "reach":
          await this.driver.exec("reach", [input.side, input.dofs, input.ms]);
          return this.textResult(b, "ok");
        case "grip":
          await this.driver.exec("grip", [input.side, input.action]);
          return this.textResult(b, "ok");
        case "base":
          await this.driver.exec("base", [{ linear: input.linear, angular: input.angular }, input.ms]);
          return this.textResult(b, "ok");
        case "lift":
          await this.driver.exec("lift", [input.side, input.dir, input.ms]);
          return this.textResult(b, "ok");
        case "wait":
          await this.driver.exec("wait", [input.ms]);
          return this.textResult(b, "ok");
        case "play_audio": {
          // Not a motion tool (harmless, gain-capped on the robot) → outside the confirm gate. Restrict
          // to https:/data: for an autonomous loop — the agent can't produce blob: and we don't want it
          // fetching arbitrary http hosts. The driver re-validates the scheme too.
          const url = String(input.url ?? "");
          if (!/^(https:|data:)/.test(url)) return this.errorResult(b, `play_audio: url must be an https:// or data: URL`);
          await this.driver.exec("playAudio", [url]);
          return this.textResult(b, "ok");
        }
        default:
          return this.errorResult(b, `unknown tool "${b.name}"`);
      }
    } catch (e) {
      return this.errorResult(b, e instanceof Error ? e.message : String(e));
    }
  }

  // look → snapshot of ONE camera. On a multi-camera (composite) robot, a `camera` role is REQUIRED:
  // the whole shrunken grid confuses spatial reasoning and the model just re-queries each tile anyway,
  // so we don't offer the composite — bare look errors, naming the valid roles. On a single-camera
  // robot (no layout) bare look returns that camera. On an unknown role the SDK returns null and NEVER
  // substitutes the composite (a mislabeled frame would corrupt spatial reasoning) — so we error too.
  private async doLook(b: AgentBlock, camera: string | undefined): Promise<AgentBlock> {
    const tiles = this.o.teleop.cameraLayoutInfo()?.tiles ?? [];
    if (!camera && tiles.length > 1) {
      return this.errorResult(b, `this robot has multiple cameras — call look with a "camera" argument (valid: ${tiles.join(", ")})`);
    }
    const blob = await this.o.teleop.snapshot(500, camera);
    if (!blob) {
      if (camera) {
        const roles = this.o.teleop.cameraLayoutInfo()?.tiles ?? [];
        const valid = roles.length ? `valid: ${roles.join(", ")}` : "this robot has one camera — use look with no camera argument";
        return this.errorResult(b, `unknown camera "${camera}" (${valid})`);
      }
      return this.errorResult(b, "no camera frame (video not arriving)");
    }
    const data = await blobToBase64(blob);
    this.o.onEvent?.({
      kind: "tool_result", tool: "look", toolUseId: b.id ?? "", ok: true,
      imageDataUrl: "data:image/jpeg;base64," + data,
    });
    return {
      type: "tool_result", tool_use_id: b.id,
      content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }],
    };
  }

  private textResult(b: AgentBlock, text: string): AgentBlock {
    this.o.onEvent?.({ kind: "tool_result", tool: b.name ?? "", toolUseId: b.id ?? "", ok: true, text });
    return { type: "tool_result", tool_use_id: b.id, content: [{ type: "text", text }] };
  }

  private errorResult(b: AgentBlock, message: string): AgentBlock {
    this.o.onEvent?.({ kind: "tool_result", tool: b.name ?? "", toolUseId: b.id ?? "", ok: false, text: message });
    return { type: "tool_result", tool_use_id: b.id, is_error: true, content: [{ type: "text", text: message }] };
  }

  // Replace all but the last N image blocks (across the whole conversation) with a text placeholder,
  // so the model keeps the recent frames it reasons on but old pixels stop riding every upload. A
  // `look` image lives nested inside a tool_result's `content`, so we descend one level. Collect every
  // image in document order, then stub all but the last N (the oldest go first).
  private pruneOldImages(): void {
    const images: AgentBlock[] = [];
    for (const m of this.messages) {
      for (const block of m.content) {
        if (block.type === "image") images.push(block);
        else if (Array.isArray(block.content)) {
          for (const inner of block.content as AgentBlock[]) if (inner.type === "image") images.push(inner);
        }
      }
    }
    for (let i = 0; i < images.length - this.keepLastImages; i++) {
      // Mutate in place: drop the image source, leave a breadcrumb the model can read.
      const block = images[i];
      delete block.source;
      block.type = "text";
      block.text = "[earlier frame omitted]";
    }
  }

  private robotState(): Record<string, number> | undefined {
    const state = this.lastTelemetry?.state;
    if (!state) return undefined;
    return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  }

  private cameraLayout(): string | undefined {
    return this.o.teleop.cameraLayout() ?? undefined;
  }

  // Idempotent teardown: stop the driver, notify once. Unlike ScriptSession there's no worker to
  // terminate — the loop notices `stopped` and unwinds on its own.
  private finish(reason: FinishReason, detail?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    this.driver.stop();
    this.o.onEvent?.({ kind: "finished", reason, detail });
    this.o.onDone?.(reason);
  }
}

// Read the wall clock without Date.now() drift concerns — a thin wrapper so tests can reason about it
// and so the one time-source is obvious. (performance.now is monotonic; epoch offset is irrelevant
// since we only compare against our own deadline computed from the same clock.)
function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Blob → base64 (no data: prefix), for the image tool_result the API expects. Goes through
// arrayBuffer() rather than FileReader so it works both in the browser and in the node test env
// (FileReader is browser-only); encodes with btoa in the browser, Buffer under node.
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (typeof btoa === "function") {
    let binary = "";
    const chunk = 0x8000; // avoid String.fromCharCode arg-count limits on large frames
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  // node (tests): Buffer is always present here.
  return Buffer.from(bytes).toString("base64");
}
