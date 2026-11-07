import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseTableZ, taskFields } from "./settings";

describe("agent settings", () => {
  it("sends the tunables as constraints and a budget a pick can finish in", () => {
    const f = taskFields(DEFAULT_SETTINGS);
    expect(f.budget).toEqual({ seconds: 900, llm_calls: 80 });
    expect(f.constraints).toEqual({ operator_presence: true, home: true, allow_base: false, record_episode: true, learn: true, speed_factor: 0.3, depth_model: "unidepth_v2_vits", world_session: false, show_thinking: true, primitives: "position" });
  });
  it("sends the primitive set and falls back to the new one on an unknown saved value", () => {
    expect(taskFields(DEFAULT_SETTINGS).constraints.primitives).toBe("position");
    expect(taskFields({ ...DEFAULT_SETTINGS, primitives: "jog" }).constraints.primitives).toBe("jog");
    const store: Record<string, string> = { nori_agent_settings: JSON.stringify({ primitives: "planned" }) };
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    expect(loadSettings().primitives).toBe("position");
    vi.unstubAllGlobals();
  });
  it("keeps speed under the worker's 0.8 limit", () => {
    expect(taskFields({ ...DEFAULT_SETTINGS, speed: 1 }).constraints.speed_factor).toBe(0.8);
  });
  it("sends a table height only when one was typed", () => {
    expect(taskFields({ ...DEFAULT_SETTINGS, tableZ: "0.76" }).constraints.table_z).toBe(0.76);
    expect(taskFields(DEFAULT_SETTINGS).constraints).not.toHaveProperty("table_z");
  });
  it("calls a bad table height invalid instead of guessing", () => {
    expect(parseTableZ("")).toBeNull();
    expect(parseTableZ("76")).toBe("invalid");
    expect(parseTableZ("abc")).toBe("invalid");
  });
});
