// NORI: hosted (LeLab-free) LLM path for the Coding + Agent pages.
//
// On the DESKTOP app the pages POST to LeLab's `/nori/llm/*`, which assembles the prompt +
// tools and forwards to Nori-Backend's gated/metered Anthropic proxy (the key lives on the
// backend). A hosted Vercel build has NO LeLab, so these two pages could never reach that path
// (they hit dead `localhost:8000`). This module reproduces LeLab's assembly IN THE BROWSER and
// calls the backend's generic proxy `/api/v1/agent/llm/messages(/stream)` directly with the
// Supabase JWT — auth + per-customer metering are unchanged (the backend gates + charges).
//
// The system prompts + tool schemas come from `prompts.generated.ts`, generated from the Python
// source of truth (lelab/server.py) — see scripts/gen_llm_prompts.py — so they can't drift.
//
// Only used when isDirectBackend() is true; the desktop path is untouched.

import { getAccessToken } from "@/nori/auth/session";
import { getDirectBackendUrl } from "@/nori/api/client";
import { AgentBudgetError, type AgentMessage, type AgentTurn } from "@/nori/remote/AgentSession";
import { NORI_CODEGEN_SYSTEM, NORI_AGENT_SYSTEM, AGENT_TOOLS } from "./prompts.generated";

// Mirrors lelab/server.py: model = NORI_LLM_MODEL default, 1500-token completions.
const MODEL = (import.meta.env.VITE_NORI_LLM_MODEL as string | undefined) || "claude-sonnet-5";
const MAX_TOKENS = 1500;
const LLM_BASE = "/api/v1/agent/llm"; // backend proxy prefix (routes/agent.py)

// The logical codegen inputs the page already gathers (same field set as LeLab's
// NoriLlmGenerateBody). Assembled into an Anthropic message here instead of on the server.
export interface CodegenRequest {
  prompt: string;
  current_code?: string;
  robot_state?: Record<string, number>;
  image_b64?: string;
  camera_layout?: string;
  perception_active?: boolean;
  retry_note?: string;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };

/** Backend agent-budget snapshot -> the `daily` shape the Agent page consumes. Mirror of
 * lelab/server.py `_daily_view`. */
function dailyView(budget: Record<string, unknown> | undefined): AgentTurn["daily"] {
  const b = budget ?? {};
  return {
    spent: (b.used_today as number) ?? 0,
    allowed: (b.allowed_today as number | null) ?? null,
    remaining: (b.remaining_today as number | null) ?? null,
    warn: (b.soft_warn_threshold as number | null) ?? null,
    capped: (b.hard_capped as boolean) ?? false,
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function backendBase(): string {
  const base = getDirectBackendUrl();
  if (!base) throw new Error("hosted LLM path used without direct-backend mode");
  return base;
}

// Build the user message (text + optional image block). Mirror of lelab/server.py `_llm_prepare`.
function buildCodegenContent(body: CodegenRequest): ContentBlock[] {
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
// lelab/server.py `nori_llm_agent`. Keeps the browser-held messages[] untouched.
function buildAgentSystem(
  robotState: Record<string, number> | undefined, cameraLayout: string | undefined,
): string {
  const grounding: string[] = [];
  if (cameraLayout) grounding.push(`Camera layout (which composite tile is which): ${cameraLayout}`);
  if (robotState) grounding.push("Current robot state (proprioceptive, normalized): " + JSON.stringify(robotState));
  return grounding.length ? NORI_AGENT_SYSTEM + "\n\nCONTEXT FOR THIS RUN:\n" + grounding.join("\n") : NORI_AGENT_SYSTEM;
}

/** Hosted codegen: POST to the backend streaming proxy and return the raw Response so the caller
 * reads `res.body` exactly as it does for the LeLab stream (both are text/plain). */
export async function hostedGenerateStream(body: CodegenRequest): Promise<Response> {
  return fetch(`${backendBase()}${LLM_BASE}/messages/stream`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: NORI_CODEGEN_SYSTEM,
      messages: [{ role: "user", content: buildCodegenContent(body) }],
      new_run: true, // each generation is its own run (matches LeLab)
    }),
  });
}

/** Hosted agent turn: POST the browser-held messages to the backend proxy with the agent system +
 * tools, return the normalized AgentTurn (429 -> AgentBudgetError, like the LeLab path). */
export async function hostedAgentTurn(
  messages: AgentMessage[],
  robotState: Record<string, number> | undefined,
  cameraLayout: string | undefined,
): Promise<AgentTurn> {
  // new_run: first turn of a run has no assistant message yet (matches LeLab's inference).
  const newRun = !messages.some((m) => m.role === "assistant");
  const res = await fetch(`${backendBase()}${LLM_BASE}/messages`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildAgentSystem(robotState, cameraLayout),
      tools: AGENT_TOOLS,
      messages,
      new_run: newRun,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const msg = (detail as { detail?: string })?.detail || res.statusText;
    if (res.status === 429) throw new AgentBudgetError(msg);
    throw new Error(msg);
  }
  const turn = (await res.json()) as {
    stop_reason: string | null;
    content: AgentTurn["content"];
    usage?: { input_tokens: number; output_tokens: number };
    budget?: Record<string, unknown>;
  };
  return {
    stop_reason: turn.stop_reason,
    content: turn.content,
    usage: turn.usage,
    daily: dailyView(turn.budget),
  };
}
