// NORI: pure request-assembly for the hosted (LeLab-free) LLM path — the browser-side mirror of
// lelab/server.py's `_llm_prepare`, the agent grounding fold, and `_daily_view`.
//
// Split out from hostedLlm.ts (which owns the network/auth) so these functions have NO heavy import
// graph (only the generated prompt constants) and can be unit-tested in a plain Node vitest env.
// Parity with the Python is enforced by these tests + the gen_llm_prompts drift guard.

import { NORI_AGENT_SYSTEM } from "./prompts.generated";
// jointDofsFor is a pure descriptor lookup (no DOM/WebRTC) — the one SDK import this module
// needs so the live robot's joint vocabulary can override the generated prompt's L2 prose.
import { jointDofsFor } from "@nori/sdk";
import type { RobotDescriptor } from "@nori/sdk";
import type { AgentMessage } from "@/nori/remote/AgentSession";

// The logical codegen inputs the page gathers (same field set as LeLab's NoriLlmGenerateBody).
export interface CodegenRequest {
  prompt: string;
  current_code?: string;
  robot_state?: Record<string, number>;
  image_b64?: string;
  camera_layout?: string;
  perception_active?: boolean;
  retry_note?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };

export interface DailyBudget {
  spent: number;
  allowed: number | null;
  remaining: number | null;
  warn: number | null;
  capped: boolean;
}

// Build the codegen user message (text + optional leading image block). Mirror of `_llm_prepare`.
export function buildCodegenContent(body: CodegenRequest): ContentBlock[] {
  const parts: string[] = [];
  if (body.current_code) parts.push("Current code:\n```js\n" + body.current_code + "\n```");
  if (body.robot_state) {
    parts.push(
      "Current robot state (proprioceptive, normalized: arm joints ~[-100,100], grippers " +
        "[0,100], lifts in mm, base as velocities). Treat it as the STARTING pose and plan " +
        "moves relative to it:\n" + JSON.stringify(body.robot_state),
    );
  }
  if (body.image_b64) {
    const layout = body.camera_layout ? `\nCamera layout (which tile is which): ${body.camera_layout}` : "";
    parts.push("A still photo from the robot's camera is attached (one frame, not depth)." + layout);
  }
  if (body.perception_active !== undefined) {
    parts.push(
      body.perception_active
        ? "Perception: a detector IS feeding nori.perceive() frames right now — you may poll " +
            "it to react to objects (still handle null defensively)."
        : "Perception: nori.perceive() is NOT receiving frames right now and will return null — " +
            "do NOT rely on it; write a blind/telemetry-only routine.",
    );
  }
  parts.push(`Request: ${body.prompt}`);
  if (body.retry_note) parts.push(`IMPORTANT: ${body.retry_note}`);

  const content: ContentBlock[] = [{ type: "text", text: parts.join("\n\n") }];
  if (body.image_b64) {
    content.unshift({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: body.image_b64 },
    });
  }
  return content;
}

// Fold the run's grounding into the agent system prompt (a stable suffix), matching
// `nori_llm_agent`. Returns the base prompt unchanged when there's nothing to ground.
export function buildAgentSystem(
  robotState: Record<string, number> | undefined, cameraLayout: string | undefined,
  descriptor?: RobotDescriptor | null,
): string {
  const grounding: string[] = [];
  if (cameraLayout) grounding.push(`Camera layout (which composite tile is which): ${cameraLayout}`);
  if (robotState) grounding.push("Current robot state (proprioceptive, normalized): " + JSON.stringify(robotState));
  if (descriptor) {
    // The generated base prompt narrates the L2 anatomy (shoulder_pan, shoulder_lift, …).
    // A connected robot's ack descriptor is the truth; without this override an A3 agent is
    // taught six joints that don't exist while its real seven go unnamed.
    const left = jointDofsFor(descriptor, "left");
    const right = jointDofsFor(descriptor, "right");
    const arms = left.join(",") === right.join(",")
      ? `each arm has, torso out: ${left.join(", ")}`
      : `left arm: ${left.join(", ")}; right arm: ${right.join(", ")}`;
    grounding.push(
      `THIS robot's actual arm joints (${arms}). These OVERRIDE any joint names in the body ` +
      `layout above — command only these; other names are refused as unknown_joint.`,
    );
  }
  return grounding.length ? NORI_AGENT_SYSTEM + "\n\nCONTEXT FOR THIS RUN:\n" + grounding.join("\n") : NORI_AGENT_SYSTEM;
}

// First turn of a run has no assistant message yet (matches LeLab's new_run inference).
export function inferNewRun(messages: AgentMessage[]): boolean {
  return !messages.some((m) => m.role === "assistant");
}

// Backend agent-budget snapshot -> the `daily` shape the Agent page consumes. Mirror of `_daily_view`.
export function dailyView(budget: Record<string, unknown> | undefined): DailyBudget {
  const b = budget ?? {};
  return {
    spent: (b.used_today as number) ?? 0,
    allowed: (b.allowed_today as number | null) ?? null,
    remaining: (b.remaining_today as number | null) ?? null,
    warn: (b.soft_warn_threshold as number | null) ?? null,
    capped: (b.hard_capped as boolean) ?? false,
  };
}
