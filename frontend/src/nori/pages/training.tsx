// NORI: Training. Dual-mode like LeLab's pages/Training.tsx: a config/launch form
// at /nori/training, and a live monitor at /nori/training/:jobId. Reuses LeLab's
// local job data path (@/lib/jobsApi — /jobs/*, no Nori JWT needed) for the monitor
// and forwards the full config through startNoriTraining. Nori-styled throughout.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Play, Square } from "lucide-react";

import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { useNori } from "@/nori/NoriContext";
import { Button } from "@/components/ui/button";
import Panel from "@/nori/components/Panel";

import ConfigForm from "@/nori/components/training/ConfigForm";
import {
  DEFAULT_TRAINING_CONFIG,
  type NoriTrainingFormState,
} from "@/nori/components/training/types";
import NoriTrainingStats from "@/nori/components/training/NoriTrainingStats";
import NoriTrainingLogs from "@/nori/components/training/NoriTrainingLogs";
import { startNoriTraining } from "@/nori/api/client";
import {
  getJob,
  getJobLogs,
  getJobLogFile,
  stopJob,
  type JobRecord,
  type LogLine,
} from "@/lib/jobsApi";

const POLL_INTERVAL_MS = 1000;
const MAX_LOG_LINES = 5000;

// -- Configuration mode --------------------------------------------------------

const ConfigurationMode = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { customer } = useNori();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [config, setConfig] = useState<NoriTrainingFormState>(DEFAULT_TRAINING_CONFIG);
  const [starting, setStarting] = useState(false);
  const datasetTouched = useRef(false);

  // Prefill the dataset from the customer's Nori dataset once it loads, unless
  // the user has already typed their own.
  useEffect(() => {
    if (!datasetTouched.current && customer?.hf_dataset_repo) {
      setConfig((prev) =>
        prev.dataset_repo_id
          ? prev
          : { ...prev, dataset_repo_id: customer.hf_dataset_repo },
      );
    }
  }, [customer?.hf_dataset_repo]);

  const updateConfig = <T extends keyof NoriTrainingFormState>(
    key: T,
    value: NoriTrainingFormState[T],
  ) => {
    if (key === "dataset_repo_id") datasetTouched.current = true;
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleStart = async () => {
    if (!config.dataset_repo_id.trim()) {
      toast({
        title: "Dataset required",
        description: "Enter a dataset repository to train on.",
        variant: "destructive",
      });
      return;
    }
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

      <ConfigForm config={config} updateConfig={updateConfig} />

      <div className="flex justify-end">
        <Button
          size="lg"
          onClick={handleStart}
          disabled={starting || !config.dataset_repo_id.trim()}
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

  const jobStateRef = useRef(job?.state);
  jobStateRef.current = job?.state;

  // Seed logs from the persistent on-disk file once on mount.
  useEffect(() => {
    let cancelled = false;
    getJobLogFile(baseUrl, fetchWithHeaders, jobId)
      .then((seeded) => {
        if (!cancelled && seeded.length > 0) setLogs(seeded);
      })
      .catch(() => {
        // 404 / transient — live polling fills in.
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, jobId]);

  // Poll the job + logs while running.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getJob(baseUrl, fetchWithHeaders, jobId);
        if (cancelled) return;
        setJob(next);
        if (next.state === "running") {
          const newLogs = await getJobLogs(baseUrl, fetchWithHeaders, jobId);
          if (!cancelled && newLogs.length > 0) {
            setLogs((prev) => {
              const merged = [...prev, ...newLogs];
              return merged.length > MAX_LOG_LINES
                ? merged.slice(merged.length - MAX_LOG_LINES)
                : merged;
            });
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(() => {
      if (cancelled) return;
      if (jobStateRef.current && jobStateRef.current !== "running") return;
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
