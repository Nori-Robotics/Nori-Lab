// NORI: "Agent" — the console for the ASPIRE System 2 agent (nori-policy-agent synthesis/aspire_service).
//
// The operator types a GOAL; the page queues a task on the active robot (POST /aspire/tasks) and the HOSTED
// worker runs the look→think→act loop: the model decides, the executor moves the robot through the Nori SDK
// under the bench safety layer. Nothing executes in the browser. The page only supervises:
//
//   transcript   the task's events, polled as JSON (thought / say / step / refused / needs_input / done ...), with
//                every frame a tool returned to the model shown inline -- exactly what the agent looked at (the
//                page cannot open its own video: the task holds the robot's single remote session)
//   STOP/E-STOP  POST .../cancel: the executor zeroes motion, sends E-STOP and waits for the robot to confirm
//                the latch BEFORE the task is reported cancelled. (A connected teleop session, if any, gets a
//                direct estop too.)
//   deadman      while a task runs the page checks in every PRESENCE_MS; a task started with "stop if I close
//                this page" (constraints.operator_presence) is cancelled by the backend when the check-ins stop,
//                so closing the tab (or navigating away) stops the robot within a few seconds.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Play, Square, OctagonX, Bot, Send, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { useNori } from "@/nori/NoriContext";
import { useApi } from "@/contexts/ApiContext";
import { friendlyErrorMessage } from "@/lib/apiClient";
import {
  aspireApi, RobotBusyError, TERMINAL,
  type TaskEvent, type TaskRecord, type TaskStatus,
} from "@/nori/aspire/api";

const EVENTS_MS = 700;      // transcript poll
const RECORD_MS = 2000;     // task record poll (status, usage, waiting_for_answer)
const PRESENCE_MS = 2000;   // deadman check-in (the backend cancels after 6 s without one)

// A rendered transcript line. Rows are a pure function of the event list (toRows below).
type Row =
  | { kind: "goal"; text: string }
  | { kind: "info"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "say"; text: string }
  | { kind: "call"; tool: string; args: Record<string, unknown>; pending: boolean; status?: string; result?: string }
  | { kind: "frame"; tool: string; src: string }
  | { kind: "refused"; tool: string; reason: string }
  | { kind: "question"; text: string; answered?: string }
  | { kind: "safety"; text: string }
  | { kind: "end"; status: TaskStatus; text: string };

// Event types the transcript renders. Everything else is plumbing — queued/claimed/preflight/armed/table/
// start_check/started/home/safety/record… — and that is exactly what the logs card shows: how the worker
// got to the robot (claim → credentials → session → arming → table) and why it did not, when it did not.
const TRANSCRIPT_TYPES = new Set([
  "thought", "say", "step_start", "step", "frame", "needs_input", "answered", "done", "failed", "cancelled",
]);

/** One log line per non-transcript event: `HH:MM:SS type key=value …`, the payload compacted so an unknown
 * event type from a newer worker still reads. `done`/`failed`/`cancelled` are repeated here too so the log ends. */
export function toLogLines(events: TaskEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (TRANSCRIPT_TYPES.has(e.type) && !["failed", "cancelled", "done"].includes(e.type)) continue;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      if (k === "n" || k === "ts" || k === "type" || k === "jpeg_b64" || v == null) continue;
      rest[k] = typeof v === "string" && v.length > 160 ? v.slice(0, 157) + "…" : v;
    }
    const when = typeof e.ts === "number" ? new Date(e.ts * 1000).toLocaleTimeString([], { hour12: false }) : "--:--:--";
    const body = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
    out.push(`${when}  ${e.type}${body ? "  " + body : ""}`);
  }
  return out;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "queued — waiting for a worker", claiming: "starting", running: "running",
  done: "finished", failed: "failed", cancelled: "stopped",
};

/** Events -> transcript rows. A `step_start` is a pending call until its `step` arrives (same tool, in order); the
 * `frame` events that follow a step are the images that tool returned to the model. */
export function toRows(instruction: string, events: TaskEvent[]): Row[] {
  const rows: Row[] = [{ kind: "goal", text: instruction }];
  const pending: number[] = [];                                  // indexes of unresolved call rows
  const str = (v: unknown, n = 300) => (v == null ? "" : String(v)).slice(0, n);
  for (const e of events) {
    switch (e.type) {
      case "queued": case "claimed": break;                     // plumbing; the status chip shows these
      case "started":
        rows.push({ kind: "info", text: `started on ${str(e.robot)} · model ${str(e.model)} · ${str(e.grant)} session` });
        break;
      case "home":
        rows.push({ kind: "info", text: e.ok ? `homed the ${str(e.side)} arm to the high-side pose (${str(e.duration_s)} s)`
          : `homing skipped: ${str(e.skipped ?? e.reason)}` });
        break;
      case "thought": rows.push({ kind: "thought", text: str(e.text, 2000) }); break;
      case "say": rows.push({ kind: "say", text: str(e.text) }); break;
      case "step_start":
        pending.push(rows.length);
        rows.push({ kind: "call", tool: str(e.tool), args: (e.args as Record<string, unknown>) ?? {}, pending: true });
        break;
      case "step": {
        const i = pending.shift();
        const row = i != null ? rows[i] : null;
        if (row && row.kind === "call" && row.tool === e.tool) {
          rows[i!] = { ...row, pending: false, status: str(e.status), result: str(e.result) };
        } else {
          rows.push({ kind: "call", tool: str(e.tool), args: (e.args as Record<string, unknown>) ?? {}, pending: false, status: str(e.status), result: str(e.result) });
        }
        break;
      }
      case "frame":
        if (typeof e.jpeg_b64 === "string" && e.jpeg_b64) rows.push({ kind: "frame", tool: str(e.tool), src: `data:image/jpeg;base64,${e.jpeg_b64}` });
        break;
      case "refused": rows.push({ kind: "refused", tool: str(e.tool), reason: str(e.reason) }); break;
      case "needs_input": rows.push({ kind: "question", text: str(e.question, 400) }); break;
      case "answered": {
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (r.kind === "question" && !r.answered) { rows[i] = { ...r, answered: str(e.text, 400) }; break; }
        }
        break;
      }
      case "safety":
        if (e.ok === false) rows.push({ kind: "safety", text: `${str(e.check)}: ${str(e.reason)}` });
        break;
      case "operator_lost": rows.push({ kind: "safety", text: str(e.reason) }); break;
      case "done": {
        const ok = e.success_claim === true;
        rows.push({ kind: "end", status: "done", text: `${ok ? "✓ goal reached" : "finished without success"}${e.summary ? ` — ${str(e.summary, 500)}` : ""}` });
        break;
      }
      case "failed": rows.push({ kind: "end", status: "failed", text: `failed — ${str(e.reason)}` }); break;
      case "cancelled": rows.push({ kind: "end", status: "cancelled", text: `■ stopped${e.reason ? ` — ${str(e.reason)}` : ""}` }); break;
      default: break;                                             // progress/collect events the page does not show
    }
  }
  return rows;
}

const Agent = () => {
  const {
    teleop, running: appSessionUp, connecting: appSessionJoining, disconnect: closeAppSession, setYield,
    heldNote, clearEstopLatch,
  } = useTeleopSession();
  const { activeRobotSerial, customer } = useNori();
  const { baseUrl, fetchWithHeaders } = useApi();
  const api = useMemo(() => aspireApi(baseUrl, fetchWithHeaders), [baseUrl, fetchWithHeaders]);

  const robot = activeRobotSerial ?? customer?.robot_serial_number ?? "";
  const [goal, setGoal] = useState("");
  const [presence, setPresence] = useState(true);               // stop the robot if this page goes away
  const [homeFirst, setHomeFirst] = useState(true);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [record, setRecord] = useState<TaskRecord | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sinceRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const [showLog, setShowLog] = useState(true);
  // Page-side notes (what THIS page did: closed its session, attached, cancelled) go in the same log so
  // the order of app actions vs worker events is visible. Stamped like the worker lines.
  const [pageNotes, setPageNotes] = useState<string[]>([]);
  const note = useCallback((text: string) => {
    const when = new Date().toLocaleTimeString([], { hour12: false });
    setPageNotes((prev) => [...prev.slice(-100), `${when}  page  ${text}`]);
  }, []);

  const status = record?.status ?? null;
  const active = !!taskId && status !== null && !TERMINAL.has(status);
  const rows = useMemo(() => toRows(record?.instruction ?? goal, events), [record?.instruction, goal, events]);
  const openQuestion = record?.waiting_for_answer && rows.some((r) => r.kind === "question" && !r.answered);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [rows]);

  // The logs card: the worker's plumbing events + this page's notes. NOT the app's own robot-session log — that
  // is the operator's teleop session (Remote page's Robot logs), nothing to do with how the task reached the robot.
  const logText = useMemo(() => [...pageNotes, ...toLogLines(events)], [events, pageNotes]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logText, showLog]);
  useEffect(() => { if (heldNote) note(`robot: ${heldNote}`); }, [heldNote, note]);

  // -- polling while a task is open ----------------------------------------------------------------------------
  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    // One fetch in flight at a time: the immediate first tick and the interval's first tick used to overlap with the
    // same cursor, so the opening events (queued, claimed) arrived twice. The cursor advances only when a fetch returns,
    // and the merge drops anything at or below the last `n` already shown as a second guard.
    let inflight = false;
    const tick = async () => {
      if (stop || inflight) return;
      inflight = true;
      try {
        const evs = await api.events(taskId, sinceRef.current);
        if (evs.length && !stop) {
          sinceRef.current = evs[evs.length - 1].n + 1;
          setEvents((prev) => {
            const last = prev.length ? prev[prev.length - 1].n : -1;
            return [...prev, ...evs.filter((e) => e.n > last)];
          });
        }
      } catch (e) { setError(friendlyErrorMessage(e)); }
      finally { inflight = false; }
    };
    const rec = async () => {
      if (stop) return;
      try { const r = await api.task(taskId); if (!stop) setRecord(r); } catch (e) { setError(friendlyErrorMessage(e)); }
    };
    void tick(); void rec();
    const a = setInterval(tick, EVENTS_MS), b = setInterval(rec, RECORD_MS);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, [api, taskId]);

  // The deadman: check in while the task is active. Unmounting (tab closed, navigated away) ends the check-ins,
  // and a presence-supervised task is then cancelled by the backend — robot stopped first.
  useEffect(() => {
    if (!taskId || !active || !presence) return;
    let stop = false;
    const beat = async () => { if (!stop) { try { await api.presence(taskId); } catch { /* retried next beat */ } } };
    void beat();
    const t = setInterval(beat, PRESENCE_MS);
    return () => { stop = true; clearInterval(t); };
  }, [api, taskId, active, presence]);

  // The robot has ONE session. The gateway treats a `ready` from the same operator as a page refresh that replaces
  // the live session, and the hosted worker drives the robot under this customer's identity: with this app still
  // connected, the app and the worker preempt each other every few seconds and the task never gets past the
  // handshake (0003, 2026-10-30). So: close this app's session before a task starts (or before following one that
  // is already running), and refuse to reconnect while it is active (TeleopSessionContext.setYield).
  const [yieldedNote, setYieldedNote] = useState<string | null>(null);
  const yieldRobot = useCallback(async () => {
    if (appSessionUp || appSessionJoining || teleop) {
      await closeAppSession();
      setYieldedNote(`closed this app's session to ${robot || "the robot"}: ASPIRE holds the robot's one session while the task runs; reconnect from Remote when it ends`);
      note(`closed this app's robot session so the task can take ${robot || "the robot"}`);
    }
  }, [appSessionUp, appSessionJoining, teleop, closeAppSession, robot, note]);
  useEffect(() => {
    setYield("agent-task", active ? `ASPIRE task running on ${robot || "the robot"} (Agent page)` : null);
    return () => setYield("agent-task", null);
  }, [setYield, active, robot]);

  // -- actions ---------------------------------------------------------------------------------------------------
  const attach = useCallback((id: string) => {
    sinceRef.current = 0;
    setEvents([]); setRecord(null); setError(null); setTaskId(id);
    note(`following task ${id.slice(0, 8)}`);
  }, [note]);

  const start = async (clearFirst = false) => {
    if (busy || !goal.trim() || !robot) return;
    if (latchHint && !clearFirst) { setConfirmClear(true); return; }   // ask once; the dialog calls start(true)
    setBusy(true); setError(null);
    if (clearFirst) {
      note("clearing the E-stop latch before starting");
      try { const r = await clearEstopLatch(); note(r); }
      catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        note(`clear E-stop latch failed: ${m}`); setError(`Could not clear the E-stop latch, not starting: ${m}`); setBusy(false); return;
      }
    }
    note(`start requested on ${robot}`);
    try {
      await yieldRobot();
      const r = await api.start({
        robot, instruction: goal.trim(),
        constraints: { operator_presence: presence, home: homeFirst },
        caller: { kind: "lab_agent_page" },
      });
      attach(r.task_id);
    } catch (e) {
      note(`start failed: ${friendlyErrorMessage(e)}`);
      if (e instanceof RobotBusyError) {
        setError("This robot already has a task running" + (e.running ? " — showing it." : "."));
        if (e.running) { await yieldRobot(); attach(e.running); }
      } else setError(friendlyErrorMessage(e));
    } finally { setBusy(false); }
  };

  const cancel = async (reason: string) => {
    if (!taskId) return;
    note(`cancel: ${reason}`);
    try { await api.cancel(taskId, reason); } catch (e) { setError(friendlyErrorMessage(e)); }
  };
  const stop = () => void cancel("stopped from the Agent page");
  const estop = () => {
    void cancel("E-STOP from the Agent page");                  // the backend cancels the task; the worker's guard stops the robot
    teleop?.command("estop");                                   // a teleop session open in this app, if any (none during a task: see yieldRobot)
  };

  // A task that fails after its first commanded motion E-stops the robot and the latch stays; the next task then
  // refuses at preflight ("motion daemon offline: estop_latched"). Clear it from here instead of going to Remote.
  const clearLatch = async () => {
    if (clearing || active) return;
    setClearing(true); setError(null);
    note("clearing the E-stop latch: opening this app's robot session, reset_latch, closing");
    try { const r = await clearEstopLatch(); note(r); setYieldedNote(r); }
    catch (e) { const m = e instanceof Error ? e.message : String(e); note(`clear E-stop latch failed: ${m}`); setError(`Could not clear the E-stop latch: ${m}`); }
    finally { setClearing(false); }
  };
  // The previous task on this page latched the robot's E-stop: it failed after its first commanded motion (the
  // worker's stop path latches then), or its reason names the latch. Start then offers "clear it and start" as ONE
  // explicit click — never silently: the page cannot tell this latch from one a person set on purpose.
  const lastFailure = [...events].reverse().find((e) => e.type === "failed");
  const latchHint = !active && !!lastFailure && (
    lastFailure.before_motion === false || (typeof lastFailure.reason === "string" && /estop_latched|E-stop/i.test(lastFailure.reason)));
  const [confirmClear, setConfirmClear] = useState(false);

  const sendAnswer = async () => {
    if (!taskId || !answer.trim()) return;
    try { await api.answer(taskId, answer.trim()); setAnswer(""); } catch (e) { setError(friendlyErrorMessage(e)); }
  };

  const usage = record?.usage ?? {};
  const statusChip = status
    ? `${STATUS_LABEL[status]}${status === "running" && typeof usage.llm_calls === "number" ? ` · ${usage.llm_calls} turns` : ""}`
    : robot ? `ready · ${robot}` : "no robot paired";

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
            <p className="text-sm text-muted-foreground">look → think → act on the robot · the transcript shows what it sees · STOP / E-STOP below</p>
          </div>
          <span className={"inline-flex h-9 items-center rounded-full px-3 font-mono text-xs " + (active ? "bg-nori-h8ab135/25 text-nori-h4d6a1e" : "bg-nori-h14131a/8 text-nori-h857b6b")}>
            ● {statusChip}
          </span>
        </div>

        <div className="grid h-[calc(100vh-12rem)] grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Left: goal + controls + overhead view */}
          <div className="flex h-full min-w-0 min-h-0 flex-col gap-4">
            <div className="flex flex-col gap-2 rounded-md border border-nori-h14131a/10 bg-nori-hf6f4eb p-4 text-nori-h14131a shadow-sm">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">// goal</span>
              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Describe the task, e.g. 'Pick up the can on the table. Use the left arm.'"
                className="min-h-[80px] resize-none border-nori-h14131a/12 bg-nori-hfffdf7"
                disabled={active}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                  <label className="flex items-center gap-1.5" title="Cancel the task (robot stopped first) if this page closes or stops responding.">
                    <input type="checkbox" checked={presence} disabled={active} onChange={(e) => setPresence(e.target.checked)} />
                    stop if I close this page
                  </label>
                  <label className="flex items-center gap-1.5" title="Move the working arm from rest to the high-side staging pose before the first turn.">
                    <input type="checkbox" checked={homeFirst} disabled={active} onChange={(e) => setHomeFirst(e.target.checked)} />
                    home the arm first
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  {!active ? (
                    <Button size="sm" onClick={() => void start()} disabled={busy || !robot || !goal.trim()}
                      className="rounded-md bg-nori-h8ab135 text-foreground hover:bg-nori-h799c2a" title={robot ? undefined : "Pair a robot first"}>
                      <Play className="mr-2 h-4 w-4" /> Start
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={stop} title="Cancel the task; the executor stops the robot first">
                      <Square className="mr-2 h-4 w-4" /> Stop
                    </Button>
                  )}
                  {/* One button, two states (like Remote's E-STOP / unlatch): while a task runs, or this app has its own
                      session open, it is E-STOP. With nothing running there is nothing to stop, and the only useful act is
                      clearing the latch a failed task left behind. */}
                  {active || teleop ? (
                    <Button size="sm" variant="destructive" className="font-bold" onClick={estop}
                      title="Stop the robot now: zero motion + E-STOP latch, then end the task">
                      <OctagonX className="mr-2 h-4 w-4" /> E-STOP
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={clearLatch} disabled={clearing || busy || !robot}
                      className={latchHint ? "border-nori-hd98b3d text-nori-hb06a1c" : undefined}
                      title="Clear the robot's software E-stop latch (a failed task leaves it set): opens this app's robot session, sends reset_latch, waits for motion online, closes the session">
                      <RotateCcw className="mr-2 h-4 w-4" /> {clearing ? "Clearing latch…" : "Clear E-stop latch"}
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
                {robot && <span>robot {robot}</span>}
                {typeof usage.llm_calls === "number" && <span>· {usage.llm_calls} turns</span>}
                {typeof usage.output_tokens === "number" && usage.output_tokens > 0 && <span>· ~{fmtTokens(usage.output_tokens)} tok out</span>}
                {record?.budget?.seconds && <span>· budget {record.budget.seconds}s / {record.budget.llm_calls} turns</span>}
                {taskId && <span className="truncate">· task {taskId.slice(0, 8)}</span>}
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-nori-hb4442e/40 bg-nori-hfbecea p-3 text-[11px] text-nori-h8a2f20 shadow-sm">{error}</div>
            )}
            {yieldedNote && (
              <div className="rounded-md border border-nori-hd98b3d/50 bg-nori-hfdf3e6 p-3 text-[11px] text-nori-hb06a1c shadow-sm">{yieldedNote}</div>
            )}

            {openQuestion && (
              <div className="flex flex-col gap-2 rounded-md border border-nori-hd98b3d/50 bg-nori-hfdf3e6 p-4 shadow-sm">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">// the agent is asking</span>
                <div className="text-sm">{rows.filter((r) => r.kind === "question").slice(-1).map((r) => (r as { text: string }).text)}</div>
                <div className="flex items-center gap-2">
                  <input value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void sendAnswer(); }}
                    placeholder="Your answer…" className="flex-1 rounded border border-nori-h14131a/12 bg-nori-hfffdf7 px-2 py-1 text-sm" />
                  <Button size="sm" onClick={sendAnswer} disabled={!answer.trim()} className="rounded-md bg-nori-h8ab135 text-foreground hover:bg-nori-h799c2a">
                    <Send className="mr-2 h-4 w-4" /> Answer
                  </Button>
                </div>
              </div>
            )}

            {/* ASPIRE logs: how the worker reached the robot (claim → credentials → session → arming → table) and
                what this page did. The transcript is for what the agent thinks; this is for why a run did or
                did not get going. */}
            <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-md border border-nori-h14131a/10 bg-nori-hf6f4eb p-4 text-nori-h14131a shadow-sm">
              <button type="button" onClick={() => setShowLog((v) => !v)}
                className="flex items-center gap-1 self-start font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">
                {showLog ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {"// aspire logs"}
                <span className="ml-2 normal-case tracking-normal text-muted-foreground">{logText.length} lines</span>
              </button>
              {showLog && (
                <div ref={logRef} className="min-h-[120px] flex-1 overflow-y-auto overflow-x-hidden rounded-md border border-nori-h14131a/10 bg-nori-hf3f1e8 p-3 font-mono text-[10.5px] leading-relaxed text-nori-h5a5346">
                  {logText.length === 0
                    ? <span className="text-muted-foreground">Worker events (claim, credentials, session, arming, table) and this page's actions appear here as a task starts.</span>
                    : logText.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>)}
                </div>
              )}
            </div>

          </div>

          {/* Right: transcript */}
          <div className="flex h-full min-w-0 min-h-0 flex-col gap-2 rounded-md border border-nori-h14131a/10 bg-nori-hf6f4eb p-4 text-nori-h14131a shadow-sm">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">// transcript</span>
            <div ref={scrollRef} className="flex-1 min-w-0 space-y-2 overflow-y-auto overflow-x-hidden rounded-md border border-nori-h14131a/10 bg-nori-hf3f1e8 p-3 text-xs text-nori-h5a5346">
              {!taskId ? (
                <span className="font-mono text-muted-foreground">The agent's thoughts, what it says, its tool calls, their results and the frames it looked at appear here.</span>
              ) : rows.map((r, i) => <TranscriptRow key={i} row={r} />)}
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>The robot's E-stop is latched</AlertDialogTitle>
            <AlertDialogDescription>
              The previous task left {robot || "the robot"}'s software E-stop latched. Starting now would fail at preflight.
              Clear the latch and start? Only do this if nobody stopped the robot on purpose and it is safe to move.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmClear(false); void start(true); }}>Clear latch and start</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};

const TranscriptRow = ({ row }: { row: Row }) => {
  // Every text row wraps (break-words / break-all) so a long result JSON or an unbroken token can't push the
  // transcript into a horizontal scroll.
  switch (row.kind) {
    case "goal":
      return <div className="whitespace-pre-wrap break-words font-mono text-[11px] text-nori-hb06a1c">▸ goal: {row.text}</div>;
    case "info":
      return <div className="whitespace-pre-wrap break-words font-mono text-[11px] text-nori-h857b6b">· {row.text}</div>;
    case "thought":
      return <div className="whitespace-pre-wrap break-words italic text-nori-h5a5346/80">{row.text}</div>;
    case "say":
      return <div className="whitespace-pre-wrap break-words rounded border border-nori-h8ab135/40 bg-nori-h8ab135/10 px-2 py-1 text-nori-h14131a">🗣 {row.text}</div>;
    case "call": {
      const ok = row.status === "ok";
      return (
        <div className="break-all font-mono text-[11px]">
          <div className={row.pending ? "text-nori-h857b6b" : "text-nori-h4d6a1e"}>
            {row.pending ? "… " : "→ "}{row.tool}({compactArgs(row.args)})
          </div>
          {!row.pending && row.result && (
            <div className={"whitespace-pre-wrap pl-3 " + (ok ? "text-nori-h857b6b" : "text-nori-hb4442e")}>{ok ? "↳ " : "✗ "}{row.result}</div>
          )}
        </div>
      );
    }
    case "frame":
      return <img src={row.src} alt={`what the agent saw (${row.tool})`} className="max-h-48 w-auto rounded border border-nori-h14131a/20" />;
    case "refused":
      return <div className="whitespace-pre-wrap break-words font-mono text-[11px] text-nori-hb4442e">✗ {row.tool} refused — {row.reason}</div>;
    case "question":
      return (
        <div className="whitespace-pre-wrap break-words rounded border border-nori-hd98b3d/50 bg-nori-hfdf3e6 px-2 py-1">
          ? {row.text}{row.answered ? <span className="block text-nori-h4d6a1e">↳ you: {row.answered}</span> : null}
        </div>
      );
    case "safety":
      return <div className="whitespace-pre-wrap break-words font-mono text-[11px] font-semibold text-nori-hb4442e">⚠ {row.text}</div>;
    case "end":
      return <div className="whitespace-pre-wrap break-words font-mono text-[11px] font-semibold text-nori-hb06a1c">{row.text}</div>;
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
  return s.length <= 90 ? s.slice(1, -1) : s.slice(1, 89) + "…";
}

export default Agent;
