// NORI: download a cloud dataset to your own machine for offline training.
// Enqueues the backend export job (worker snapshots the dataset from HF, tars it
// to S3, mints a short-lived presigned GET), polls it to DONE, then hands the user
// the bytes. "Copy link" covers Colab / a remote GPU box (wget the presigned URL).
// Bytes go S3 -> client directly, never through lelab.
//
// TWO download paths, by capability:
//   * STREAMING (Chromium): showSaveFilePicker + fetch, so the user picks the
//     folder and gets a real progress bar. Requires the bucket CORS rule, which
//     was applied 2026-11-25 — a cross-origin fetch() of the presigned URL is
//     unreadable without it (S3 returns the bytes; the browser discards them).
//     Also requires a SECURE CONTEXT, so it is unavailable over plain-http LAN.
//   * PLAIN (everyone else): a navigation; S3's Content-Disposition names the
//     file. No CORS needed. This is the fallback for Firefox/Safari, which do not
//     implement showSaveFilePicker, and for non-secure contexts.
// The plain path is deliberately kept as the default-safe option: the browser's
// own download manager handles resume on a dropped connection, which a JS stream
// does not, and these archives run to several GB.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Download, FolderDown, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { exportDataset, getExportJob, type ExportJob } from "@/nori/api/client";

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "";
  const mb = n / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

/** Streaming save is Chromium-only AND needs a secure context (https or
 *  localhost) — over http on a LAN IP the API is simply absent. Checked at
 *  render time, never assumed. */
function canStreamToDisk(): boolean {
  return typeof window !== "undefined"
    && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function"
    && window.isSecureContext;
}

const POLL_MS = 2500;

export function ExportModal({
  dataset,
  onClose,
}: {
  dataset: { session_id: string; label: string };
  onClose: () => void;
}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [phase, setPhase] = useState<"preparing" | "ready" | "saving" | "error">("preparing");
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Queue position matters to the user: PENDING means "waiting for a worker",
  // EXPORTING means "actively packaging". The old UI showed one spinner for both
  // and so could not distinguish a queued job from a stalled one.
  const [stage, setStage] = useState<"PENDING" | "EXPORTING">("PENDING");
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  // Elapsed timer. A multi-GB dataset takes minutes to package; without this the
  // UI is indistinguishable from a hang, which is exactly how the starvation bug
  // presented (an export that never got claimed looked like a slow one).
  useEffect(() => {
    if (phase !== "preparing") return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [phase, attempt]);

  // Enqueue + poll to terminal.
  useEffect(() => {
    cancelled.current = false;
    setElapsed(0);
    (async () => {
      try {
        let cur = await exportDataset(baseUrl, fetchWithHeaders, dataset.session_id);
        for (;;) {
          if (cancelled.current) return;
          if (cur.status === "DONE") {
            if (cur.download_url) {
              setJob(cur);
              setPhase("ready");
              return;
            }
            // DONE with no URL means the presigned link has EXPIRED (the backend
            // nulls it past expires_at). This matched neither terminal branch
            // before, so the modal polled this state forever with no error.
            // It is terminal: re-requesting mints a fresh link.
            setError("This download link has expired. Request a new one.");
            setPhase("error");
            return;
          }
          if (cur.status === "FAILED") {
            setError(cur.failure_reason || "Export failed. Try again in a moment.");
            setPhase("error");
            return;
          }
          if (cur.status === "PENDING" || cur.status === "EXPORTING") setStage(cur.status);
          await new Promise((r) => setTimeout(r, POLL_MS));
          if (cancelled.current) return;
          cur = await getExportJob(baseUrl, fetchWithHeaders, cur.export_job_id);
        }
      } catch (e) {
        if (cancelled.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [baseUrl, fetchWithHeaders, dataset.session_id, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setJob(null);
    setProgress(null);
    setStage("PENDING");
    setPhase("preparing");
    setAttempt((a) => a + 1);
  }, []);

  const suggestedName = `${dataset.label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "dataset"}.tar.gz`;

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

  // Streaming save: pick a folder, then pipe S3 -> disk with progress.
  const onStreamDownload = useCallback(async () => {
    if (!job?.download_url) return;
    type Picker = (o: unknown) => Promise<FileSystemFileHandle>;
    const pick = (window as unknown as { showSaveFilePicker: Picker }).showSaveFilePicker;
    let handle: FileSystemFileHandle;
    try {
      handle = await pick({
        suggestedName,
        types: [{ description: "gzipped tar", accept: { "application/gzip": [".tar.gz", ".tgz"] } }],
      });
    } catch {
      return; // user dismissed the picker — not an error
    }
    setPhase("saving");
    setProgress({ done: 0, total: null });
    try {
      const r = await fetch(job.download_url);
      if (!r.ok || !r.body) throw new Error(`S3 returned ${r.status}`);
      // Content-Length is readable thanks to the bucket's ExposeHeaders.
      const len = Number(r.headers.get("Content-Length")) || job.size_bytes || null;
      const writable = await handle.createWritable();
      const reader = r.body.getReader();
      let done = 0;
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        if (value) {
          await writable.write(value);
          done += value.byteLength;
          setProgress({ done, total: len });
        }
      }
      await writable.close();
      setPhase("ready");
      setProgress(null);
    } catch (e) {
      // A failed stream must not leave the user stuck in "saving" — fall back to
      // the plain download, which needs no CORS and no secure context.
      setPhase("ready");
      setProgress(null);
      setError(
        (e instanceof Error ? e.message : String(e))
        + " — use the plain Download button instead."
      );
    }
  }, [job, suggestedName]);

  const onCopy = useCallback(async () => {
    if (!job?.download_url) return;
    try {
      await navigator.clipboard.writeText(job.download_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (non-secure context) — ignore */
    }
  }, [job]);

  const streamable = canStreamToDisk();
  const pct = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  // Portaled to <body>: the page content sits inside an animated wrapper
  // (NoriLayout's page fade-in), and an animating transform turns that wrapper
  // into the containing block for position:fixed — the overlay then starts at
  // the wrapper's top instead of the viewport's, leaving an undimmed strip
  // above it. From <body> the overlay always spans the real viewport.
  return createPortal(
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
              {stage === "PENDING"
                ? "Queued — waiting for a worker to pick this up."
                : "Packaging in your cloud — this can take a few minutes for a large dataset."}
            </p>
            <p className="text-xs text-muted-foreground [font-variant-numeric:tabular-nums]">
              {Math.floor(elapsed / 60)}m {String(elapsed % 60).padStart(2, "0")}s elapsed
            </p>
            {elapsed > 180 && (
              <p className="text-xs text-amber-700">
                Still {stage === "PENDING" ? "queued" : "packaging"}. You can close this and come
                back — reopening picks up the same export.
              </p>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Run in background
            </Button>
          </div>
        )}

        {phase === "saving" && (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-nori-h14131a" />
            <p className="text-sm text-muted-foreground">Saving to your chosen folder…</p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-nori-hb06a1c transition-[width] duration-200"
                style={{ width: pct != null ? `${pct}%` : "100%" }}
              />
            </div>
            <p className="text-xs text-muted-foreground [font-variant-numeric:tabular-nums]">
              {formatBytes(progress?.done ?? 0)}
              {progress?.total ? ` of ${formatBytes(progress.total)}` : ""}
              {pct != null ? ` · ${pct}%` : ""}
            </p>
          </div>
        )}

        {phase === "ready" && job && (
          <div className="mt-5">
            <div className="rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
              Ready{job.size_bytes ? ` · ${formatBytes(job.size_bytes)}` : ""}. Link is private to you and
              expires in ~6 hours.
            </div>
            {error && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
            )}

            <div className="mt-4 flex flex-col gap-2">
              {streamable && (
                <Button onClick={onStreamDownload} className="w-full gap-2">
                  <FolderDown className="h-4 w-4" />
                  Save to a folder…
                </Button>
              )}
              <Button
                onClick={onDownload}
                variant={streamable ? "outline" : "default"}
                className="w-full gap-2"
              >
                <Download className="h-4 w-4" />
                Download
              </Button>
              <Button variant="ghost" onClick={onCopy} className="w-full gap-2">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Link copied" : "Copy link (for Colab / a remote box)"}
              </Button>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              {streamable
                ? "“Save to a folder” shows progress and lets you choose the location. “Download” uses your browser’s download manager, which can resume if the connection drops — better for very large files."
                : "Saves to your browser’s downloads folder."}{" "}
              The archive extracts to a ready-to-train LeRobotDataset (a README inside shows how to
              load it).
            </p>
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={retry}>Try again</Button>
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
