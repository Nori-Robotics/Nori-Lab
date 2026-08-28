// NORI: tests for the arm/disarm sequencing the ArmControl block renders (armPhase.ts).
//
// The regression under test (operator report, 2026-08-27): disarming showed
// "disarmed" immediately and "disarming…" a beat LATER, because the gateway
// pushes `armed: false` the instant arbiter ownership drops while the motion
// stack's activation file still says "active" — arms fully torqued.

import { describe, expect, it } from "vitest";
import { isSettled, isStuck, motorsLabel } from "./armPhase";

// A run of daemon_status frames as the block sees them, under one pending click.
type Step = { armed: boolean; activation: string };
const labels = (steps: Step[], pendingTarget: boolean | null) =>
  steps.map((s) => motorsLabel({
    pendingTarget,
    armed: s.armed,
    activation: s.activation,
    // enabled tracks the block: locked while pending or mid-transition. Only the
    // "—" branch reads it, and none of these steps reach it.
    enabled: true,
  }));

describe("disarm sequencing", () => {
  it("holds disarming… across the whole robot-side sequence, never flashing disarmed", () => {
    // The sequence off the bench: ownership drops instantly, the activation file
    // catches up a second or two later, torque is off 20-45 s after that.
    expect(labels([
      { armed: true, activation: "active" },    // click lands here
      { armed: false, activation: "active" },   // ownership released — the race window
      { armed: false, activation: "disarming" },
      { armed: false, activation: "disarming" }, // 3 s rebroadcasts, still torqued
      { armed: false, activation: "inactive" },  // torque actually off
    ], false)).toEqual(["disarming…", "disarming…", "disarming…", "disarming…", "disarmed"]);
  });

  it("armed:false with activation still active is NOT settled", () => {
    expect(isSettled(false, false, "active")).toBe(false);
    expect(isSettled(false, false, "disarming")).toBe(false);
    expect(isSettled(false, true, "inactive")).toBe(false); // ownership hasn't dropped
    expect(isSettled(false, false, "inactive")).toBe(true);
  });
});

describe("arming sequencing", () => {
  it("holds arming… until armed AND activation leaves the transitional set", () => {
    expect(labels([
      { armed: false, activation: "inactive" },
      { armed: true, activation: "arming" },
      { armed: true, activation: "running" },
      { armed: true, activation: "active" },
    ], true)).toEqual(["arming…", "arming…", "arming…", "ARMED"]);
    expect(isSettled(true, true, "running")).toBe(false);
    expect(isSettled(true, true, "active")).toBe(true);
  });
});

describe("no pending click", () => {
  it("renders the robot's own transitions as before — this is the timeout fallback too", () => {
    // pendingTarget null is both "nobody clicked" and "the 90 s lock expired":
    // whatever the robot last reported, unfinished or not.
    expect(labels([
      { armed: false, activation: "active" },    // torque on, ownership elsewhere
      { armed: false, activation: "disarming" },
      { armed: true, activation: "arming" },
      { armed: true, activation: "running" },
      { armed: false, activation: "inactive" },
      { armed: true, activation: "active" },
    ], null)).toEqual(["disarmed", "disarming…", "preparing…", "preparing…", "disarmed", "ARMED"]);
  });

  it("shows — when the control is greyed out", () => {
    expect(motorsLabel({ pendingTarget: null, armed: false, activation: "", enabled: false })).toBe("—");
  });
});

describe("stuck activation", () => {
  it("is terminal: the click's lock drops and the blocked chip wins", () => {
    expect(isStuck("physical_blocked")).toBe(true);
    expect(isStuck("configuration_fault")).toBe(true);
    expect(isStuck("failed")).toBe(true);
    expect(isStuck("some_state_this_build_predates")).toBe(true);
    expect(isStuck("active")).toBe(false);
    expect(isStuck("")).toBe(false); // gateway doesn't report activation at all
    expect(labels([{ armed: false, activation: "physical_blocked" }], false)).toEqual(["blocked"]);
  });
});

describe("gateway without an activation field", () => {
  it("settles on armed alone, exactly as before activation existed", () => {
    expect(labels([
      { armed: true, activation: "" },
      { armed: false, activation: "" },
    ], false)).toEqual(["disarming…", "disarmed"]);
    expect(isSettled(true, true, "")).toBe(true);
  });
});
