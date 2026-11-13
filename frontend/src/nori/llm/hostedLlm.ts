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
import {
  NORI_CODEGEN_SYSTEM, NORI_PRIMITIVE_SYSTEM, NORI_PYSDK_SYSTEM, AGENT_TOOLS,
} from "./prompts.generated";
import { buildAgentTools } from "@nori/sdk";
import type { RobotDescriptor } from "@nori/sdk";
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
// Mirror of lelab/server.py `_system_for`: ts -> JS teleop prompt (default), python -> the
// primitive policy prompt (or the raw-SDK prompt for flavor "sdk").
function systemFor(body: CodegenRequest): string {
  if (body.mode !== "python") return NORI_CODEGEN_SYSTEM;
  return body.flavor === "sdk" ? NORI_PYSDK_SYSTEM : NORI_PRIMITIVE_SYSTEM;
}

export async function hostedGenerateStream(body: CodegenRequest): Promise<Response> {
  return fetch(`${backendBase()}${LLM_BASE}/messages/stream`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemFor(body),
      // buildCodegenContent injects body.skills (the trigger-matched bodies, fetched in generate()) into
      // the user content — the agent-parity "inject, don't rely on read_skill" path (read_skill fired in
      // 0/12 agent runs). See docs/codegen-agent-parity-design.md P1.
      messages: [{ role: "user", content: buildCodegenContent(body) }],
      new_run: true, // each generation is its own run (matches LeLab)
    }),
  });
}

/** Hosted skill INJECTION (agent-parity P1): fetch the relevant skill BODIES and return them as text to
 *  inject into the codegen system prompt — instead of the index + read_skill loop the model rarely calls.
 *  Uses the live /aspire/skills endpoints (index for names + summaries, {name} for the body); relevance is
 *  client-side keyword overlap over the small library. Best-effort: returns {"",[]} on any failure. */
export async function hostedRelevantSkills(
  prompt: string, onPick?: (name: string) => void,
): Promise<{ text: string; names: string[] }> {
  const base = backendBase();
  const headers = await authHeaders();
  let idxText = "";
  let names: string[] = [];
  try {
    const ir = await fetch(`${base}/api/v1/aspire/skills/index`, { headers });
    if (ir.ok) {
      const j = (await ir.json()) as { text?: string; names?: string[] };
      idxText = j.text || ""; names = j.names || [];
    }
  } catch { return { text: "", names: [] }; }
  if (!names.length) return { text: "", names: [] };
  const words = new Set((prompt || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const lines = idxText.split("\n");
  const score = (n: string): number => {
    const line = lines.find((l) => l.toLowerCase().includes(n.toLowerCase())) || "";
    const hay = `${line} ${n}`.toLowerCase();
    return [...words].filter((w) => hay.includes(w)).length;
  };
  const ranked = names.map((n) => ({ n, s: score(n) })).sort((a, b) => b.s - a.s);
  const pick = (ranked[0]?.s ? ranked.filter((x) => x.s > 0) : ranked).slice(0, 2).map((x) => x.n);
  const blocks: string[] = [];
  for (const n of pick) {
    onPick?.(n);
    try {
      const r = await fetch(`${base}/api/v1/aspire/skills/${encodeURIComponent(n)}`, { headers });
      if (r.ok) {
        const sk = (await r.json()) as { name?: string; text?: string };
        if (sk.text) blocks.push(`### ${sk.name || n}\n${sk.text}`);
      }
    } catch { /* skip a skill that fails to load */ }
  }
  return { text: blocks.join("\n\n---\n\n"), names: pick };
}

// The read_skill tool (matches nori-backend aspire/skills.READ_SKILL_TOOL). Primitive codegen gets the
// skill INDEX in the prompt + this tool, and CHOOSES which skills to read — the agent's `index` model,
// not a pre-injected top-N. The loop serves read_skill from /aspire/skills/{name}.
const READ_SKILL_TOOL = {
  name: "read_skill",
  description:
    "Read one skill from the library (the SKILL LIBRARY list in your instructions) and get its full text: " +
    "triggers, a sketch of which tools to call in which order, evidence and limits. Costs nothing. Read a " +
    "skill when its triggers match the task.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "the skill's name from the list" } },
    required: ["name"],
  },
};

/** Hosted PRIMITIVE codegen where the model CHOOSES skills (index + read_skill), like the agent worker:
 *  put the skill index in the system prompt, give it read_skill, and run a short tool loop (serving
 *  read_skill from /aspire/skills/{name}) until it emits the policy. Non-streaming — the loop must see
 *  tool_use. `onRead` reports each skill the model actually read. Returns the raw code (caller strips fences). */
export async function hostedGenerateWithSkills(
  body: CodegenRequest, onRead?: (name: string) => void,
): Promise<string> {
  const base = backendBase();
  const headers = await authHeaders();
  let indexText = "";
  try {
    const ir = await fetch(`${base}/api/v1/aspire/skills/index`, { headers });
    if (ir.ok) indexText = ((await ir.json()) as { text?: string })?.text || "";
  } catch { /* skills are optional grounding */ }
  const system = systemFor(body) + indexText;
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: buildCodegenContent(body) }];
  for (let round = 0; round < 6; round++) {
    const res = await fetch(`${backendBase()}${LLM_BASE}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages, tools: [READ_SKILL_TOOL], new_run: round === 0 }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string })?.detail || res.statusText);
    const turn = (await res.json()) as { stop_reason?: string; content?: Array<Record<string, unknown>> };
    const content = turn.content ?? [];
    messages.push({ role: "assistant", content });
    if (turn.stop_reason === "tool_use") {
      const results: Array<Record<string, unknown>> = [];
      for (const b of content) {
        if (b.type === "tool_use" && (b as { name?: string }).name === "read_skill") {
          const name = String(((b as { input?: { name?: unknown } }).input?.name) ?? "");
          onRead?.(name);
          let payload: unknown = { status: "error", reason: "fetch failed" };
          try {
            const r = await fetch(`${base}/api/v1/aspire/skills/${encodeURIComponent(name)}`, { headers });
            if (r.ok) payload = await r.json();
          } catch { /* served as an error tool_result below */ }
          results.push({ type: "tool_result", tool_use_id: (b as { id?: string }).id, content: JSON.stringify(payload) });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    return content.filter((b) => b.type === "text").map((b) => String((b as { text?: string }).text ?? "")).join("");
  }
  throw new Error("codegen exceeded the read_skill round limit");
}

/** Hosted depth fetch: POST one look-frame JPEG to the backend's depth endpoint and return the
 * raw grid result, or null on any failure (depth is best-effort grounding, never a dependency). */
export async function hostedDepthGrid(imageB64: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${backendBase()}/api/v1/agent/depth`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ image_b64: imageB64 }),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Hosted agent turn: POST the browser-held messages to the backend proxy with the agent system +
 * tools, return the normalized AgentTurn (429 -> AgentBudgetError, like the LeLab path). */
export async function hostedAgentTurn(
  messages: AgentMessage[],
  robotState: Record<string, number> | undefined,
  cameraLayout: string | undefined,
  descriptor?: RobotDescriptor | null,
  poseSummary?: string,
  motors?: string,
): Promise<AgentTurn> {
  const res = await fetch(`${backendBase()}${LLM_BASE}/messages`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildAgentSystem(robotState, cameraLayout, descriptor, poseSummary, motors),
      // Rebuilt per-connection: with a descriptor the move_to / reach / lift schemas name the
      // joints, task DOFs and rail THIS robot has; without one (legacy/no ack yet) it is
      // byte-identical to the generated AGENT_TOOLS, which remains the L2 rendering LeLab's
      // server-side path also ships.
      tools: descriptor ? buildAgentTools(descriptor) : AGENT_TOOLS,
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
