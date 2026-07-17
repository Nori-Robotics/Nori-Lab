// NORI: Additive (SDK v1 mock mode). Node-side coverage for the mock's pure halves:
// MockDaemonSim (wire behavior: ack shape, jog integration, clamps, E-STOP latch, watchdog,
// action lifecycle) and the loopback signaling bus (delivery, ordering, close semantics).
// The browser shell (mock/robot.ts: WebRTC + canvas) is exercised by the examples/mock page,
// not here — Node has no RTCPeerConnection.
import { describe, expect, it } from "vitest";
import { MockDaemonSim, createLoopbackSignaling } from "@nori/sdk/mock";
import { parseAck } from "@nori/sdk";

const jogFrame = (arm: Record<string, number>, base?: { linear: number; angular: number }) => ({
  type: "control",
  seq: 1,
  jog: { right_arm: arm, ...(base ? { base } : {}) },
});

// Advance the sim from `fromMs` to `toMs`, refreshing a (neutral) control frame each slice so the
// watchdog stays fed — i.e. what a connected operator's 50 Hz jog stream does. Tests that just
// jump the clock are testing the watchdog, not the behavior under test.
function drive(sim: MockDaemonSim, fromMs: number, toMs: number, stepMs = 50): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    sim.handleFrame({ type: "control", seq: t, jog: {} }, t);
    out.push(...sim.tick(t));
  }
  return out;
}

describe("MockDaemonSim ack", () => {
  it("emits a fixture-shaped ack the SDK's parseAck accepts", () => {
    const sim = new MockDaemonSim();
    const info = parseAck(sim.ackFrame());
    expect(info.accepted).toBe(true);
    expect(info.protocolVersion).toBe(1);
    expect(info.normMode).toBe("range_m100_100");
    expect(info.watchdogProfile).toEqual({ t_warn_ms: 300, t_stop_ms: 1000 });
    expect(info.descriptor?.joints).toHaveLength(12);
    expect(info.descriptor?.cameras).toEqual(["front", "left_wrist", "right_wrist", "overhead"]);
    expect(info.initialState?.["right_arm_gripper.pos"]).toBe(30);
  });

  it("camera layout covers every camera in a grid", () => {
    const layout = new MockDaemonSim().cameraLayoutFrame()!;
    expect(layout.cols).toBe(2);
    expect(layout.rows).toBe(2);
    expect(layout.tiles).toHaveLength(4);
  });

  it("single-camera robots send no layout (matches the bridge)", () => {
    const sim = new MockDaemonSim({
      descriptor: { joints: ["right_arm_gripper.pos"], cameras: ["front"], ranges: {} },
    });
    expect(sim.cameraLayoutFrame()).toBeNull();
  });

  it("reports currents only for motors the descriptor actually has", () => {
    const sim = new MockDaemonSim({
      descriptor: { joints: ["left_arm_gripper.pos"], cameras: ["front"], ranges: {} },
    });
    const tel = sim.tick(0).find((f) => f.type === "telemetry")!;
    expect(Object.keys(tel.currents as Record<string, number>)).toEqual(["left_arm_gripper"]);
  });
});

describe("MockDaemonSim motion", () => {
  it("integrates a joint-mode jog at the configured rate and reports it in telemetry", () => {
    const sim = new MockDaemonSim({ jogUnitsPerS: 60 });
    sim.tick(0);
    sim.handleFrame(jogFrame({ shoulder_pan: 1.0 }), 0);
    const frames = sim.tick(100); // 0.1 s at rate 1 -> +6 units
    const tel = frames.find((f) => f.type === "telemetry")!;
    const state = tel.state as Record<string, number>;
    expect(state["right_arm_shoulder_pan.pos"]).toBeCloseTo(6, 1);
    expect((tel.currents as Record<string, number>)["right_arm_shoulder_pan"]).toBeGreaterThan(0);
  });

  it("maps cylindrical task dofs onto joints so motion is visible", () => {
    const sim = new MockDaemonSim();
    sim.tick(0);
    sim.handleFrame(jogFrame({ x: 1.0 }), 0);
    sim.tick(100);
    expect(sim.state()["right_arm_elbow_flex.pos"]).toBeGreaterThan(0);
  });

  it("clamps at descriptor ranges (clamp-don't-reject)", () => {
    const sim = new MockDaemonSim();
    sim.tick(0);
    // Keep control frames fresh (inside the watchdog window) while driving well past the
    // [0,100] gripper ceiling: 3 s at full rate would be +180 unclamped.
    for (let t = 0; t <= 3000; t += 100) {
      sim.handleFrame(jogFrame({ gripper: 1.0 }), t);
      sim.tick(t + 50);
    }
    expect(sim.state()["right_arm_gripper.pos"]).toBe(100);
  });

  it("applies base jog as velocities, not integration", () => {
    const sim = new MockDaemonSim();
    sim.tick(0);
    sim.handleFrame(jogFrame({}, { linear: 0.3, angular: 0 }), 0);
    sim.tick(50);
    expect(sim.state()["x.vel"]).toBe(0.3);
  });

  it("stops the base when a jog frame omits `base` (released key must not latch)", () => {
    // The SDK's keyboard path drops the base key entirely once no base key is held, so absence
    // means stop. Latching here would drive the mock's base away forever.
    const sim = new MockDaemonSim();
    sim.tick(0);
    sim.handleFrame(jogFrame({}, { linear: 0.5, angular: 0.2 }), 0);
    sim.tick(50);
    expect(sim.state()["x.vel"]).toBe(0.5);
    sim.handleFrame(jogFrame({ shoulder_pan: 0 }), 100); // key released: no base key at all
    sim.tick(150);
    expect(sim.state()["x.vel"]).toBe(0);
    expect(sim.state()["theta.vel"]).toBe(0);
  });
});

describe("MockDaemonSim safety", () => {
  it("estop latches (both wire shapes), freezes motion, reset_latch clears", () => {
    for (const cmd of [{ type: "command", name: "estop" }, { type: "command", estop: true }]) {
      const sim = new MockDaemonSim();
      sim.tick(0);
      sim.handleFrame(jogFrame({ shoulder_pan: 1.0 }, { linear: 0.5, angular: 0 }), 0);
      sim.tick(100);
      sim.handleFrame(cmd, 100);
      const before = sim.state()["right_arm_shoulder_pan.pos"];
      sim.handleFrame(jogFrame({ shoulder_pan: 1.0 }), 150);
      const frames = sim.tick(300);
      const status = (frames.find((f) => f.type === "telemetry")!.status ?? {}) as Record<string, unknown>;
      expect(status.safety).toBe("latched");
      expect(status.latch_reason).toBe("estop");
      expect(sim.state()["right_arm_shoulder_pan.pos"]).toBe(before);
      expect(sim.state()["x.vel"]).toBe(0);

      sim.handleFrame({ type: "command", name: "reset_latch" }, 400);
      const after = sim.tick(500).find((f) => f.type === "telemetry")!;
      expect((after.status as Record<string, unknown>).safety).toBe("ok");
    }
  });

  it("watchdog stops the base after control silence and recovers on the next frame", () => {
    const sim = new MockDaemonSim();
    sim.tick(0);
    sim.handleFrame(jogFrame({}, { linear: 0.5, angular: 0 }), 0);
    sim.tick(100);
    expect(sim.state()["x.vel"]).toBe(0.5);
    const frames = sim.tick(1500); // > t_stop_ms of silence
    const status = (frames.find((f) => f.type === "telemetry")!.status ?? {}) as Record<string, unknown>;
    expect(status.watchdog).toBe("stop");
    expect(sim.state()["x.vel"]).toBe(0);
    sim.handleFrame(jogFrame({}, { linear: 0.2, angular: 0 }), 1600);
    const rec = sim.tick(1700).find((f) => f.type === "telemetry")!;
    expect((rec.status as Record<string, unknown>).watchdog).toBe("ok");
  });

  it("watchdog stop freezes an in-flight action instead of completing it", () => {
    // A real daemon halts ALL motion on control silence; an action that kept slewing to `done`
    // would teach link-loss recovery code the opposite of hardware behavior.
    const sim = new MockDaemonSim({ actionUnitsPerS: 20 });
    sim.tick(0);
    sim.handleFrame({ type: "control", action: { "right_arm_shoulder_pan.pos": 90 }, action_id: "w1" }, 0);
    sim.tick(100);
    const posAtStop = sim.state()["right_arm_shoulder_pan.pos"];
    // Go silent well past t_stop_ms, then keep ticking: motion must not advance, and no
    // terminal status may be emitted.
    const frames = [...sim.tick(2000), ...sim.tick(4000), ...sim.tick(6000)];
    expect((frames.find((f) => f.type === "telemetry")!.status as Record<string, unknown>).watchdog).toBe("stop");
    expect(frames.filter((f) => f.type === "action_status")).toEqual([]);
    expect(sim.state()["right_arm_shoulder_pan.pos"]).toBe(posAtStop);

    // Control returns -> the frozen action resumes and completes.
    const resumed = drive(sim, 6100, 12000);
    expect(resumed.filter((f) => f.type === "action_status")).toContainEqual(
      expect.objectContaining({ action_id: "w1", state: "done" })
    );
  });
});

describe("MockDaemonSim actions", () => {
  it("runs the accepted -> active -> done lifecycle and slews to target", () => {
    const sim = new MockDaemonSim({ actionUnitsPerS: 100 });
    sim.tick(0);
    const replies = sim.handleFrame(
      { type: "control", action: { "right_arm_shoulder_pan.pos": 50 }, action_id: "a1" },
      0
    );
    expect(replies).toEqual([expect.objectContaining({ type: "action_status", action_id: "a1", state: "accepted" })]);
    const mid = sim.tick(100).filter((f) => f.type === "action_status");
    expect(mid).toEqual([expect.objectContaining({ action_id: "a1", state: "active" })]);
    const end = drive(sim, 150, 1500).filter((f) => f.type === "action_status");
    expect(end).toEqual([expect.objectContaining({ action_id: "a1", state: "done" })]);
    expect(sim.state()["right_arm_shoulder_pan.pos"]).toBe(50);
  });

  it("reports clamped when a target exceeds the range", () => {
    const sim = new MockDaemonSim();
    sim.tick(0);
    sim.handleFrame({ type: "control", action: { "right_arm_gripper.pos": 250 }, action_id: "a2" }, 0);
    const end = drive(sim, 50, 2000).filter((f) => f.type === "action_status");
    expect(end).toContainEqual(expect.objectContaining({ action_id: "a2", state: "clamped" }));
    expect(sim.state()["right_arm_gripper.pos"]).toBe(100);
  });

  it("blocks actions while latched", () => {
    const sim = new MockDaemonSim();
    sim.handleFrame({ type: "command", name: "estop" }, 0);
    const replies = sim.handleFrame(
      { type: "control", action: { "right_arm_gripper.pos": 50 }, action_id: "a3" },
      10
    );
    expect(replies).toEqual([expect.objectContaining({ action_id: "a3", state: "blocked" })]);
  });
});

describe("loopback signaling", () => {
  it("delivers the room handshake both ways, asynchronously", async () => {
    const { transport, robot } = createLoopbackSignaling();
    const seen: string[] = [];
    robot.onOperatorOpen(() => seen.push("open"));
    robot.onReady((p) => seen.push("ready:" + (p.mac ?? "")));
    robot.onBye(() => seen.push("bye"));

    let robotHere = 0;
    await transport.connect({
      onSdp: () => {},
      onIce: () => {},
      onRobotHere: () => { robotHere++; },
      onOpen: () => transport.sendReady({}),
    });
    expect(seen).toEqual([]); // nothing delivered synchronously
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["open", "ready:"]);

    robot.announce({ nonce: "n1" });
    transport.sendBye();
    await new Promise((r) => setTimeout(r, 20));
    expect(robotHere).toBe(1);
    expect(seen).toContain("bye");
  });

  it("drops sends made after close", async () => {
    const { transport, robot } = createLoopbackSignaling();
    let opened = false;
    robot.onReady(() => { opened = true; });
    await transport.connect({ onSdp: () => {}, onIce: () => {}, onRobotHere: () => {}, onOpen: () => {} });
    await transport.close();
    transport.sendReady({});
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toBe(false);
  });

  it("still delivers a bye sent immediately before close (RemoteTeleop.stop's exact shape)", async () => {
    // teleop.stop() calls sendBye() and close() in the same synchronous task. Dropping that bye
    // leaves the mock robot's timers and peer running forever and breaks the next start().
    const { transport, robot } = createLoopbackSignaling();
    let byes = 0;
    robot.onBye(() => { byes++; });
    await transport.connect({ onSdp: () => {}, onIce: () => {}, onRobotHere: () => {}, onOpen: () => {} });
    transport.sendBye();
    await transport.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(byes).toBe(1);
  });
});

describe("MockDaemonSim record (W2.11 on-robot recorder emulation)", () => {
  it("start/stop round-trips with record_status replies", () => {
    const sim = new MockDaemonSim();
    let out = sim.handleFrame({ type: "record", action: "status" }, 0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "record_status", ok: true, recording: false });

    out = sim.handleFrame({ type: "record", action: "start", task: "fold" }, 0);
    expect(out[0]).toMatchObject({ type: "record_status", ok: true, recording: true });
    expect(String(out[0].episode)).toMatch(/episode-\d{4}$/);
    expect(typeof out[0].free_gb).toBe("number");

    out = sim.handleFrame({ type: "record", action: "start" }, 0);
    expect(out[0]).toMatchObject({ ok: false, recording: true });
    expect(String(out[0].error)).toContain("already recording");

    out = sim.handleFrame({ type: "record", action: "stop" }, 0);
    expect(out[0]).toMatchObject({ ok: true, recording: false });

    out = sim.handleFrame({ type: "record", action: "stop" }, 0);
    expect(out[0]).toMatchObject({ ok: false });
    expect(String(out[0].error)).toContain("not recording");
  });

  it("discard behaves like stop and episode ids advance per start", () => {
    const sim = new MockDaemonSim();
    const first = sim.handleFrame({ type: "record", action: "start" }, 0)[0].episode;
    sim.handleFrame({ type: "record", action: "discard" }, 0);
    const second = sim.handleFrame({ type: "record", action: "start" }, 0)[0].episode;
    expect(first).not.toEqual(second);
  });
});
