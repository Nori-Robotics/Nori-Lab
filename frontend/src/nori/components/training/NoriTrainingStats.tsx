// NORI: Nori-styled training progress + loss/LR charts. Pure renderer: the
// monitor parses metrics + curve points from the backend log stream (works for
// any job, including resumed/continued segments) and passes them in. Charts in
// the warm Panel palette.

import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Panel from "@/nori/components/Panel";
import type { TrainingMetrics } from "@/lib/jobsApi";
import type { MetricPoint } from "@/nori/components/training/parseMetrics";

interface NoriTrainingStatsProps {
  metrics: TrainingMetrics | null;
  lossHistory: MetricPoint[];
  lrHistory: MetricPoint[];
  /** True while the run is live but hasn't emitted its first progress tick. */
  starting?: boolean;
}

type Point = MetricPoint;

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
};

const NoriTrainingStats = ({
  metrics,
  lossHistory,
  lrHistory,
  starting,
}: NoriTrainingStatsProps) => {
  const m = metrics;
  const loss = lossHistory;
  const lr = lrHistory;

  const total = m?.total_steps ?? 0;
  const current = m?.current_step ?? 0;
  const progress = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  const isStarting = !!starting && total === 0;
  const stepLabel = isStarting
    ? "Training starting…"
    : `${current.toLocaleString()} / ${total.toLocaleString()}`;
  const eta = m?.eta_seconds != null ? formatTime(m.eta_seconds) : "—";

  return (
    <div className="space-y-4">
      <Panel eyebrow="progress">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="text-base font-semibold text-[#14131a]">
            {stepLabel}
          </div>
          <div className="text-sm text-[#14131a]/60">
            ETA <span className="font-semibold text-[#14131a]">{eta}</span>
          </div>
        </div>
        <div className="relative h-8 w-full overflow-hidden rounded-md border border-[#14131a]/10 bg-white">
          <div
            className="h-full bg-[#b06a1c] transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums text-[#14131a] drop-shadow-sm">
            {isStarting ? "warming up…" : `${progress.toFixed(1)}%`}
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MetricChart
          title="Loss"
          reading={m?.current_loss?.toFixed(4) ?? "—"}
          data={loss}
          color="#2f7d5b"
          format={(v) => v.toFixed(4)}
        />
        <MetricChart
          title="Learning rate"
          reading={m?.current_lr?.toExponential(2) ?? "—"}
          data={lr}
          color="#b06a1c"
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
    <div className="mb-2 text-sm font-semibold text-[#14131a]">
      {title}{" "}
      <span className="font-normal text-[#14131a]/50">({reading})</span>
    </div>
    <div className="h-48">
      {data.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-[#14131a]/50">
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
                background: "#f6f4eb",
                border: "1px solid #14131a33",
                borderRadius: 8,
              }}
              labelStyle={{ color: "#14131a" }}
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
