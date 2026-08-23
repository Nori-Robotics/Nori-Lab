// sendPose (control.pose, capability "pose_targets"): the wire shape must match the
// nori-protocol fixtures byte-for-byte, the capability gate must be three-valued (throw
// only on an EXPLICIT absence — a legacy ack passes through), and malformed vectors must
// throw client-side rather than costing a round trip to a robot-side "bad_pose".
import { describe, expect, it } from "vitest";
import { RemoteTeleop, parseAck } from "@nori/sdk";

// Reach the private wire path the way the mock-session tests do: drive the instance
// directly and capture dcSend output.
function teleopWithAck(ack: Record<string, unknown> | null) {
  const t = new RemoteTeleop({ arm: "right" } as never);
  const sent: Record<string, unknown>[] = [];
  const raw = t as unknown as {
    ackInfo: unknown;
    dcSend: (f: Record<string, unknown>) => void;
    sendPose: RemoteTeleop["sendPose"];
  };
  raw.ackInfo = ack === null ? null : parseAck(ack);
  raw.dcSend = (f) => sent.push(f);
  return { t, sent };
}

const A3_ACK = {
  type: "ack", accepted: true, protocol_version: 1, model: "A3",
  capabilities: ["task_jog", "pose_targets", "record"],
};

describe("sendPose", () => {
  it("emits the spec wire shape (fixtures/daemon/control_pose.json)", () => {
    const { t, sent } = teleopWithAck(A3_ACK);
    t.sendPose("right", [0.55, -0.45, 0.98], [0.0, 0.7071068, 0.0, 0.7071068], "pose-000041");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "control",
      action_id: "pose-000041",
      pose: {
        right_arm: {
          frame: "base_footprint",
          position_m: [0.55, -0.45, 0.98],
          orientation_xyzw: [0.0, 0.7071068, 0.0, 0.7071068],
        },
      },
    });
    expect(typeof sent[0].seq).toBe("number");
  });

  it("omits orientation for position-only targets (solver keeps the current wrist)", () => {
    const { t, sent } = teleopWithAck(A3_ACK);
    t.sendPose("left", [0.38, 0.21, 0.7]);
    const target = (sent[0].pose as Record<string, Record<string, unknown>>).left_arm;
    expect(target.position_m).toEqual([0.38, 0.21, 0.7]);
    expect("orientation_xyzw" in target).toBe(false);
    expect("action_id" in sent[0]).toBe(false);
  });

  it("throws on an EXPLICITLY missing capability — the frame would be silently ignored", () => {
    const { t, sent } = teleopWithAck({ ...A3_ACK, capabilities: ["task_jog"] });
    expect(() => t.sendPose("right", [0.1, 0.2, 0.3])).toThrow(/pose_targets/);
    expect(sent).toHaveLength(0);
  });

  it("lets a legacy ack (no capabilities field) through: probe-or-assume-legacy", () => {
    const { t, sent } = teleopWithAck({ type: "ack", accepted: true });
    t.sendPose("right", [0.1, 0.2, 0.3]);
    expect(sent).toHaveLength(1);
  });

  it("also passes before any ack has arrived (nothing to gate on yet)", () => {
    const { t, sent } = teleopWithAck(null);
    t.sendPose("right", [0.1, 0.2, 0.3]);
    expect(sent).toHaveLength(1);
  });

  it("throws on malformed vectors instead of flying them", () => {
    const { t, sent } = teleopWithAck(A3_ACK);
    expect(() => t.sendPose("right", [0.1, 0.2])).toThrow(/position/);
    expect(() => t.sendPose("right", [0.1, 0.2, 0.3], [0, 0, 1])).toThrow(/orientation/);
    expect(sent).toHaveLength(0);
  });
});
