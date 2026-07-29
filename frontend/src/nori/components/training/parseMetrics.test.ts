// Regression tests for the live-training chart data: folding must be
// idempotent under re-served log windows (the backend slices the full HF log
// by line index per poll) and must emit a strictly sorted, duplicate-free
// step axis — a categorical axis fed duplicated steps duplicated itself every
// poll and rendered the loss curve as a sawtooth.
import { describe, expect, it } from "vitest";
import { emptyMetrics, foldMetrics, type MetricPoint } from "./parseMetrics";

const LINES = [
  "Training:   1%|▏         | 125/10000 [02:02<2:36:10,  1.05step/s] INFO step:125 loss:0.9000 lr:1.0e-04",
  "Training:   2%|▎         | 150/10000 [02:26<2:35:00,  1.05step/s] INFO step:150 loss:0.8000 lr:1.0e-04",
  "Training:   2%|▎         | 175/10000 [02:50<2:34:00,  1.05step/s] INFO step:175 loss:0.7000 lr:1.0e-04",
];

const fold = (lines: string[], prev = { metrics: emptyMetrics(), loss: [] as MetricPoint[], lr: [] as MetricPoint[] }) =>
  foldMetrics(lines, prev);

const steps = (pts: MetricPoint[]) => pts.map((p) => p.step);

describe("foldMetrics", () => {
  it("parses one point per metric line", () => {
    const out = fold(LINES);
    expect(steps(out.loss)).toEqual([125, 150, 175]);
    expect(out.loss[0].value).toBeCloseTo(0.9);
    expect(out.metrics.current_step).toBe(175);
  });

  it("is idempotent when the same log window is re-served", () => {
    const first = fold(LINES);
    const again = foldMetrics(LINES, first); // full replay, as an overlapping poll does
    expect(steps(again.loss)).toEqual([125, 150, 175]); // no duplicated axis
    expect(steps(again.lr)).toEqual([125, 150, 175]);
  });

  it("keeps the latest value when a step repeats (non-consecutively too)", () => {
    const first = fold(LINES);
    const out = foldMetrics(
      ["Training:   1%|▏         | 150/10000 [02:26<2:35:00,  1.05step/s] INFO step:150 loss:0.5000 lr:1.0e-04"],
      first,
    );
    expect(steps(out.loss)).toEqual([125, 150, 175]);
    expect(out.loss.find((p) => p.step === 150)?.value).toBeCloseTo(0.5);
  });

  it("emits a sorted axis even when rounded step tokens arrive out of order", () => {
    // loss lines WITHOUT a same-line tqdm bar fall back to the K-rounded
    // "step:" token — these can land behind already-seen exact steps.
    const first = fold(LINES);
    const out = foldMetrics(["INFO step:0.1K loss:0.6500 lr:1.0e-04"], first); // 0.1K -> 100
    expect(steps(out.loss)).toEqual([100, 125, 150, 175]); // sorted, no dup
  });

  it("never mutates its inputs", () => {
    const first = fold(LINES);
    const frozenLoss = [...first.loss];
    foldMetrics(LINES, first);
    expect(first.loss).toEqual(frozenLoss);
  });
});
