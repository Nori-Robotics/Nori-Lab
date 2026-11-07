// NORI: tests for activationLatch.ts — the refused-arm message must outlive the
// two-second physical_blocked -> disarming -> inactive sequence the robot runs.

import { describe, expect, it } from "vitest";
import type { DaemonStatus } from "@nori/sdk";
import { EMPTY_LATCH, dismissLatch, latchActivation, latchedDetail } from "./activationLatch";

const BLOCKER = "the right wrist pitch joint is parked ~1.1° past its lower limit — nudge it toward center and retry";
const IDLE = "arm buses torque-free; lift and joint-state broadcaster remain active";

const frame = (activation: string, activation_detail?: string, armed = false): DaemonStatus =>
  ({ state: "online", armed, activation, ...(activation_detail ? { activation_detail } : {}) });

const run = (frames: (DaemonStatus | null)[], start = EMPTY_LATCH) =>
  frames.reduce((latch, f) => latchActivation(latch, f), start);

describe("refused arm on 0003, 2026-11-05 13:03:58", () => {
  // Measured sequence: blocked at 0.0 s, disarming at 0.3 s, inactive at 1.8 s;
  // the robot keeps re-sending the blocker text on every frame.
  const sequence = [
    frame("inactive", IDLE),
    frame("physical_blocked", BLOCKER),
    frame("disarming", BLOCKER),
    frame("inactive", BLOCKER),
  ];

  it("keeps the blocker after the robot settles to inactive", () => {
    expect(latchedDetail(run(sequence))).toBe(BLOCKER);
  });

  it("survives the 3 s rebroadcast of the same inactive frame", () => {
    const latch = run([...sequence, frame("inactive", BLOCKER), frame("inactive", BLOCKER)]);
    expect(latchedDetail(latch)).toBe(BLOCKER);
  });

  it("survives a second attempt that is refused the same way", () => {
    const latch = run([...sequence, frame("inactive", BLOCKER, true), ...sequence.slice(1)]);
    expect(latchedDetail(latch)).toBe(BLOCKER);
  });

  it("clears once an arm succeeds", () => {
    const latch = run([...sequence, frame("arming", "guarded activation started"), frame("active")]);
    expect(latchedDetail(latch)).toBe("");
    expect(latch).toEqual(EMPTY_LATCH);
  });

  it("clears when the session ends", () => {
    expect(run([...sequence, null])).toEqual(EMPTY_LATCH);
  });

  it("does not latch transitional or nominal detail", () => {
    expect(latchedDetail(run([frame("inactive", IDLE), frame("arming", "guarded activation started")]))).toBe("");
  });

  it("replaces the cause when a different joint is named", () => {
    const other = "the left shoulder roll joint is parked ~2.0° past its lower limit — nudge it toward center and retry";
    const latch = run([...sequence, frame("physical_blocked", other), frame("inactive", other)]);
    expect(latchedDetail(latch)).toBe(other);
  });
});

describe("dismiss", () => {
  const blocked = run([frame("physical_blocked", BLOCKER), frame("inactive", BLOCKER)]);

  it("hides the dismissed text, including its later rebroadcasts", () => {
    const latch = run([frame("inactive", BLOCKER), frame("inactive", BLOCKER)], dismissLatch(blocked));
    expect(latchedDetail(latch)).toBe("");
  });

  it("re-shows when a different cause arrives", () => {
    const other = "could not hear servo 4 on the left bus — check the arm cable";
    const latch = run([frame("physical_blocked", other)], dismissLatch(blocked));
    expect(latchedDetail(latch)).toBe(other);
  });

  it("does not re-show the same refused arm a second time", () => {
    const latch = run([frame("physical_blocked", BLOCKER), frame("inactive", BLOCKER)], dismissLatch(blocked));
    expect(latchedDetail(latch)).toBe("");
  });

  it("dismissing nothing stays empty", () => {
    expect(latchedDetail(dismissLatch(EMPTY_LATCH))).toBe("");
  });
});
