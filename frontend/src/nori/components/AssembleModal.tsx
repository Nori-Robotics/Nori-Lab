// NORI: assemble robot recordings into a trainable dataset. Enqueues the backend
// assembly job (airgapped, cloud-side) and polls it to terminal. New dataset or
// append onto an existing one (joint contract enforced backend-side; a mismatch
// surfaces as a job failure here).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import {
  assembleDataset,
  estimateAssembly,
  getAssemblyJob,
  DERIVE_MAPS,
  VIDEO_PROCESSING,
} from "@/nori/api/client";

interface DatasetOption {
  session_id: string;
  label: string;
}

const radioCls = (active: boolean) =>
  `flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition ${
    active ? "border-nori-h14131a bg-nori-h14131a/[0.03]" : "border-border hover:border-nori-h14131a/40"
  }`;

// Selected = tinted fill + the always-readable foreground color (text-nori-h14131a
// flips with the theme, so it stays legible in both light and dark — unlike a
// hardcoded text-white on the theme-flipping brand background).
const chipCls = (active: boolean) =>
  `rounded-full border px-3 py-1 text-xs transition ${
    active
      ? "border-nori-h14131a bg-nori-h14131a/10 font-medium text-nori-h14131a"
      : "border-border text-muted-foreground hover:border-nori-h14131a/40 hover:text-nori-h14131a"
  }`;

const prettyOption = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

const fmtEta = (s: number) =>
  s < 90 ? `~${Math.max(1, Math.round(s))} sec` : `~${Math.round(s / 60)} min`;

// Client mirror of the backend assembly-time model (routes/datasets.py
// ASSEMBLY_SETUP_SECONDS / ASSEMBLY_SECONDS_PER_KFRAME) — a provisional fallback
// shown from the selected recordings' frame count until the backend estimate
// endpoint is deployed. The backend value wins whenever it's available (it will
// also carry per-map / per-processing time the client can't know about).
const ASSEMBLY_SETUP_SECONDS = 45;
const ASSEMBLY_SECONDS_PER_KFRAME = 8;
const clientAssemblyEstimate = (frames: number) =>
  Math.round(ASSEMBLY_SETUP_SECONDS + (frames / 1000) * ASSEMBLY_SECONDS_PER_KFRAME);

export function AssembleModal({
  sources,
  datasets,
  sourceFrameCount,
  onClose,
  onDone,
}: {
  sources: string[];
  datasets: DatasetOption[];
  /** Total frames across the selected recordings — powers the fallback estimate
   * shown before the backend estimate endpoint is deployed. */
  sourceFrameCount?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [mode, setMode] = useState<"new" | "append">("new");
  const [name, setName] = useState("");
  const [targetId, setTargetId] = useState<string>(datasets[0]?.session_id ?? "");
  const [phase, setPhase] = useState<"form" | "running" | "error" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [doneNote, setDoneNote] = useState<string | null>(null); // e.g. skipped episodes
  // Derive-maps + video-processing (PREP: persisted onto the job; the tools that
  // consume them don't exist yet, so these change nothing about today's output).
  const [deriveMaps, setDeriveMaps] = useState<Set<string>>(new Set());
  const [videoProcessing, setVideoProcessing] = useState<Set<string>>(new Set());
  const [estimateSec, setEstimateSec] = useState<number | null>(null);
  const [estimating, setEstimating] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  const toggle = (setter: typeof setDeriveMaps, v: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });

  // Live assembly-time estimate. Today this is base assembly time (options add
  // nothing until the processing tools land); fail SOFT so an older backend
  // without the estimate endpoint just hides the number instead of erroring.
  useEffect(() => {
    if (!sources.length) {
      setEstimateSec(null);
      return;
    }
    let stale = false;
    setEstimating(true);
    estimateAssembly(baseUrl, fetchWithHeaders, {
      sources,
      deriveMaps: [...deriveMaps],
      videoProcessing: [...videoProcessing],
    })
      .then((r) => {
        if (!stale) setEstimateSec(r.estimated_seconds);
      })
      .catch(() => {
        if (!stale) setEstimateSec(null);
      })
      .finally(() => {
        if (!stale) setEstimating(false);
      });
    return () => {
      stale = true;
    };
  }, [sources, deriveMaps, videoProcessing, baseUrl, fetchWithHeaders]);

  const submit = useCallback(async () => {
    setError(null);
    if (mode === "append" && !targetId) {
      setError("Pick a dataset to add to.");
      return;
    }
    setPhase("running");
    try {
      const { assembly_job_id } = await assembleDataset(baseUrl, fetchWithHeaders, {
        sources,
        mode,
        targetDatasetSessionId: mode === "append" ? targetId : null,
        name: mode === "new" ? name.trim() || null : null,
        deriveMaps: [...deriveMaps],
        videoProcessing: [...videoProcessing],
      });
      // Poll to terminal. The heavy work runs in an ephemeral cloud job, so this
      // can take a few minutes; keep polling until DONE/FAILED.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        if (cancelled.current) return;
        const job = await getAssemblyJob(baseUrl, fetchWithHeaders, assembly_job_id);
        if (job.status === "DONE") {
          onDone();
          // A note on a DONE job means some episodes were skipped (unusable) —
          // show it so the user isn't surprised by a lower count; else just close.
          if (job.failure_reason) {
            setDoneNote(job.failure_reason);
            setPhase("done");
          } else {
            onClose();
          }
          return;
        }
        if (job.status === "FAILED") {
          setError(job.failure_reason || "Assembly failed. The recordings may be unusable (too many dropped frames).");
          setPhase("error");
          return;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [mode, targetId, name, sources, deriveMaps, videoProcessing, baseUrl, fetchWithHeaders, onClose, onDone]);

  const running = phase === "running";

  // Portaled to <body>: see ExportModal — the layout's animated page wrapper can
  // become the containing block for position:fixed, leaving an undimmed strip.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[20px] bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-nori-h14131a">Assemble into dataset</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-nori-h14131a" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {sources.length} recording{sources.length === 1 ? "" : "s"} → a trainable dataset. Episodes are
          temporally aligned and de-dropped during assembly.
        </p>

        {phase === "done" ? (
          <div className="mt-6">
            <p className="font-medium text-nori-h14131a">Dataset ready ✓</p>
            <p className="mt-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
              Some episodes were left out because they can't be trained on (usually a camera
              dropped out for several seconds):
              <br />
              <span className="text-nori-h14131a">{doneNote}</span>
            </p>
            <div className="mt-5 flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : running ? (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-nori-h14131a" />
            <p className="text-sm text-muted-foreground">
              Assembling in your cloud — this can take a few minutes. You can close this; the
              recordings show <span className="font-medium text-nori-h14131a">Uploading to dataset</span> until
              it finishes.
            </p>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Run in background
            </Button>
          </div>
        ) : (
          <>
            <div className="mt-5 space-y-2">
              <label className={radioCls(mode === "new")}>
                <input
                  type="radio"
                  checked={mode === "new"}
                  onChange={() => setMode("new")}
                  className="mt-1"
                />
                <div>
                  <p className="font-semibold text-nori-h14131a">Create a new dataset</p>
                  <p className="text-sm text-muted-foreground">Start fresh from the selected recordings.</p>
                </div>
              </label>
              <label className={`${radioCls(mode === "append")}${datasets.length ? "" : " pointer-events-none opacity-50"}`}>
                <input
                  type="radio"
                  checked={mode === "append"}
                  onChange={() => setMode("append")}
                  disabled={!datasets.length}
                  className="mt-1"
                />
                <div>
                  <p className="font-semibold text-nori-h14131a">Add to an existing dataset</p>
                  <p className="text-sm text-muted-foreground">
                    {datasets.length
                      ? "Append these recordings to a dataset you already have."
                      : "No datasets yet — create one first."}
                  </p>
                </div>
              </label>
            </div>

            {mode === "new" ? (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dataset name (optional)"
                className="mt-4 w-full rounded-lg border border-border bg-background text-foreground px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-nori-h14131a"
              />
            ) : (
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="mt-4 w-full rounded-lg border border-border bg-background text-foreground px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-nori-h14131a"
              >
                {datasets.map((d) => (
                  <option key={d.session_id} value={d.session_id}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}

            {/* Derive maps + process videos (PREP — persisted onto the job; a no-op
                until the processing tools exist). */}
            <div className="mt-4 space-y-3">
              <div>
                <p className="text-xs font-medium text-nori-h14131a">Derive maps</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {DERIVE_MAPS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggle(setDeriveMaps, m)}
                      className={chipCls(deriveMaps.has(m))}
                    >
                      {prettyOption(m)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-nori-h14131a">Process videos</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {VIDEO_PROCESSING.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => toggle(setVideoProcessing, p)}
                      className={chipCls(videoProcessing.has(p))}
                    >
                      {prettyOption(p)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {error && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            {/* Estimated assembly time — base assembly today; the options add time
                only once the processing tools land. Hidden if the backend can't
                estimate (older deploy without the endpoint). */}
            <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm">
              <span className="text-muted-foreground">Estimated time</span>
              <span className="font-medium text-nori-h14131a [font-variant-numeric:tabular-nums]">
                {(() => {
                  // Backend estimate wins; otherwise the client fallback from frame
                  // count; otherwise the spinner (or — if we have neither).
                  const shown =
                    estimateSec ??
                    (sourceFrameCount != null ? clientAssemblyEstimate(sourceFrameCount) : null);
                  return shown != null ? fmtEta(shown) : estimating ? "…" : "—";
                })()}
              </span>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={!sources.length}>
                Assemble
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
