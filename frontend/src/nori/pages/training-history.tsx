// NORI: Training history. Lists the customer's durable Nori-Backend training
// jobs (GET /nori/training/jobs). Every row links into the live monitor at
// /nori/training/:uuid — which works for all jobs (fresh, resumed, continued)
// because the monitor is keyed off the backend UUID. Pause/Resume/Continue act
// in place and then open the (new) segment's monitor.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "@/contexts/ApiContext";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  listJobs,
  resumeTrainingJob,
  stopTrainingJob,
  type TrainingJob,
} from "@/nori/api/client";

const statusTone = (s: string) => {
  const low = s.toLowerCase();
  if (/(succeed|success|complete|promot|done)/.test(low)) return "text-green-600";
  if (/paused/.test(low)) return "text-[#b06a1c] font-semibold";
  if (/(fail|error|cancel)/.test(low)) return "text-destructive";
  return "text-muted-foreground";
};

const STOPPABLE = new Set(["PENDING", "SCHEDULING", "RUNNING"]);

const statusLabel = (job: TrainingJob): string => {
  const ac = (job as { applied_config?: { steps?: number } | null }).applied_config;
  const done = (job as { steps_done?: number | null }).steps_done;
  // steps_done is only stamped on pause; a completed run trained to its target.
  if (job.status === "PAUSED" && done != null && ac?.steps)
    return `PAUSED · ${done.toLocaleString()}/${ac.steps.toLocaleString()} steps`;
  if (job.status === "COMPLETED" && ac?.steps)
    return `COMPLETED · ${ac.steps.toLocaleString()} steps`;
  return job.status;
};

const TrainingHistory = () => {
  const { toast } = useToast();
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const { baseUrl, fetchWithHeaders } = useApi();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<TrainingJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?open=<uuid> deep-links (from My Stuff) straight into the live monitor.
  const [searchParams] = useSearchParams();
  const deepLinkHandled = useRef(false);

  const openMonitor = useCallback(
    (uuid: string) => navigate(`/nori/training/${uuid}`),
    [navigate],
  );

  const reload = useCallback(async () => {
    try {
      setJobs(await listJobs(baseUrl, fetchWithHeaders));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, fetchWithHeaders]);

  const onStop = async (jobId: string) => {
    setActionBusy(jobId);
    try {
      const res = await stopTrainingJob(baseUrl, fetchWithHeaders, jobId);
      toast({ title: "Pausing training", description: res.detail });
      setTimeout(() => void reload(), 5000);
    } catch (e) {
      toast({
        title: "Couldn't pause",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setActionBusy(null);
    }
  };

  const onResume = async (jobId: string, timeoutSeconds: number) => {
    setActionBusy(jobId);
    try {
      const res = await resumeTrainingJob(baseUrl, fetchWithHeaders, jobId, timeoutSeconds);
      toast({
        title: "Training resumed",
        description: `Continuing from the saved checkpoint (new segment ${res.internal_job_uuid.slice(0, 8)}…).`,
      });
      // Jump straight to the new segment's live monitor.
      openMonitor(res.internal_job_uuid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({
        title: /402|allowance|insufficient/i.test(msg)
          ? "Not enough compute allowance left"
          : "Couldn't resume",
        description: /402|allowance|insufficient/i.test(msg)
          ? "This month's compute allowance can't cover another segment. Resume after it resets, or upgrade your plan."
          : msg,
        variant: "destructive",
      });
    } finally {
      setActionBusy(null);
    }
  };

  // Continue-from-completed: extend a FINISHED policy with more steps. Prompts
  // for a new TOTAL step target; the backend requires it to exceed what the run
  // already trained and resumes from its saved checkpoint (optimizer preserved).
  const onContinue = async (jobId: string, timeoutSeconds: number, trained?: number | null) => {
    const input = window.prompt(
      "Continue training to how many TOTAL steps?" +
        (trained ? ` (already trained ${trained})` : ""),
      "",
    );
    if (input === null) return;
    const steps = parseInt(input, 10);
    if (!Number.isFinite(steps) || steps <= 0) {
      toast({ title: "Enter a valid total step count", variant: "destructive" });
      return;
    }
    setActionBusy(jobId);
    try {
      const res = await resumeTrainingJob(baseUrl, fetchWithHeaders, jobId, timeoutSeconds, steps);
      toast({
        title: "Continuing training",
        description: `Extending to ${steps} steps (new segment ${res.internal_job_uuid.slice(0, 8)}…).`,
      });
      openMonitor(res.internal_job_uuid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({
        title: /402|allowance|insufficient/i.test(msg)
          ? "Not enough compute allowance left"
          : "Couldn't continue training",
        description: msg, // backend gives clear 409 (no resume bundle) / 422 (steps too low) text
        variant: "destructive",
      });
    } finally {
      setActionBusy(null);
    }
  };

  useEffect(() => {
    void reload();
  }, [reload]);

  // ?open=<uuid> → forward to the live monitor (works for every job now).
  useEffect(() => {
    const target = searchParams.get("open");
    if (!target || deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    navigate(`/nori/training/${target}`, { replace: true });
  }, [searchParams, navigate]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Training history</h1>
        <Button size="sm" onClick={() => navigate("/nori/training")}>
          Start new training
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : jobs === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No training jobs yet.</p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <Card key={job.id}>
              <CardHeader
                className="cursor-pointer"
                onClick={() => openMonitor(job.id)}
              >
                <div className="flex items-center justify-between gap-4">
                  <CardTitle className="text-sm font-medium">
                    {job.dataset_repo}
                    <span className="ml-2 text-xs font-normal text-[#b06a1c]">view live ↗</span>
                  </CardTitle>
                  <span className="flex items-center gap-2">
                    <span className={`text-xs ${statusTone(job.status)}`}>
                      {statusLabel(job)}
                    </span>
                    {STOPPABLE.has(job.status) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionBusy === job.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onStop(job.id);
                        }}
                      >
                        {actionBusy === job.id ? "…" : "Pause"}
                      </Button>
                    )}
                    {job.status === "PAUSED" && (
                      <Button
                        size="sm"
                        disabled={actionBusy === job.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onResume(job.id, job.timeout_duration_seconds || 900);
                        }}
                      >
                        {actionBusy === job.id ? "…" : "Resume"}
                      </Button>
                    )}
                    {job.status === "COMPLETED" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionBusy === job.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onContinue(
                            job.id,
                            job.timeout_duration_seconds || 3600,
                            job.steps_done ??
                              (job as { applied_config?: { steps?: number } | null })
                                .applied_config?.steps,
                          );
                        }}
                      >
                        {actionBusy === job.id ? "…" : "Continue"}
                      </Button>
                    )}
                  </span>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
};

export default TrainingHistory;
