// NORI: unit tests for formatCameraLayout (the SDK's composite-layout → LLM-prompt-string builder,
// Phase F vision). Pure function, so no peer/DOM needed — imported from @nori/sdk (vite-aliased to src).

import { describe, expect, it } from "vitest";
import { formatCameraLayout } from "@nori/sdk";

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
