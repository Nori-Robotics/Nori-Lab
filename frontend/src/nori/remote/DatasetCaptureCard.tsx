// "Record training dataset" card on the Remote page (W2.11).
//
// Records to the ROBOT, not the laptop. The full-quality training copy is made
// on the robot (rpi5/media/recorder.py: full-res frames + 50 Hz state + actions)
// and ships itself to the cloud once the robot idles (docs/offline_recorder_
// design.md). Recorded episodes appear on My Stuff ("Robot recordings").
//
// UX — a two-tier SESSION → EPISODES flow, matching how you collect data:
//   1. Start a session with a task label (the grouping key; all its episodes
//      share it, and assembly groups by it into one LeRobot dataset).
//   2. Within the session, record episodes one at a time: Start episode → drive
//      → Stop episode → EPHEMERAL in-browser preview (the degraded live view —
//      all the laptop has) → Keep or Reject. Reject deletes the robot's copy too
//      (record("discard_last")) before it can upload.
//   3. Finish the session when done.
// Each episode is one robot start/stop; Keep leaves it to ship, Reject discards
// it on the robot. The card never spools to the laptop (contrast datasetCapture.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { EphemeralEpisodeRecorder } from "@/nori/remote/episodePreview";

type Phase =
  | { kind: "idle" }                              // no session
  | { kind: "session" }                           // session open, between episodes
  | { kind: "recording" }                         // an episode is recording
  | { kind: "review"; url: string | null };       // just-stopped episode awaiting Keep/Reject

export function DatasetCaptureCard() {
  const { teleop, running, connState, recordState } = useTeleopSession();
  const connected = running && connState === "connected";

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);        // start/stop round-trip in flight
  const [reviewBusy, setReviewBusy] = useState(false);
  const [episodeCount, setEpisodeCount] = useState(0);   // kept episodes this session
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const previewRef = useRef<EphemeralEpisodeRecorder>(new EphemeralEpisodeRecorder());

  const recording = phase.kind === "recording";
  const inSession = phase.kind !== "idle";

  // Keep the controls visible whenever a session is open.
  useEffect(() => {
    if (phase.kind !== "idle") setOpen(true);
  }, [phase.kind]);

  // Free the preview object URL on change/unmount; drop any in-flight recording
  // on unmount (the robot copy is unaffected).
  useEffect(() => {
    const preview = previewRef.current;
    return () => {
      if (phase.kind === "review" && phase.url) URL.revokeObjectURL(phase.url);
      preview.cancel();
    };
  }, [phase]);

  const startSession = useCallback(() => {
    if (!teleop) return;
    setEpisodeCount(0);
    setError(null);
    // Opens ONE robot session dir; every episode below goes into it and the whole
    // session ships as one bundle (W2.11 one-bundle-per-session).
    teleop.record("session_start", task.trim() || "teleop session");
    setPhase({ kind: "session" });
  }, [teleop, task]);

  const finishSession = useCallback(() => {
    // Close the robot session — it uploads (as one bundle) when the robot idles.
    teleop?.record("session_end");
    setPhase({ kind: "idle" });
  }, [teleop]);

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
      teleop.record("episode_start");
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
      teleop.record("episode_stop");
      const blob = await previewRef.current.stop();
      // ALWAYS surface the Keep/Reject decision, even if the preview came back
      // empty (a null url just renders a "no preview" note) — the operator must
      // always get to reject a bad take, never have it silently kept.
      setPhase({ kind: "review", url: blob ? URL.createObjectURL(blob) : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: "session" });
    } finally {
      setBusy(false);
    }
  }, [teleop, busy]);

  const keepEpisode = useCallback(() => {
    if (phase.kind === "review" && phase.url) URL.revokeObjectURL(phase.url);
    setEpisodeCount((n) => n + 1);
    setPhase({ kind: "session" });
  }, [phase]);

  const rejectEpisode = useCallback(() => {
    if (phase.kind !== "review") return;
    setReviewBusy(true);
    try {
      // Delete just this episode's robot copy; other kept episodes in the session
      // stay. Safe: still connected, so the idle-gated shipper hasn't shipped the
      // session yet (recorder.py _episode_discard).
      teleop?.record("episode_discard");
      if (phase.url) URL.revokeObjectURL(phase.url);
      setPhase({ kind: "session" });
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
          {inSession && (
            <span className="text-xs">
              {episodeCount} episode{episodeCount === 1 ? "" : "s"} kept
            </span>
          )}
          {open ? "▲ hide" : "▼ show"}
        </span>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          {/* ---- no session: choose a task and start ---- */}
          {phase.kind === "idle" && (
            <>
              <p className="text-sm leading-relaxed text-[#6f6858]">
                Record demonstrations of a task: each episode is saved on the robot at full
                quality and will upload to Your Stuff when the robot is idle.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="h-9 flex-1 rounded-md border border-[#14131a]/15 bg-white/70 px-3 text-sm"
                  placeholder="task for this session (e.g. pick up the red cube)"
                  maxLength={200}
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                />
                <Button onClick={startSession} disabled={!connected || !task.trim()}>
                  Start session
                </Button>
              </div>
              {!connected && <p className="text-sm text-[#6f6858]">connect to the robot first</p>}
            </>
          )}

          {/* ---- session open, between episodes ---- */}
          {phase.kind === "session" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-[#14131a]">
                  Session: <span className="font-semibold">{task.trim() || "teleop session"}</span>
                  <span className="ml-2 text-[#6f6858]">· {episodeCount} kept</span>
                </p>
                <Button size="sm" variant="ghost" onClick={finishSession}>
                  Finish session
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={startEpisode} disabled={busy || !connected}>
                  {busy ? "Starting…" : "Start episode"}
                </Button>
                <span className="text-sm text-[#6f6858]">
                  drive the robot through the task, then stop to review it
                </span>
              </div>
              <p className="rounded-md border border-[#14131a]/10 bg-white/50 px-3 py-2 text-xs text-[#6f6858]">
                When you’re done recording, just <b>disconnect</b> and leave the robot
                <b> powered on and idle</b> — your episodes upload to the cloud while it sits
                idle. <b>Don’t turn it off</b> until they’ve finished uploading.
              </p>
            </>
          )}

          {/* ---- an episode is recording ---- */}
          {phase.kind === "recording" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void stopEpisode()} variant="destructive" disabled={busy}>
                {busy ? "Stopping…" : "Stop episode"}
              </Button>
              <span className="text-sm text-[#6f6858]">
                recording episode {episodeCount + 1} of “{task.trim() || "teleop session"}”
              </span>
            </div>
          )}

          {/* ---- review the just-stopped episode ---- */}
          {phase.kind === "review" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[#14131a]">Keep this episode?</p>
              {phase.url ? (
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
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  Preview unavailable (short take or video paused) — the robot still recorded it.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={keepEpisode} disabled={reviewBusy}>
                  Keep
                </Button>
                <Button onClick={rejectEpisode} variant="destructive" disabled={reviewBusy}>
                  Reject
                </Button>
                <span className="text-xs text-[#6f6858]">
                  Keep adds it to the session; Reject deletes the robot&apos;s copy too.
                </span>
              </div>
            </div>
          )}

          {/* robot recorder status — always visible while a session is open */}
          {inSession && (
            <p className="text-xs text-[#6f6858]">
              robot recorder:{" "}
              {recordState?.recording && (
                <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" />
              )}
              {robotLine}
            </p>
          )}
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
      )}
    </div>
  );
}
