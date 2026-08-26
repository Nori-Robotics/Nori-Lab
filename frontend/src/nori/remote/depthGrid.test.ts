// NORI: tests for the depth-grid formatting the look tool_result carries (depthGrid.ts).

import { describe, expect, it } from "vitest";
import { formatDepthGrid, isDepthGridResult, type DepthGridResult } from "./depthGrid";

const result: DepthGridResult = {
  model: "depth-anything-v2-small",
  width: 640, height: 480, grid_w: 3, grid_h: 2,
  grid: [[0.9, 0.5, 0.1], [1, 0.25, 0]],
  ms: 200,
};

describe("formatDepthGrid", () => {
  it("one framing line + one line per row, fixed two decimals", () => {
    const s = formatDepthGrid(result);
    const lines = s.split("\n");
    expect(lines).toHaveLength(3); // framing + 2 rows
    expect(lines[0]).toContain("3 cols x 2 rows");
    expect(lines[0]).toContain("NOT metres");
    expect(lines[1]).toBe("0.90 0.50 0.10");
    expect(lines[2]).toBe("1.00 0.25 0.00");
  });
});

describe("isDepthGridResult", () => {
  it("accepts the endpoint shape, rejects error payloads and junk", () => {
    expect(isDepthGridResult(result)).toBe(true);
    expect(isDepthGridResult(null)).toBe(false);
    expect(isDepthGridResult({ detail: "image too large" })).toBe(false);
    expect(isDepthGridResult({ grid: [] })).toBe(false);
    expect(isDepthGridResult({ grid: [0.5] })).toBe(false); // rows must be arrays
  });
});
