import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteTeleop, parseAck } from "@nori/sdk";
import type { NavigationStatus } from "@nori/sdk";


type Raw = {
  ackInfo: unknown;
  dcSend: (frame: Record<string, unknown>) => boolean;
  handleTelemetry: (data: string) => void;
};

function harness(capabilities = ["named_navigation"]) {
  const observed: NavigationStatus[] = [];
  // `link.open` models the control channel going away under an in-flight request.
  const link = { open: true };
  const teleop = new RemoteTeleop({
    arm: "right",
    onNavigationStatus: (status: NavigationStatus) => observed.push(status),
    // Just enough option surface for the real stop() teardown to run in-process.
    signaling: { sendBye: () => {}, close: async () => {} },
    onTelemetry: () => {},
    onControlActive: () => {},
    onConnState: () => {},
  } as never);
  const raw = teleop as unknown as Raw;
  raw.ackInfo = parseAck({
    type: "ack", accepted: true, protocol_version: 1, capabilities,
  });
  const sent: Record<string, unknown>[] = [];
  raw.dcSend = (frame) => { sent.push(frame); return link.open; };
  return { teleop, raw, sent, observed, link };
}

const NAVIGATING = (goalId: string) => JSON.stringify({
  type: "navigation_status", ok: true, state: "navigating", active: true,
  goal_id: goalId, name: "Dock",
});

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

// A lost reply is not a lost command: every synthesized status must stay honest about
// the fact that the robot may still be driving.
describe("navigation failure paths", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("marks a reply timeout unreachable rather than reporting a finished goal", async () => {
    const { teleop, sent } = harness();
    const pending = teleop.navigateToWaypoint("Dock", { timeoutMs: 5000 });
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    const status = await pending;
    expect(status).toMatchObject({ ok: false, unreachable: true });
    expect(status.error).toMatch(/no reply in 5000ms/);
    expect(status.goalId).toBe(sent[0].goal_id);
  });

  it("carries the robot's last known motion into an awaitNavigation timeout", async () => {
    const { teleop, raw } = harness();
    const goalId = "90b234d9-9582-4d5b-9792-7f81080a4dcb";
    raw.handleTelemetry(NAVIGATING(goalId));
    const pending = teleop.awaitNavigation(goalId, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    // The goal did not finish in time, but the robot was last seen DRIVING and a
    // client-side timeout is not evidence that it stopped.
    await expect(pending).resolves.toMatchObject({
      ok: false, unreachable: true, state: "navigating", active: true, goalId,
    });
  });

  it("does not treat an unknown lifecycle state as a finished goal", async () => {
    const { teleop, raw } = harness();
    const goalId = "44444444-4444-4444-8444-444444444444";
    const pending = teleop.awaitNavigation(goalId, { timeoutMs: 1000 });
    // A newer robot reports a state this build has never heard of, mid-drive.
    raw.handleTelemetry(JSON.stringify({
      type: "navigation_status", ok: true, state: "docking", active: true,
      goal_id: goalId, name: "Dock",
    }));
    expect(teleop.latestNavigationStatus()?.state).toBe("docking");
    // It must NOT have resolved: coercing the unknown state onto "failed" would report a
    // finished goal while the robot is still driving.
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({
      unreachable: true, state: "docking", active: true,
    });
  });

  it("never carries a different goal's snapshot into an unreachable status", async () => {
    const { teleop, raw } = harness();
    raw.handleTelemetry(NAVIGATING("11111111-1111-4111-8111-111111111111"));
    const pending = teleop.awaitNavigation(
      "22222222-2222-4222-8222-222222222222", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({
      unreachable: true, state: "unavailable", active: false,
    });
  });

  it("retries one request_id so a lost reply cannot start a duplicate goal", async () => {
    const { teleop, sent } = harness();
    const pending = teleop.navigateToWaypoint("Dock", { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(2400);
    expect(sent.length).toBeGreaterThan(1);
    expect(new Set(sent.map((frame) => frame.request_id)).size).toBe(1);
    expect(new Set(sent.map((frame) => frame.goal_id)).size).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
  });

  it("resolves unreachable and arms no retry when the channel is closed", async () => {
    const { teleop, sent, link } = harness();
    link.open = false;
    const status = await teleop.navigateToWaypoint("Dock");
    expect(status).toMatchObject({ ok: false, unreachable: true });
    expect(status.error).toMatch(/not open/);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1); // no retry interval survived the failed send
  });

  it("drains in-flight waiters as unreachable when the session stops", async () => {
    const { teleop, raw } = harness();
    const goalId = "33333333-3333-4333-8333-333333333333";
    raw.handleTelemetry(NAVIGATING(goalId));
    const request = teleop.listWaypoints();
    const goal = teleop.awaitNavigation(goalId, { timeoutMs: 60_000 });
    await teleop.stop();
    await expect(request).resolves.toMatchObject({ ok: false, unreachable: true });
    // The gateway cancels this session's goal on disconnect, but that is best-effort
    // and unconfirmable from here, so teardown must not report the robot as stopped.
    await expect(goal).resolves.toMatchObject({
      ok: false, unreachable: true, state: "navigating", active: true,
    });
  });
});
