// NORI: Training. Dual-mode like LeLab's pages/Training.tsx: a config/launch form
// at /nori/training, and a live monitor at /nori/training/:jobId. Reuses LeLab's
// local job data path (@/lib/jobsApi — /jobs/*, no Nori JWT needed) for the monitor
// and forwards the full config through startNoriTraining. Nori-styled throughout.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Play, Square, UploadCloud } from "lucide-react";

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
import {
  DEFAULT_TRAINING_CONFIG,
  type NoriTrainingFormState,
} from "@/nori/components/training/types";
import NoriTrainingStats from "@/nori/components/training/NoriTrainingStats";
import NoriTrainingLogs from "@/nori/components/training/NoriTrainingLogs";
import { startNoriTraining, listMyDatasets, uploadDataset } from "@/nori/api/client";
import { listDatasets } from "@/lib/replayApi";
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
  const { toast } = useToast();
  const navigate = useNavigate();

  const [config, setConfig] = useState<NoriTrainingFormState>(DEFAULT_TRAINING_CONFIG);
  const [starting, setStarting] = useState(false);

  // Dataset is chosen via dataset_ref (a promoted upload); unset => backend uses
  // the latest upload. Populate the dropdown from the customer's promoted uploads.
  const [datasets, setDatasets] = useState<{ ref: string; label: string }[]>([]);
  const refreshMyDatasets = useCallback(() => {
    listMyDatasets(baseUrl, fetchWithHeaders)
      .then((rows) => setDatasets(rows.map((d) => ({ ref: d.dataset_ref, label: d.label }))))
      .catch(() => {
        // No datasets / transient — the form still works with the "Latest" default.
      });
  }, [baseUrl, fetchWithHeaders]);
  useEffect(() => refreshMyDatasets(), [refreshMyDatasets]);

  // Datasets available to upload to Nori: local-on-disk AND the user's HF
  // datasets (source "local" | "hub" | "both"). Hub-only ones are downloaded
  // by LeLab before upload, so they're all selectable here.
  const [uploadable, setUploadable] = useState<{ repo: string; source: string }[]>([]);
  const [selectedLocal, setSelectedLocal] = useState<string>("");
  const [hfRepoInput, setHfRepoInput] = useState<string>(""); // paste any HF dataset repo id
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    listDatasets(baseUrl, fetchWithHeaders)
      .then((rows) => {
        if (!cancelled) setUploadable(rows.map((d) => ({ repo: d.repo_id, source: d.source })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders]);

  const handleUpload = async () => {
    // A pasted HF repo id wins over the dropdown selection.
    const repo = hfRepoInput.trim() || selectedLocal;
    if (!repo) return;
    setUploading(true);
    try {
      const session = await uploadDataset(baseUrl, fetchWithHeaders, repo);
      if (session.status === "PROMOTED") {
        toast({ title: "Dataset uploaded", description: repo });
        setHfRepoInput("");
        refreshMyDatasets(); // the new dataset appears in the training picker
      } else {
        toast({ title: "Upload finished", description: `status: ${session.status}` });
      }
    } catch (e) {
      toast({
        title: "Upload failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

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

      {/* Upload a dataset to Nori (recorded locally OR one of your HF datasets). */}
      <Panel eyebrow="datasets" title="Upload a dataset">
        <div className="space-y-3">
          <p className="text-sm text-[#14131a]/70">
            Push a dataset to your Nori account — one you recorded locally or one
            of your HuggingFace datasets. Once uploaded it appears in the dataset
            picker above.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label className="text-[#14131a]/70">Your datasets</Label>
              <Select
                value={selectedLocal}
                onValueChange={(v) => {
                  setSelectedLocal(v);
                  setHfRepoInput(""); // dropdown pick clears any pasted repo
                }}
              >
                <SelectTrigger className="mt-1 border-[#14131a]/15 bg-white text-[#14131a] rounded-md">
                  <SelectValue placeholder={uploadable.length ? "Choose a dataset" : "No datasets found"} />
                </SelectTrigger>
                <SelectContent>
                  {uploadable.map((d) => (
                    <SelectItem key={d.repo} value={d.repo}>
                      {d.repo}
                      {d.source === "hub" ? " · HF" : d.source === "both" ? " · local + HF" : " · local"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <Label className="text-[#14131a]/70">or an HF dataset repo id</Label>
              <Input
                value={hfRepoInput}
                onChange={(e) => setHfRepoInput(e.target.value)}
                placeholder="username/dataset"
                className="mt-1 border-[#14131a]/15 bg-white text-[#14131a] rounded-md"
              />
            </div>
            <Button
              variant="outline"
              onClick={handleUpload}
              disabled={uploading || (!hfRepoInput.trim() && !selectedLocal)}
            >
              {uploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading…
                </>
              ) : (
                <>
                  <UploadCloud className="mr-2 h-4 w-4" /> Upload to Nori
                </>
              )}
            </Button>
          </div>
        </div>
      </Panel>

      <ConfigForm config={config} updateConfig={updateConfig} datasets={datasets} />

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
