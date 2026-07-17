// "Record training dataset" card on the Remote page (W2.11 rework).
//
// This NO LONGER records to the laptop. The full-quality training copy is made
// ON THE ROBOT (rpi5/media/recorder.py: full-res frames + 50 Hz state + actions)
// and ships itself to the cloud once the robot idles — see docs/offline_recorder_
// design.md. This card only:
//   1. drives the robot recorder over the control channel (teleop.record),
//   2. shows an EPHEMERAL in-browser preview of each take (the degraded live
//      stream — all the laptop has) so the operator can quality-check it,
//   3. lets them Reject a bad take, which deletes the robot's copy too
//      (record("discard_last")) before it ever uploads.
//
// The recorded datasets appear on the My Stuff page ("Robot recordings"), sourced
// from the cloud — not from any laptop spool. The legacy laptop-spool pipeline
// (datasetCapture.ts / DatasetCapture) is no longer used here.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { EphemeralEpisodeRecorder } from "@/nori/remote/episodePreview";

type Phase =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "review"; url: string };

export function DatasetCaptureCard() {
  const { teleop, running, connState, recordState } = useTeleopSession();
  const connected = running && connState === "connected";

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [task, setTask] = useState("");
  // Start/stop round-trip in flight — button shows Starting…/Stopping… and refuses
  // re-entry, so a slow recorder can never look like a dead button.
  const [busy, setBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  // Episodes kept this sitting (increments on Accept) — operator feedback only.
  const [savedCount, setSavedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default, like Robot logs — recording is an occasional task.
  const [open, setOpen] = useState(false);

  const previewRef = useRef<EphemeralEpisodeRecorder>(new EphemeralEpisodeRecorder());

  const recording = phase.kind === "recording";

  // Never leave the Stop/review controls buried behind a collapsed header.
  useEffect(() => {
    if (phase.kind !== "idle") setOpen(true);
  }, [phase.kind]);

  // Free the preview object URL when it changes or the card unmounts; drop any
  // in-flight recording on unmount (the robot copy is unaffected).
  useEffect(() => {
    const preview = previewRef.current;
    return () => {
      if (phase.kind === "review") URL.revokeObjectURL(phase.url);
      preview.cancel();
    };
  }, [phase]);

  const startEpisode = useCallback(() => {
    if (!teleop || busy) return;
    setBusy(true);
    setError(null);
    try {
      const stream = teleop.videoStream();
      if (!stream) throw new Error("no video stream — is video enabled?");
      // Browser preview FIRST: if the stream is stale/missing it throws here and
      // the robot never starts, so the two can't diverge.
      previewRef.current.start(stream);
      teleop.record("start", task.trim() || "teleop session");
      setPhase({ kind: "recording" });
    } catch (e) {
      previewRef.current.cancel();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [teleop, busy, task]);

  const stopEpisode = useCallback(async () => {
    if (!teleop || busy) return;
    setBusy(true);
    try {
      teleop.record("stop");
      const blob = await previewRef.current.stop();
      if (blob) {
        setPhase({ kind: "review", url: URL.createObjectURL(blob) });
      } else {
        // No preview captured (very short take) — nothing to review; the robot
        // still recorded it, so keep it.
        setSavedCount((n) => n + 1);
        setPhase({ kind: "idle" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: "idle" });
    } finally {
      setBusy(false);
    }
  }, [teleop, busy]);

  const acceptEpisode = useCallback(() => {
    if (phase.kind === "review") URL.revokeObjectURL(phase.url);
    setSavedCount((n) => n + 1);
    setPhase({ kind: "idle" });
  }, [phase]);

  const rejectEpisode = useCallback(async () => {
    if (phase.kind !== "review") return;
    setReviewBusy(true);
    try {
      // Delete the robot's full-quality copy of this take before it uploads.
      // Safe: the operator is still connected, so the idle-gated shipper hasn't
      // shipped it yet (recorder.py _discard_last).
      teleop?.record("discard_last");
      URL.revokeObjectURL(phase.url);
      setPhase({ kind: "idle" });
    } finally {
      setReviewBusy(false);
    }
  }, [phase, teleop]);

  // Robot recorder status line (record_status replies via onRecord).
  const robotLine = (() => {
    if (recordState === null) return "no reply yet";
    if (recordState.recording) {
      return `recording ${recordState.episode ?? ""}${
        recordState.freeGb !== undefined ? ` · ${recordState.freeGb} GB free` : ""
      }`;
    }
    if (recordState.error) return `unavailable (${recordState.error})`;
    return "ready — a full-quality copy records with each episode";
  })();

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
          {recording && (
            <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" />
          )}
        </h3>
        <span className="flex items-center gap-3 text-sm font-normal text-muted-foreground">
          {savedCount > 0 && (
            <span className="text-xs">
              {savedCount} episode{savedCount === 1 ? "" : "s"} saved
            </span>
          )}
          {open ? "▲ hide" : "▼ show"}
        </span>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed text-[#6f6858]">
            Record demonstrations of a task to train your Nori to do it autonomously. Each
            episode is saved on the robot at full quality and uploads to your cloud when the
            robot is idle — find them on the My Stuff page. The preview below is the live
            view, so you can reject a bad take.
          </p>

          {phase.kind === "review" ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[#14131a]">Keep this episode?</p>
              <video
                key={phase.url}
                src={phase.url}
                className="w-full max-w-md rounded-md border border-[#14131a]/15 bg-black"
                controls
                loop
                autoPlay
                muted
              >
                <track kind="captions" />
              </video>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={acceptEpisode} disabled={reviewBusy}>
                  Keep
                </Button>
                <Button onClick={() => void rejectEpisode()} variant="destructive" disabled={reviewBusy}>
                  Reject
                </Button>
                <span className="text-xs text-[#6f6858]">
                  Keep adds it to your recordings; Reject deletes the robot&apos;s copy too.
                </span>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="h-9 flex-1 rounded-md border border-[#14131a]/15 bg-white/70 px-3 text-sm"
                  placeholder="task description (e.g. pick up the red cube)"
                  maxLength={200}
                  value={task}
                  disabled={recording}
                  onChange={(e) => setTask(e.target.value)}
                />
                <Button
                  onClick={() => (recording ? void stopEpisode() : startEpisode())}
                  variant={recording ? "destructive" : "default"}
                  disabled={busy || (!recording && !connected)}
                >
                  {busy
                    ? recording ? "Stopping…" : "Starting…"
                    : recording ? "Stop episode" : "Start episode"}
                </Button>
              </div>
              <p className="text-xs text-[#6f6858]">
                robot recorder:{" "}
                {recordState?.recording && (
                  <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" />
                )}
                {robotLine}
              </p>
              {!connected && !recording && (
                <p className="text-sm text-[#6f6858]">connect to the robot first</p>
              )}
              {error && <p className="text-sm text-red-700">{error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
