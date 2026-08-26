// Descriptor-gated task jog (A3 cartesian vocabulary): the task keymap, legend and mode
// label derive from descriptor.jog_scale.task — PRESENCE, never a model string. Every L2
// shape (no descriptor, or a descriptor without jog_scale.task) must fall back to the
// EXACT legacy TASK_KEYS object so deployed L2 units behave byte-identically.
import { describe, expect, it } from "vitest";

import {
  CARTESIAN_TASK_KEYS,
  REACH_DOFS,
  TASK_KEYS,
  keybindLegend,
  reachDofsFor,
  taskKeymapFor,
  taskModeLabel,
  type RobotDescriptor,
} from "@nori/sdk";

// A3-shaped descriptor: advertises a task jog vocabulary (yaw canonical, shoulder_pan
// still listed as the deprecated alias the gateway accepts).
const A3_DESCRIPTOR: RobotDescriptor = {
  joints: ["left_arm_shoulder_pitch.pos", "left_arm_elbow_pitch.pos", "left_arm_gripper.pos"],
  base: ["x.vel", "theta.vel"],
  aux: ["lift"],
  jog_scale: {
    task: { x: 0.2, y: 0.2, z: 0.15, pitch: 1.0, yaw: 1.2, shoulder_pan: 1.2 },
  },
};

// L2-shaped descriptor: has joints/ranges but no jog_scale.task (the deployed fleet
// never sends jog_scale at all).
const L2_DESCRIPTOR: RobotDescriptor = {
  joints: ["right_arm_shoulder_pan.pos", "right_arm_gripper.pos"],
  base: ["x.vel", "theta.vel"],
};

describe("taskKeymapFor", () => {
  it("no descriptor -> the EXACT legacy TASK_KEYS object (same reference, same content)", () => {
    expect(taskKeymapFor(undefined)).toBe(TASK_KEYS);
    expect(taskKeymapFor(null)).toBe(TASK_KEYS);
    expect(taskKeymapFor(null)).toEqual({
      q: ["shoulder_pan", 1], e: ["shoulder_pan", -1],
      w: ["x", 1], s: ["x", -1], a: ["y", 1], d: ["y", -1],
      z: ["pitch", 1], x: ["pitch", -1], r: ["wrist_roll", 1], f: ["wrist_roll", -1],
      t: ["gripper", 1], g: ["gripper", -1],
    });
  });

  it("descriptor without jog_scale.task (every L2) -> the same legacy object", () => {
    expect(taskKeymapFor(L2_DESCRIPTOR)).toBe(TASK_KEYS);
    expect(taskKeymapFor({ ...L2_DESCRIPTOR, jog_scale: { joints: {} } })).toBe(TASK_KEYS);
  });

  it("jog_scale.task advertised (A3) -> cartesian map: yaw + z present, shoulder_pan gone", () => {
    const map = taskKeymapFor(A3_DESCRIPTOR);
    expect(map).toBe(CARTESIAN_TASK_KEYS);
    const dofs = new Set(Object.values(map).map(([dof]) => dof));
    expect(dofs.has("yaw")).toBe(true);
    expect(dofs.has("z")).toBe(true);
    expect(dofs.has("shoulder_pan")).toBe(false);
    // q/e carry the canonical angular-z verb; y/h carry z.
    expect(map.q).toEqual(["yaw", 1]);
    expect(map.e).toEqual(["yaw", -1]);
    expect(map.y).toEqual(["z", 1]);
    expect(map.h).toEqual(["z", -1]);
  });

  it("cartesian keys never collide with base (ikjl), lift (uo) or command (m/space/p/c) keys", () => {
    const reserved = ["i", "k", "j", "l", "u", "o", "m", " ", "p", "c"];
    for (const k of reserved) expect(k in CARTESIAN_TASK_KEYS).toBe(false);
  });
});

describe("taskModeLabel", () => {
  it("is 'cylindrical' for L2 / unknown, 'cartesian' when jog_scale.task is advertised", () => {
    expect(taskModeLabel(undefined)).toBe("cylindrical");
    expect(taskModeLabel(null)).toBe("cylindrical");
    expect(taskModeLabel(L2_DESCRIPTOR)).toBe("cylindrical");
    expect(taskModeLabel(A3_DESCRIPTOR)).toBe("cartesian");
  });
});

describe("keybindLegend (task mode, descriptor-threaded)", () => {
  it("no descriptor -> legend identical to the legacy rendering", () => {
    expect(keybindLegend("cylindrical", null, null)).toEqual(keybindLegend("cylindrical"));
    const dofs = keybindLegend("cylindrical").arm.map((r) => r.dof);
    expect(dofs).toEqual(["shoulder_pan", "x", "y", "pitch", "wrist_roll", "gripper"]);
  });

  it("A3 descriptor -> legend shows yaw and z, not shoulder_pan", () => {
    const dofs = keybindLegend("cylindrical", null, A3_DESCRIPTOR).arm.map((r) => r.dof);
    expect(dofs).toContain("yaw");
    expect(dofs).toContain("z");
    expect(dofs).not.toContain("shoulder_pan");
  });

  it("joint mode is unaffected by the descriptor's task vocabulary", () => {
    expect(keybindLegend("joint", null, A3_DESCRIPTOR).arm)
      .toEqual(keybindLegend("joint").arm);
  });
});

describe("reachDofsFor", () => {
  it("no descriptor / L2 -> exactly the legacy REACH_DOFS", () => {
    expect(reachDofsFor(undefined)).toEqual(REACH_DOFS);
    expect(reachDofsFor(L2_DESCRIPTOR)).toEqual(REACH_DOFS);
  });

  it("A3 -> cartesian vocabulary with yaw/z, without shoulder_pan", () => {
    const dofs = reachDofsFor(A3_DESCRIPTOR);
    expect(dofs).toEqual(["yaw", "x", "y", "z", "pitch", "wrist_roll", "gripper"]);
  });
});
