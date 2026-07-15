// NORI: Training. Dual-mode like LeLab's pages/Training.tsx: a config/launch form
// at /nori/training, and a live monitor at /nori/training/:jobId. Reuses LeLab's
// local job data path (@/lib/jobsApi — /jobs/*, no Nori JWT needed) for the monitor
// and forwards the full config through startNoriTraining. Nori-styled throughout.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Play, Square } from "lucide-react";

import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Panel from "@/nori/components/Panel";

import ConfigForm from "@/nori/components/training/ConfigForm";
import DatasetSourcePicker from "@/nori/components/training/DatasetSourcePicker";
import {
  DEFAULT_TRAINING_CONFIG,
  type NoriTrainingFormState,
} from "@/nori/components/training/types";
import NoriTrainingStats from "@/nori/components/training/NoriTrainingStats";
import NoriTrainingLogs from "@/nori/components/training/NoriTrainingLogs";
import { startNoriTraining, getJobLogs as getBackendJobLogs } from "@/nori/api/client";
import {
  getJob,
  stopJob,
  type JobRecord,
  type LogLine,
} from "@/lib/jobsApi";

const POLL_INTERVAL_MS = 1000;
const MAX_LOG_LINES = 5000;

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
      navigate(`/nori/training/${job.id}`);
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
          <h1 className="text-3xl font-bold">Train a policy</h1>
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

  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Poll the job + logs. Logs are read from Nori-Backend DIRECTLY via the app's
  // LIVE session (auto-refreshing token) with offset tracking — not the local
  // LeLab mirror, whose background streamer thread exits when the token captured
  // at dispatch expires (or after repeated poll failures). That death is what
  // froze the log panel mid-run ("stuck at N%"). This only changes where the UI
  // reads logs; the running HF job is untouched.
  useEffect(() => {
    let cancelled = false;
    let offset = 0; // backend log cursor (next_offset); resets per jobId
    let terminal = false;
    // The route param `jobId` is the LOCAL LeLab job id; the backend logs
    // endpoint needs the Nori-Backend UUID, which the job record carries as
    // nori_job_uuid (captured at dispatch, persisted to disk → survives a
    // lelab restart). Resolve it from getJob, then poll logs by UUID. (Passing
    // the local id straight to the backend endpoint 500s — the bug this fixes.)
    let backendUuid: string | null = null;
    const tick = async () => {
      // 1. Job record first — carries nori_job_uuid + drives the header/stats.
      try {
        const next = await getJob(baseUrl, fetchWithHeaders, jobId);
        if (cancelled) return;
        setJob(next);
        if (next.nori_job_uuid) backendUuid = next.nori_job_uuid;
      } catch {
        /* keep last-known record + uuid */
      }
      // 2. Logs from Nori-Backend via the app's live session, keyed by the
      //    backend UUID (not the local id). Independent of the local streamer.
      if (!backendUuid) return;
      try {
        const res = await getBackendJobLogs(baseUrl, fetchWithHeaders, backendUuid, offset);
        if (cancelled) return;
        offset = res.next_offset ?? offset;
        terminal = res.is_terminal;
        if (res.lines.length > 0) {
          const mapped: LogLine[] = res.lines.map((message) => ({ timestamp: 0, message }));
          setLogs((prev) => {
            const merged = [...prev, ...mapped];
            return merged.length > MAX_LOG_LINES
              ? merged.slice(merged.length - MAX_LOG_LINES)
              : merged;
          });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(() => {
      if (cancelled || terminal) return;
      tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baseUrl, fetchWithHeaders, jobId]);

  // Auto-scroll the log panel as new lines arrive.
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleStop = async () => {
    if (!job) return;
    if (!window.confirm("Stop watching this run? It keeps training on Nori.")) return;
    try {
      const next = await stopJob(baseUrl, fetchWithHeaders, job.id);
      setJob(next);
      toast({ title: "Stopped watching" });
    } catch (e) {
      toast({
        title: "Couldn't stop",
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

  const isRunning = job.state === "running";

  return (
    <section className="space-y-5">
      {back}
      <Panel>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-[#14131a]">{job.name}</h1>
              <span className="rounded border border-[#b06a1c]/40 bg-[#b06a1c]/10 px-2 py-0.5 text-xs text-[#b06a1c]">
                Nori cloud
              </span>
            </div>
            <p className="text-xs text-[#14131a]/60">
              {job.state}
              {job.error_message ? ` — ${job.error_message}` : ""}
            </p>
          </div>
          {isRunning && (
            <Button
              onClick={handleStop}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              <Square className="mr-2 h-4 w-4" /> Stop watching
            </Button>
          )}
        </div>
      </Panel>

      <NoriTrainingStats jobId={jobId} job={job} />
      <NoriTrainingLogs logs={logs} logContainerRef={logContainerRef} />
    </section>
  );
};

const Training = () => {
  const { jobId } = useParams<{ jobId?: string }>();
  return jobId ? <MonitoringMode jobId={jobId} /> : <ConfigurationMode />;
};

export default Training;
