// The Agent page's per-task settings. The worker validates every value again and refuses anything out of range
// (synthesis/aspire_service/executor.py task_settings), so these bounds are a convenience, not the safety limit.
import type { StartBody } from "./api";

export const SPEED = { min: 0.1, max: 0.8 };
export const LLM_CALLS = { min: 10, max: 80 };        // the backend's BUDGET_MAX
export const SECONDS = { min: 60, max: 1800 };
export const TABLE_Z = { min: 0.3, max: 1.2 };
export const DEPTH_MODELS = [
  { id: "unidepth_v2_vits", label: "UniDepth ViT-S (fast)" },
  { id: "unidepth_v2_vitl", label: "UniDepth ViT-L" },
] as const;
// The agent's primitive set (worker: synthesis/real/position.py). "position" = the target-based tools (move_to as a jog
// servo, locate_object, descend_until_contact, grasped, placed) next to the jog tools, with the position pick-and-place
// skill; "jog" = the jog surface alone with the jog pick-and-place skill, as before 2026-11-06. Per task, no deploy.
export const PRIMITIVES = [
  { id: "position", label: "new (position)" },
  { id: "jog", label: "old (jog)" },
] as const;
export type Primitives = (typeof PRIMITIVES)[number]["id"];

export interface AgentSettings {
  speed: number;
  llmCalls: number;
  seconds: number;
  tableZ: string;              // text so the field can be empty: empty = the robot's configured table height
  depthModel: string;
  worldMap: boolean;
  showThinking: boolean;
  stopOnClose: boolean;
  homeFirst: boolean;
  allowBase: boolean;
  recordEpisode: boolean;
  learn: boolean;                // the agent writes its end-of-run report into the robot's memory
  primitives: Primitives;
}

// Budget defaults sized for a pick and place: real runs take 45-67 tool calls, the API's default of 30 ends them early.
export const DEFAULT_SETTINGS: AgentSettings = {
  speed: 0.3, llmCalls: 80, seconds: 900, tableZ: "", depthModel: DEPTH_MODELS[0].id, worldMap: false, showThinking: true,
  stopOnClose: true, homeFirst: true, allowBase: false, recordEpisode: true, learn: true, primitives: "position",
};

const KEY = "nori_agent_settings";
const clamp = (v: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, v));

export function loadSettings(): AgentSettings {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") } as AgentSettings;
    const primitives = PRIMITIVES.some((p) => p.id === s.primitives) ? s.primitives : DEFAULT_SETTINGS.primitives;
    return { ...s, primitives, speed: clamp(Number(s.speed) || DEFAULT_SETTINGS.speed, SPEED) };
  } catch { return DEFAULT_SETTINGS; }
}

export function saveSettings(s: AgentSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* a convenience: the page works without it */ }
}

/** A typed table height, or null for empty, or "invalid": the page refuses to start on a bad number. */
export function parseTableZ(text: string): number | null | "invalid" {
  if (!text.trim()) return null;
  const v = Number(text);
  return Number.isFinite(v) && v >= TABLE_Z.min && v <= TABLE_Z.max ? v : "invalid";
}

/** The request fields these settings add to a task. */
export function taskFields(s: AgentSettings): Pick<StartBody, "budget"> & { constraints: Record<string, unknown> } {
  const table = parseTableZ(s.tableZ);
  return {
    budget: { seconds: clamp(s.seconds, SECONDS), llm_calls: clamp(s.llmCalls, LLM_CALLS) },
    constraints: {
      operator_presence: s.stopOnClose, home: s.homeFirst, allow_base: s.allowBase, record_episode: s.recordEpisode, learn: s.learn,
      speed_factor: clamp(s.speed, SPEED), depth_model: s.depthModel, world_session: s.worldMap, show_thinking: s.showThinking,
      primitives: s.primitives,
      ...(typeof table === "number" ? { table_z: table } : {}),
    },
  };
}
