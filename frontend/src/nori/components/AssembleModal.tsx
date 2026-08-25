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
  VIDEO_PROCESSING_ENABLED,
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

const fmtEta = (s: number) => {
  if (s < 90) return `~${Math.max(1, Math.round(s))} sec`;
  if (s < 3600) return `~${Math.round(s / 60)} min`;
  // Map derivation runs to hours (~0.6 h for one 4-camera episode of normals,
  // ~6 h for twenty). Minutes past this point stop being readable.
  const h = s / 3600;
  return h < 10 ? `~${h.toFixed(1)} hr` : `~${Math.round(h)} hr`;
};

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
  // consume them are live: depth from the masking stage, normals/albedo/
  // roughness from one inverse-rendering pass on a GPU).
  const [deriveMaps, setDeriveMaps] = useState<Set<string>>(new Set());
  const [videoProcessing, setVideoProcessing] = useState<Set<string>>(new Set());
  // Any GPU post-processing selected? Drives whether the estimate splits into
  // "assembly" + "map processing" or stays a single line.
  const anyProcessing = deriveMaps.size > 0 || videoProcessing.size > 0;
  // Which cameras to derive maps for. Maps are computed PER CAMERA on a GPU, so
  // a 4-camera recording costs 4x a 1-camera one. Wrist views are close-ups
  // where scene geometry and material maps mean least, so overhead-only is
  // usually the right trade. "all" sends [] (every camera).
  const [mapScope, setMapScope] = useState<"all" | "overhead">("overhead");
  const mapCameras = mapScope === "overhead" ? ["overhead"] : [];
  const [estimateSec, setEstimateSec] = useState<number | null>(null);
  // Processing is a SEPARATE, much longer phase. undefined = not yet known,
  // null = the backend says "selected but unmeasured" (render as unknown).
  const [processingSec, setProcessingSec] = useState<number | null | undefined>(undefined);
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
      mapCameras,
    })
      .then((r) => {
        if (!stale) {
          // assembly_seconds when the backend splits the two; estimated_seconds
          // is the same number on older deploys.
          setEstimateSec(r.assembly_seconds ?? r.estimated_seconds);
          setProcessingSec(r.processing_seconds);
        }
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
  }, [sources, deriveMaps, videoProcessing, mapScope, baseUrl, fetchWithHeaders]);

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
        mapCameras,
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
  }, [mode, targetId, name, sources, deriveMaps, videoProcessing, mapScope, baseUrl, fetchWithHeaders, onClose, onDone]);

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

            {/* Derive maps + process videos. Live: depth from the masking stage,
                normals/albedo/roughness from one inverse-rendering pass. */}
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
              {deriveMaps.size > 0 && (
                <div>
                  <p className="text-xs font-medium text-nori-h14131a">Map cameras</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setMapScope("overhead")}
                      className={chipCls(mapScope === "overhead")}
                    >
                      Overhead only
                    </button>
                    <button
                      type="button"
                      onClick={() => setMapScope("all")}
                      className={chipCls(mapScope === "all")}
                    >
                      All cameras
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Maps are generated per camera, so every extra camera multiplies
                    the GPU time. Overhead usually carries the useful geometry.
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs font-medium text-nori-h14131a">Process videos</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {VIDEO_PROCESSING.map((p) => {
                    const enabled = VIDEO_PROCESSING_ENABLED.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        disabled={!enabled}
                        // Shown-but-disabled rather than hidden: these are on the
                        // roadmap, and a user who was told the feature exists
                        // should see it coming rather than conclude it vanished.
                        title={enabled ? undefined : "Coming soon — the render pass runs but its output isn't downloadable yet"}
                        onClick={() => enabled && toggle(setVideoProcessing, p)}
                        className={
                          enabled
                            ? chipCls(videoProcessing.has(p))
                            : `${chipCls(false)} cursor-not-allowed opacity-50`
                        }
                      >
                        {prettyOption(p)}
                      </button>
                    );
                  })}
                </div>
                {VIDEO_PROCESSING_ENABLED.length === 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Relighting and colour jitter are coming soon.
                  </p>
                )}
              </div>
            </div>

            {error && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            {/* Estimated assembly time — base assembly today; the options add time
                only once the processing tools land. Hidden if the backend can't
                estimate (older deploy without the endpoint). */}
            {/* TWO estimates, deliberately separate. Assembly is minutes and
                ends with a trainable dataset; map derivation is GPU work that
                runs to HOURS and lands afterwards as an extra layer. Collapsing
                them into one number either hides a multi-hour job or makes
                plain assembly look broken. */}
            <div className="mt-4 space-y-1.5 border-t border-border pt-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {anyProcessing ? "Assembly time" : "Estimated time"}
                </span>
                <span className="font-medium text-nori-h14131a [font-variant-numeric:tabular-nums]">
                  {(() => {
                    // Backend estimate wins; otherwise the client fallback from
                    // frame count; otherwise the spinner (or — if neither).
                    const shown =
                      estimateSec ??
                      (sourceFrameCount != null ? clientAssemblyEstimate(sourceFrameCount) : null);
                    return shown != null ? fmtEta(shown) : estimating ? "…" : "—";
                  })()}
                </span>
              </div>
              {anyProcessing && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Map processing</span>
                    <span className="font-medium text-nori-h14131a [font-variant-numeric:tabular-nums]">
                      {processingSec === undefined
                        ? estimating
                          ? "…"
                          : "—"
                        : processingSec === null
                          ? "unknown"
                          : fmtEta(processingSec)}
                    </span>
                  </div>
                  <p className="pt-0.5 text-xs text-muted-foreground">
                    Your dataset is ready to train as soon as assembly finishes. Maps
                    are generated on GPUs afterwards and appear as an extra
                    downloadable layer.
                  </p>
                </>
              )}
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
