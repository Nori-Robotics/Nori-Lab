// NORI: parity tests for the hosted-LLM request assembly (promptAssembly.ts). These lock the
// browser-side request shape to what lelab/server.py builds, so a refactor can't silently change
// what the hosted Coding/Agent pages send to Nori-Backend's proxy. The prompt CONTENT itself is
// kept in sync by the gen_llm_prompts drift guard; this covers the assembly LOGIC around it.

import { describe, expect, it } from "vitest";
import {
  buildCodegenContent, buildAgentSystem, inferNewRun, dailyView,
} from "./promptAssembly";
import { NORI_AGENT_SYSTEM } from "./prompts.generated";
import type { AgentMessage } from "@/nori/remote/AgentSession";

describe("buildCodegenContent", () => {
  it("plain prompt → single text block, no image", () => {
    const c = buildCodegenContent({ prompt: "wave the left arm" });
    expect(c).toEqual([{ type: "text", text: "Request: wave the left arm" }]);
  });

  it("orders parts: code, state, image-note, perception, request, retry", () => {
    const c = buildCodegenContent({
      prompt: "go home",
      current_code: "await nori.home('left');",
      robot_state: { "left_arm_shoulder_pan.pos": 12 },
      image_b64: "AAAA",
      camera_layout: "tile0=overhead",
      perception_active: false,
      retry_note: "output only JS",
    });
    // image block is prepended; text block is last
    expect(c[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
    const text = (c[1] as { text: string }).text;
    const order = [
      text.indexOf("Current code:"),
      text.indexOf("Current robot state"),
      text.indexOf("A still photo"),
      text.indexOf("Perception: nori.perceive() is NOT"),
      text.indexOf("Request: go home"),
      text.indexOf("IMPORTANT: output only JS"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b)); // strictly increasing => right order
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(text).toContain('"left_arm_shoulder_pan.pos":12');
    expect(text).toContain("Camera layout (which tile is which): tile0=overhead");
  });

  it("perception_active true vs false vs undefined", () => {
    expect(JSON.stringify(buildCodegenContent({ prompt: "x", perception_active: true })))
      .toContain("a detector IS feeding");
    expect(JSON.stringify(buildCodegenContent({ prompt: "x", perception_active: false })))
      .toContain("is NOT receiving frames");
    // undefined → no perception line at all
    expect(JSON.stringify(buildCodegenContent({ prompt: "x" }))).not.toContain("Perception:");
  });

  it("image note omits the layout suffix when no camera_layout is given", () => {
    const text = (buildCodegenContent({ prompt: "x", image_b64: "AA" })[1] as { text: string }).text;
    expect(text).toContain("A still photo from the robot's camera is attached");
    expect(text).not.toContain("Camera layout");
  });
});

describe("buildAgentSystem", () => {
  it("no grounding → base prompt unchanged", () => {
    expect(buildAgentSystem(undefined, undefined)).toBe(NORI_AGENT_SYSTEM);
  });

  it("folds camera layout + robot state into a CONTEXT suffix", () => {
    const s = buildAgentSystem({ "x.pos": 3 }, "tile0=front");
    expect(s.startsWith(NORI_AGENT_SYSTEM)).toBe(true);
    expect(s).toContain("CONTEXT FOR THIS RUN:");
    expect(s).toContain("Camera layout (which composite tile is which): tile0=front");
    expect(s).toContain('Current robot state (proprioceptive, normalized): {"x.pos":3}');
  });

  it("only robot state (no layout) still appends context", () => {
    const s = buildAgentSystem({ "x.pos": 3 }, undefined);
    expect(s).toContain("CONTEXT FOR THIS RUN:");
    // the GROUNDING camera-layout line is absent (the base prompt mentions "Camera layout" itself,
    // so we check for the specific folded line, not the bare phrase)
    expect(s).not.toContain("Camera layout (which composite tile is which):");
  });
});

describe("inferNewRun", () => {
  const user = (t: string): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }] });
  const asst = (t: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text: t }] });

  it("true on the first turn (no assistant message yet)", () => {
    expect(inferNewRun([user("goal")])).toBe(true);
  });
  it("false once the assistant has spoken", () => {
    expect(inferNewRun([user("goal"), asst("ok"), user("result")])).toBe(false);
  });
});

describe("dailyView", () => {
  it("maps backend budget keys → the page's daily shape", () => {
    expect(dailyView({
      used_today: 15000,
      allowed_today: 1_000_000,
      remaining_today: 985_000,
      soft_warn_threshold: 800_000,
      hard_capped: false,
    })).toEqual({ spent: 15000, allowed: 1_000_000, remaining: 985_000, warn: 800_000, capped: false });
  });

  it("defaults sanely when the budget is missing/partial", () => {
    expect(dailyView(undefined)).toEqual({ spent: 0, allowed: null, remaining: null, warn: null, capped: false });
    expect(dailyView({ used_today: 5, hard_capped: true }))
      .toEqual({ spent: 5, allowed: null, remaining: null, warn: null, capped: true });
  });
});

describe("buildAgentSystem joint grounding (H2)", () => {
  it("a descriptor adds a joint override line naming THIS robot's joints", () => {
    const descriptor = {
      joints: ["left", "right"].flatMap((s) =>
        ["shoulder_pitch", "elbow_pitch", "gripper"].map((j) => `${s}_arm_${j}.pos`)),
      ranges: {},
    } as never;
    const s = buildAgentSystem(undefined, undefined, descriptor);
    expect(s).toContain("CONTEXT FOR THIS RUN:");
    expect(s).toContain("shoulder_pitch, elbow_pitch, gripper");
    expect(s).toContain("OVERRIDE");
  });

  it("no descriptor leaves the prompt byte-identical (the legacy path)", () => {
    expect(buildAgentSystem(undefined, undefined, null)).toBe(NORI_AGENT_SYSTEM);
  });
});
