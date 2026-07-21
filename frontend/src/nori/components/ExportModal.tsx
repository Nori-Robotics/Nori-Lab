// NORI: download a cloud dataset to your own machine for offline training.
// Enqueues the backend export job (worker snapshots the dataset from HF, tars it
// to S3, mints a short-lived presigned GET), polls it to DONE, then hands the user
// the bytes via a plain download — the browser saves it (S3's Content-Disposition
// names the file). "Copy link" covers Colab / a remote GPU box (wget the presigned
// URL). Bytes go S3 -> client directly, never through lelab.
//
// FUTURE (dropped 2026-07-20): an in-app "Save to a folder" picker + progress bar
// via the File System Access API (showSaveFilePicker + streaming fetch of the S3
// URL). It needs a bucket CORS rule (cross-origin fetch) that the scoped IAM user
// can't set. To re-enable: add the CORS rule documented in the backend
// src/storage/verify_aws_setup.py checklist, then restore the streaming path here.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { exportDataset, getExportJob, type ExportJob } from "@/nori/api/client";

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "";
  const mb = n / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

export function ExportModal({
  dataset,
  onClose,
}: {
  dataset: { session_id: string; label: string };
  onClose: () => void;
}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [phase, setPhase] = useState<"preparing" | "ready" | "error">("preparing");
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  // Enqueue + poll to terminal. The export runs on the durable-queue worker, so
  // this can take a bit for a large dataset; keep polling until DONE/FAILED.
  useEffect(() => {
    (async () => {
      try {
        let cur = await exportDataset(baseUrl, fetchWithHeaders, dataset.session_id);
        for (;;) {
          if (cancelled.current) return;
          if (cur.status === "DONE" && cur.download_url) {
            setJob(cur);
            setPhase("ready");
            return;
          }
          if (cur.status === "FAILED") {
            setError(cur.failure_reason || "Export failed. Try again in a moment.");
            setPhase("error");
            return;
          }
          await new Promise((r) => setTimeout(r, 2500));
          if (cancelled.current) return;
          cur = await getExportJob(baseUrl, fetchWithHeaders, cur.export_job_id);
        }
      } catch (e) {
        if (cancelled.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [baseUrl, fetchWithHeaders, dataset.session_id]);

  // Plain browser download (Downloads folder, or the browser's own save prompt).
  // No CORS needed — it's a navigation; S3's Content-Disposition supplies the name.
  const onDownload = useCallback(() => {
    if (!job?.download_url) return;
    const a = document.createElement("a");
    a.href = job.download_url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [job]);

  const onCopy = useCallback(async () => {
    if (!job?.download_url) return;
    try {
      await navigator.clipboard.writeText(job.download_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }, [job]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-[20px] bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-nori-h14131a">Download dataset</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-nori-h14131a" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-nori-h14131a">{dataset.label}</span> as a LeRobot dataset
          (.tar.gz) — train on it offline.
        </p>

        {phase === "preparing" && (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-nori-h14131a" />
            <p className="text-sm text-muted-foreground">
              Packaging in your cloud — this can take a moment. You can close this and come back.
            </p>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Run in background
            </Button>
          </div>
        )}

        {phase === "ready" && job && (
          <div className="mt-5">
            <div className="rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
              Ready{job.size_bytes ? ` · ${formatBytes(job.size_bytes)}` : ""}. Link is private to you and
              expires in ~6 hours.
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <Button onClick={onDownload} className="w-full gap-2">
                <Download className="h-4 w-4" />
                Download
              </Button>
              <Button variant="ghost" onClick={onCopy} className="w-full gap-2">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Link copied" : "Copy link (for Colab / a remote box)"}
              </Button>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Saves to your browser's downloads folder. The archive extracts to a ready-to-train
              LeRobotDataset (a README inside shows how to load it).
            </p>
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            <div className="mt-5 flex justify-end">
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
