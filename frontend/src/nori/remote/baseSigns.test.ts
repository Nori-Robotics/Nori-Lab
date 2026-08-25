// NORI: Additive. Regression guard for the base sign convention (nori-protocol MODELS.md).
//
// The wire is spec REP-103 (+linear = forward, +angular = LEFT, no client negation) for every
// robot except the frozen L2 fleet, whose firmware turns opposite on angular and can never be
// updated. RemoteTeleop.wireJog is the ONE place that flip happens, keyed to a POSITIVE L2
// match (opts override > ack.model > room serial) — unknown must resolve to the spec
// convention, never to the legacy one, or a future model inherits the quirk by omission.
import { describe, expect, it } from "vitest";
import { RemoteTeleop, parseAck, serialModelCode } from "@nori/sdk";

// Same private-reach idiom as sendPose.test.ts: poke ackInfo, call wireJog directly.
function teleop(opts: { room?: string; ackModel?: string | null; baseSigns?: "rep103" | "l2-legacy" }) {
  const t = new RemoteTeleop({
    arm: "right",
    baseSigns: opts.baseSigns,
    signaling: opts.room !== undefined ? { room: opts.room } : {},
  } as never);
  const raw = t as unknown as {
    ackInfo: unknown;
    wireJog: (jog: Record<string, unknown>) => Record<string, unknown>;
  };
  if (opts.ackModel !== undefined) {
    raw.ackInfo = parseAck({ type: "ack", accepted: true, ...(opts.ackModel ? { model: opts.ackModel } : {}) });
  }
  return raw;
}

const JOG = { base: { linear: 0.4, angular: 0.5 }, left_arm: { x: 1 } };

describe("serialModelCode", () => {
  it("parses fleet serials, case-insensitively", () => {
    expect(serialModelCode("NORI-L2-0007")).toBe("L2");
    expect(serialModelCode("nori-a3-0001")).toBe("A3");
  });
  it("returns null for non-fleet rooms", () => {
    expect(serialModelCode("nori-dev")).toBeNull();
    expect(serialModelCode("")).toBeNull();
  });
});

describe("wireJog base signs", () => {
  it("passes REP-103 through untouched for an A3 (ack.model)", () => {
    expect(teleop({ ackModel: "A3" }).wireJog(JOG)).toEqual(JOG);
  });

  it("defaults to REP-103 when nothing identifies the robot", () => {
    expect(teleop({ room: "nori-dev" }).wireJog(JOG)).toEqual(JOG);
    expect(teleop({}).wireJog(JOG)).toEqual(JOG);
  });

  it("flips ONLY angular for an L2 room serial; linear and arms untouched", () => {
    const wired = teleop({ room: "NORI-L2-0007" }).wireJog(JOG);
    expect(wired).toEqual({ base: { linear: 0.4, angular: -0.5 }, left_arm: { x: 1 } });
    // and the input payload is not mutated (VR reuses its ExternalJog object across ticks)
    expect(JOG.base.angular).toBe(0.5);
  });

  it("believes a positive ack.model over an L2-looking room", () => {
    expect(teleop({ room: "NORI-L2-0007", ackModel: "A3" }).wireJog(JOG)).toEqual(JOG);
  });

  it("an L2 daemon never sends model — an ack without one falls back to the room", () => {
    const wired = teleop({ room: "NORI-L2-0007", ackModel: null }).wireJog(JOG);
    expect((wired.base as Record<string, number>).angular).toBe(-0.5);
  });

  it("opts.baseSigns overrides everything (dev-room L2, mislabelled ack)", () => {
    const legacy = teleop({ room: "nori-dev", baseSigns: "l2-legacy" }).wireJog(JOG);
    expect((legacy.base as Record<string, number>).angular).toBe(-0.5);
    const spec = teleop({ room: "NORI-L2-0007", baseSigns: "rep103" }).wireJog(JOG);
    expect(spec).toEqual(JOG);
  });

  it("leaves a zero/absent base alone", () => {
    const zero = { base: { linear: 0, angular: 0 } };
    expect(teleop({ room: "NORI-L2-0007" }).wireJog(zero)).toEqual(zero);
    expect(teleop({ room: "NORI-L2-0007" }).wireJog({ left_arm: { x: 1 } })).toEqual({ left_arm: { x: 1 } });
  });
});
