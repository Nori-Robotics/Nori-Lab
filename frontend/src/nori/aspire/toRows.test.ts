import { describe, expect, it } from "vitest";
import { isAtBottom, toLogLines, toRows } from "@/nori/pages/agent";
import type { TaskEvent } from "@/nori/aspire/api";

const ev = (n: number, type: string, rest: Record<string, unknown> = {}): TaskEvent => ({ n, type, ...rest });

describe("toRows", () => {
  it("renders the executor's event stream as a transcript, pairing step_start with its step", () => {
    const rows = toRows("pick up the can", [
      ev(0, "queued"), ev(1, "claimed"),
      ev(2, "started", { robot: "NORI-A3-0003", model: "m", grant: "backend_task" }),
      ev(3, "home", { ok: true, side: "left", duration_s: 12.5 }),
      ev(4, "thought", { text: "Looking first." }),
      ev(5, "say", { text: "I'll look at the table." }),
      ev(6, "step_start", { tool: "observe", args: {} }),
      ev(7, "step", { tool: "observe", args: {}, result: "{\"status\": \"ok\"}", status: "ok" }),
      ev(8, "frame", { tool: "observe", jpeg_b64: "QUJD" }),
      ev(9, "frame", { tool: "observe", jpeg_b64: "" }),                       // an empty image is skipped
      ev(10, "step_start", { tool: "jog_arm", args: { x: 1, seconds: 2 } }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["goal", "info", "info", "thought", "say", "call", "frame", "call"]);
    expect(rows[5]).toMatchObject({ kind: "call", tool: "observe", pending: false, status: "ok" });
    expect(rows[6]).toMatchObject({ kind: "frame", tool: "observe", src: "data:image/jpeg;base64,QUJD" });
    expect(rows[7]).toMatchObject({ kind: "call", tool: "jog_arm", pending: true });
    expect(rows[2]).toMatchObject({ text: "homed the left arm to the high-side pose (12.5 s)" });
  });

  it("shows refusals, questions with their answers, safety trips and the end", () => {
    const rows = toRows("x", [
      ev(0, "step_start", { tool: "lift", args: { height: 0.9 } }),
      ev(1, "step", { tool: "lift", args: { height: 0.9 }, result: "{\"status\": \"geofence\"}", status: "ok" }),
      ev(2, "refused", { tool: "lift", reason: "lift 0.900 m outside [0.05, 0.55]" }),
      ev(3, "needs_input", { question: "Which can?" }),
      ev(4, "answered", { text: "the red one" }),
      ev(5, "safety", { check: "geofence", ok: false, reason: "hand x=0.132 m outside" }),
      ev(6, "safety", { check: "step", ok: true }),
      ev(7, "operator_lost", { reason: "operator_lost: the supervising page stopped checking in" }),
      ev(8, "cancelled", { reason: "operator_lost" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["goal", "call", "refused", "question", "safety", "safety", "end"]);
    expect(rows[3]).toMatchObject({ kind: "question", text: "Which can?", answered: "the red one" });
    expect(rows[6]).toMatchObject({ kind: "end", status: "cancelled", text: "■ stopped — operator_lost" });
  });

  it("labels the outcome", () => {
    expect(toRows("x", [ev(0, "done", { success_claim: true, summary: "Picked it up." })]).at(-1))
      .toMatchObject({ kind: "end", status: "done", text: "✓ goal reached — Picked it up." });
    expect(toRows("x", [ev(0, "done", { success_claim: false })]).at(-1)).toMatchObject({ text: "finished without success" });
    expect(toRows("x", [ev(0, "failed", { reason: "budget:llm_calls" })]).at(-1)).toMatchObject({ text: "failed — budget:llm_calls" });
  });

  it("shows the agent's thinking and the settings a run used", () => {
    const rows = toRows("x", [
      ev(0, "started", { robot: "r", model: "m", grant: "g", settings: { speed_factor: 0.6, table_z: 0.76, depth_model: "default", world_session: false, allow_base: true } }),
      ev(1, "think", { text: "the box is left of the gripper" }),
    ]);
    expect(rows[2]).toMatchObject({ kind: "info", text: "speed 0.6 · table 0.76 m · depth default · map off · base on · recording off" });
    expect(rows[3]).toMatchObject({ kind: "think", text: "the box is left of the gripper" });
  });

  it("keeps a log line short however much the event carried", () => {
    const [line] = toLogLines([ev(0, "video", { rtp: "x".repeat(150), more: "y".repeat(150), again: "z".repeat(150) })]);
    expect(line.length).toBeLessThanOrEqual(240);
  });

  it("shows what happened to the recording", () => {
    const rows = toRows("x", [
      ev(0, "episode_started", { episode: "episode-0001", free_gb: 41.2 }),
      ev(1, "episode_done", { episode: "episode-0001", keep: true, success_claim: false, seconds: 212.4 }),
      ev(2, "episode_done", { episode: "episode-0002", keep: false }),
      ev(3, "record_warning", { kind: "refused", detail: "already recording an episode" }),
    ]);
    expect(rows.slice(1).map((r) => ("text" in r ? r.text : ""))).toEqual([
      "recording episode-0001 · 41.2 GB free on the robot",
      "recording kept: episode-0001 as failure (212.4 s)",
      "recording discarded: episode-0002",
      "recording problem (refused): already recording an episode",
    ]);
    expect(rows[4].kind).toBe("safety");
  });

  it("leaves out a free-space figure the robot did not report", () => {
    expect(toRows("x", [ev(0, "episode_started", { episode: "episode-0001", free_gb: 0 })])[1]).toMatchObject({ text: "recording episode-0001" });
  });

  it("follows the transcript only near the bottom", () => {
    expect(isAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isAtBottom({ scrollHeight: 1000, scrollTop: 570, clientHeight: 400 })).toBe(true);
    expect(isAtBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false);
  });
});
