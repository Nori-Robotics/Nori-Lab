import { describe, expect, it } from "vitest";
import { RemoteTeleop, parseAck } from "@nori/sdk";
import type { NavigationStatus } from "@nori/sdk";


type Raw = {
  ackInfo: unknown;
  dcSend: (frame: Record<string, unknown>) => boolean;
  handleTelemetry: (data: string) => void;
};

function harness(capabilities = ["named_navigation"]) {
  const observed: NavigationStatus[] = [];
  const teleop = new RemoteTeleop({
    arm: "right",
    onNavigationStatus: (status: NavigationStatus) => observed.push(status),
  } as never);
  const raw = teleop as unknown as Raw;
  raw.ackInfo = parseAck({
    type: "ack", accepted: true, protocol_version: 1, capabilities,
  });
  const sent: Record<string, unknown>[] = [];
  raw.dcSend = (frame) => { sent.push(frame); return true; };
  return { teleop, raw, sent, observed };
}

describe("named navigation", () => {
  it("emits correlated start and resolves only its matching reply", async () => {
    const { teleop, raw, sent } = harness();
    const promise = teleop.navigateToWaypoint("Dock");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "navigation", action: "start", name: "Dock",
    });
    expect(String(sent[0].request_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(sent[0].goal_id)).toMatch(/^[0-9a-f-]{36}$/);

    raw.handleTelemetry(JSON.stringify({
      type: "navigation_status",
      request_id: sent[0].request_id,
      goal_id: sent[0].goal_id,
      ok: true,
      state: "navigating",
      active: true,
      name: "Dock",
    }));
    await expect(promise).resolves.toMatchObject({
      ok: true, state: "navigating", active: true, name: "Dock",
    });
  });

  it("awaits a terminal goal update and ignores stale regression", async () => {
    const { teleop, raw, observed } = harness();
    const goalId = "90b234d9-9582-4d5b-9792-7f81080a4dcb";
    const finished = teleop.awaitNavigation(goalId, { timeoutMs: 500 });
    raw.handleTelemetry(JSON.stringify({
      type: "navigation_status", ok: true, state: "succeeded", active: false,
      goal_id: goalId, name: "Dock",
    }));
    await expect(finished).resolves.toMatchObject({ state: "succeeded" });
    raw.handleTelemetry(JSON.stringify({
      type: "navigation_status", ok: true, state: "navigating", active: true,
      goal_id: goalId, name: "Dock",
    }));
    expect(teleop.latestNavigationStatus()?.state).toBe("succeeded");
    expect(observed.map((status) => status.state)).toEqual(["succeeded"]);
  });

  it("parses waypoint lists without exposing wire casing", async () => {
    const { teleop, raw, sent } = harness();
    const promise = teleop.listWaypoints();
    raw.handleTelemetry(JSON.stringify({
      type: "navigation_status", request_id: sent[0].request_id,
      ok: true, state: "idle", active: false,
      waypoints: [{ name: "Dock", saved_at_unix: 1234.5 }],
    }));
    await expect(promise).resolves.toMatchObject({
      waypoints: [{ name: "Dock", savedAtUnix: 1234.5 }],
    });
  });

  it("preflights an explicitly absent capability", async () => {
    const { teleop, sent } = harness(["record"]);
    await expect(teleop.getNavigationStatus()).rejects.toThrow(/named_navigation/);
    expect(sent).toHaveLength(0);
  });
});
