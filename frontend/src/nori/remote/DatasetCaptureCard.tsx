// NORI: Additive file. The browser-catcher UI — a card on the Remote page that
// records the live session into a LeRobot dataset (see datasetCapture.ts for the
// pipeline; lelab/browser_capture.py for the spool it feeds).
//
// Lifecycle the card walks the operator through:
//   record session → [episode start … episode stop]×N → export → upload to cloud
//
// Renders nothing when the spool isn't reachable (hosted LeLab-free app) and
// disables itself until a session is connected with video available.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { uploadDataset } from "@/nori/api/client";
import { DatasetCapture } from "@/nori/remote/datasetCapture";

type Phase =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { kind: "exporting" }
  | { kind: "exported"; repoId: string }
  | { kind: "uploading"; repoId: string }
  | { kind: "uploaded"; repoId: string }
  | { kind: "error"; message: string };

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

  useEffect(() => {
    let alive = true;
    void DatasetCapture.available(baseUrl).then((ok) => alive && setAvailable(ok));
    return () => {
      alive = false;
    };
  }, [baseUrl]);

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
    try {
      const { repoId } = await capture.finish();
      captureRef.current = null;
      setPhase({ kind: "exported", repoId });
    } catch (e) {
      captureRef.current = null;
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [setTelemetryListener, setControlSentListener]);

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
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={beginCapture} disabled={!running || !teleop}>
              Record session
            </Button>
            <span className="text-sm text-[#6f6858]">
              {running
                ? "captures video + joint state from this session into a LeRobot dataset"
                : "connect to the robot first"}
            </span>
          </div>
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
                Finish & export
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
              Dataset <span className="font-mono text-xs">{phase.repoId}</span>{" "}
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
              onClick={() => setPhase({ kind: "idle" })}
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
      </div>
      )}
    </div>
  );
}
