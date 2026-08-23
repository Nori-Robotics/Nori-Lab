// parseAck (P4.1): the handshake parse must survive the full fixture ack, a bare old-daemon
// ack, and a rejection — and flag (not fail on) a protocol version mismatch.
import { describe, expect, it } from "vitest";
import { parseAck, supportsCapability, NORI_PROTOCOL_VERSION } from "@nori/sdk";

// Mirrors nori-protocol fixtures/ack.json (the daemon's golden handshake frame).
const FIXTURE_ACK: Record<string, unknown> = {
  type: "ack",
  accepted: true,
  protocol_version: 1,
  norm_mode: "range_m100_100",
  watchdog_profile: { t_warn_ms: 300, t_stop_ms: 1000 },
  descriptor: {
    buses: ["bus1", "bus2"],
    joints: ["left_arm_shoulder_pan.pos", "left_arm_gripper.pos", "right_arm_gripper.pos"],
    base: ["x.vel", "theta.vel"],
    aux: ["left_lift", "right_lift"],
    cameras: ["front", "right_wrist"],
    ranges: {
      "left_arm_shoulder_pan.pos": [-100, 100],
      "left_arm_gripper.pos": [0, 100],
    },
  },
  initial_state: { "right_arm_shoulder_pan.pos": 12.4, "x.vel": 0.0 },
};

describe("parseAck", () => {
  it("parses the full golden-fixture ack", () => {
    const info = parseAck(FIXTURE_ACK);
    expect(info.accepted).toBe(true);
    expect(info.protocolVersion).toBe(1);
    expect(info.normMode).toBe("range_m100_100");
    expect(info.watchdogProfile).toEqual({ t_warn_ms: 300, t_stop_ms: 1000 });
    expect(info.descriptor?.cameras).toEqual(["front", "right_wrist"]);
    expect(info.descriptor?.ranges?.["left_arm_gripper.pos"]).toEqual([0, 100]);
    expect(info.initialState?.["right_arm_shoulder_pan.pos"]).toBe(12.4);
    expect(info.error).toBeUndefined();
    expect(info.versionMismatch).toBe(false);
  });

  it("SDK's own protocol version is the default comparison target", () => {
    const info = parseAck({ type: "ack", protocol_version: NORI_PROTOCOL_VERSION });
    expect(info.versionMismatch).toBe(false);
  });

  it("tolerates a bare old-daemon ack: accepted, everything else undefined, no mismatch", () => {
    const info = parseAck({ type: "ack" });
    expect(info.accepted).toBe(true); // absent `accepted` = accepted (old daemons)
    expect(info.protocolVersion).toBeUndefined();
    expect(info.watchdogProfile).toBeUndefined();
    expect(info.descriptor).toBeUndefined();
    expect(info.versionMismatch).toBe(false); // can't mismatch an undeclared version
  });

  it("parses a rejection with its reason", () => {
    const info = parseAck({ type: "ack", accepted: false, error: "protocol_version 99 unsupported" });
    expect(info.accepted).toBe(false);
    expect(info.error).toBe("protocol_version 99 unsupported");
  });

  it("flags a version mismatch as advisory state (still parses the rest)", () => {
    const info = parseAck({ ...FIXTURE_ACK, protocol_version: 2 }, 1);
    expect(info.versionMismatch).toBe(true);
    expect(info.accepted).toBe(true);
    expect(info.descriptor?.joints?.length).toBe(3);
  });

  it("drops a malformed watchdog_profile instead of propagating garbage", () => {
    const info = parseAck({ type: "ack", watchdog_profile: { t_warn_ms: "soon" } });
    expect(info.watchdogProfile).toBeUndefined();
  });

  it("parses model and capabilities (A3-era ack)", () => {
    const info = parseAck({
      ...FIXTURE_ACK,
      model: "A3",
      capabilities: ["task_jog", "pose_targets", "record"],
    });
    expect(info.model).toBe("A3");
    expect(info.capabilities).toEqual(["task_jog", "pose_targets", "record"]);
    expect(supportsCapability(info, "pose_targets")).toBe(true);
    expect(supportsCapability(info, "call")).toBe(false);
  });

  it("capability check is THREE-VALUED: an ack predating the field is unknown, not false", () => {
    const legacy = parseAck(FIXTURE_ACK); // no capabilities key — pre-2026-08 robots
    expect(legacy.capabilities).toBeUndefined();
    expect(supportsCapability(legacy, "pose_targets")).toBeUndefined();
    // Explicitly-empty means NONE — distinct from unknown.
    const none = parseAck({ ...FIXTURE_ACK, capabilities: [] });
    expect(supportsCapability(none, "pose_targets")).toBe(false);
  });

  it("drops malformed capabilities/model instead of propagating garbage", () => {
    const info = parseAck({ ...FIXTURE_ACK, capabilities: ["task_jog", 7], model: "" });
    expect(info.capabilities).toBeUndefined(); // mixed types -> unknown, never partial
    expect(info.model).toBeUndefined();        // empty label is the legacy signal
  });

  it("parses jog_scale through the descriptor (advisory commanded scale)", () => {
    const info = parseAck({
      ...FIXTURE_ACK,
      descriptor: {
        ...(FIXTURE_ACK.descriptor as Record<string, unknown>),
        jog_scale: { task: { x: 0.08, z: 0.08 }, lift: 50.0 },
      },
    });
    expect(info.descriptor?.jog_scale?.task?.x).toBe(0.08);
    expect(info.descriptor?.jog_scale?.lift).toBe(50.0);
  });
});
