// NORI: Training. Dual-mode: a config/launch form at /nori/training, and a live
// monitor at /nori/training/:jobId where :jobId is the Nori-Backend job UUID.
//
// The monitor is keyed entirely off the backend UUID and backend endpoints
// (GET /training/jobs/{uuid} + …/logs), so it works for EVERY durable job —
// fresh, resumed-from-pause, and continued (extended) segments alike, without
// needing a local LeLab job record. Live progress + the loss/LR curves are
// reconstructed by parsing the log stream (parseMetrics), the same lines
// lelab/jobs.py parses server-side. On (re)load it pulls the FULL log once so
// the charts + panel show everything from step 0, then streams new lines.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Play, Square } from "lucide-react";

import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import Panel from "@/nori/components/Panel";

import ConfigForm from "@/nori/components/training/ConfigForm";
import DatasetSourcePicker from "@/nori/components/training/DatasetSourcePicker";
import ScopePanel from "@/nori/components/training/ScopePanel";
import {
  DEFAULT_TRAINING_CONFIG,
  type NoriTrainingFormState,
} from "@/nori/components/training/types";
import NoriTrainingStats from "@/nori/components/training/NoriTrainingStats";
import NoriTrainingLogs from "@/nori/components/training/NoriTrainingLogs";
import {
  emptyMetrics,
  foldMetrics,
  type MetricPoint,
} from "@/nori/components/training/parseMetrics";
import {
  startNoriTraining,
  getJob,
  getJobLogs,
  stopTrainingJob,
  type TrainingJob,
} from "@/nori/api/client";
import type { LogLine, TrainingMetrics } from "@/lib/jobsApi";

const POLL_INTERVAL_MS = 1000;
const MAX_LOG_LINES = 5000;
const HISTORY_CAP = 2000;

// Backend job status vocab.
const STOPPABLE = new Set(["PENDING", "SCHEDULING", "RUNNING"]);
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "REJECTED"]);

// -- Configuration mode --------------------------------------------------------

const ConfigurationMode = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [config, setConfig] = useState<NoriTrainingFormState>(DEFAULT_TRAINING_CONFIG);
  const [starting, setStarting] = useState(false);

  const updateConfig = <T extends keyof NoriTrainingFormState>(
    key: T,
    value: NoriTrainingFormState[T],
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleStart = async () => {
    setStarting(true);
    try {
      const { timeout_seconds, ...trainingConfig } = config;
      const job = await startNoriTraining(
        baseUrl,
        fetchWithHeaders,
        trainingConfig,
        timeout_seconds,
      );
      toast({ title: "Training dispatched", description: job.name });
      // Monitor by the BACKEND uuid so the page works identically to a
      // resumed/continued job (and survives a lelab restart).
      navigate(`/nori/training/${job.nori_job_uuid ?? job.id}`);
    } catch (e) {
      toast({
        title: "Couldn't start training",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Train a policy</h1>
            <span className="inline-flex -rotate-3 animate-floaty items-center rounded-full bg-sticker px-3 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink shadow-soft">
              {"// beta"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Configure a run and dispatch it to Nori cloud compute.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate("/nori/training-history")}
        >
          Training history
        </Button>
      </div>

      <DatasetSourcePicker config={config} updateConfig={updateConfig} />

      <ScopePanel config={config} updateConfig={updateConfig} />

      <ConfigForm config={config} updateConfig={updateConfig} />

      <div className="flex justify-end">
        <Button
          size="lg"
          onClick={handleStart}
          disabled={starting}
        >
          {starting ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Dispatching…
            </>
          ) : (
            <>
              <Play className="mr-2 h-5 w-5" /> Start training
            </>
          )}
        </Button>
      </div>
    </section>
  );
};

// -- Monitoring mode -----------------------------------------------------------

const MonitoringMode = ({ jobId }: { jobId: string }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [job, setJob] = useState<TrainingJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [metrics, setMetrics] = useState<TrainingMetrics>(emptyMetrics());
  const [lossHistory, setLossHistory] = useState<MetricPoint[]>([]);
  const [lrHistory, setLrHistory] = useState<MetricPoint[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Log cursor + running metric accumulator (refs so the poll closure and the
  // "load full" handler share one source of truth without stale captures).
  const offsetRef = useRef(0);
  const seededRef = useRef(false);
  const terminalRef = useRef(false);
  const accRef = useRef<{ metrics: TrainingMetrics; loss: MetricPoint[]; lr: MetricPoint[] }>({
    metrics: emptyMetrics(),
    loss: [],
    lr: [],
  });

  const applyLines = useCallback((lines: string[]) => {
    if (lines.length === 0) return;
    const folded = foldMetrics(lines, accRef.current);
    accRef.current = folded;
    setMetrics(folded.metrics);
    setLossHistory(folded.loss.slice(-HISTORY_CAP));
    setLrHistory(folded.lr.slice(-HISTORY_CAP));
  }, []);

  const appendLogLines = useCallback((lines: string[]) => {
    if (lines.length === 0) return;
    const mapped: LogLine[] = lines.map((message) => ({ timestamp: 0, message }));
    setLogs((prev) => {
      const merged = [...prev, ...mapped];
      return merged.length > MAX_LOG_LINES ? merged.slice(merged.length - MAX_LOG_LINES) : merged;
    });
  }, []);

  // Poll job status + logs by backend UUID. Reset all state when jobId changes.
  useEffect(() => {
    let cancelled = false;
    offsetRef.current = 0;
    seededRef.current = false;
    terminalRef.current = false;
    accRef.current = { metrics: emptyMetrics(), loss: [], lr: [] };
    setJob(null);
    setError(null);
    setLogs([]);
    setMetrics(emptyMetrics());
    setLossHistory([]);
    setLrHistory([]);

    const tick = async () => {
      // 1. Job record (status/header) — backend UUID, works for every job.
      try {
        const next = await getJob(baseUrl, fetchWithHeaders, jobId);
        if (cancelled) return;
        setJob(next);
        if (TERMINAL.has(next.status)) terminalRef.current = true;
      } catch (e) {
        if (!cancelled) setError((prev) => prev ?? (e instanceof Error ? e.message : String(e)));
      }
      // 2. Logs. First read seeds the tail cheaply; then stream from the cursor.
      try {
        // First read pulls the ENTIRE log so the charts AND the panel show
        // everything from step 0 on enter/reload; later polls stream new lines
        // from the cursor. MAX_LOG_LINES caps the panel.
        const firstRead = !seededRef.current;
        const res = firstRead
          ? await getJobLogs(baseUrl, fetchWithHeaders, jobId, 0)
          : await getJobLogs(baseUrl, fetchWithHeaders, jobId, offsetRef.current);
        if (cancelled) return;
        seededRef.current = true;
        offsetRef.current = res.next_offset ?? offsetRef.current;
        if (res.is_terminal) terminalRef.current = true;
        if (res.lines.length > 0) {
          applyLines(res.lines);
          appendLogLines(res.lines);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    void tick();
    const id = setInterval(() => {
      if (cancelled || terminalRef.current) return;
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baseUrl, fetchWithHeaders, jobId, applyLines, appendLogLines]);

  // Auto-scroll the log panel as new lines arrive.
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handlePause = async () => {
    if (!job) return;
    if (!window.confirm("Pause this run? It checkpoints and stops; resume it later from Training history.")) return;
    try {
      const res = await stopTrainingJob(baseUrl, fetchWithHeaders, jobId);
      toast({ title: "Pausing training", description: res.detail });
    } catch (e) {
      toast({
        title: "Couldn't pause",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const back = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => navigate("/nori/training-history")}
      className="text-muted-foreground"
    >
      <ArrowLeft className="mr-2 h-4 w-4" /> Training history
    </Button>
  );

  if (error && !job) {
    return (
      <section className="space-y-4">
        {back}
        <p className="text-sm text-destructive">
          Couldn't load job {jobId}: {error}
        </p>
      </section>
    );
  }

  if (!job) {
    return (
      <section className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-3 h-6 w-6 animate-spin" /> Loading job…
      </section>
    );
  }

  const appliedSteps = (job.applied_config as { steps?: number } | null | undefined)?.steps;
  const policyType = (job.applied_config as { policy_type?: string } | null | undefined)?.policy_type;
  // Seed the progress denominator from the configured target until the first
  // tqdm tick supplies it.
  const shownMetrics: TrainingMetrics = {
    ...metrics,
    total_steps: metrics.total_steps || appliedSteps || 0,
  };
  const isStoppable = STOPPABLE.has(job.status);
  const starting = !terminalRef.current && shownMetrics.current_step === 0;

  return (
    <section className="space-y-5">
      {back}
      <Panel>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-nori-h14131a">{job.dataset_repo}</h1>
              {policyType && (
                <span className="rounded border border-nori-h14131a/15 bg-nori-h14131a/5 px-2 py-0.5 text-xs text-nori-h14131a/70">
                  {policyType}
                </span>
              )}
              <span className="rounded border border-nori-hb06a1c/40 bg-nori-hb06a1c/10 px-2 py-0.5 text-xs text-nori-hb06a1c">
                Nori cloud
              </span>
            </div>
            <p className="text-xs text-nori-h14131a/60">
              {job.status}
              {job.failure_reason ? ` — ${job.failure_reason}` : ""}
              {job.final_cost_usd != null ? ` · $${job.final_cost_usd}` : ""}
            </p>
          </div>
          {isStoppable && (
            <Button
              onClick={handlePause}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              <Square className="mr-2 h-4 w-4" /> Pause
            </Button>
          )}
        </div>
      </Panel>

      <NoriTrainingStats
        metrics={shownMetrics}
        lossHistory={lossHistory}
        lrHistory={lrHistory}
        starting={starting}
      />
      <NoriTrainingLogs logs={logs} logContainerRef={logContainerRef} />
    </section>
  );
};

const Training = () => {
  const { jobId } = useParams<{ jobId?: string }>();
  return jobId ? <MonitoringMode jobId={jobId} /> : <ConfigurationMode />;
};

export default Training;
