// NORI: latch for the robot's activation blocker, so a refused arm stays readable.
//
// The bug this closes (operator report, 2026-11-06): "joint parked out of limits"
// almost never showed. The robot's side is correct — within 40 ms of a refused
// activation the gateway sends daemon_status with activation "physical_blocked"
// and the humanized blocker ("the right wrist pitch joint is parked ~1.1° past
// its lower limit — nudge it toward center and retry"). But a refused activation
// drops the arm buses, the arbiter releases ownership, and the guarded disarm
// runs, so the state goes physical_blocked -> disarming -> inactive in ~2 s
// (measured on 0003, 2026-11-05 13:03:58: 0.0 s / 0.3 s / 1.8 s). ActivationBanner
// gated on the LIVE state and rendered nothing for "inactive", so the sentence
// was on screen for under two seconds, mostly under the wrong headline. The
// robot keeps sending the detail on every later frame (the status store keeps
// the blocker until the next successful activation) — the app just stopped
// looking at it.
//
// This latch remembers the last stuck detail and keeps it until something the
// operator did makes it stale:
//   * a later frame reports activation "active"  — the arm succeeded;
//   * the session ends (status null)              — nothing to act on;
//   * a different stuck detail arrives            — the newer cause replaces it;
//   * the operator dismisses it                   — until a DIFFERENT detail arrives
//     (the same sentence re-sent on the next 3 s rebroadcast is not news).
// A new arm attempt that fails the same way re-shows the same sentence only if
// it was not dismissed; if it was, the operator already read it.
//
// Pure reducer + a thin hook so the sequencing is unit-tested like armPhase.

import { useEffect, useState } from "react";
import type { DaemonStatus } from "@nori/sdk";
import { isStuck } from "@/nori/remote/armPhase";

export type ActivationLatch = {
  // The last blocker the robot named, "" when none.
  detail: string;
  // The operator dismissed exactly this text. A different text re-shows.
  dismissed: string;
};

export const EMPTY_LATCH: ActivationLatch = { detail: "", dismissed: "" };

export function latchActivation(prev: ActivationLatch, status: DaemonStatus | null): ActivationLatch {
  if (!status) return EMPTY_LATCH;
  const activation = status.activation ?? "";
  if (activation === "active") return EMPTY_LATCH;
  const detail = status.activation_detail ?? "";
  if (isStuck(activation) && detail && detail !== prev.detail) {
    return { detail, dismissed: "" };
  }
  return prev;
}

export function dismissLatch(prev: ActivationLatch): ActivationLatch {
  return { detail: prev.detail, dismissed: prev.detail };
}

// What the banner should show for a stuck cause the live frame no longer
// carries: the latched text, unless the operator dismissed that exact text.
export function latchedDetail(latch: ActivationLatch): string {
  return latch.detail && latch.detail !== latch.dismissed ? latch.detail : "";
}

export function useActivationLatch(status: DaemonStatus | null): [ActivationLatch, () => void] {
  const [latch, setLatch] = useState<ActivationLatch>(EMPTY_LATCH);
  useEffect(() => {
    setLatch((prev) => latchActivation(prev, status));
  }, [status]);
  return [latch, () => setLatch(dismissLatch)];
}
