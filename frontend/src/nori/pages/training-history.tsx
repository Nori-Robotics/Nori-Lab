// NORI: Additive file. Training history (Phase 6).
// Lists the customer's durable Nori-Backend training jobs (GET /nori/training/jobs), with
// per-job live log polling (GET …/{id}/logs?since=, ~2s). Rows for jobs this LeLab process
// is watching link into the rich local monitor (/nori/training/:leLabJobId); others fall
// back to the inline log expander. "Start training" jumps to the config form.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "@/contexts/ApiContext";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getJobLogs,
  listJobs,
  resumeTrainingJob,
  stopTrainingJob,
  type TrainingJob,
} from "@/nori/api/client";
import { listJobs as listLeLabJobs } from "@/lib/jobsApi";

const statusTone = (s: string) => {
  const low = s.toLowerCase();
  if (/(succeed|success|complete|promot|done)/.test(low)) return "text-green-600";
  if (/paused/.test(low)) return "text-[#b06a1c] font-semibold";
  if (/(fail|error|cancel)/.test(low)) return "text-destructive";
  return "text-muted-foreground";
};

const STOPPABLE = new Set(["PENDING", "SCHEDULING", "RUNNING"]);

const JobLogs = ({ jobId }: { jobId: string }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const offset = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await getJobLogs(baseUrl, fetchWithHeaders, jobId, offset.current);
        if (cancelled) return;
        offset.current = res.next_offset;
        if (res.lines.length) setLines((prev) => [...prev, ...res.lines].slice(-500));
        if (res.is_terminal) {
          setDone(true);
          return;
        }
      } catch {
        // transient; keep polling
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, baseUrl, fetchWithHeaders]);

  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded bg-background/60 p-2 text-xs text-muted-foreground">
      {lines.length ? lines.join("\n") : "Waiting for logs…"}
      {done && "\n— end of logs —"}
    </pre>
  );
};

const TrainingHistory = () => {
  const { toast } = useToast();
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const { baseUrl, fetchWithHeaders } = useApi();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<TrainingJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Map Nori job uuid -> local LeLab job id, for jobs this process is watching.
  const [localByUuid, setLocalByUuid] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      setJobs(await listJobs(baseUrl, fetchWithHeaders));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // Best-effort bridge to local records; failure just means no deep links.
    try {
      const local = await listLeLabJobs(baseUrl, fetchWithHeaders, 200);
      const map: Record<string, string> = {};
      for (const r of local) {
        if (r.runner === "nori_cloud" && r.nori_job_uuid) map[r.nori_job_uuid] = r.id;
      }
      setLocalByUuid(map);
    } catch {
      setLocalByUuid({});
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
      await reload();
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


  useEffect(() => {
    void reload();
  }, [reload]);

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
          {jobs.map((job) => {
            const localId = localByUuid[job.id];
            return (
              <Card key={job.id}>
                <CardHeader
                  className="cursor-pointer"
                  onClick={() =>
                    localId
                      ? navigate(`/nori/training/${localId}`)
                      : setOpenId(openId === job.id ? null : job.id)
                  }
                >
                  <div className="flex items-center justify-between gap-4">
                    <CardTitle className="text-sm font-medium">
                      {job.dataset_repo}
                      {localId && (
                        <span className="ml-2 text-xs font-normal text-[#b06a1c]">
                          view live ↗
                        </span>
                      )}
                    </CardTitle>
                    <span className="flex items-center gap-2">
                      <span className={`text-xs ${statusTone(job.status)}`}>
                        {job.status === "PAUSED" &&
                        (job as { steps_done?: number | null }).steps_done != null &&
                        (job as { applied_config?: { steps?: number } | null }).applied_config?.steps
                          ? `PAUSED · ${(job as { steps_done?: number | null }).steps_done}/${String((job as { applied_config?: { steps?: number } | null }).applied_config?.steps)} steps`
                          : job.status}
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
                    </span>
                  </div>
                </CardHeader>
                {openId === job.id && !localId && (
                  <CardContent>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Created</span>
                      <span className="text-right">{new Date(job.created_at).toLocaleString()}</span>
                      <span>Timeout</span>
                      <span className="text-right">{job.timeout_duration_seconds}s</span>
                      {job.final_cost_usd != null && (
                        <>
                          <span>Cost</span>
                          <span className="text-right">${job.final_cost_usd}</span>
                        </>
                      )}
                      {job.failure_reason && (
                        <>
                          <span>Failure</span>
                          <span className="text-right text-destructive">{job.failure_reason}</span>
                        </>
                      )}
                    </div>
                    <JobLogs jobId={job.id} />
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default TrainingHistory;
