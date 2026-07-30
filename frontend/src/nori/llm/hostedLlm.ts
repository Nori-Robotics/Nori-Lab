// NORI: hosted (LeLab-free) LLM path for the Coding + Agent pages.
//
// On the DESKTOP app the pages POST to LeLab's `/nori/llm/*`, which assembles the prompt +
// tools and forwards to Nori-Backend's gated/metered Anthropic proxy (the key lives on the
// backend). A hosted Vercel build has NO LeLab, so these two pages could never reach that path
// (they hit dead `localhost:8000`). This module reproduces LeLab's assembly IN THE BROWSER
// (see promptAssembly.ts) and calls the backend's generic proxy `/api/v1/agent/llm/messages
// (/stream)` directly with the Supabase JWT — auth + per-customer metering are unchanged (the
// backend gates + charges).
//
// The system prompts + tool schemas come from `prompts.generated.ts`, generated from the Python
// source of truth (lelab/server.py) — see scripts/gen_llm_prompts.py — so they can't drift.
//
// Only used when isDirectBackend() is true; the desktop path is untouched.

import { getAccessToken } from "@/nori/auth/session";
import { getDirectBackendUrl } from "@/nori/api/client";
import { AgentBudgetError, type AgentMessage, type AgentTurn } from "@/nori/remote/AgentSession";
import { NORI_CODEGEN_SYSTEM, AGENT_TOOLS } from "./prompts.generated";
import {
  buildCodegenContent, buildAgentSystem, inferNewRun, dailyView, type CodegenRequest,
} from "./promptAssembly";

export type { CodegenRequest };

// Mirrors lelab/server.py: model = NORI_LLM_MODEL default, 1500-token completions.
const MODEL = (import.meta.env.VITE_NORI_LLM_MODEL as string | undefined) || "claude-sonnet-5";
const MAX_TOKENS = 1500;
const LLM_BASE = "/api/v1/agent/llm"; // backend proxy prefix (routes/agent.py)

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
  const res = await fetch(`${backendBase()}${LLM_BASE}/messages`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildAgentSystem(robotState, cameraLayout),
      tools: AGENT_TOOLS,
      messages,
      new_run: inferNewRun(messages),
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
