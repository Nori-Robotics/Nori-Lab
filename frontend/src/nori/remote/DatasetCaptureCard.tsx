// NORI: Additive file. The browser-catcher UI — a card on the Remote page that
// records the live session into a LeRobot dataset (see datasetCapture.ts for the
// pipeline; lelab/browser_capture.py for the spool it feeds).
//
// Lifecycle the card walks the operator through:
//   pick destination (new dataset [name] | add to existing) → record session →
//   [episode start … episode stop]×N → export → upload to cloud
//
// Also the local dataset manager: lists the cache datasets (episodes/frames/
// date) with inline rename — the operator's view of "what have I recorded".
//
// Renders nothing when the spool isn't reachable (hosted LeLab-free app) and
// disables itself until a session is connected with video available.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { useApi } from "@/contexts/ApiContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { uploadDataset } from "@/nori/api/client";
import { DatasetCapture, type CaptureDatasetEntry } from "@/nori/remote/datasetCapture";

type Phase =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { kind: "exporting" }
  | { kind: "exported"; repoId: string; appended: boolean }
  | { kind: "uploading"; repoId: string }
  | { kind: "uploaded"; repoId: string }
  | { kind: "error"; message: string };

type Destination = { mode: "new"; name: string } | { mode: "append"; repoId: string };

// One row of the "your datasets" list, with inline rename. Rename is a local
// cache operation; failures (name taken, bad chars) surface inline.
function DatasetRow({
  entry,
  disabled,
  onRename,
}: {
  entry: CaptureDatasetEntry;
  disabled: boolean;
  onRename: (oldId: string, newId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.repo_id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === entry.repo_id) {
      setEditing(false);
      setErr(null);
      return;
    }
    setBusy(true);
    try {
      await onRename(entry.repo_id, next);
      setEditing(false);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#14131a]/10 py-1.5 first:border-t-0">
      {editing ? (
        <input
          className="h-7 min-w-0 flex-1 rounded border border-[#14131a]/20 bg-white px-2 font-mono text-xs"
          value={draft}
          disabled={busy}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(entry.repo_id);
              setErr(null);
            }
          }}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.repo_id}>
          {entry.repo_id}
        </span>
      )}
      <span className="shrink-0 text-xs text-[#6f6858]">
        {entry.episodes} ep · {entry.frames} frames
        {entry.fps ? ` · ${entry.fps} fps` : ""} · {entry.modified_at.slice(0, 10)}
      </span>
      {editing ? (
        <span className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void commit()} disabled={busy}>
            {busy ? "…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setDraft(entry.repo_id);
              setErr(null);
            }}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          rename
        </Button>
      )}
      {err && <span className="w-full text-xs text-red-700">{err}</span>}
    </div>
  );
}

export function DatasetCaptureCard() {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { teleop, running, settings, setTelemetryListener, setControlSentListener } =
    useTeleopSession();

  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [task, setTask] = useState("");
  const [episodeOn, setEpisodeOn] = useState(false);
  const [episodeCount, setEpisodeCount] = useState(0);
  const captureRef = useRef<DatasetCapture | null>(null);

  // Collapsed by default, like Robot logs — recording is an occasional task and the card is tall.
  const [open, setOpen] = useState(false);

  // Destination for this session's episodes, chosen up front. The dataset
  // list doubles as the append picker's source and the rename manager.
  const [dest, setDest] = useState<Destination>({ mode: "new", name: "" });
  const [datasets, setDatasets] = useState<CaptureDatasetEntry[]>([]);
  const [listOpen, setListOpen] = useState(false);

  const refreshDatasets = useCallback(() => {
    DatasetCapture.listDatasets(baseUrl)
      .then(setDatasets)
      .catch(() => setDatasets([]));
  }, [baseUrl]);

  useEffect(() => {
    let alive = true;
    void DatasetCapture.available(baseUrl).then((ok) => {
      if (!alive) return;
      setAvailable(ok);
    });
    return () => {
      alive = false;
    };
  }, [baseUrl]);

  useEffect(() => {
    if (available) refreshDatasets();
  }, [available, refreshDatasets]);

  // Tear down listeners (and any dangling capture) when the card unmounts.
  useEffect(
    () => () => {
      setTelemetryListener(null);
      setControlSentListener(null);
      void captureRef.current?.abort();
    },
    [setTelemetryListener, setControlSentListener]
  );

  // Anything other than idle means a capture, export or upload is live and the operator needs the
  // controls (Stop episode, Finish & export) — never leave those buried behind a collapsed header.
  // Only forces it open on the transition, so the card can still be collapsed again afterwards.
  useEffect(() => {
    if (phase.kind !== "idle") setOpen(true);
  }, [phase.kind]);

  const appendable = datasets.filter((d) => d.appendable);
  const appendTarget =
    dest.mode === "append" ? appendable.find((d) => d.repo_id === dest.repoId) : undefined;

  const beginCapture = useCallback(async () => {
    if (!teleop) return;
    const capture = new DatasetCapture(baseUrl);
    try {
      await capture.begin(teleop, settings.room);
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    captureRef.current = capture;
    setTelemetryListener(capture.onTelemetry);
    setControlSentListener(capture.onControlSent);
    setEpisodeCount(0);
    setEpisodeOn(false);
    setPhase({ kind: "capturing" });
  }, [teleop, baseUrl, settings.room, setTelemetryListener, setControlSentListener]);

  const toggleEpisode = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture || !teleop) return;
    try {
      if (episodeOn) {
        await capture.episodeStop();
        setEpisodeOn(false);
        setEpisodeCount((n) => n + 1);
      } else {
        await capture.episodeStart(teleop, task.trim() || "teleop session");
        setEpisodeOn(true);
      }
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [episodeOn, task, teleop]);

  const finishCapture = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    setTelemetryListener(null);
    setControlSentListener(null);
    setPhase({ kind: "exporting" });
    const appended = dest.mode === "append";
    try {
      const { repoId } = await capture.finish(
        15,
        dest.mode === "new" ? dest.name.trim() : "",
        dest.mode === "append" ? dest.repoId : ""
      );
      captureRef.current = null;
      setPhase({ kind: "exported", repoId, appended });
      refreshDatasets();
    } catch (e) {
      captureRef.current = null;
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [dest, setTelemetryListener, setControlSentListener, refreshDatasets]);

  const abortCapture = useCallback(async () => {
    setTelemetryListener(null);
    setControlSentListener(null);
    await captureRef.current?.abort();
    captureRef.current = null;
    setEpisodeOn(false);
    setEpisodeCount(0);
    setPhase({ kind: "idle" });
  }, [setTelemetryListener, setControlSentListener]);

  const uploadToCloud = useCallback(async () => {
    if (phase.kind !== "exported") return;
    const repoId = phase.repoId;
    setPhase({ kind: "uploading", repoId });
    try {
      await uploadDataset(baseUrl, fetchWithHeaders, repoId, "Remote-session browser capture");
      setPhase({ kind: "uploaded", repoId });
    } catch (e) {
      setPhase({
        kind: "error",
        message: `upload of ${repoId} failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [phase, baseUrl, fetchWithHeaders]);

  const renameDataset = useCallback(
    async (oldId: string, newId: string) => {
      await DatasetCapture.renameDataset(baseUrl, oldId, newId);
      // Keep an append selection pointing at the renamed dataset.
      setDest((d) => (d.mode === "append" && d.repoId === oldId ? { ...d, repoId: newId } : d));
      refreshDatasets();
    },
    [baseUrl, refreshDatasets]
  );

  if (!available) return null;

  const capturing = phase.kind === "capturing";
  const busy = phase.kind === "exporting" || phase.kind === "uploading";

  return (
    <div className={`rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-4 pt-3 text-[#14131a] shadow-sm ${open ? "pb-4" : "pb-3"}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="flex min-h-9 cursor-pointer items-center justify-between"
      >
        <h3 className="text-base font-semibold leading-none tracking-tight">
          Record training dataset
          {/* The live dot and the episode count stay in the header while collapsed — a recording
              in progress must never be invisible just because the card is shut. */}
          {capturing && (
            <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" />
          )}
        </h3>
        <span className="flex items-center gap-3 text-sm font-normal text-muted-foreground">
          {capturing && (
            <span className="text-xs">
              {episodeCount} episode{episodeCount === 1 ? "" : "s"} saved
            </span>
          )}
          {open ? "▲ hide" : "▼ show"}
        </span>
      </div>

      {open && (
      <div className="mt-3 space-y-3">
        <p className="text-sm leading-relaxed text-[#6f6858]">
          Record sessions of teleoperation to train your Nori to do the task autonomously. After
          recording enough episodes, go to the Training page to start creating a policy.
        </p>
        {phase.kind === "idle" && (
          <>
            {/* Destination: a brand-new dataset, or new episodes appended to a
                previous session's dataset (same joints; exporter re-validates). */}
            <div className="flex flex-wrap items-center gap-2">
              <Pill size="sm" active={dest.mode === "new"} onClick={() => setDest({ mode: "new", name: "" })}>
                New dataset
              </Pill>
              <Pill
                size="sm"
                active={dest.mode === "append"}
                onClick={() =>
                  setDest({ mode: "append", repoId: appendable[0]?.repo_id ?? "" })
                }
              >
                Add to existing
              </Pill>
              {dest.mode === "new" ? (
                <input
                  className="h-9 min-w-48 flex-1 rounded-md border border-[#14131a]/15 bg-white/70 px-3 font-mono text-sm"
                  placeholder="dataset name (optional — timestamped if empty)"
                  maxLength={120}
                  value={dest.name}
                  onChange={(e) => setDest({ mode: "new", name: e.target.value })}
                />
              ) : appendable.length === 0 ? (
                <span className="text-sm text-[#6f6858]">no capture datasets yet — record a new one first</span>
              ) : (
                <select
                  className="h-9 min-w-48 flex-1 rounded-md border border-[#14131a]/15 bg-white/70 px-2 font-mono text-sm"
                  value={dest.mode === "append" ? dest.repoId : ""}
                  onChange={(e) => setDest({ mode: "append", repoId: e.target.value })}
                >
                  {appendable.map((d) => (
                    <option key={d.repo_id} value={d.repo_id}>
                      {d.repo_id} ({d.episodes} ep)
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={beginCapture}
                disabled={!running || !teleop || (dest.mode === "append" && !appendTarget)}
              >
                Record session
              </Button>
              <span className="text-sm text-[#6f6858]">
                {!running
                  ? "connect to the robot first"
                  : dest.mode === "append" && appendTarget
                    ? `episodes will be added to ${appendTarget.repo_id}`
                    : "captures video + joint state from this session into a LeRobot dataset"}
              </span>
            </div>
          </>
        )}

        {capturing && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="h-9 flex-1 rounded-md border border-[#14131a]/15 bg-white/70 px-3 text-sm"
                placeholder="task description (e.g. pick up the red cube)"
                maxLength={200}
                value={task}
                disabled={episodeOn}
                onChange={(e) => setTask(e.target.value)}
              />
              <Button onClick={toggleEpisode} variant={episodeOn ? "destructive" : "default"}>
                {episodeOn ? "Stop episode" : "Start episode"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={finishCapture} disabled={episodeOn || episodeCount === 0}>
                {dest.mode === "append" ? "Finish & add episodes" : "Finish & export"}
              </Button>
              <Button onClick={abortCapture} variant="ghost" disabled={episodeOn}>
                Discard
              </Button>
              {captureRef.current?.lastError && (
                <span className="text-xs text-red-700">spool: {captureRef.current.lastError}</span>
              )}
            </div>
          </>
        )}

        {phase.kind === "exporting" && (
          <p className="text-sm text-[#6f6858]">
            Assembling LeRobot dataset (video decode + encode — this can take a few minutes)…
          </p>
        )}

        {(phase.kind === "exported" || phase.kind === "uploading" || phase.kind === "uploaded") && (
          <div className="space-y-2">
            <p className="text-sm">
              {phase.kind === "exported" && phase.appended ? "Episodes added to " : "Dataset "}
              <span className="font-mono text-xs">{phase.repoId}</span>{" "}
              {phase.kind === "uploaded" ? "uploaded to your cloud repo ✓" : "saved locally."}
            </p>
            {phase.kind !== "uploaded" && (
              <div className="flex items-center gap-3">
                <Button onClick={uploadToCloud} disabled={phase.kind === "uploading"}>
                  {phase.kind === "uploading" ? "Uploading…" : "Upload to cloud"}
                </Button>
                <span className="text-xs text-[#6f6858]">
                  backend-mediated, lands private in your assigned HF repo
                </span>
              </div>
            )}
            {phase.kind === "uploaded" && (
              <p className="text-xs text-[#6f6858]">
                Train on it from the Training page — it's now your latest upload.
              </p>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setPhase({ kind: "idle" });
                refreshDatasets();
              }}
              disabled={busy}
            >
              Record another
            </Button>
          </div>
        )}

        {phase.kind === "error" && (
          <div className="space-y-2">
            <p className="text-sm text-red-700">{phase.message}</p>
            <Button variant="ghost" onClick={abortCapture}>
              Reset
            </Button>
          </div>
        )}

        {/* Local dataset manager — visible while idle so renames can't race an
            active export (the backend refuses those anyway). */}
        {phase.kind === "idle" && datasets.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              className="text-xs font-medium text-[#6f6858] underline-offset-2 hover:underline"
              onClick={() => setListOpen((v) => !v)}
            >
              {listOpen ? "▾" : "▸"} your datasets ({datasets.length})
            </button>
            {listOpen && (
              <div className="mt-1">
                {datasets.map((d) => (
                  <DatasetRow key={d.repo_id} entry={d} disabled={busy} onRename={renameDataset} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
