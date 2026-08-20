import { describe, it, expect } from "vitest";
import { isHostedOrigin } from "./hostedOrigin";

describe("isHostedOrigin", () => {
  it("treats the deployed app as hosted", () => {
    expect(isHostedOrigin("lab.norirobotics.com")).toBe(true);
    expect(isHostedOrigin("nori-lelab-git-main-nori.vercel.app")).toBe(true);
    expect(isHostedOrigin("nori-lelab.hf.space")).toBe(true);
  });

  it("treats a LeLab on this machine as NOT hosted", () => {
    for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "LOCALHOST"])
      expect(isHostedOrigin(h)).toBe(false);
  });

  it("treats a LeLab reached over the user's own LAN as NOT hosted", () => {
    // Someone opening their laptop's LeLab from a phone on the same network.
    for (const h of ["192.168.68.72", "10.0.0.4", "172.16.5.9", "172.31.255.1", "169.254.1.1", "jasmine-mbp.local"])
      expect(isHostedOrigin(h)).toBe(false);
  });

  it("does not mistake a public address that merely looks private", () => {
    // 172.15 and 172.32 are outside the RFC1918 block.
    expect(isHostedOrigin("172.15.0.1")).toBe(true);
    expect(isHostedOrigin("172.32.0.1")).toBe(true);
    expect(isHostedOrigin("11.0.0.1")).toBe(true);
  });

  it("assumes local when there is no window", () => {
    expect(isHostedOrigin("")).toBe(false);
  });
});
