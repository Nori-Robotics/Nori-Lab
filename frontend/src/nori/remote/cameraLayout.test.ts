// NORI: unit tests for formatCameraLayout (the SDK's composite-layout → LLM-prompt-string builder,
// Phase F vision). Pure function, so no peer/DOM needed — imported from @nori/sdk (vite-aliased to src).

import { describe, expect, it } from "vitest";
import { cameraTileRect, formatCameraLayout } from "@nori/sdk";

describe("formatCameraLayout", () => {
  it("labels a 2x2 grid row-major (the canonical 4-camera composite)", () => {
    const s = formatCameraLayout({
      cols: 2, rows: 2, tiles: ["left_wrist", "right_wrist", "overhead", "front"],
    });
    expect(s).toContain("2x2");
    expect(s).toContain("top-left = left_wrist");
    expect(s).toContain("top-right = right_wrist");
    expect(s).toContain("bottom-left = overhead");
    expect(s).toContain("bottom-right = front");
  });

  it("labels a single row (2 side-by-side)", () => {
    const s = formatCameraLayout({ cols: 2, rows: 1, tiles: ["left_wrist", "right_wrist"] });
    expect(s).toContain("left = left_wrist");
    expect(s).toContain("right = right_wrist");
  });

  it("labels a single column", () => {
    const s = formatCameraLayout({ cols: 1, rows: 2, tiles: ["overhead", "front"] });
    expect(s).toContain("top = overhead");
    expect(s).toContain("bottom = front");
  });

  it("uses row/col words for a larger grid", () => {
    const s = formatCameraLayout({ cols: 3, rows: 2, tiles: ["a", "b", "c", "d", "e", "f"] });
    expect(s).toContain("top col 1 = a");     // index 0 -> row 0, col 0
    expect(s).toContain("bottom col 3 = f");  // index 5 -> row 1, col 2
  });
});

// cameraTileRect: the role -> source-crop-rect mapping shared by cameraView() (live per-camera
// stream), captureFrame(role) (one-shot crop, the agent-loop per-camera `look`), and any app-side
// consumer. Grid geometry mirrors the real robot: A2 of camera_test_plan.md measured 640x480 for
// 3 cams (2x2 grid) and 640x240 after dropping to 2 (2x1) — composite pixels are exactly
// cols*cellW x rows*cellH, which is the assumption this math rests on.
describe("cameraTileRect", () => {
  const grid2x2 = { cols: 2, rows: 2, tiles: ["left_wrist", "right_wrist", "overhead"] };

  it("maps each role to its row-major tile in a 2x2 composite (3 cams, 640x480)", () => {
    expect(cameraTileRect(grid2x2, "left_wrist", 640, 480))
      .toEqual({ sx: 0, sy: 0, sw: 320, sh: 240 });
    expect(cameraTileRect(grid2x2, "right_wrist", 640, 480))
      .toEqual({ sx: 320, sy: 0, sw: 320, sh: 240 });
    expect(cameraTileRect(grid2x2, "overhead", 640, 480))
      .toEqual({ sx: 0, sy: 240, sw: 320, sh: 240 });
  });

  it("maps a 2x1 grid (2 cams, 640x240)", () => {
    const grid2x1 = { cols: 2, rows: 1, tiles: ["left_wrist", "overhead"] };
    expect(cameraTileRect(grid2x1, "overhead", 640, 240))
      .toEqual({ sx: 320, sy: 0, sw: 320, sh: 240 });
  });

  it("tracks a mid-session resolution change (crop rect derives from live frame dims)", () => {
    expect(cameraTileRect(grid2x2, "right_wrist", 960, 720))
      .toEqual({ sx: 480, sy: 0, sw: 480, sh: 360 });
  });

  it("returns null on an unknown role or degenerate dims — callers must error, never fall back to the composite", () => {
    expect(cameraTileRect(grid2x2, "front", 640, 480)).toBeNull();
    expect(cameraTileRect(grid2x2, "left_wrist", 0, 480)).toBeNull();
    expect(cameraTileRect({ cols: 0, rows: 1, tiles: ["x"] }, "x", 640, 480)).toBeNull();
  });
});
