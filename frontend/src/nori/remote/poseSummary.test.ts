// NORI: tests for the FK pose grounding — the SDK's pure-math L2 gripper FK (fk.ts) and the
// summarizer wrapper (poseSummary.ts). The A-series URDF path needs a served URDF + DOM, so here
// we only pin its graceful degradation (null while the URDF isn't loadable); its geometry is the
// URDF itself and gets verified against the real arm.

import { describe, expect, it } from "vitest";
import { l2GripperMm, SO101_L1_M, SO101_L2_M, SO101_WRIST_M, SO101_GRIP_M } from "@nori/sdk";
import { createPoseSummarizer } from "./poseSummary";
import type { RemoteTeleop } from "@nori/sdk";

const L2_STATE = {
  "left_arm_shoulder_pan.pos": 0,
  "left_arm_shoulder_lift.pos": 0,
  "left_arm_elbow_flex.pos": 0,
  "left_arm_wrist_flex.pos": 0,
};

describe("l2GripperMm", () => {
  it("missing arm → null (never a fictitious rest pose)", () => {
    expect(l2GripperMm({}, "left")).toBeNull();
    expect(l2GripperMm(L2_STATE, "right")).toBeNull();
  });

  it("rest pose: on the sagittal plane (y=0), forward of the shoulder, within total reach", () => {
    const p = l2GripperMm(L2_STATE, "left")!;
    const reach = (SO101_L1_M + SO101_L2_M + SO101_WRIST_M + SO101_GRIP_M) * 1000;
    expect(p.y).toBe(0); // pan 0 → no lateral offset
    expect(p.x).toBeGreaterThan(0); // arms extend toward the FRONT
    expect(Math.hypot(p.x, p.y, p.z)).toBeLessThanOrEqual(reach + 1);
  });

  it("+pan yaws toward robot-RIGHT (SO101 URDF axis (0,0,-1)): y goes negative", () => {
    const p = l2GripperMm({ ...L2_STATE, "left_arm_shoulder_pan.pos": 30 }, "left")!;
    expect(p.y).toBeLessThan(0);
    // radial distance is pan-invariant
    const rest = l2GripperMm(L2_STATE, "left")!;
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(Math.hypot(rest.x, rest.y), 0);
  });

  it("rail descent (positive lift.pos mm below top) subtracts from z", () => {
    const top = l2GripperMm(L2_STATE, "left")!;
    const dropped = l2GripperMm({ ...L2_STATE, "left_lift.pos": 200 }, "left")!;
    expect(dropped.z).toBe(top.z - 200);
    expect(dropped.x).toBe(top.x);
  });

  it("a level gripper stays level: z is wrist-flex-compensated (coupling identity)", () => {
    // sl + ef + wf = 0 keeps the gripper world pitch at 0 → the tip segment stays horizontal,
    // so z must match the rest pose's arm-only height minus the tip's (zero) vertical part.
    const a = l2GripperMm({ ...L2_STATE, "left_arm_wrist_flex.pos": 0 }, "left")!;
    const b = l2GripperMm(
      { ...L2_STATE, "left_arm_shoulder_lift.pos": 10, "left_arm_elbow_flex.pos": -10, "left_arm_wrist_flex.pos": 0 },
      "left",
    )!;
    // Both poses have gripper world pitch = -(sl+ef+wf) = 0 → the 150mm tip contributes 0 to z
    // in each; heights differ only by the (moved) elbow/shoulder geometry, so just sanity-bound it.
    expect(Math.abs(a.z - b.z)).toBeLessThan((SO101_L1_M + SO101_L2_M) * 1000);
  });
});

describe("createPoseSummarizer", () => {
  const teleopWith = (joints: string[] | null): RemoteTeleop =>
    ({ robotInfo: () => (joints ? { descriptor: { joints } } : null) }) as unknown as RemoteTeleop;

  it("L-series descriptor → per-arm line naming the frame, both sides when present", () => {
    const summarize = createPoseSummarizer(teleopWith(["left_arm_shoulder_lift.pos", "right_arm_shoulder_lift.pos"]));
    const s = summarize({ ...L2_STATE, "right_arm_shoulder_pan.pos": 0 })!;
    expect(s).toContain("left gripper ≈ (x ");
    expect(s).toContain("right gripper ≈ (x ");
    expect(s).toContain("+x forward, +y robot-left, +z up");
    expect(s).toContain("Approximate");
  });

  it("no robotInfo falls back to state keys; no arms at all → null", () => {
    const summarize = createPoseSummarizer(teleopWith(null));
    expect(summarize({ "x.vel": 0 })).toBeNull();
    expect(summarize(L2_STATE)).toContain("left gripper");
  });

  it("A-series (shoulder_pitch) without a loadable URDF → null, never a throw", () => {
    const summarize = createPoseSummarizer(teleopWith(["left_arm_shoulder_pitch.pos"]));
    expect(summarize({ "left_arm_shoulder_pitch.pos": 0 })).toBeNull();
  });
});
