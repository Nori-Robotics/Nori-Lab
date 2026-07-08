// NORI: Additive file. The script sandbox (docs/llm_integration_plan.md, Phase B).
//
// A module Web Worker that runs pasted / LLM-generated TS-transpiled-to-JS against an injected
// async `robot` API. Two structural safety properties, both load-bearing:
//   1. This worker CANNOT reach the RTCDataChannel — it lives on the main thread. The only way
//      script code moves the robot is by posting an op that the main-thread ScriptDriver
//      validates. That is what enforces "SDK-or-nothing"; the neutering below is defense in depth.
//   2. worker.terminate() from the main thread kills a runaway script instantly (the plan's
//      required hard preempt) — no cooperative shutdown needed.
//
// Wire protocol (worker <-> main, both structured-clone-able plain objects):
//   main -> worker : { kind:"run", source }
//   worker -> main : { kind:"op", id, op, args }   (awaits a result)
//                    { kind:"log", line }
//                    { kind:"done" } | { kind:"error", message }
//   main -> worker : { kind:"result", id, result } | { kind:"error", id, message }

/// <reference lib="webworker" />
import { installPrimitives } from "./primitives";
import { neuterGlobals } from "./sandbox";

declare const self: DedicatedWorkerGlobalScope;

// ---- containment: neuter network/module escape hatches before any user code runs ------------
// The real guarantee is (1) above; this just removes the obvious footguns so a script can't even
// try to fetch/open a socket. The logic lives in sandbox.ts so it can be unit-tested (sandbox.test.ts).
neuterGlobals(self as unknown as Record<string, unknown>);

// ---- the op bridge: each robot.* call round-trips to the main thread --------------------------
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function callOp(op: string, args: unknown[]): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    self.postMessage({ kind: "op", id, op, args });
  });
}

// The injected vocabulary — the SDK-or-nothing surface (docs plan §"The robot API"). Every motion
// method is open-loop timed until protocol G1; the panel copy says so.
const robot = {
  reach: (side: "left" | "right", dofs: Record<string, number>, ms: number) =>
    callOp("reach", [side, dofs, ms]),
  joint: (side: "left" | "right", dofs: Record<string, number>, ms: number) =>
    callOp("joint", [side, dofs, ms]),
  grip: (side: "left" | "right", action: "open" | "close") => callOp("grip", [side, action]),
  base: (vec: { linear?: number; angular?: number }, ms: number) => callOp("base", [vec, ms]),
  lift: (side: "left" | "right", dir: number, ms: number) => callOp("lift", [side, dir, ms]),
  moveTo: (
    side: "left" | "right",
    targets: Record<string, number>,
    opts?: { slew?: number },
  ) => callOp("moveTo", [side, targets, opts]),
  wait: (ms: number) => callOp("wait", [ms]),
  telemetry: () => callOp("telemetry", []),
  // Phase F: latest world-state from the on-Pi detector (or null if none). Lets a script REACT to
  // what the robot sees: `const w = await robot.perceive(); if (w?.objects.find(o=>o.label==="cup"))…`
  perceive: () => callOp("perceive", []),
  playAudio: (url: string) => callOp("playAudio", [url]),
  reset: () => callOp("reset", []), // re-sync the IK cursor (call before reach() after joint())
  estop: () => callOp("estop", []),
  log: (...parts: unknown[]) => {
    self.postMessage({ kind: "log", line: parts.map(String).join(" ") });
  },
};

// D2: add the composed primitive library (robot.home / stow / gripSequence / wave) onto `robot`.
installPrimitives(robot);

// Capture the AsyncFunction constructor BEFORE user code so we can build the runner even if the
// script tampers with globals. `robot` is the only injected name; everything else is whatever the
// worker global still exposes (minus the blocked hatches).
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (robot: typeof robotApi) => Promise<void>;
const robotApi = robot;

async function runUserCode(source: string): Promise<void> {
  const fn = new AsyncFunction("robot", source);
  await fn(robot);
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as
    | { kind: "run"; source: string }
    | { kind: "result"; id: number; result: unknown }
    | { kind: "error"; id: number; message: string };

  if (m.kind === "result") {
    pending.get(m.id)?.resolve(m.result);
    pending.delete(m.id);
    return;
  }
  if (m.kind === "error") {
    pending.get(m.id)?.reject(new Error(m.message));
    pending.delete(m.id);
    return;
  }
  if (m.kind === "run") {
    runUserCode(m.source).then(
      () => self.postMessage({ kind: "done" }),
      (err: unknown) =>
        self.postMessage({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
    );
  }
};
