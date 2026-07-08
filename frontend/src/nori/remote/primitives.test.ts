// NORI: unit tests for the D2 primitive library. A fake robot records the base-API calls each
// primitive composes; no hardware, no timers (the fake resolves immediately).

import { describe, expect, it } from "vitest";
import { installPrimitives, type Primitives, type ScriptRobot } from "./primitives";

type Call = [string, ...unknown[]];

function fakeRobot() {
  const calls: Call[] = [];
  const robot: ScriptRobot = {
    joint: (s, d, ms) => { calls.push(["joint", s, d, ms]); return Promise.resolve(); },
    moveTo: (s, t, o) => { calls.push(["moveTo", s, t, o]); return Promise.resolve("done"); },
    grip: (s, a) => { calls.push(["grip", s, a]); return Promise.resolve(); },
    wait: (ms) => { calls.push(["wait", ms]); return Promise.resolve(); },
    log: (...p) => { calls.push(["log", ...p]); },
  };
  installPrimitives(robot);
  return { robot: robot as ScriptRobot & Primitives, calls };
}

describe("D2 primitives", () => {
  it("home moves the arm to the neutral pose via moveTo", async () => {
    const { robot, calls } = fakeRobot();
    await robot.home("left");
    const move = calls.find((c) => c[0] === "moveTo")!;
    expect(move[1]).toBe("left");
    expect(move[2]).toMatchObject({ shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0 });
  });

  it("stow uses a distinct (folded) pose", async () => {
    const { robot, calls } = fakeRobot();
    await robot.stow("right");
    const move = calls.find((c) => c[0] === "moveTo")!;
    expect(move[1]).toBe("right");
    expect((move[2] as Record<string, number>).elbow_flex).not.toBe(0); // folded, not neutral
  });

  it("gripSequence opens, waits, then closes", async () => {
    const { robot, calls } = fakeRobot();
    await robot.gripSequence("right");
    expect(calls.filter((c) => c[0] === "grip").map((c) => c[2])).toEqual(["open", "close"]);
    expect(calls.some((c) => c[0] === "wait")).toBe(true);
  });

  it("wave alternates the wrist N times", async () => {
    const { robot, calls } = fakeRobot();
    await robot.wave("left", 2);
    expect(calls.filter((c) => c[0] === "joint").length).toBe(4); // 2 * (up, down)
  });

  it("each primitive logs a [lib] marker (usage harvest)", async () => {
    const { robot, calls } = fakeRobot();
    await robot.home("left");
    expect(calls.some((c) => c[0] === "log" && String(c[1]).includes("[lib] home"))).toBe(true);
  });
});
