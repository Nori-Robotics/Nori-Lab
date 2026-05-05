import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import {
  HubJob,
  HubModel,
  JobRecord,
  deleteJob,
  listHubJobs,
  listJobs,
  stopJob,
} from "@/lib/jobsApi";
import JobCard from "./JobCard";
import HubJobCard from "./HubJobCard";
import HubModelCard from "./HubModelCard";
import InferenceModal from "@/components/landing/InferenceModal";
import { useRobots } from "@/hooks/useRobots";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight, RefreshCw } from "lucide-react";

const POLL_INTERVAL_MS = 5000;
const LIMIT = 10;

const JobsSection: React.FC = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();

  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [hubJobs, setHubJobs] = useState<HubJob[]>([]);
  const [hubModels, setHubModels] = useState<HubModel[]>([]);
  const [hubAuthenticated, setHubAuthenticated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { selectedRecord } = useRobots();
  const [inferenceModalOpen, setInferenceModalOpen] = useState(false);
  const [inferenceJob, setInferenceJob] = useState<JobRecord | null>(null);
  const [inferenceStep, setInferenceStep] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [next, hub] = await Promise.all([
        listJobs(baseUrl, fetchWithHeaders, LIMIT),
        listHubJobs(baseUrl, fetchWithHeaders),
      ]);
      setJobs(next);
      setHubJobs(hub.jobs);
      setHubModels(hub.models);
      setHubAuthenticated(hub.authenticated);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    let cancelled = false;
    refresh();
    const id = setInterval(() => {
      if (!cancelled) refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh]);

  const handleStop = async (id: string) => {
    try {
      await stopJob(baseUrl, fetchWithHeaders, id);
      toast({ title: "Job stopping" });
      refresh();
    } catch (e) {
      toast({
        title: "Stop failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const handlePlay = (job: JobRecord, step: number) => {
    setInferenceJob(job);
    setInferenceStep(step);
    setInferenceModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteJob(baseUrl, fetchWithHeaders, id);
      toast({ title: "Job removed" });
      refresh();
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const localJobs = useMemo(
    () => jobs.filter((j) => j.runner === "local"),
    [jobs],
  );
  const trackedCloudJobs = useMemo(
    () => jobs.filter((j) => j.runner === "hf_cloud"),
    [jobs],
  );
  // Hub jobs already mirrored by a local JobRecord get their richer card via
  // trackedCloudJobs; everything else from the hub gets a plain HubJobCard.
  const trackedHfJobIds = useMemo(
    () =>
      new Set(
        trackedCloudJobs
          .map((j) => j.hf_job_id)
          .filter((id): id is string => !!id),
      ),
    [trackedCloudJobs],
  );
  const untrackedHubJobs = useMemo(
    () => hubJobs.filter((h) => !trackedHfJobIds.has(h.id)),
    [hubJobs, trackedHfJobIds],
  );
  // Hide model repos that map 1-to-1 to a tracked cloud job (those already
  // appear via JobCard); the remainder are past trainings the registry no
  // longer remembers.
  const trackedRepoIds = useMemo(
    () =>
      new Set(
        trackedCloudJobs
          .map((j) => j.hf_repo_id)
          .filter((id): id is string => !!id),
      ),
    [trackedCloudJobs],
  );
  const untrackedHubModels = useMemo(
    () => hubModels.filter((m) => !trackedRepoIds.has(m.repo_id)),
    [hubModels, trackedRepoIds],
  );
  // Cancelled cloud work is collapsed away by default. Tracked side maps
  // CANCELLED → "interrupted"; untracked side keeps the raw HF stage.
  const trackedCloudActive = useMemo(
    () => trackedCloudJobs.filter((j) => j.state !== "interrupted"),
    [trackedCloudJobs],
  );
  const trackedCloudCancelled = useMemo(
    () => trackedCloudJobs.filter((j) => j.state === "interrupted"),
    [trackedCloudJobs],
  );
  // HF returns "CANCELED" (single L); accept the British spelling too in case
  // it ever changes.
  const isCancelledStage = (stage: string | undefined | null) => {
    const s = (stage ?? "").toUpperCase();
    return s === "CANCELED" || s === "CANCELLED";
  };
  const untrackedHubActive = useMemo(
    () => untrackedHubJobs.filter((h) => !isCancelledStage(h.status?.stage)),
    [untrackedHubJobs],
  );
  const untrackedHubCancelled = useMemo(
    () => untrackedHubJobs.filter((h) => isCancelledStage(h.status?.stage)),
    [untrackedHubJobs],
  );
  const cancelledCount =
    trackedCloudCancelled.length + untrackedHubCancelled.length;

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Jobs</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={refresh}
          className="h-7 w-7 text-slate-400 hover:text-white"
          aria-label="Refresh jobs"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      {error ? <p className="text-sm text-red-300">Couldn't load jobs: {error}</p> : null}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Local jobs
        </h3>
        {localJobs.length === 0 ? (
          <p className="text-sm text-slate-500">
            No local training jobs yet. Start one from the Training page.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {localJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onStop={handleStop}
                onDelete={handleDelete}
                onPlay={handlePlay}
              />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-slate-700" />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Online jobs
        </h3>
        {!hubAuthenticated && trackedCloudJobs.length === 0 ? (
          <p className="text-sm text-slate-500">
            Sign in with Hugging Face to see your cloud jobs.
          </p>
        ) : trackedCloudJobs.length === 0 &&
          untrackedHubJobs.length === 0 &&
          untrackedHubModels.length === 0 ? (
          <p className="text-sm text-slate-500">No cloud jobs yet.</p>
        ) : (
          <>
            {trackedCloudActive.length === 0 &&
            untrackedHubActive.length === 0 &&
            untrackedHubModels.length === 0 ? (
              <p className="text-sm text-slate-500">
                No active cloud jobs — see cancelled below.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {trackedCloudActive.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onStop={handleStop}
                    onDelete={handleDelete}
                    onPlay={handlePlay}
                  />
                ))}
                {untrackedHubActive.map((job) => (
                  <HubJobCard key={job.id} job={job} />
                ))}
                {untrackedHubModels.map((model) => (
                  <HubModelCard key={model.repo_id} model={model} />
                ))}
              </div>
            )}

            {cancelledCount > 0 ? (
              <Collapsible className="mt-4">
                <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-white transition-colors">
                  <ChevronRight className="w-3.5 h-3.5 transition-transform group-data-[state=open]:rotate-90" />
                  Cancelled ({cancelledCount})
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {trackedCloudCancelled.map((job) => (
                      <JobCard
                        key={job.id}
                        job={job}
                        onStop={handleStop}
                        onDelete={handleDelete}
                        onPlay={handlePlay}
                      />
                    ))}
                    {untrackedHubCancelled.map((job) => (
                      <HubJobCard key={job.id} job={job} />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </>
        )}
      </div>
      {inferenceJob ? (
        <InferenceModal
          open={inferenceModalOpen}
          onOpenChange={setInferenceModalOpen}
          robot={selectedRecord}
          jobId={inferenceJob.id}
          initialStep={inferenceStep}
        />
      ) : null}
    </section>
  );
};

export default JobsSection;
