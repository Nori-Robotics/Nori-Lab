import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyRunner } from "./policyRun";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PolicyRunner startup cleanup", () => {
  it("restores manual control after a post-load camera-layout failure", async () => {
    const calls: string[] = [];
    const video = { style: {}, play: () => Promise.resolve(), muted: false, playsInline: false };
    const div = { style: {}, appendChild: () => undefined, remove: () => undefined, textContent: "" };
    vi.stubGlobal("document", {
      createElement: (tag: string) => (tag === "video" ? video : div),
      body: { appendChild: () => undefined },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      image_keys: { "observation.images.left_wrist": [3, 224, 224] }, fps: 10,
    }), { status: 200 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const teleop = {
      isVideoPaused: () => false,
      resumeVideo: () => calls.push("resume"),
      setPolicyDriving: (enabled: boolean) => calls.push(`driving:${enabled}`),
      cameraLayoutInfo: () => ({ cols: 1, rows: 1, tiles: [] }),
      videoStream: () => null,
      policyStreamStatus: () => null,
    };
    const runner = new PolicyRunner("http://lelab", () => ({ state: { "left_arm_gripper.pos": 0 } }));

    await expect(runner.start(teleop as never, "policy")).rejects.toThrow('policy needs camera "left_wrist"');

    expect(calls).toContain("driving:false");
    expect(calls.indexOf("driving:false")).toBeGreaterThan(calls.indexOf("driving:true"));
  });

  it("restores manual control when the policy load request fails", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("load failed", { status: 500 })));
    const teleop = {
      isVideoPaused: () => false,
      resumeVideo: () => calls.push("resume"),
      setPolicyDriving: (enabled: boolean) => calls.push(`driving:${enabled}`),
      policyStreamStatus: () => null,
    };
    const runner = new PolicyRunner("http://lelab", () => ({ state: { "left_arm_gripper.pos": 0 } }));

    await expect(runner.start(teleop as never, "policy")).rejects.toThrow("load failed: HTTP 500");

    expect(calls).toContain("driving:false");
    expect(calls.indexOf("driving:false")).toBeGreaterThan(calls.indexOf("driving:true"));
  });
});
