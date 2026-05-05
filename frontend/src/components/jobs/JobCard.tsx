import React from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JobRecord } from "@/lib/jobsApi";
import { Square, X, AlertTriangle, CheckCircle2, Loader2, XCircle, ExternalLink } from "lucide-react";

interface Props {
  job: JobRecord;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
}

function relativeTime(epochSec: number): string {
  const diff = Math.max(0, Date.now() / 1000 - epochSec);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const statePresentation: Record<
  JobRecord["state"],
  { label: string; color: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  running: { label: "Running", color: "text-green-400", Icon: Loader2 },
  done: { label: "Done", color: "text-slate-400", Icon: CheckCircle2 },
  failed: { label: "Failed", color: "text-red-400", Icon: XCircle },
  interrupted: { label: "Interrupted", color: "text-amber-400", Icon: AlertTriangle },
};

const JobCard: React.FC<Props> = ({ job, onStop, onDelete }) => {
  const navigate = useNavigate();
  const present = statePresentation[job.state];
  const Icon = present.Icon;
  const isRunning = job.state === "running";
  // Until tqdm fires its first progress line we have no step counts; show
  // "Starting…" instead of a misleading 0/0 0% bar.
  const isStarting = isRunning && job.metrics.total_steps === 0;
  const progressPct =
    job.metrics.total_steps > 0
      ? Math.min(100, (job.metrics.current_step / job.metrics.total_steps) * 100)
      : 0;

  const subtitle = isStarting
    ? "starting…"
    : isRunning
    ? `started ${relativeTime(job.started_at)}`
    : job.ended_at != null
    ? `ended ${relativeTime(job.ended_at)}`
    : present.label.toLowerCase();

  const handleAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      if (window.confirm("Stop this run?")) onStop(job.id);
    } else {
      if (window.confirm("Delete this run? This wipes the output directory.")) onDelete(job.id);
    }
  };

  return (
    <Card
      onClick={() => navigate(`/training/${job.id}`)}
      className="bg-slate-800/50 border-slate-700 rounded-xl cursor-pointer hover:border-slate-500 transition-colors"
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className={`flex items-center gap-1.5 text-xs font-semibold ${present.color}`}>
            <Icon className={`w-3.5 h-3.5 ${isRunning ? "animate-spin" : ""}`} />
            {present.label}
          </div>
          {job.runner === "hf_cloud" && job.hf_job_url ? (
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="h-7 w-7 text-slate-400 hover:text-white"
              aria-label="Open Hub job page"
            >
              <a
                href={job.hf_job_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleAction}
              className="h-7 w-7 text-slate-400 hover:text-white"
              aria-label={isRunning ? "Stop job" : "Delete job"}
            >
              {isRunning ? <Square className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
            </Button>
          )}
        </div>
        <div>
          <div
            className="text-white font-semibold truncate"
            title={job.name}
          >
            {job.name}
          </div>
          <div className="text-xs text-slate-400">{subtitle}</div>
        </div>
        <div className="relative h-5 w-full overflow-hidden rounded-md bg-slate-900 border border-slate-700">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-sky-400 transition-[width] duration-500"
            style={{ width: `${progressPct}%` }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-white tabular-nums drop-shadow">
            {isStarting ? "Training starting…" : `${progressPct.toFixed(1)}%`}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default JobCard;
