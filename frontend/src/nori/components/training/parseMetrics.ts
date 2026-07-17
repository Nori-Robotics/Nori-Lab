// NORI: client-side training-log metric parser. Mirrors lelab/jobs.py
// `parse_metrics_into` so the live monitor can reconstruct progress + the loss
// curve for ANY backend job (including resumed/continued segments) purely from
// the log stream it already polls — no local LeLab job record required.

import type { TrainingMetrics } from "@/lib/jobsApi";

export interface MetricPoint {
  step: number;
  value: number;
}

// tqdm progress line, e.g.
// "Training:   1%|▏         | 125/10000 [02:02<2:36:10,  1.05step/s]"
// groups: (current)/(total) [elapsed<(eta)
const TQDM_RE =
  /Training:\s*\d+%[^|]*\|[^|]*\|\s*(\d+)\/(\d+)\s*\[(?:[\d:]+)<([\d:]+)/;

export function emptyMetrics(): TrainingMetrics {
  return {
    current_step: 0,
    total_steps: 0,
    current_loss: null,
    current_lr: null,
    grad_norm: null,
    eta_seconds: null,
  };
}

// "H:MM:SS" or "MM:SS" -> seconds. Returns null on a malformed token.
function parseDuration(s: string): number | null {
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0] ?? "";
}

// Parse one log line, mutating `m` with the latest readings. Returns any
// (step, loss)/(step, lr) sample points the line carried, for the charts.
// tqdm lines advance step/total/eta but have no loss; the periodic
// "step:N ... loss:X ... lr:Z grdn:Y" lines carry the curve samples.
export function parseMetricLine(
  line: string,
  m: TrainingMetrics,
): { loss?: MetricPoint; lr?: MetricPoint } {
  const tq = TQDM_RE.exec(line);
  if (tq) {
    const cur = parseInt(tq[1], 10);
    const total = parseInt(tq[2], 10);
    if (Number.isFinite(cur)) m.current_step = cur;
    if (Number.isFinite(total) && total > 0) m.total_steps = total;
    const eta = parseDuration(tq[3]);
    if (eta != null) m.eta_seconds = eta;
    return {};
  }

  if (line.includes("step:") && line.includes("loss:")) {
    let step = m.current_step;
    const stepTok = firstToken(line.split("step:")[1] ?? "").replace(/,/g, "");
    const parsedStep = parseInt(stepTok, 10);
    if (Number.isFinite(parsedStep)) step = parsedStep;

    let loss: number | null = null;
    const lossTok = firstToken(line.split("loss:")[1] ?? "");
    const parsedLoss = parseFloat(lossTok);
    if (Number.isFinite(parsedLoss)) loss = parsedLoss;

    let lr: number | null = null;
    if (line.includes("lr:")) {
      const lrTok = firstToken(line.split("lr:")[1] ?? "");
      const parsedLr = parseFloat(lrTok);
      if (Number.isFinite(parsedLr)) lr = parsedLr;
    }
    if (line.includes("grdn:")) {
      const gTok = firstToken(line.split("grdn:")[1] ?? "");
      const parsedG = parseFloat(gTok);
      if (Number.isFinite(parsedG)) m.grad_norm = parsedG;
    }

    if (Number.isFinite(step)) m.current_step = step;
    if (loss != null) m.current_loss = loss;
    if (lr != null) m.current_lr = lr;

    const out: { loss?: MetricPoint; lr?: MetricPoint } = {};
    if (loss != null && Number.isFinite(step)) out.loss = { step, value: loss };
    if (lr != null && Number.isFinite(step)) out.lr = { step, value: lr };
    return out;
  }

  return {};
}

// Fold a batch of new log lines into the running metrics + de-duplicated
// (by step) loss/lr histories. Returns fresh arrays/objects (never mutates the
// inputs) so React state updates stay referentially honest.
export function foldMetrics(
  lines: string[],
  prev: { metrics: TrainingMetrics; loss: MetricPoint[]; lr: MetricPoint[] },
): { metrics: TrainingMetrics; loss: MetricPoint[]; lr: MetricPoint[] } {
  const metrics: TrainingMetrics = { ...prev.metrics };
  const loss = [...prev.loss];
  const lr = [...prev.lr];
  for (const line of lines) {
    const pt = parseMetricLine(line, metrics);
    if (pt.loss) {
      const last = loss[loss.length - 1];
      if (!last || last.step !== pt.loss.step) loss.push(pt.loss);
      else loss[loss.length - 1] = pt.loss;
    }
    if (pt.lr) {
      const last = lr[lr.length - 1];
      if (!last || last.step !== pt.lr.step) lr.push(pt.lr);
      else lr[lr.length - 1] = pt.lr;
    }
  }
  return { metrics, loss, lr };
}
