// NORI: typed client for the ASPIRE task API (Nori-Backend routes/aspire.py), the hosted System 2
// agent the Agent page supervises. Desktop: through LeLab's `/nori/aspire/*` proxy; hosted: straight
// to the backend's `/api/v1/aspire/*` (noriRequest rewrites the prefix and swaps the auth header).
//
// The page never opens its own robot session: the task holds the robot's single remote session
// (the gateway serves one WebRTC session per robot) and the worker posts the overhead camera for
// us (GET .../frame). Events are polled as JSON rather than streamed as SSE so one code path works
// through the proxy and directly.

import { noriRequest } from "@/nori/api/client";
import { ApiError, type Fetcher } from "@/lib/apiClient";

export type TaskStatus = "queued" | "claiming" | "running" | "done" | "failed" | "cancelled";
export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);

export interface TaskRecord {
  task_id: string;
  robot: string;
  instruction: string;
  status: TaskStatus;
  outcome?: Record<string, unknown> | null;
  waiting_for_answer?: boolean;
  usage?: { llm_calls?: number; input_tokens?: number; output_tokens?: number };
  budget?: { seconds?: number; llm_calls?: number };
  created?: number | null;
  started?: number | null;
  ended?: number | null;
  n_events?: number;
}

/** One executor event. `n` orders them; the rest depends on `type` (see pages/agent.tsx rows). */
export interface TaskEvent {
  n: number;
  type: string;
  ts?: number;
  t?: number;
  [k: string]: unknown;
}

export interface LiveFrame {
  role: "overhead" | "front";
  jpeg_b64: string;
  width?: number | null;
  height?: number | null;
  captured_at?: number | null;
  seq: number;
}

export interface StartBody {
  robot: string;
  instruction: string;
  budget?: { seconds?: number; llm_calls?: number };
  constraints?: Record<string, unknown>;
  caller?: Record<string, string>;
}

export class RobotBusyError extends Error {
  constructor(public running: string | null) {
    super("the robot already has an active task");
  }
}

export function aspireApi(baseUrl: string, fetcher: Fetcher) {
  const req = <T,>(path: string, opts: Parameters<typeof noriRequest>[3] = {}) =>
    noriRequest<T>(baseUrl, fetcher, path, opts);
  return {
    async start(body: StartBody): Promise<{ task_id: string; status: TaskStatus }> {
      try {
        return await req<{ task_id: string; status: TaskStatus }>("/nori/aspire/tasks", {
          method: "POST", body, action: "Start the agent",
        });
      } catch (e) {
        // 409 {error: robot_busy, running}: a typed error so the page can attach to the running task. Through the
        // LeLab proxy the body arrives as `detail` (an object); directly it has no `detail` at all.
        if (e instanceof ApiError && e.status === 409) {
          const d = e.detail as unknown;
          const running = d && typeof d === "object" ? (d as { running?: string }).running ?? null : null;
          throw new RobotBusyError(running);
        }
        throw e;
      }
    },
    task: (id: string) => req<TaskRecord>(`/nori/aspire/tasks/${id}`, { action: "Read the task" }),
    events: (id: string, since: number) =>
      req<TaskEvent[]>(`/nori/aspire/tasks/${id}/events?since=${since}&follow=false`, { action: "Read the task's events" }),
    answer: (id: string, text: string) =>
      req<{ ok: boolean }>(`/nori/aspire/tasks/${id}/answer`, { method: "POST", body: { text }, action: "Answer the agent" }),
    cancel: (id: string, reason: string) =>
      req<{ status: string }>(`/nori/aspire/tasks/${id}/cancel`, { method: "POST", body: { reason }, action: "Stop the agent" }),
    /** null when there is no frame newer than `after` (HTTP 204). */
    frame: async (id: string, after: number) =>
      (await req<LiveFrame | undefined>(`/nori/aspire/tasks/${id}/frame?after=${after}`, { action: "Read the live frame" })) ?? null,
    presence: (id: string) =>
      req<{ ok: boolean; status: TaskStatus }>(`/nori/aspire/tasks/${id}/presence`, { method: "POST", action: "Keep the task supervised" }),
  };
}

export type AspireApi = ReturnType<typeof aspireApi>;
