import { describe, expect, it } from "vitest";
import {
  blackCell, boardFits, boardGeometry, estimatedScale, isTargetPath, readSavedProfile,
  sameEnvironment, targetManifest, type ScreenEnvironment, type VerifiedScreenProfile,
} from "./screenTarget";

const environment: ScreenEnvironment = { screenWidth: 915, screenHeight: 412, dpr: 2.625, zoom: 1, orientation: "landscape-primary" };
const profile: VerifiedScreenProfile = {
  version: 1, phone: "pixel-6", cssPixelsPerMm: estimatedScale("pixel-6", environment.dpr),
  environment, verifiedAt: "2026-11-13T12:00:00Z",
};

describe("screen checkerboard physical geometry", () => {
  it("treats Pixel 6 data as an estimate and requires explicit operator verification", () => {
    expect(estimatedScale("pixel-6", 2.625)).toBeCloseTo(411 / 25.4 / 2.625);
    expect(readSavedProfile(JSON.stringify({ phone: "pixel-6" }), environment)).toBeNull();
    expect(readSavedProfile(JSON.stringify(profile), environment)).toEqual(profile);
  });
  it("exports the actual rounded cell spacing, in metres, rather than requested spacing", () => {
    const g = boardGeometry(5, profile.cssPixelsPerMm, environment.dpr);
    const m = targetManifest(profile, 5, "overhead", environment, "test-target");
    expect(Number.isInteger(g.squareDevicePixels)).toBe(true);
    expect(g.widthDevicePixels).toBe(g.squareDevicePixels * 12);
    expect(g.heightDevicePixels).toBe(g.squareDevicePixels * 10);
    expect(m.square_size_m).toBe(g.squareDevicePixels / environment.dpr / profile.cssPixelsPerMm / 1000);
    expect(m.square_size_m).not.toBe(m.requested_square_size_m);
    expect(m.inner_corners).toEqual({ columns: 9, rows: 7 });
    expect(m.status).toBe("target_only_camera_calibration_not_performed");
  });
  it("contains ten by eight alternating squares and a complete white border", () => {
    for (let y = 0; y < 10; y++) for (let x = 0; x < 12; x++) {
      if (x === 0 || y === 0 || x === 11 || y === 9) expect(blackCell(x, y)).toBe(false);
      else { expect(blackCell(x, y)).toBe((x + y) % 2 === 0); }
    }
    expect(blackCell(1, 1)).toBe(true);
  });
  it("rejects stale, corrupt and unsupported saved profiles", () => {
    for (const change of [{ dpr: 3 }, { zoom: 1.1 }, { screenWidth: 412 }, { orientation: "portrait-primary" }]) {
      expect(readSavedProfile(JSON.stringify(profile), { ...environment, ...change })).toBeNull();
    }
    for (const raw of ["oops", "{}", "null", JSON.stringify({ ...profile, cssPixelsPerMm: 0 }), JSON.stringify({ ...profile, version: 2 }), JSON.stringify({ ...profile, verifiedAt: "bad" })]) {
      expect(readSavedProfile(raw, environment)).toBeNull();
    }
  });
  it("does not export a guessed profile or a zoomed target", () => {
    expect(() => targetManifest({ ...profile, verifiedAt: "" }, 5, "front", environment, "id")).toThrow();
    const zoomed = { ...environment, zoom: 1.2 };
    expect(() => targetManifest({ ...profile, environment: zoomed }, 5, "front", zoomed, "id")).toThrow();
  });
  it("never silently shrinks a board to fit a small viewport", () => {
    const g = boardGeometry(6, profile.cssPixelsPerMm, environment.dpr);
    expect(boardFits(g, 915, 200)).toBe(false);
    expect(boardFits(g, 915, 412)).toBe(true);
    expect(boardFits(g, NaN, 412)).toBe(false);
    expect(g.actualSquareMm).toBeGreaterThan(5.9);
  });
  it("rejects non-finite and non-positive physical dimensions", () => {
    for (const n of [0, -1, NaN, Infinity]) expect(() => boardGeometry(n, 6, 2)).toThrow();
    expect(() => boardGeometry(5, 0, 2)).toThrow();
  });
  it("detects physical mapping changes while tolerating floating-point noise", () => {
    expect(sameEnvironment(environment, { ...environment, dpr: 2.625000001 })).toBe(true);
    expect(sameEnvironment(environment, { ...environment, zoom: 1.01 })).toBe(false);
  });
  it("recognizes only the standalone route", () => {
    expect(isTargetPath("/nori/calibration-target/")).toBe(true);
    expect(isTargetPath("/nori/calibration-target-extra")).toBe(false);
  });
});
