// NORI: download a cloud dataset to your own machine for offline training.
// Enqueues the backend export job (worker snapshots the dataset from HF, tars it
// to S3, mints a short-lived presigned GET), polls it to DONE, then hands the user
// the bytes. On Chromium we stream straight into a folder they pick (File System
// Access API + progress); elsewhere we fall back to a normal browser download
// (S3's Content-Disposition still names the file). "Copy link" covers Colab / a
// remote GPU box (wget the presigned URL). Bytes go S3 -> client, never via lelab.
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

function safeName(label: string): string {
  const base = (label || "dataset").trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9._-]/g, "");
  return (base.replace(/^[._-]+|[._-]+$/g, "") || "dataset").slice(0, 80);
}

const hasSavePicker = typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";

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
  const [saving, setSaving] = useState<number | null>(null); // 0..1 stream progress, null = idle
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

  const filename = `${safeName(dataset.label)}.tar.gz`;

  // Plain browser download (Downloads folder / browser's own prompt). No CORS
  // needed — it's a navigation; S3's Content-Disposition supplies the filename.
  const downloadPlain = useCallback((url: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  // Chromium: let the user pick WHERE to save, and stream into it with progress.
  // Requires S3 CORS to allow this origin; on any failure we fall back to a plain
  // download so the feature still works.
  const saveWithPicker = useCallback(
    async (url: string, sizeBytes: number | null) => {
      const picker = (window as unknown as {
        showSaveFilePicker: (o: unknown) => Promise<{
          createWritable: () => Promise<{
            write: (chunk: Uint8Array) => Promise<void>;
            close: () => Promise<void>;
            abort?: () => Promise<void>;
          }>;
        }>;
      }).showSaveFilePicker;
      let handle;
      try {
        handle = await picker({
          suggestedName: filename,
          types: [{ description: "LeRobot dataset (gzip tarball)", accept: { "application/gzip": [".gz", ".tgz"] } }],
        });
      } catch (e) {
        // AbortError = user cancelled the Save dialog; just stop, no fallback.
        if (e instanceof DOMException && e.name === "AbortError") return;
        downloadPlain(url);
        return;
      }
      const writable = await handle.createWritable();
      try {
        const resp = await fetch(url);
        if (!resp.ok || !resp.body) throw new Error(`download failed (${resp.status})`);
        const total = Number(resp.headers.get("content-length")) || sizeBytes || 0;
        const reader = resp.body.getReader();
        let received = 0;
        setSaving(0);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          received += value.length;
          if (total > 0) setSaving(Math.min(1, received / total));
        }
        await writable.close();
        setSaving(null);
      } catch (err) {
        // CORS/network failure mid-stream: abort the partial file and fall back.
        try {
          await writable.abort?.();
        } catch {
          /* ignore */
        }
        setSaving(null);
        downloadPlain(url);
      }
    },
    [filename, downloadPlain]
  );

  const onDownload = useCallback(() => {
    if (!job?.download_url) return;
    if (hasSavePicker) void saveWithPicker(job.download_url, job.size_bytes);
    else downloadPlain(job.download_url);
  }, [job, saveWithPicker, downloadPlain]);

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

            {saving !== null ? (
              <div className="mt-4">
                <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-nori-h14131a transition-all"
                    style={{ width: `${Math.round(saving * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  Saving… {Math.round(saving * 100)}%
                </p>
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-2">
                <Button onClick={onDownload} className="w-full gap-2">
                  <Download className="h-4 w-4" />
                  {hasSavePicker ? "Save to…" : "Download"}
                </Button>
                <Button variant="ghost" onClick={onCopy} className="w-full gap-2">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Link copied" : "Copy link (for Colab / a remote box)"}
                </Button>
              </div>
            )}

            <p className="mt-3 text-xs text-muted-foreground">
              {hasSavePicker
                ? "Save to… lets you pick the folder. "
                : "Downloads to your browser's downloads folder. "}
              The archive extracts to a ready-to-train LeRobotDataset (a README inside shows how to load it).
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
