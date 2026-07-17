// NORI: Additive. Unit tests for the ABR decision table (SDK videoQuality.ts) — the pure math
// that keeps robot video visible on poor links. The controller is deliberately peer-free so its
// collapse/hold/ramp behavior is provable here; the getStats plumbing is tested with a stub pc.
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  ABR_DEFAULTS, AbrController, VideoStatsProbe, classifyQuality, type LinkSample,
} from "@nori/sdk";

const clean = (over?: Partial<LinkSample>): LinkSample => ({
  packetsDelta: 200, lossPct: 0, fps: 15, rttMs: 50, frameHeight: 480, ...over,
});

describe("AbrController", () => {
  it("starts at the slow-start rate, not the ceiling", () => {
    const c = new AbrController();
    expect(c.target).toBe(ABR_DEFAULTS.startKbps);
  });

  it("holds (no ramp) while no packets are arriving — outage or paused encoder", () => {
    const c = new AbrController();
    for (let i = 0; i < 30; i++) c.step(clean({ packetsDelta: 0, fps: 0 }));
    expect(c.target).toBe(ABR_DEFAULTS.startKbps);
  });

  it("ramps up only after ~5 clean seconds, and caps at maxKbps", () => {
    const c = new AbrController();
    for (let i = 0; i < 4; i++) expect(c.step(clean())).toBe(ABR_DEFAULTS.startKbps);
    expect(c.step(clean())).toBeGreaterThan(ABR_DEFAULTS.startKbps); // 5th clean tick probes up
    for (let i = 0; i < 60; i++) c.step(clean());
    expect(Math.round(c.target)).toBe(ABR_DEFAULTS.maxKbps);
  });

  it("collapses multiplicatively on heavy loss and floors at minKbps", () => {
    const c = new AbrController();
    const t1 = c.step(clean({ lossPct: 30 }));
    expect(t1).toBe(Math.round(ABR_DEFAULTS.startKbps * 0.7));
    for (let i = 0; i < 20; i++) c.step(clean({ lossPct: 30 }));
    expect(c.target).toBe(ABR_DEFAULTS.minKbps);
  });

  it("holds (neither grows nor cuts) on tolerable loss that NACK/RTX can cover", () => {
    const c = new AbrController();
    for (let i = 0; i < 10; i++) c.step(clean({ lossPct: 5 }));
    expect(c.target).toBe(ABR_DEFAULTS.startKbps);
  });

  it("tolerable loss resets the clean streak (no ramp through flapping loss)", () => {
    const c = new AbrController();
    for (let i = 0; i < 20; i++) {
      c.step(clean());                    // clean...
      c.step(clean({ lossPct: 5 }));      // ...but never 5 in a row
    }
    expect(c.target).toBe(ABR_DEFAULTS.startKbps);
  });

  it("backs off gently on RTT inflation (bufferbloat), before any loss shows", () => {
    const c = new AbrController();
    c.step(clean({ rttMs: 50 }));  // establishes the 50 ms baseline
    const t = c.step(clean({ rttMs: 260 })); // >2x AND >+150 ms over baseline
    expect(t).toBe(Math.round(ABR_DEFAULTS.startKbps * 0.85));
  });

  it("ignores RTT ratios without the absolute margin (2x a LAN RTT is noise)", () => {
    const c = new AbrController();
    c.step(clean({ rttMs: 5 }));
    for (let i = 0; i < 5; i++) c.step(clean({ rttMs: 12 })); // 2.4x but only +7 ms
    expect(c.target).toBeGreaterThanOrEqual(ABR_DEFAULTS.startKbps); // treated as clean
  });

  it("recovers after a collapse once the link is clean again", () => {
    const c = new AbrController();
    for (let i = 0; i < 5; i++) c.step(clean({ lossPct: 30 }));
    const low = c.target;
    for (let i = 0; i < 10; i++) c.step(clean());
    expect(c.target).toBeGreaterThan(low);
  });
});

describe("classifyQuality", () => {
  it("maps loss/fps to the operator-facing verdict", () => {
    expect(classifyQuality(clean())).toBe("good");
    expect(classifyQuality(clean({ lossPct: 10 }))).toBe("degraded");
    expect(classifyQuality(clean({ fps: 10 }))).toBe("degraded");
    expect(classifyQuality(clean({ lossPct: 25 }))).toBe("bad");
    expect(classifyQuality(clean({ fps: 5 }))).toBe("bad");
    expect(classifyQuality(clean({ fps: null }))).toBe("good"); // unknown fps is not evidence
  });
});

describe("VideoStatsProbe", () => {
  afterEach(() => vi.restoreAllMocks());

  const statsReport = (v: {
    received: number; lost: number; frames: number; rttS: number; height?: number;
  }) =>
    new Map<string, unknown>([
      ["pair", { type: "candidate-pair", selected: true, currentRoundTripTime: v.rttS }],
      ["video", {
        type: "inbound-rtp", kind: "video",
        packetsReceived: v.received, packetsLost: v.lost, framesDecoded: v.frames,
        frameHeight: v.height ?? 480,
      }],
      ["audio", { type: "inbound-rtp", kind: "audio", packetsReceived: 1, packetsLost: 1 }],
    ]);

  const stubPc = (reports: ReturnType<typeof statsReport>[]) => {
    let i = 0;
    return { getStats: async () => reports[Math.min(i++, reports.length - 1)] } as
      unknown as RTCPeerConnection;
  };

  it("returns a no-information first sample, then real deltas (video kind only)", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const probe = new VideoStatsProbe(stubPc([
      statsReport({ received: 900, lost: 0, frames: 100, rttS: 0.05 }),
      statsReport({ received: 1000, lost: 25, frames: 130, rttS: 0.05 }),
    ]));
    const first = await probe.sample();
    expect(first.packetsDelta).toBe(0);
    expect(first.fps).toBeNull();
    expect(first.rttMs).toBe(50);

    now.mockReturnValue(2_000); // 1 s later
    const second = await probe.sample();
    expect(second.packetsDelta).toBe(125);            // 100 received + 25 lost
    expect(second.lossPct).toBeCloseTo(20);           // 25 / 125
    expect(second.fps).toBeCloseTo(30);               // 30 frames / 1 s
    expect(second.frameHeight).toBe(480);             // resolution-ladder rung observability
  });

  it("clamps a packetsLost revision (spec allows the cumulative count to go DOWN)", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const probe = new VideoStatsProbe(stubPc([
      statsReport({ received: 100, lost: 50, frames: 10, rttS: 0.05 }),
      statsReport({ received: 200, lost: 40, frames: 25, rttS: 0.05 }),
    ]));
    await probe.sample();
    now.mockReturnValue(2_000);
    const s = await probe.sample();
    expect(s.lossPct).toBe(0); // -10 lost clamps to 0, not a negative rate
  });
});
