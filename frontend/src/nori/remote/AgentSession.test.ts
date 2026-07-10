// NORI: unit tests for AgentSession (docs/agentic_vision_loop.md milestone 2) — the browser half of
// the agentic vision loop. Covers the tool dispatcher, the look/per-camera contract, the
// confirm-before-first-motion gate, image pruning, done/give_up, and the step cap. Pure: a fake
// teleop records driver side effects + serves snapshots; a scripted postTurn feeds turns. No
// hardware, no DOM, real timers with tiny motion durations so held jogs settle fast.

import { describe, expect, it, vi } from "vitest";
import type { ArmSide, CameraLayout, RemoteTeleop, TelemetryView } from "@nori/sdk";
import { AgentSession, type AgentBlock, type AgentTurn, type AgentEvent, type PostTurn } from "./AgentSession";

// ---- fakes -------------------------------------------------------------------

// A tool_use content block (what the model "emits").
const tool = (name: string, input: Record<string, unknown> = {}, id = name + "-1"): AgentBlock => ({
  type: "tool_use", id, name, input,
});
const turn = (content: AgentBlock[], stop_reason = "tool_use"): AgentTurn => ({ stop_reason, content });

// Minimal RemoteTeleop stand-in: the driver methods (setExternalJog/command/sendAction/action API)
// plus the AgentSession-specific surface (snapshot/cameraLayout/cameraLayoutInfo). The action API is
// a SILENT daemon so moveTo resolves via its client-side fallback quickly.
function makeFakeTeleop(opts: { layout?: CameraLayout | null; snapshot?: (settleMs: number, role?: string) => Blob | null } = {}) {
  const commands: string[] = [];
  const snapshots: Array<{ settleMs: number; role?: string }> = [];
  const layout = "layout" in opts ? opts.layout ?? null : { cols: 2, rows: 2, tiles: ["left_wrist", "right_wrist", "overhead", "front"] };
  const teleop = {
    setExternalJog: () => {},
    command: (c: string) => { commands.push(c); },
    sendAction: () => {},
    nextActionId: () => "act-1",
    actionStatus: () => null, // silent daemon
    awaitAction: () => new Promise<never>(() => {}), // never resolves → client fallback path
    snapshot: async (settleMs = 500, role?: string) => {
      snapshots.push({ settleMs, role });
      return opts.snapshot ? opts.snapshot(settleMs, role) : new Blob([Uint8Array.from([1, 2, 3])], { type: "image/jpeg" });
    },
    cameraLayout: () => (layout ? "2x2 layout" : null),
    cameraLayoutInfo: () => layout,
  } as unknown as RemoteTeleop;
  return { teleop, commands, snapshots };
}

const telWithState = (state: Record<string, number>) => ({ state } as unknown as TelemetryView);

// A scripted transport: returns queued turns in order, recording what it was called with.
function scriptedPostTurn(turns: AgentTurn[]) {
  const calls: Array<{ messages: unknown[]; robotState: unknown; cameraLayout: unknown }> = [];
  let i = 0;
  const postTurn: PostTurn = async (messages, robotState, cameraLayout) => {
    calls.push({ messages: structuredClone(messages), robotState, cameraLayout });
    return turns[Math.min(i++, turns.length - 1)];
  };
  return { postTurn, calls };
}

function setup(turns: AgentTurn[], override: Partial<Parameters<typeof makeAgent>[1]> = {}, fakeOpts = {}) {
  const fake = makeFakeTeleop(fakeOpts);
  const { postTurn, calls } = scriptedPostTurn(turns);
  const events: AgentEvent[] = [];
  const logs: string[] = [];
  const agent = makeAgent(fake.teleop, {
    postTurn,
    onEvent: (e) => events.push(e),
    onLog: (l) => logs.push(l),
    ...override,
  });
  agent.setTelemetry(telWithState({ "right_arm_shoulder_pan.pos": 12.4 }));
  return { agent, fake, calls, events, logs };
}

function makeAgent(teleop: RemoteTeleop, o: Omit<ConstructorParameters<typeof AgentSession>[0], "teleop">) {
  return new AgentSession({ teleop, ...o });
}

const finished = (events: AgentEvent[]) => events.find((e) => e.kind === "finished") as Extract<AgentEvent, { kind: "finished" }> | undefined;

// ---- tests -------------------------------------------------------------------

describe("loop termination", () => {
  it("ends on done and reports the summary", async () => {
    const { agent, events, logs } = setup([turn([tool("done", { summary: "cup grasped" })])]);
    await agent.run("pick up the cup");
    expect(finished(events)?.reason).toBe("done");
    expect(logs.some((l) => l.includes("cup grasped"))).toBe(true);
  });

  it("ends on give_up", async () => {
    const { agent, events } = setup([turn([tool("give_up", { reason: "no cup visible" })])]);
    await agent.run("pick up the cup");
    expect(finished(events)?.reason).toBe("give_up");
  });

  it("ends when the model stops calling tools (end_turn)", async () => {
    const { agent, events } = setup([turn([{ type: "text", text: "all done" }], "end_turn")]);
    await agent.run("do nothing");
    expect(finished(events)?.reason).toBe("end_turn");
  });

  it("aborts at the step cap", async () => {
    // Always returns a look turn → never terminates on its own; cap must stop it.
    const { agent, events } = setup([turn([tool("look")])], { maxSteps: 3, confirmFirstMotion: false });
    await agent.run("loop forever");
    expect(finished(events)?.reason).toBe("max_steps");
  });
});

describe("tool dispatch", () => {
  it("single-camera robot: bare look returns an image tool_result", async () => {
    const { agent, fake, calls } = setup([
      turn([tool("look")]),
      turn([tool("done", { summary: "" })]),
    ], {}, { layout: null });
    await agent.run("look around");
    expect(fake.snapshots).toEqual([{ settleMs: 500, role: undefined }]);
    // The second turn's messages must include the image tool_result we appended.
    const secondTurnMsgs = calls[1].messages as Array<{ role: string; content: AgentBlock[] }>;
    const toolResult = secondTurnMsgs.at(-1)!.content[0];
    expect(toolResult.type).toBe("tool_result");
    expect((toolResult.content as AgentBlock[])[0].type).toBe("image");
  });

  it("multi-camera robot: bare look errors and demands a camera", async () => {
    // Default fake has a 4-tile layout → bare look must not return the composite.
    const { agent, fake, calls } = setup([
      turn([tool("look")]),
      turn([tool("done", { summary: "" })]),
    ]);
    await agent.run("look around");
    expect(fake.snapshots).toEqual([]); // never even snapshotted
    const msgs = calls[1].messages as Array<{ content: AgentBlock[] }>;
    const result = msgs.at(-1)!.content[0];
    expect(result.is_error).toBe(true);
    expect((result.content as AgentBlock[])[0].text).toContain("multiple cameras");
    expect((result.content as AgentBlock[])[0].text).toContain("valid: left_wrist, right_wrist, overhead, front");
  });

  it("per-camera look forwards the role to snapshot", async () => {
    const { agent, fake } = setup([
      turn([tool("look", { camera: "overhead" })]),
      turn([tool("done", { summary: "" })]),
    ]);
    await agent.run("look overhead");
    expect(fake.snapshots[0]).toEqual({ settleMs: 500, role: "overhead" });
  });

  it("unknown camera errors with the valid roles and does NOT substitute the composite", async () => {
    const { agent, calls } = setup(
      [turn([tool("look", { camera: "nope" })]), turn([tool("done", { summary: "" })])],
      {},
      { snapshot: (_ms: number, role?: string) => (role === "nope" ? null : new Blob(["x"])) },
    );
    await agent.run("look at a bad camera");
    const msgs = calls[1].messages as Array<{ content: AgentBlock[] }>;
    const result = msgs.at(-1)!.content[0];
    expect(result.is_error).toBe(true);
    expect((result.content as AgentBlock[])[0].text).toContain("valid: left_wrist, right_wrist, overhead, front");
  });

  it("single-camera robot (no layout) errors a camera arg toward bare look", async () => {
    const { agent, calls } = setup(
      [turn([tool("look", { camera: "overhead" })]), turn([tool("done", { summary: "" })])],
      {},
      { layout: null, snapshot: () => null },
    );
    await agent.run("look");
    const msgs = calls[1].messages as Array<{ content: AgentBlock[] }>;
    expect((msgs.at(-1)!.content[0].content as AgentBlock[])[0].text).toContain("one camera");
  });

  it("get_state returns the cached telemetry state as JSON", async () => {
    const { agent, calls } = setup([
      turn([tool("get_state")]),
      turn([tool("done", { summary: "" })]),
    ], { confirmFirstMotion: false });
    await agent.run("check state");
    const msgs = calls[1].messages as Array<{ content: AgentBlock[] }>;
    const text = (msgs.at(-1)!.content[0].content as AgentBlock[])[0].text as string;
    expect(JSON.parse(text)["right_arm_shoulder_pan.pos"]).toBe(12.4);
  });

  it("move_to returns the driver's status string as the tool_result", async () => {
    const { agent, calls } = setup([
      turn([tool("move_to", { side: "right" as ArmSide, targets: { shoulder_pan: 12.4 } })]),
      turn([tool("done", { summary: "" })]),
    ], { confirmFirstMotion: false });
    await agent.run("go to pose");
    const msgs = calls[1].messages as Array<{ content: AgentBlock[] }>;
    // Target equals current pos (12.4) → immediate arrival → "done".
    expect((msgs.at(-1)!.content[0].content as AgentBlock[])[0].text).toBe("done");
  });

  it("play_audio rejects a non-https/data URL with an is_error (no fetch attempted)", async () => {
    const { agent, calls } = setup([
      turn([tool("play_audio", { url: "http://evil.example/x.mp3" })]),
      turn([tool("done", { summary: "" })]),
    ], { confirmFirstMotion: false });
    await agent.run("beep");
    const msgs = calls[1].messages as Array<{ content: AgentBlock[] }>;
    const result = msgs.at(-1)!.content[0];
    expect(result.is_error).toBe(true);
    expect((result.content as AgentBlock[])[0].text).toContain("https:// or data:");
  });

  it("a bad tool arg comes back as an is_error tool_result, not a throw", async () => {
    const { agent, calls } = setup([
      turn([tool("reach", { side: "right", dofs: { bogus: 1 }, ms: 1 })]),
      turn([tool("done", { summary: "" })]),
    ], { confirmFirstMotion: false });
    await agent.run("bad reach");
    const msgs = calls[1].messages as Array<{ content: AgentBlock[] }>;
    const result = msgs.at(-1)!.content[0];
    expect(result.is_error).toBe(true);
    expect((result.content as AgentBlock[])[0].text).toContain("unknown DOF");
  });
});

describe("confirm-before-first-motion gate", () => {
  it("asks before the first motion tool and proceeds when approved", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const { agent, events } = setup([
      turn([tool("reach", { side: "right", dofs: { x: 0.3 }, ms: 1 })]),
      turn([tool("done", { summary: "" })]),
    ], { onConfirmMotion: confirm });
    await agent.run("nudge forward");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(finished(events)?.reason).toBe("done");
  });

  it("does NOT ask for non-motion tools (look/get_state)", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const { agent } = setup([
      turn([tool("look")]),
      turn([tool("get_state")]),
      turn([tool("done", { summary: "" })]),
    ], { onConfirmMotion: confirm });
    await agent.run("look then think");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("only asks once — subsequent motions don't re-prompt", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const { agent } = setup([
      turn([tool("reach", { side: "right", dofs: { x: 0.2 }, ms: 1 })]),
      turn([tool("reach", { side: "right", dofs: { x: -0.2 }, ms: 1 })]),
      turn([tool("done", { summary: "" })]),
    ], { onConfirmMotion: confirm });
    await agent.run("wiggle");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("aborts the run when motion is denied", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const { agent, events, logs } = setup([
      turn([tool("base", { linear: 0.3, ms: 1 })]),
    ], { onConfirmMotion: confirm });
    await agent.run("drive");
    expect(finished(events)?.reason).toBe("not_confirmed");
    expect(logs.some((l) => l.includes("not confirmed"))).toBe(true);
  });
});

describe("estop / stop", () => {
  it("estop latches the daemon and finishes with estop", async () => {
    // A turn that never resolves the run on its own; we estop after it starts. Use a resolvable
    // confirm so the first motion parks waiting, then estop mid-flight.
    const { agent, fake, events } = setup([turn([tool("look")]), turn([tool("look")])], {
      confirmFirstMotion: false,
    });
    const p = agent.run("go");
    agent.estop();
    await p;
    expect(fake.commands).toContain("estop");
    expect(finished(events)?.reason).toBe("estop");
  });
});

describe("image pruning", () => {
  it("keeps only the last N frames and stubs older ones", async () => {
    // 4 looks then done, keepLastImages: 2 → the two oldest images become text placeholders.
    // Multi-camera robot, so each look names a camera.
    const look = () => turn([tool("look", { camera: "overhead" })]);
    const { agent, calls } = setup([
      look(), look(), look(), look(),
      turn([tool("done", { summary: "" })]),
    ], { keepLastImages: 2, confirmFirstMotion: false });
    await agent.run("look a lot");
    // Inspect the final turn's messages (the fullest conversation). Images live nested inside
    // tool_result.content, so collect recursively.
    const finalMsgs = calls.at(-1)!.messages as Array<{ content: AgentBlock[] }>;
    const blocks: AgentBlock[] = [];
    const walk = (bs: AgentBlock[]) => bs.forEach((b) => { blocks.push(b); if (Array.isArray(b.content)) walk(b.content as AgentBlock[]); });
    finalMsgs.forEach((m) => walk(m.content));
    const images = blocks.filter((b) => b.type === "image");
    const stubs = blocks.filter((b) => b.type === "text" && b.text === "[earlier frame omitted]");
    expect(images.length).toBe(2);
    expect(stubs.length).toBe(2);
  });
});

describe("grounding passed to the transport", () => {
  it("forwards rounded robot_state and the camera layout string", async () => {
    const { agent, calls } = setup([turn([tool("done", { summary: "" })])]);
    await agent.run("noop");
    expect(calls[0].robotState).toEqual({ "right_arm_shoulder_pan.pos": 12.4 });
    expect(calls[0].cameraLayout).toBe("2x2 layout");
  });
});

describe("daily token budget (cost governance)", () => {
  it("emits a budget event carrying today's spend and the warn threshold", async () => {
    const t: AgentTurn = {
      stop_reason: "tool_use", content: [tool("done", { summary: "" })],
      daily: { spent: 820_000, warn: 800_000 },
    };
    const { agent, events } = setup([t]);
    await agent.run("noop");
    const budget = events.find((e) => e.kind === "budget") as Extract<AgentEvent, { kind: "budget" }>;
    expect(budget).toMatchObject({ spent: 820_000, warn: 800_000 });
  });

  it("finishes cleanly as 'budget' (not 'error') when a turn is refused for cost (429)", async () => {
    const fake = makeFakeTeleop();
    const events: AgentEvent[] = [];
    const postTurn: PostTurn = async () => {
      const { AgentBudgetError } = await import("./AgentSession");
      throw new AgentBudgetError("Daily agent token budget reached (500,000 / 500,000 tokens). Resets tomorrow.");
    };
    const agent = makeAgent(fake.teleop, { postTurn, onEvent: (e) => events.push(e) });
    await agent.run("anything");
    const fin = finished(events)!;
    expect(fin.reason).toBe("budget");
    expect(fin.detail).toContain("budget reached");
  });
});
