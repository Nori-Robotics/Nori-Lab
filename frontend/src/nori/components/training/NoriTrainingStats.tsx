// NORI: Additive file. Nori-styled training progress + loss/LR charts. Reuses
// LeLab's metrics data path (GET /jobs/{id}/metrics-history seed + live append
// from JobRecord.metrics) but renders in the warm Panel palette. Mirrors the
// seeding logic in components/training/monitoring/MonitoringStats.tsx.

import { useEffect, useRef, useState } from "react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Panel from "@/nori/components/Panel";
import { useApi } from "@/contexts/ApiContext";
import { getJobMetricsHistory, type JobRecord } from "@/lib/jobsApi";

interface NoriTrainingStatsProps {
  jobId: string;
  job: JobRecord | null;
}

interface Point {
  step: number;
  value: number;
}

const HISTORY_CAP = 2000;

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
};

const NoriTrainingStats = ({ jobId, job }: NoriTrainingStatsProps) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [loss, setLoss] = useState<Point[]>([]);
  const [lr, setLr] = useState<Point[]>([]);
  const lastStepRef = useRef(0);

  // Seed the curves from the persisted log on mount / job change.
  useEffect(() => {
    let cancelled = false;
    getJobMetricsHistory(baseUrl, fetchWithHeaders, jobId)
      .then((points) => {
        if (cancelled || points.length === 0) return;
        setLoss(
          points
            .filter((p) => p.loss != null)
            .map((p) => ({ step: p.step, value: p.loss as number }))
            .slice(-HISTORY_CAP),
        );
        setLr(
          points
            .filter((p) => p.lr != null)
            .map((p) => ({ step: p.step, value: p.lr as number }))
            .slice(-HISTORY_CAP),
        );
        lastStepRef.current = points[points.length - 1]?.step ?? 0;
      })
      .catch(() => {
        // 404 / transient — live ticks will populate from empty.
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, jobId]);

  // Append new points from the live job metrics; reset if a new run restarts.
  const m = job?.metrics;
  useEffect(() => {
    if (!m) return;
    const step = m.current_step;
    if (step < lastStepRef.current) {
      setLoss([]);
      setLr([]);
    }
    lastStepRef.current = step;
    if (step > 0 && m.current_loss != null) {
      const value = m.current_loss;
      setLoss((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.step === step) return prev;
        return [...prev, { step, value }].slice(-HISTORY_CAP);
      });
    }
    if (step > 0 && m.current_lr != null) {
      const value = m.current_lr;
      setLr((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.step === step) return prev;
        return [...prev, { step, value }].slice(-HISTORY_CAP);
      });
    }
  }, [m?.current_step, m?.current_loss, m?.current_lr, m]);

  const total = m?.total_steps ?? 0;
  const current = m?.current_step ?? 0;
  const progress = total > 0 ? (current / total) * 100 : 0;
  const isStarting = job?.state === "running" && total === 0;
  const stepLabel = isStarting
    ? "Training starting…"
    : `${current.toLocaleString()} / ${total.toLocaleString()}`;
  const eta = m?.eta_seconds != null ? formatTime(m.eta_seconds) : "—";

  return (
    <div className="space-y-4">
      <Panel eyebrow="progress">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="text-base font-semibold text-nori-h14131a">
            {stepLabel}
          </div>
          <div className="text-sm text-nori-h14131a/60">
            ETA <span className="font-semibold text-nori-h14131a">{eta}</span>
          </div>
        </div>
        <div className="relative h-8 w-full overflow-hidden rounded-md border border-nori-h14131a/10 bg-white">
          <div
            className="h-full bg-nori-hb06a1c transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums text-nori-h14131a drop-shadow-sm">
            {isStarting ? "warming up…" : `${progress.toFixed(1)}%`}
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MetricChart
          title="Loss"
          reading={m?.current_loss?.toFixed(4) ?? "—"}
          data={loss}
          color="hsl(var(--nori-h2f7d5b))"
          format={(v) => v.toFixed(4)}
        />
        <MetricChart
          title="Learning rate"
          reading={m?.current_lr?.toExponential(2) ?? "—"}
          data={lr}
          color="hsl(var(--nori-hb06a1c))"
          format={(v) => v.toExponential(2)}
          yTickFormat={(v) => v.toExponential(0)}
        />
      </div>
    </div>
  );
};

interface MetricChartProps {
  title: string;
  reading: string;
  data: Point[];
  color: string;
  format: (v: number) => string;
  yTickFormat?: (v: number) => string;
}

const MetricChart = ({
  title,
  reading,
  data,
  color,
  format,
  yTickFormat,
}: MetricChartProps) => (
  <Panel>
    <div className="mb-2 text-sm font-semibold text-nori-h14131a">
      {title}{" "}
      <span className="font-normal text-nori-h14131a/50">({reading})</span>
    </div>
    <div className="h-48">
      {data.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-nori-h14131a/50">
          Waiting for first metric tick…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="step"
              tick={{ fill: "#14131a99", fontSize: 11 }}
              stroke="#14131a33"
            />
            <YAxis
              tick={{ fill: "#14131a99", fontSize: 11 }}
              stroke="#14131a33"
              width={48}
              tickFormatter={yTickFormat}
            />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--nori-hf6f4eb))",
                border: "1px solid #14131a33",
                borderRadius: 8,
              }}
              labelStyle={{ color: "hsl(var(--nori-h14131a))" }}
              itemStyle={{ color }}
              formatter={(v: number) => format(v)}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  </Panel>
);

export default NoriTrainingStats;
