// Descriptor-driven per-motor jog (L3): the keymap derives from the robot's
// ack descriptor when — and only when — it advertises joints outside the L2
// vocabulary. Every L2 shape must fall back to the legacy JOINT_KEYS
// untouched, so deployed L2 units behave byte-identically.
import { describe, expect, it } from "vitest";

import {
  JOINT_KEYS,
  jointKeymapForShorts,
  keybindLegend,
  l3JointShorts,
} from "@nori/sdk";

const L3_DESCRIPTOR = {
  joints: [
    "right_arm_bicep_yaw.pos",
    "right_arm_elbow_pitch.pos",
    "right_arm_forearm_yaw.pos",
    "right_arm_gripper.pos",
    "right_arm_shoulder_pitch.pos",
    "right_arm_shoulder_roll.pos",
    "right_arm_wrist_pitch.pos",
    "right_arm_wrist_roll.pos",
  ],
  base: ["x.vel", "theta.vel"],
};

const L2_DESCRIPTOR = {
  joints: [
    "right_arm_shoulder_pan.pos", "right_arm_shoulder_lift.pos",
    "right_arm_elbow_flex.pos", "right_arm_wrist_flex.pos",
    "right_arm_wrist_roll.pos", "right_arm_gripper.pos",
  ],
};

describe("l3JointShorts", () => {
  it("extracts L3 shorts in anatomical order, gripper excluded", () => {
    expect(l3JointShorts(L3_DESCRIPTOR, "right")).toEqual([
      "shoulder_pitch", "shoulder_roll", "bicep_yaw", "elbow_pitch",
      "forearm_yaw", "wrist_pitch", "wrist_roll",
    ]);
  });

  it("returns null for the L2 vocabulary (legacy map preserved)", () => {
    expect(l3JointShorts(L2_DESCRIPTOR, "right")).toBeNull();
  });

  it("returns null with no descriptor (old daemons)", () => {
    expect(l3JointShorts(undefined, "right")).toBeNull();
    expect(l3JointShorts({}, "right")).toBeNull();
  });

  it("returns null for the arm the descriptor does not cover", () => {
    expect(l3JointShorts(L3_DESCRIPTOR, "left")).toBeNull();
  });
});

describe("jointKeymapForShorts", () => {
  const shorts = l3JointShorts(L3_DESCRIPTOR, "right")!;
  const map = jointKeymapForShorts(shorts);

  it("maps 7 joints + gripper onto 8 non-colliding key pairs", () => {
    expect(Object.keys(map)).toHaveLength(16);
    expect(map.q).toEqual(["shoulder_pitch", 1]);
    expect(map.a).toEqual(["shoulder_pitch", -1]);
    expect(map.z).toEqual(["wrist_roll", 1]);
    expect(map.b).toEqual(["gripper", 1]);
    expect(map.n).toEqual(["gripper", -1]);
  });

  it("never claims base (ikjl), lift (uo), mode (m) or command keys", () => {
    for (const reserved of ["i", "k", "j", "l", "u", "o", "m", "p", "c", " "]) {
      expect(map[reserved]).toBeUndefined();
    }
  });

  it("gripper keeps the last pair even with >7 joints advertised", () => {
    const crowded = jointKeymapForShorts(
      [...shorts, "extra_1", "extra_2"]);
    expect(crowded.b).toEqual(["gripper", 1]);
  });
});

describe("keybindLegend", () => {
  it("without shorts renders the legacy joint legend (L2 unchanged)", () => {
    const legacy = keybindLegend("joint");
    const dofs = legacy.arm.map((r) => r.dof);
    expect(dofs).toContain("shoulder_pan");
    expect(dofs).not.toContain("shoulder_pitch");
  });

  it("with shorts renders the dynamic rows the jog stream uses", () => {
    const legend = keybindLegend(
      "joint", l3JointShorts(L3_DESCRIPTOR, "right"));
    const dofs = legend.arm.map((r) => r.dof);
    expect(dofs).toContain("shoulder_pitch");
    expect(dofs).toContain("gripper");
    expect(dofs).not.toContain("shoulder_pan");
  });

  it("cylindrical mode ignores shorts (task keys are robot-interpreted)", () => {
    const legend = keybindLegend(
      "cylindrical", l3JointShorts(L3_DESCRIPTOR, "right"));
    expect(legend.arm.map((r) => r.dof)).toContain("x");
  });
});
