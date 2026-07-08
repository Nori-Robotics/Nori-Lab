// NORI: unit tests for ScriptDriver (docs/llm_integration_plan.md A6). Covers the op->ExternalJog
// mapping, the rate clamp, DOF validation, and lifecycle (start/hold-zeroing/stop/reset/estop).
// Pure: a fake teleop records setExternalJog/command calls; fake timers drive the held-jog spans.
// No hardware, no DOM, no real Worker (worker isolation is B5, a manual browser check).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalJog, RemoteTeleop, TelemetryView } from "@nori/sdk";
import { ScriptDriver, type ScriptDriverOptions } from "./ScriptDriver";

// Minimal stand-in for RemoteTeleop: only the two methods ScriptDriver calls, recording every call.
function makeFakeTeleop() {
  const jogs: (ExternalJog | null)[] = [];
  const commands: string[] = [];
  const actions: Record<string, number>[] = [];
  const teleop = {
    setExternalJog: (j: ExternalJog | null) => { jogs.push(j); },
    command: (c: string) => { commands.push(c); },
    sendAction: (a: Record<string, number>) => { actions.push(a); },
  } as unknown as RemoteTeleop;
  return { teleop, jogs, commands, actions };
}

// Minimal telemetry frame carrying just a `state` dict for moveTo.
const telWithState = (state: Record<string, number>) => ({ state } as unknown as TelemetryView);

function setup(opts: Partial<ScriptDriverOptions> = {}) {
  const fake = makeFakeTeleop();
  const driver = new ScriptDriver({ teleop: fake.teleop, ...opts });
  driver.start(); // pushes the initial zero-hold {}
  return { driver, ...fake };
}

// The last jog payload the driver pushed.
const lastJog = (jogs: (ExternalJog | null)[]) => jogs.at(-1);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("start / heartbeat", () => {
  it("start() begins a zero-hold so the watchdog is fed", () => {
    const { jogs } = setup();
    expect(jogs).toEqual([{}]);
  });
});

describe("op -> ExternalJog mapping", () => {
  it("reach maps cylindrical DOFs onto <side>_arm", async () => {
    const { driver, jogs } = setup();
    const p = driver.exec("reach", ["right", { x: 0.5, y: -0.3 }, 500]);
    await vi.advanceTimersByTimeAsync(1); // run the queued op -> setExternalJog(payload)
    expect(lastJog(jogs)).toEqual({ right_arm: { x: 0.5, y: -0.3 } });
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(lastJog(jogs)).toEqual({}); // zeroed after the held span
  });

  it("joint maps per-motor DOFs onto <side>_arm", async () => {
    const { driver, jogs } = setup();
    const p = driver.exec("joint", ["left", { elbow_flex: 0.4 }, 300]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ left_arm: { elbow_flex: 0.4 } });
    await vi.advanceTimersByTimeAsync(300);
    await p;
  });

  it("base maps linear/angular onto base", async () => {
    const { driver, jogs } = setup();
    const p = driver.exec("base", [{ linear: 0.4, angular: 0 }, 200]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ base: { linear: 0.4, angular: 0 } });
    await vi.advanceTimersByTimeAsync(200);
    await p;
  });

  it("lift maps a scalar onto <side>_lift", async () => {
    const { driver, jogs } = setup();
    const p = driver.exec("lift", ["left", 0.3, 100]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ left_lift: 0.3 });
    await vi.advanceTimersByTimeAsync(100);
    await p;
  });

  it("grip open/close drives the gripper DOF", async () => {
    const { driver, jogs } = setup();
    const open = driver.exec("grip", ["right", "open"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ right_arm: { gripper: 0.5 } }); // +GRIP_RATE clamped to capRate
    await vi.advanceTimersByTimeAsync(800); // default gripMs
    await open;

    const close = driver.exec("grip", ["right", "close"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ right_arm: { gripper: -0.5 } });
    await vi.advanceTimersByTimeAsync(800);
    await close;
  });
});

describe("rate clamp", () => {
  it("clamps magnitudes beyond capRate (default 0.5)", async () => {
    const { driver, jogs } = setup();
    const p = driver.exec("reach", ["right", { x: 1, y: -1 }, 10]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ right_arm: { x: 0.5, y: -0.5 } });
    await vi.advanceTimersByTimeAsync(10);
    await p;
  });

  it("honours a custom capRate", async () => {
    const { driver, jogs } = setup({ capRate: 0.2 });
    const p = driver.exec("reach", ["right", { x: 1 }, 10]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ right_arm: { x: 0.2 } });
    await vi.advanceTimersByTimeAsync(10);
    await p;
  });

  it("coerces NaN/Infinity to 0", async () => {
    const { driver, jogs } = setup();
    const p = driver.exec("reach", ["right", { x: NaN, y: Infinity }, 10]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ right_arm: { x: 0, y: 0 } });
    await vi.advanceTimersByTimeAsync(10);
    await p;
  });
});

describe("DOF validation", () => {
  it("rejects a joint DOF passed to reach (cylindrical)", async () => {
    const { driver } = setup();
    await expect(driver.exec("reach", ["right", { elbow_flex: 1 }, 100])).rejects.toThrow(/unknown DOF/);
  });

  it("rejects a task DOF passed to joint", async () => {
    const { driver } = setup();
    await expect(driver.exec("joint", ["right", { x: 1 }, 100])).rejects.toThrow(/unknown DOF/);
  });

  it("rejects an invalid grip action", async () => {
    const { driver } = setup();
    await expect(driver.exec("grip", ["right", "squeeze"])).rejects.toThrow(/open.*close/);
  });

  it("rejects an unknown op", async () => {
    const { driver } = setup();
    await expect(driver.exec("teleport", [])).rejects.toThrow(/unknown op/);
  });
});

describe("wait / commands / telemetry", () => {
  it("wait() idles without changing the jog payload", async () => {
    const { driver, jogs } = setup();
    const before = jogs.length;
    const p = driver.exec("wait", [50]);
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(jogs.length).toBe(before); // no setExternalJog during a pure wait
  });

  it("reset -> command('reset')", async () => {
    const { driver, commands } = setup();
    await driver.exec("reset", []);
    await vi.advanceTimersByTimeAsync(1);
    expect(commands).toEqual(["reset"]);
  });

  it("estop -> command('estop') immediately", async () => {
    const { driver, commands } = setup();
    await driver.exec("estop", []);
    expect(commands).toEqual(["estop"]);
  });

  it("telemetry() returns the last frame fed in", async () => {
    const { driver } = setup();
    const frame = { loopHz: 50, safety: "ok" } as unknown as TelemetryView;
    driver.setTelemetry(frame);
    await expect(driver.exec("telemetry", [])).resolves.toBe(frame);
  });
});

describe("stop()", () => {
  it("releases the jog to null and is idempotent", () => {
    const { driver, jogs } = setup();
    driver.stop();
    expect(lastJog(jogs)).toBeNull();
    const n = jogs.length;
    driver.stop(); // second call is a no-op
    expect(jogs.length).toBe(n);
  });

  it("a queued op after stop() rejects rather than moving the robot", async () => {
    const { driver } = setup();
    driver.stop();
    await expect(driver.exec("reach", ["right", { x: 0.5 }, 100])).rejects.toThrow(/stopped/);
  });
});

describe("moveTo (absolute, client-side slew + arrival)", () => {
  it("ramps toward the target, then reports 'done' when telemetry shows arrival", async () => {
    const { driver, actions } = setup();
    driver.setTelemetry(telWithState({ "right_arm_shoulder_pan.pos": 0 }));
    const p = driver.exec("moveTo", ["right", { shoulder_pan: 30 }, { slew: 60 }]);
    await vi.advanceTimersByTimeAsync(1);
    // First frame STEPS toward the goal (slew 60 u/s * 40ms = 2.4), not a snap to 30.
    expect(actions.at(-1)!["right_arm_shoulder_pan.pos"]).toBeCloseTo(2.4, 1);
    await vi.advanceTimersByTimeAsync(2000); // finish the ramp
    expect(actions.at(-1)!["right_arm_shoulder_pan.pos"]).toBe(30); // ramp reached goal
    // simulate the arm physically arriving; confirm phase then resolves "done"
    driver.setTelemetry(telWithState({ "right_arm_shoulder_pan.pos": 30 }));
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe("done");
  });

  it("reports 'timeout' if the arm never arrives", async () => {
    const { driver } = setup();
    driver.setTelemetry(telWithState({ "right_arm_shoulder_pan.pos": 0 })); // stays at 0
    const p = driver.exec("moveTo", ["right", { shoulder_pan: 30 }, {}]);
    await vi.advanceTimersByTimeAsync(6000); // ramp + full arrival timeout, no arrival
    await expect(p).resolves.toBe("timeout");
  });

  it("reports 'blocked' when the daemon latches (safety)", async () => {
    const { driver } = setup();
    driver.setTelemetry(telWithState({ "right_arm_shoulder_pan.pos": 0 }));
    const p = driver.exec("moveTo", ["right", { shoulder_pan: 30 }, {}]);
    await vi.advanceTimersByTimeAsync(200);
    driver.setTelemetry({ state: { "right_arm_shoulder_pan.pos": 5 }, safety: "latched" } as unknown as TelemetryView);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe("blocked");
  });

  it("clamps targets to the joint range", async () => {
    const { driver, actions } = setup();
    driver.setTelemetry(telWithState({ "right_arm_shoulder_pan.pos": 0, "right_arm_gripper.pos": 50 }));
    const p = driver.exec("moveTo", ["right", { shoulder_pan: 999, gripper: -20 }, { slew: 999 }]);
    // slew is capped to MAX_MOVE_SLEW (120) -> 4.8/tick; 0->100 takes ~840ms. Advance past it.
    await vi.advanceTimersByTimeAsync(1200);
    expect(actions.at(-1)!["right_arm_shoulder_pan.pos"]).toBe(100); // clamped to [-100,100]
    expect(actions.at(-1)!["right_arm_gripper.pos"]).toBe(0); // gripper clamped to [0,100]
    driver.setTelemetry(telWithState({ "right_arm_shoulder_pan.pos": 100, "right_arm_gripper.pos": 0 }));
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe("done");
  });

  it("rejects an unknown joint", async () => {
    const { driver } = setup();
    driver.setTelemetry(telWithState({}));
    await expect(driver.exec("moveTo", ["right", { x: 10 }, undefined])).rejects.toThrow(/unknown joint/);
  });

  it("rejects when there is no telemetry yet", async () => {
    const { driver } = setup(); // setTelemetry never called
    await expect(driver.exec("moveTo", ["right", { shoulder_pan: 10 }, undefined])).rejects.toThrow(/no telemetry/);
  });
});

describe("queue serialization", () => {
  it("runs overlapping ops in order (payload A -> zero -> payload B)", async () => {
    const { driver, jogs } = setup();
    const a = driver.exec("reach", ["right", { x: 0.5 }, 100]);
    const b = driver.exec("reach", ["left", { y: 0.4 }, 100]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ right_arm: { x: 0.5 } }); // A holds first
    await vi.advanceTimersByTimeAsync(100);
    await a;
    await vi.advanceTimersByTimeAsync(1);
    expect(lastJog(jogs)).toEqual({ left_arm: { y: 0.4 } }); // then B, not concurrently
    await vi.advanceTimersByTimeAsync(100);
    await b;
    expect(lastJog(jogs)).toEqual({});
  });
});
