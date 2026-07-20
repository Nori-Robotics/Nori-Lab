// NORI: assemble robot recordings into a trainable dataset. Enqueues the backend
// assembly job (airgapped, cloud-side) and polls it to terminal. New dataset or
// append onto an existing one (joint contract enforced backend-side; a mismatch
// surfaces as a job failure here).
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { assembleDataset, getAssemblyJob } from "@/nori/api/client";

interface DatasetOption {
  session_id: string;
  label: string;
}

const radioCls = (active: boolean) =>
  `flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition ${
    active ? "border-nori-h14131a bg-nori-h14131a/[0.03]" : "border-border hover:border-nori-h14131a/40"
  }`;

export function AssembleModal({
  sources,
  datasets,
  onClose,
  onDone,
}: {
  sources: string[];
  datasets: DatasetOption[];
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
  const cancelled = useRef(false);
  useEffect(() => () => {
    cancelled.current = true;
  }, []);

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
  }, [mode, targetId, name, sources, baseUrl, fetchWithHeaders, onClose, onDone]);

  const running = phase === "running";

  return (
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

            {error && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            <div className="mt-6 flex justify-end gap-2">
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
    </div>
  );
}
