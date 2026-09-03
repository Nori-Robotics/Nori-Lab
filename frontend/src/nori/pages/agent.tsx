// NORI: "Agent" — the Tier-1.5 agentic vision loop console (docs/agentic_vision_loop.md, milestone 3).
//
// Distinct from the Coding page ON PURPOSE: this is autonomous look->act->look motion, not
// paste-and-run. The operator types a GOAL; Claude drives the robot in a loop via the same persistent
// teleop session (shared through TeleopSessionProvider). Every turn is a POST to /nori/llm/agent (the
// server holds the key + tools); every tool executes here through AgentSession -> ScriptDriver, the
// same validated motion envelope the script console uses.
//
// Safety is the operator: live video is on the Remote page, E-STOP is here, the daemon watchdog
// safe-stops if the tab dies, and the first motion of every run pauses for an explicit OK (toggle to
// disable per-run once a task is trusted). Step + wall-clock caps bound the run; the transcript shows
// the model's intent BEFORE it moves.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Play, Square, OctagonX, Check, X, Bot } from "lucide-react";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { useApi } from "@/contexts/ApiContext";
import { isDirectBackend } from "@/nori/api/client";
import { hostedAgentTurn, hostedDepthGrid } from "@/nori/llm/hostedLlm";
import { formatDepthGrid, isDepthGridResult } from "@/nori/remote/depthGrid";
import { descriptorGrounding } from "@/nori/llm/promptAssembly";
import type { RobotDescriptor } from "@nori/sdk";
import { useConnectGate } from "@/nori/components/ConnectionPanel";
import { createPoseSummarizer } from "@/nori/remote/poseSummary";
import {
  AgentSession, AgentBudgetError,
  type AgentBlock, type AgentEvent, type AgentTurn, type FinishReason, type AgentMessage,
} from "@/nori/remote/AgentSession";
import { ArmControlView } from "@/nori/remote/ArmControl";
import { isPreparing, isStuck } from "@/nori/remote/armPhase";

// A rendered transcript line. We keep the raw events and turn them into rows at render time so the
// UI stays a pure function of the event log.
type Row =
  | { kind: "goal"; text: string }
  | { kind: "say"; text: string } // assistant reasoning text
  | { kind: "call"; tool: string; input: Record<string, unknown> }
  | { kind: "result"; tool: string; ok: boolean; text?: string; imageDataUrl?: string }
  | { kind: "end"; reason: FinishReason; detail?: string };

// Friendly one-liners for a finished run.
const END_LABEL: Record<FinishReason, string> = {
  done: "✓ goal reached", give_up: "gave up", end_turn: "stopped (no further action)",
  stopped: "stopped", estop: "■ E-STOP", error: "error", max_steps: "step cap reached",
  wall_clock: "time cap reached", not_confirmed: "first motion declined",
  // Neutral: the 429 can be the daily OR monthly cap — the appended server
  // reason string says which ("Daily agent token limit reached. It resets…").
  budget: "token budget reached",
};

// Today's server-tracked agent token spend (report-only; no hard limit yet — see server.py). `warn`
// is the soft threshold past which we show a "high usage" banner (null = no threshold configured).
// Backend-enforced per-customer daily budget. `spent` = today's billable tokens, `warn` = the
// soft-warning threshold, `allowed`/`remaining` = the hard daily cap, `capped` = past it (turns 429).
type DailyBudget = {
  spent: number;
  warn: number | null;
  allowed?: number | null;
  remaining?: number | null;
  capped?: boolean;
};

const Agent = () => {
  const { teleop, connState, connecting, connect, tel, setSessionBusy, daemonStatus } = useTeleopSession();
  const connectBlocked = useConnectGate();
  const { baseUrl, fetchWithHeaders } = useApi();

  const [goal, setGoal] = useState("");
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [confirmFirstMotion, setConfirmFirstMotion] = useState(true);
  const [pendingMotion, setPendingMotion] = useState<AgentBlock | null>(null); // the block awaiting OK
  const [usage, setUsage] = useState({ steps: 0, inTokens: 0, outTokens: 0 });
  const [daily, setDaily] = useState<DailyBudget | null>(null); // today's spend vs the daily limit

  const sessionRef = useRef<AgentSession | null>(null);
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Today's spend crossed the soft warning threshold → show a "high usage" note (no hard stop).
  const budgetWarn = daily?.warn != null && daily.spent >= daily.warn;

  const connected = connState === "connected";
  const status = connected
    ? `connected · ${Math.round(tel.loopHz)} Hz`
    : connecting ? "connecting…" : "not connected";

  // MOTOR STATE. `armed` rides daemon_status, NOT telemetry, which is why the loop was blind to
  // it: a disarmed robot accepts every motion command and moves nothing, so `reach`/`grip`/
  // `base`/`lift` (all open-loop holds) report ok while the arm sits still and `move_to` reports
  // a timeout the model reads as an obstruction. Absent entirely on a gateway without arming
  // support (the whole L-series) — which is why the Agent page worked there for a year.
  //
  // Read through a ref so AgentSession sees the CURRENT value: a robot can disarm under a
  // running loop (idle timer) or be dropped by a hardware E-STOP, and a value captured at
  // start() would keep saying "armed" through both.
  const motorRef = useRef(daemonStatus);
  motorRef.current = daemonStatus;
  const motorState = () => {
    const d = motorRef.current;
    if (!d || d.state !== "online") return null;
    return { armed: d.armed, activation: d.activation, estop: d.estop, estopDetail: d.estop_detail };
  };
  // Arming is the OPERATOR's act, not the agent's — same call the Remote page's ArmControl makes,
  // and the same reasoning that keeps E-STOP off the tool list: energizing hardware with no human
  // at the moment power becomes motion is exactly what confirm-before-first-motion exists to
  // prevent. So the page refuses to start rather than arming on the operator's behalf. A robot
  // that reports no arming state at all is unaffected (armed === undefined → no block).
  const motorBlock = (() => {
    const d = daemonStatus;
    if (!connected || !d || d.state !== "online") return null;
    if (d.estop) return `Hardware E-STOP on the robot${d.estop_detail ? ` — ${d.estop_detail}` : ""}. Clear it, then arm.`;
    if (d.armed === false) return "Motors are disarmed — arm the robot before starting a run.";
    if (isStuck(d.activation ?? "")) return "Motion activation is blocked on the robot — clear the reported cause, then re-arm.";
    if (isPreparing(d.activation ?? "")) return "Motion stack is still activating — wait for the motors to report active.";
    return null;
  })();

  // Keep get_state / moveTo current inside a running loop.
  useEffect(() => { sessionRef.current?.setTelemetry(tel); }, [tel]);
  // Auto-scroll the transcript.
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [rows]);
  // Stop the loop if we navigate away (the session persists; only the run stops).
  useEffect(() => () => sessionRef.current?.stop(), []);

  // An agent run is autonomous — minutes can pass with no operator input while the robot moves —
  // so suppress the idle auto-disconnect until the loop ends. Includes the pause waiting for the
  // first-motion OK: that prompt can sit unanswered, but the operator IS about to answer it.
  useEffect(() => {
    setSessionBusy("agent:run", running || !!pendingMotion);
    return () => setSessionBusy("agent:run", false);
  }, [running, pendingMotion, setSessionBusy]);

  const push = (row: Row) => setRows((prev) => [...prev.slice(-400), row]);

  // One turn of the conversation: inject the system prompt + tools + key and return the raw
  // Anthropic turn. DESKTOP: POST to LeLab's `/nori/llm/agent` (LeLab assembles + forwards).
  // HOSTED (LeLab-free): assemble in-browser and hit Nori-Backend's proxy directly (hostedLlm.ts),
  // since baseUrl points at a dead localhost there. Both raise AgentBudgetError on a 429.
  const postTurn = async (
    messages: AgentMessage[], robotState: Record<string, number> | undefined, cameraLayout: string | undefined,
    descriptor?: RobotDescriptor | null, poseSummary?: string, motors?: string,
  ): Promise<AgentTurn> => {
    // The RAW descriptor is hosted-path only: that path has the SDK, so it rebuilds the
    // move_to / reach / lift schemas from it. The LeLab server path below ships the static L2
    // schemas and cannot resolve a descriptor, so it gets the same vocabulary as pre-rendered
    // prose lines instead (robot_vocabulary) — the schemas stay L2-shaped there and the prose
    // overrides them, which is why every line says "OVERRIDE".
    if (isDirectBackend()) return hostedAgentTurn(messages, robotState, cameraLayout, descriptor, poseSummary, motors);
    const res = await fetchWithHeaders(`${baseUrl}/nori/llm/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // robot_vocabulary / motors are pre-RENDERED here rather than sent as a raw descriptor:
      // this server path ships the static L2 tool schemas and has no SDK to resolve a descriptor
      // with, so the browser (which has both) hands it the finished grounding lines and the
      // server folds them in verbatim — the same shape pose_summary already uses.
      body: JSON.stringify({
        messages, robot_state: robotState, camera_layout: cameraLayout,
        pose_summary: poseSummary,
        robot_vocabulary: descriptorGrounding(descriptor),
        motors,
      }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      // The backend's error detail is either a plain string (413 etc.) or, on the
      // budget 429s, an OBJECT {reason, daily} — coercing that into an Error message
      // rendered as "[object Object]". Extract the human reason.
      const d = detail?.detail;
      const msg: string =
        typeof d === "string" ? d
        : typeof d?.reason === "string" ? d.reason
        : res.statusText;
      // 429 = token budget used up (daily or monthly; the reason string says which);
      // a distinct error so the loop ends cleanly (not as a fault).
      if (res.status === 429) throw new AgentBudgetError(msg);
      throw new Error(msg);
    }
    return (await res.json()) as AgentTurn;
  };

  // Depth grounding for `look`: same JPEG through the depth endpoint (desktop: LeLab's
  // /nori/depth proxy; hosted: the backend directly), formatted to the compact text grid the
  // tool_result carries. Null on ANY failure — depth never blocks or errors a look.
  const fetchDepth = async (imageB64: string): Promise<string | null> => {
    try {
      const raw = isDirectBackend()
        ? await hostedDepthGrid(imageB64)
        : await (async () => {
            const res = await fetchWithHeaders(`${baseUrl}/nori/depth`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image_b64: imageB64 }),
            });
            return res.ok ? await res.json() : null;
          })();
      return isDepthGridResult(raw) ? formatDepthGrid(raw) : null;
    } catch {
      return null;
    }
  };

  // The confirm-before-first-motion gate: show the pending motion and resolve when the operator
  // clicks Approve/Deny. Only wired when the toggle is on.
  const onConfirmMotion = (block: AgentBlock) =>
    new Promise<boolean>((resolve) => {
      confirmResolveRef.current = (ok) => { confirmResolveRef.current = null; setPendingMotion(null); resolve(ok); };
      setPendingMotion(block);
    });

  const onEvent = (ev: AgentEvent) => {
    switch (ev.kind) {
      case "assistant": {
        for (const b of ev.content) {
          if (b.type === "text" && b.text?.trim()) push({ kind: "say", text: b.text.trim() });
          else if (b.type === "tool_use") push({ kind: "call", tool: b.name ?? "?", input: (b.input ?? {}) as Record<string, unknown> });
        }
        if (ev.usage) {
          setUsage((u) => ({ steps: u.steps + 1, inTokens: ev.usage!.input_tokens, outTokens: u.outTokens + ev.usage!.output_tokens }));
        }
        break;
      }
      case "tool_result":
        // `look` already renders as the assistant's call chip + this thumbnail; text results attach to
        // the call. We push a compact result row (thumbnail or short text).
        push({ kind: "result", tool: ev.tool, ok: ev.ok, text: ev.text, imageDataUrl: ev.imageDataUrl });
        break;
      case "budget":
        setDaily({ spent: ev.spent, warn: ev.warn, allowed: ev.allowed, remaining: ev.remaining, capped: ev.capped });
        break;
      case "finished":
        push({ kind: "end", reason: ev.reason, detail: ev.detail });
        break;
    }
  };

  const start = async () => {
    if (running || !goal.trim()) return;
    if (!teleop || !connected) { push({ kind: "end", reason: "error", detail: "not connected — Connect first" }); return; }
    if (motorBlock) { push({ kind: "end", reason: "error", detail: motorBlock }); return; }
    setRows([{ kind: "goal", text: goal.trim() }]);
    setUsage({ steps: 0, inTokens: 0, outTokens: 0 });
    const session = new AgentSession({
      teleop,
      postTurn,
      // FK gripper world-coordinate grounding (poseSummary.ts): one text line per turn + in
      // get_state, so the model plans in millimetres instead of guessing from pixels.
      describePose: createPoseSummarizer(teleop),
      // Relative-depth grid appended to every look (depthGrid.ts) — best-effort.
      fetchDepth,
      // Lets the loop SEE the arming state (in get_state + every turn's grounding) and refuse a
      // motion tool it cannot act on, instead of reporting ok against dead buses.
      motorState,
      confirmFirstMotion,
      onConfirmMotion: confirmFirstMotion ? onConfirmMotion : undefined,
      onEvent,
      onDone: () => { setRunning(false); sessionRef.current = null; },
    });
    sessionRef.current = session;
    session.setTelemetry(tel);
    setRunning(true);
    await session.run(goal.trim());
  };

  const stop = () => {
    confirmResolveRef.current?.(false); // release a pending confirm as a deny
    sessionRef.current?.stop();
    sessionRef.current = null;
    setRunning(false);
  };

  const estop = () => {
    confirmResolveRef.current?.(false);
    sessionRef.current?.estop();
    if (!sessionRef.current) teleop?.command("estop");
    sessionRef.current = null;
    setRunning(false);
    push({ kind: "end", reason: "estop" });
  };

  return (
    <section className="relative -my-6 -mx-[calc(50vw-50%)] min-h-[calc(100vh-3.5rem)] overflow-hidden px-[calc(50vw-50%)] py-6">
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-leaf opacity-70 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -right-20 top-32 h-64 w-64 rounded-full bg-sticker opacity-60 blur-3xl" aria-hidden />

      <div className="relative space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="flex items-center gap-2 text-3xl font-bold"><Bot className="h-7 w-7" /> Agent</h1>
              <span className="inline-flex -rotate-3 animate-floaty items-center rounded-full bg-sticker px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink shadow-soft">
                {"// beta"}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">autonomous look→act→look · supervise with live video on Remote · E-STOP below</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={"inline-flex h-9 items-center rounded-full px-3 font-mono text-xs " + (connected ? "bg-nori-h8ab135/25 text-nori-h4d6a1e" : "bg-nori-h14131a/8 text-nori-h857b6b")}>
              ● {status}
            </span>
            {/* The SAME control the Remote page renders (one implementation — see
                remote/ArmControl.tsx). It hides itself on a robot whose gateway doesn't report
                arming, so the L-series page is unchanged. */}
            {connected && <ArmControlView teleop={teleop} running={connected} daemonStatus={daemonStatus} compact />}
            {!connected && (
              <Button
                size="sm"
                variant="secondary"
                onClick={connect}
                disabled={connecting || !!connectBlocked}
                title={connectBlocked ?? undefined}
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            )}
          </div>
        </div>

        <div className="grid h-[calc(100vh-12rem)] grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Left: goal + controls */}
          <div className="flex h-full min-w-0 min-h-0 flex-col gap-4">
            <div className="flex flex-col gap-2 rounded-md border border-nori-h14131a/10 bg-nori-hf6f4eb p-4 text-nori-h14131a shadow-sm">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">// goal</span>
              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Describe the goal, e.g. 'nudge the base toward the cup in the overhead tile'…"
                className="min-h-[96px] resize-none border-nori-h14131a/12 bg-nori-hfffdf7"
                disabled={running}
              />
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                  title="Pause for an explicit OK before the run's FIRST motion. Disable per-run once you trust a task.">
                  <input type="checkbox" checked={confirmFirstMotion} disabled={running}
                    onChange={(e) => setConfirmFirstMotion(e.target.checked)} />
                  confirm before first motion
                </label>
                <div className="flex items-center gap-2">
                  {!running ? (
                    <Button size="sm" onClick={start} disabled={!connected || !goal.trim() || !!motorBlock}
                      title={motorBlock ?? undefined}
                      className="rounded-md bg-nori-h8ab135 text-foreground hover:bg-nori-h799c2a">
                      <Play className="mr-2 h-4 w-4" /> Start
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={stop}>
                      <Square className="mr-2 h-4 w-4" /> Stop
                    </Button>
                  )}
                  <Button size="sm" variant="destructive" className="font-bold" onClick={estop}
                    title="Stop the robot + abort the loop + zero motion, immediately">
                    <OctagonX className="mr-2 h-4 w-4" /> E-STOP
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
                <span>step {usage.steps}</span>
                <span>· ~{usage.outTokens} tok out</span>
                {usage.inTokens > 0 && <span>· {usage.inTokens} ctx</span>}
                {daily && (
                  <span className={budgetWarn ? "font-semibold text-nori-hb4442e" : ""}>
                    · today {fmtTokens(daily.spent)} tok
                  </span>
                )}
              </div>
            </div>

            {/* Soft "high token usage" note — the per-customer daily cap is enforced by the backend;
                this warns as you approach it. Past the hard cap, turns return 429 and the loop ends. */}
            {budgetWarn && daily?.warn != null && (
              <div className="flex flex-col gap-1 rounded-md border border-nori-hb4442e/40 bg-nori-hfbecea p-3 text-[11px] text-nori-h8a2f20 shadow-sm">
                <span className="font-mono uppercase tracking-[0.18em] text-nori-hb4442e">// high token usage</span>
                <span>You've used {fmtTokens(daily.spent)} agent tokens today (past the {fmtTokens(daily.warn)} heads-up mark){daily.allowed != null ? ` of a ${fmtTokens(daily.allowed)} daily limit` : ""}. Approaching the cap — turns stop once it's reached.</span>
              </div>
            )}

            {/* Motors not ready. Rendered ABOVE the confirm banner because it is the reason the
                run cannot start at all — and because a disarmed A3 is otherwise indistinguishable
                from a robot that simply refuses to move. */}
            {motorBlock && (
              <div className="flex flex-col gap-1 rounded-md border border-nori-hd98b3d/50 bg-nori-hfdf3e6 p-3 text-[11px] text-nori-h8a2f20 shadow-sm">
                <span className="font-mono uppercase tracking-[0.18em] text-nori-hb06a1c">// motors not ready</span>
                <span>{motorBlock}</span>
              </div>
            )}

            {/* Confirm-before-first-motion banner */}
            {pendingMotion && (
              <div className="flex flex-col gap-2 rounded-md border border-nori-hd98b3d/50 bg-nori-hfdf3e6 p-4 shadow-sm">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">// approve first motion?</span>
                <code className="block break-all rounded bg-nori-hfffdf7 px-2 py-1 text-[11px] text-nori-h5a5346">
                  {pendingMotion.name}({JSON.stringify(pendingMotion.input ?? {})})
                </code>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => confirmResolveRef.current?.(true)}
                    className="rounded-md bg-nori-h8ab135 text-foreground hover:bg-nori-h799c2a">
                    <Check className="mr-2 h-4 w-4" /> Approve
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => confirmResolveRef.current?.(false)}>
                    <X className="mr-2 h-4 w-4" /> Deny
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Right: transcript */}
          <div className="flex h-full min-w-0 min-h-0 flex-col gap-2 rounded-md border border-nori-h14131a/10 bg-nori-hf6f4eb p-4 text-nori-h14131a shadow-sm">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">// transcript</span>
            <div ref={scrollRef} className="flex-1 min-w-0 space-y-2 overflow-y-auto overflow-x-hidden rounded-md border border-nori-h14131a/10 bg-nori-hf3f1e8 p-3 text-xs text-nori-h5a5346">
              {rows.length === 0 ? (
                <span className="font-mono text-muted-foreground">The agent's reasoning, tool calls, and frames appear here.</span>
              ) : rows.map((r, i) => <TranscriptRow key={i} row={r} />)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

const TranscriptRow = ({ row }: { row: Row }) => {
  // Every text row wraps (break-words / break-all) so a long tool_result JSON or an unbroken token
  // can't push the transcript into a wide horizontal scroll.
  switch (row.kind) {
    case "goal":
      return <div className="whitespace-pre-wrap break-words font-mono text-[11px] text-nori-hb06a1c">▸ goal: {row.text}</div>;
    case "say":
      return <div className="whitespace-pre-wrap break-words">{row.text}</div>;
    case "call":
      return (
        <div className="whitespace-pre-wrap break-all font-mono text-[11px] text-nori-h4d6a1e">
          → {row.tool}({compactArgs(row.input)})
        </div>
      );
    case "result":
      if (row.imageDataUrl) {
        return <img src={row.imageDataUrl} alt="frame the agent looked at" className="max-h-40 w-auto rounded border border-nori-h14131a/20" />;
      }
      return (
        <div className={"whitespace-pre-wrap break-all font-mono text-[11px] " + (row.ok ? "text-nori-h857b6b" : "text-nori-hb4442e")}>
          {row.ok ? "↳ " : "✗ "}{row.text ?? "ok"}
        </div>
      );
    case "end":
      return <div className="whitespace-pre-wrap break-words font-mono text-[11px] font-semibold text-nori-hb06a1c">{END_LABEL[row.reason]}{row.detail ? ` — ${row.detail}` : ""}</div>;
  }
};

// Compact token count: 500000 -> "500k", 12345 -> "12.3k", <1000 -> as-is.
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
}

// Short one-line arg preview for a tool-call chip (full object would wrap the transcript).
function compactArgs(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length <= 80 ? s.slice(1, -1) : s.slice(1, 79) + "…";
}

export default Agent;
