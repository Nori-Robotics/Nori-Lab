// NORI: Additive file. Main-side bridge for the script sandbox (docs/llm_integration_plan.md,
// Phase B3/B4). Owns the Worker + a ScriptDriver and translates worker ops into driver calls.
// The Coding page (pages/coding.tsx) talks to this, not to the worker or driver directly.
//
// It is the trust boundary: the worker is untrusted (it runs pasted / LLM code), so the *main*
// side enforces the whole-script wall-clock cap and is the only place that can preempt
// (worker.terminate() + driver.stop()). estop() is the louder tri-action.

import type { RemoteTeleop, TelemetryView } from "@nori/sdk";
import { ScriptDriver } from "./ScriptDriver";

// Whole-script budget. A well-behaved script finishes well inside this; a runaway (infinite loop
// that never awaits an op, or a script that just refuses to end) is force-killed. Distinct from
// the per-op MAX_HOLD_MS clamp inside ScriptDriver.
const DEFAULT_WALL_CLOCK_MS = 5 * 60_000;

export interface ScriptSessionOptions {
  teleop: RemoteTeleop;
  capRate?: number;
  wallClockMs?: number;
  onLog?: (line: string) => void; // nori.log() + driver status
  onDone?: () => void; // script finished (or was stopped)
  onError?: (message: string) => void; // uncaught script error / cap exceeded
}

type WorkerToMain =
  | { kind: "op"; id: number; op: string; args: unknown[] }
  | { kind: "log"; line: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export class ScriptSession {
  private readonly o: ScriptSessionOptions;
  private readonly driver: ScriptDriver;
  private worker: Worker | null = null;
  private wallClockTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;

  constructor(opts: ScriptSessionOptions) {
    this.o = opts;
    this.driver = new ScriptDriver({
      teleop: opts.teleop,
      capRate: opts.capRate,
      onLog: opts.onLog,
      onError: opts.onError,
    });
  }

  // Feed telemetry through to the driver so nori.telemetry() returns the latest frame.
  setTelemetry(t: TelemetryView): void {
    this.driver.setTelemetry(t);
  }

  // Start the driver heartbeat, spawn the worker, and run `source`. Idempotent-ish: call stop()
  // before re-running.
  run(source: string): void {
    if (this.worker) throw new Error("script already running; stop() first");
    this.finished = false;
    this.driver.start();

    // Vite bundles the worker from this `new URL(...)` form — no config change needed.
    const worker = new Worker(new URL("./scriptWorker.ts", import.meta.url), { type: "module" });
    this.worker = worker;

    worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(worker, e.data as WorkerToMain);
    worker.onerror = (e: ErrorEvent) => {
      this.o.onError?.(`[script] worker error: ${e.message}`);
      this.finish();
    };

    const budget = this.o.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    this.wallClockTimer = setTimeout(() => {
      this.o.onError?.(`[script] wall-clock cap (${Math.round(budget / 1000)}s) exceeded — killed`);
      this.finish();
    }, budget);

    worker.postMessage({ kind: "run", source });
  }

  // Clean stop (no E-STOP): kill the worker, release jog to keyboard.
  stop(): void {
    this.finish();
  }

  // Tri-action hard preempt (plan §Containment): latch the daemon AND kill the worker AND zero
  // jog. Never just latch under a still-streaming script.
  estop(): void {
    this.o.teleop.command("estop");
    this.finish();
  }

  private onWorkerMessage(worker: Worker, m: WorkerToMain): void {
    switch (m.kind) {
      case "op":
        this.driver.exec(m.op, m.args).then(
          (result) => worker.postMessage({ kind: "result", id: m.id, result }),
          (err: unknown) =>
            worker.postMessage({
              kind: "error",
              id: m.id,
              message: err instanceof Error ? err.message : String(err),
            }),
        );
        break;
      case "log":
        this.o.onLog?.(m.line);
        break;
      case "done":
        this.o.onLog?.("[script] finished");
        this.finish();
        break;
      case "error":
        this.o.onError?.(`[script] ${m.message}`);
        this.finish();
        break;
    }
  }

  // Idempotent teardown: stop driver, terminate worker, clear the cap timer, notify once.
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.wallClockTimer !== null) {
      clearTimeout(this.wallClockTimer);
      this.wallClockTimer = null;
    }
    this.driver.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.o.onDone?.();
  }
}
