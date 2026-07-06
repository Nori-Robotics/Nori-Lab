// NORI: Additive file. Training history (Phase 6).
// Lists the customer's Nori-Backend training jobs (GET /nori/training/jobs), with per-job
// live log polling (GET …/{id}/logs?since=, ~2s) and a "Start training" trigger that
// dispatches a nori_cloud job (also visible in LeLab's watch-training UI).

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNori } from "@/nori/NoriContext";
import {
  getJobLogs,
  listJobs,
  startNoriTraining,
  type TrainingJob,
} from "@/nori/api/client";

const statusTone = (s: string) => {
  const low = s.toLowerCase();
  if (/(succeed|success|complete|promot|done)/.test(low)) return "text-green-600";
  if (/(fail|error|cancel)/.test(low)) return "text-destructive";
  return "text-muted-foreground";
};

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
  const { baseUrl, fetchWithHeaders } = useApi();
  const { customer } = useNori();
  const [jobs, setJobs] = useState<TrainingJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startMsg, setStartMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setJobs(await listJobs(baseUrl, fetchWithHeaders));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const start = async () => {
    if (!customer) return;
    setStarting(true);
    setStartMsg(null);
    try {
      await startNoriTraining(baseUrl, fetchWithHeaders, customer.hf_dataset_repo);
      setStartMsg("Training dispatched.");
      await reload();
    } catch (e) {
      setStartMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Training history</h1>
        <div className="flex items-center gap-2">
          {startMsg && <span className="text-xs text-muted-foreground">{startMsg}</span>}
          <Button size="sm" onClick={start} disabled={starting || !customer}>
            {starting ? "Dispatching…" : "Start training"}
          </Button>
        </div>
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
              <CardHeader className="cursor-pointer" onClick={() => setOpenId(openId === job.id ? null : job.id)}>
                <div className="flex items-center justify-between gap-4">
                  <CardTitle className="text-sm font-medium">{job.dataset_repo}</CardTitle>
                  <span className={`text-xs ${statusTone(job.status)}`}>{job.status}</span>
                </div>
              </CardHeader>
              {openId === job.id && (
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
          ))}
        </div>
      )}
    </section>
  );
};

export default TrainingHistory;
