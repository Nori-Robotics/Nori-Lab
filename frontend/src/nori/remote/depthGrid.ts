// NORI: Additive file. Depth-grid fetch + formatting for the agent loop's `look` tool.
//
// After each look snapshot the page sends the SAME JPEG to the depth endpoint (desktop:
// LeLab's /nori/depth proxy; hosted: Nori-Backend's /api/v1/agent/depth directly) and the
// returned relative-depth grid is appended to the look tool_result as one compact text block
// (~200 tokens at 8x6). Relative only for now — per-frame normalized Depth Anything V2 output;
// metric anchoring (FK gripper-in-view / overhead homography) is the next iteration.
//
// Failures are always soft: depth is grounding, not a dependency — a run must degrade to
// plain-RGB looks, never error, when the endpoint is cold/missing/offline.

export interface DepthGridResult {
  model: string;
  width: number;
  height: number;
  grid_w: number;
  grid_h: number;
  grid: number[][]; // row-major, top row first; 1 = nearest in THIS frame, 0 = farthest
  ms: number;
}

// One line of framing + one line per grid row. Two decimals, space-separated — the densest
// encoding Claude reads reliably as a spatial grid.
export function formatDepthGrid(r: DepthGridResult): string {
  const rows = r.grid.map((row) => row.map((v) => v.toFixed(2)).join(" ")).join("\n");
  return (
    `Relative depth grid for this frame (${r.grid_w} cols x ${r.grid_h} rows covering the image, ` +
    `rows top->bottom, cols left->right; 1.00 = nearest surface IN THIS FRAME, 0.00 = farthest — ` +
    `per-frame normalized, NOT metres, not comparable across frames):\n` +
    rows
  );
}

// Shared response check so both transports fail-soft identically on a malformed payload.
export function isDepthGridResult(v: unknown): v is DepthGridResult {
  const r = v as DepthGridResult;
  return !!r && Array.isArray(r.grid) && r.grid.length > 0 && Array.isArray(r.grid[0]);
}
