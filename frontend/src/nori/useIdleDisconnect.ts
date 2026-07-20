// NORI: Additive file. "Are you still there?" — auto-disconnect an unattended teleop session.
//
// Internal testers kept walking away from the laptop with a session still open. The robot stays
// powered, holding the arm and (once a page resumes video) encoding, and the room stays claimed
// against anyone else who wants it. So: after IDLE_MS of no browser input, prompt; if the operator
// doesn't confirm within GRACE_MS, disconnect for them.
//
// Two deliberate design choices:
//
//   1. Idle means NO USER INPUT IN THIS TAB — not "no telemetry" and not "no robot commands".
//      The robot streams telemetry continuously whether or not a human is present, so robot-side
//      traffic can never distinguish "driving" from "walked away". Browser input can.
//
//   2. The timer is fully suppressed while the session is BUSY (see `busy` below). A long
//      hands-off run — a script, an agent goal, an open recording session — is exactly the case
//      where the operator legitimately isn't touching the mouse for ten minutes, and killing that
//      would be worse than the problem this solves. Busy also holds the clock at zero, so the
//      full 5 minutes starts fresh the moment the run ends.
//
// The countdown is derived from an absolute deadline rather than decremented per tick: background
// tabs throttle intervals to ~1/min, which would stretch a decrementing counter into a much longer
// grace period. With a deadline, throttling only makes the *displayed* number update coarsely.

import { useCallback, useEffect, useRef, useState } from "react";

/** No input for this long on a live, non-busy session -> show the prompt. */
export const IDLE_MS = 5 * 60_000;
/** No answer to the prompt within this long -> disconnect. */
export const GRACE_MS = 60_000;

// Passive listeners: these fire at high rates (mousemove/scroll/wheel) and we only ever stamp a
// ref, so they must never block scrolling or force a React render.
const ACTIVITY_EVENTS = [
  "pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart",
] as const;

export interface IdleDisconnectState {
  /** The "Are you still there?" dialog should be shown. */
  promptOpen: boolean;
  /** Whole seconds left before the automatic disconnect (only meaningful while prompting). */
  secondsLeft: number;
  /** The operator answered "yes" — dismiss and restart the idle clock. */
  confirmPresent: () => void;
}

export function useIdleDisconnect({
  armed, busy, onTimeout,
}: {
  /** A session is live and therefore worth disconnecting. */
  armed: boolean;
  /** Mid-activity (script/agent/recording/active control) — suppress the timer entirely. */
  busy: boolean;
  /** Called once when the grace period expires. */
  onTimeout: () => void;
}): IdleDisconnectState {
  const lastActivityRef = useRef(Date.now());
  // Absolute wall-clock deadline for the auto-disconnect; null while not prompting. Held in a
  // ref, not state: the tick has to READ it, decide, and fire onTimeout as a side effect, and a
  // side effect inside a setState updater would run twice under StrictMode (double disconnect).
  const deadlineRef = useRef<number | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(GRACE_MS / 1000));

  // Keep the callback in a ref so re-created closures (onTimeout is rebuilt on most renders)
  // don't tear down and restart the interval, which would reset the clock every render.
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => { onTimeoutRef.current = onTimeout; }, [onTimeout]);

  const confirmPresent = useCallback(() => {
    lastActivityRef.current = Date.now();
    deadlineRef.current = null;
    setPromptOpen(false);
    setSecondsLeft(Math.ceil(GRACE_MS / 1000));
  }, []);

  // Stamp activity. Attached only while armed so an idle disconnected app costs nothing.
  useEffect(() => {
    if (!armed) return;
    const stamp = () => { lastActivityRef.current = Date.now(); };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, stamp, { passive: true });
    }
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, stamp);
    };
  }, [armed]);

  // Disarming (disconnect, or a run starting) must clear a prompt that's already up — otherwise
  // the dialog outlives the session it was asking about.
  useEffect(() => {
    if (!armed || busy) {
      deadlineRef.current = null;
      setPromptOpen(false);
      setSecondsLeft(Math.ceil(GRACE_MS / 1000));
    }
  }, [armed, busy]);

  useEffect(() => {
    if (!armed) return;
    const id = setInterval(() => {
      const now = Date.now();
      // Busy holds the clock at "just active", so the countdown starts fresh when the run ends.
      if (busy) { lastActivityRef.current = now; return; }

      if (deadlineRef.current === null) {
        if (now - lastActivityRef.current < IDLE_MS) return;
        deadlineRef.current = now + GRACE_MS;
        setSecondsLeft(Math.ceil(GRACE_MS / 1000));
        setPromptOpen(true);
        return;
      }
      const remaining = deadlineRef.current - now;
      if (remaining <= 0) {
        deadlineRef.current = null;
        setPromptOpen(false);
        onTimeoutRef.current();
        return;
      }
      setSecondsLeft(Math.ceil(remaining / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [armed, busy]);

  return { promptOpen, secondsLeft, confirmPresent };
}
