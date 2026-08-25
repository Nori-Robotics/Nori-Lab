// NORI: Additive. Regression guards for three audit fixes (2026-08-25):
//
//  1. robot_here / signaling reopen must not kill a live session — the gateway broadcasts
//     robot_here on EVERY room join (including its own signaling auto-reconnect), and only
//     pc.onconnectionstatechange ever sets `connected` back, so clearing it in those
//     handlers disabled the live-session nack/state guards forever.
//  2. estop delivery honesty — an E-STOP into a dead channel must THROW (the operator has
//     to reach for the physical button), and estopConfirmed() must only trust a latch
//     reported ON THE WIRE after the send, never the cached telemetry view.
//  3. VR lift keys — external mappers speak per-hand left_lift/right_lift; on an A-series
//     robot the wire key is the bare "lift", and the unresolved per-hand names were ignored
//     in silence (the operator pressed lift and nothing moved).
import { describe, expect, it } from "vitest";
import { RemoteTeleop, parseAck } from "@nori/sdk";

// Private-reach idiom, as in sendPose.test.ts / baseSigns.test.ts.
type Raw = {
  ackInfo: unknown;
  connected: boolean;
  connStatus: { phase: string };
  controlCh: unknown;
  externalJog: unknown;
  dcSend: (f: Record<string, unknown>) => boolean;
  handleTelemetry: (data: string) => void;
  jogTick: () => void;
};

const A3_ACK = {
  type: "ack", accepted: true, protocol_version: 1, model: "A3",
  capabilities: ["task_jog", "pose_targets", "record"],
  descriptor: {
    joints: ["left_arm_gripper.pos", "right_arm_gripper.pos"],
    base: ["x.vel", "theta.vel"], aux: ["lift"], cameras: [],
    ranges: { "lift.pos": [0, 720] },
  },
};

function bare(overrides: Record<string, unknown> = {}) {
  const t = new RemoteTeleop({
    arm: "right", onTelemetry: () => {}, onLog: () => {},
    // wireJog's model gate falls back to the transport's room for an ack without `model`.
    signaling: { room: "nori-dev" },
    ...overrides,
  } as never);
  return { t, raw: t as unknown as Raw };
}

// A full-ish harness that runs start() so the signaling handlers exist.
function session() {
  const handlers: Record<string, (p?: unknown) => unknown> = {};
  let readySends = 0;
  const signaling = {
    room: "NORI-A3-0000",
    connect: async (h: Record<string, (p?: unknown) => unknown>) => { Object.assign(handlers, h); },
    sendReady: () => { readySends += 1; },
    sendSdp: () => {}, sendIce: () => {}, sendBye: () => {},
    close: async () => {},
  };
  const t = new RemoteTeleop({
    signaling, stun: "", turnUrls: [], turnUser: "", turnCred: "",
    forceRelay: false, arm: "right",
    onLog: () => {}, onConnState: () => {}, onTelemetry: () => {},
    onMode: () => {}, onControlActive: () => {},
  } as never);
  return { t, raw: t as unknown as Raw, handlers, readySends: () => readySends };
}

describe("a live session survives signaling churn", () => {
  it("robot_here mid-session keeps `connected` and still re-announces ready", async () => {
    const { t, raw, handlers, readySends } = session();
    await t.start();
    raw.connected = true; // as if pc.onconnectionstatechange fired "connected"
    await handlers.onRobotHere();
    expect(raw.connected).toBe(true); // owned by the connection-state callback alone
    // The ready must still fly: a RESTARTED gateway (no session) needs it to offer,
    // and one that already has us dedupes re-readys.
    expect(readySends()).toBeGreaterThan(0);
    await t.stop();
  });

  it("a stray nack or a signaling flap cannot paint `failed` over a driving session", async () => {
    const { t, raw, handlers } = session();
    await t.start();
    raw.connected = true;
    await handlers.onRobotHere(); // used to clear `connected`, disabling the guards below
    handlers.onNack({ reason: "forged-reject" });
    handlers.onState("error");
    expect(raw.connStatus.phase).not.toBe("failed");
    await t.stop();
  });

  it("signaling reopen mid-session keeps `connected` too", async () => {
    const { t, raw, handlers } = session();
    await t.start();
    raw.connected = true;
    handlers.onOpen();
    expect(raw.connected).toBe(true);
    await t.stop();
  });
});

describe("estop delivery honesty", () => {
  it("estop THROWS on a dead channel; ordinary commands keep dropping silently", () => {
    const { t } = bare(); // no control channel at all
    expect(() => t.command("estop")).toThrow(/physical E-STOP/);
    expect(() => t.command("reset_latch")).not.toThrow();
  });

  it("estopConfirmed resolves on a latch reported ON THE WIRE after the send", async () => {
    const { t, raw } = bare();
    raw.dcSend = () => true; // delivered
    const confirmed = t.estopConfirmed(500);
    raw.handleTelemetry(JSON.stringify({ type: "telemetry", status: { safety: "latched" } }));
    await expect(confirmed).resolves.toBeUndefined();
  });

  it("estopConfirmed ignores a stale cached latch and rejects on silence", async () => {
    const { t, raw } = bare();
    raw.dcSend = () => true;
    // A latch reported BEFORE the estop is history, not confirmation — the stream may have
    // stalled and the latch may have been cleared at the robot since.
    raw.handleTelemetry(JSON.stringify({ type: "telemetry", status: { safety: "latched" } }));
    await expect(t.estopConfirmed(30)).rejects.toThrow(/NOT stopped/);
  });

  it("estopConfirmed rejects immediately when the channel is dead", async () => {
    const { t } = bare();
    await expect(t.estopConfirmed(500)).rejects.toThrow(/physical E-STOP/);
  });
});

describe("external (VR) lift intent resolves against the descriptor", () => {
  function tickWith(ack: Record<string, unknown> | null, jog: Record<string, unknown>) {
    const { raw } = bare();
    const sent: Record<string, unknown>[] = [];
    raw.ackInfo = ack === null ? null : parseAck(ack);
    raw.controlCh = {
      readyState: "open", bufferedAmount: 0,
      send: (s: string) => sent.push(JSON.parse(s)),
    };
    raw.externalJog = jog;
    raw.jogTick();
    return sent[0]?.jog as Record<string, unknown>;
  }

  it("per-hand lift maps to the A3's bare central 'lift' key", () => {
    const jog = tickWith(A3_ACK, { left_lift: 1 });
    expect(jog.lift).toBe(1);
    expect("left_lift" in jog).toBe(false);
  });

  it("opposing hands on the shared column sum to a hold, not a silent winner", () => {
    const jog = tickWith(A3_ACK, { left_lift: 1, right_lift: -1 });
    expect(jog.lift).toBe(0);
  });

  it("legacy robot (no descriptor): per-hand keys pass through verbatim", () => {
    const jog = tickWith({ type: "ack", accepted: true }, { left_lift: 1, right_lift: -0.5 });
    expect(jog.left_lift).toBe(1);
    expect(jog.right_lift).toBe(-0.5);
    expect("lift" in jog).toBe(false);
  });

  it("a robot with no lift at all gets no invented key", () => {
    const noLift = { ...A3_ACK, descriptor: { ...A3_ACK.descriptor, aux: [] } };
    const jog = tickWith(noLift, { left_lift: 1, base: { linear: 0.2, angular: 0 } });
    expect("lift" in jog).toBe(false);
    expect("left_lift" in jog).toBe(false);
    expect(jog.base).toEqual({ linear: 0.2, angular: 0 });
  });
});
