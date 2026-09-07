// NORI: Additive file. Key derivation for the mobile touch pad (pages/mobile.tsx).
//
// The pad presses the SAME keys the keyboard does (teleop.holdKey / releaseKey), so
// everything here is derived from the SDK's exported keymaps — there is no second
// vocabulary that could drift from what the wire actually carries (same rule as the
// desktop control legend).

import {
  type RobotDescriptor, taskKeymapFor, baseKeyClusters, ZLIFT_KEYS,
} from "@nori/sdk";

export interface PadAxis {
  dof: string;       // wire DOF name, e.g. "x"
  label: string;     // what the buttons say
  posKey: string;    // key held for +
  negKey: string;    // key held for -
  posLabel: string;  // caption on the + button
  negLabel: string;
}

// Base drive cluster (the primary IJKL inverted-T; WASD is only an alias).
export interface BasePad { forward: string; back: string; left: string; right: string }

export function basePad(): BasePad {
  const c = baseKeyClusters()[0];
  return { forward: c.forward, back: c.back, left: c.left, right: c.right };
}

// Lift (u/o). Derived from ZLIFT_KEYS so the signs can't be transposed by hand.
export function liftPad(): { upKey: string; downKey: string } {
  const [up, down] = Object.entries(ZLIFT_KEYS)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  return { upKey: up, downKey: down };
}

// Human captions for the task DOFs, in the order the pad shows them. A DOF absent
// from the robot's task keymap is simply not rendered — an L2 (legacy TASK_KEYS)
// has no `z`, and inventing a button for it would send a key the robot ignores.
const AXIS_META: Record<string, { label: string; pos: string; neg: string }> = {
  x:            { label: "reach (X)",  pos: "out",   neg: "in" },
  y:            { label: "side (Y)",   pos: "left",  neg: "right" },
  z:            { label: "height (Z)", pos: "up",    neg: "down" },
  yaw:          { label: "turn",       pos: "left",  neg: "right" },
  shoulder_pan: { label: "turn",       pos: "left",  neg: "right" },
  pitch:        { label: "pitch",      pos: "up",    neg: "down" },
  wrist_roll:   { label: "roll",       pos: "ccw",   neg: "cw" },
  gripper:      { label: "gripper",    pos: "open",  neg: "close" },
};
const AXIS_ORDER = ["x", "y", "z", "yaw", "shoulder_pan", "pitch", "wrist_roll", "gripper"];

// The task-space axes this robot accepts, ready to render. Task mode only: per-motor
// mode maps these same letters to individual joints, so the mobile page forces task
// mode before it shows the pad.
export function armPadAxes(descriptor: RobotDescriptor | null | undefined): PadAxis[] {
  const km = taskKeymapFor(descriptor);
  const byDof = new Map<string, { pos: string; neg: string }>();
  for (const [key, [dof, sign]] of Object.entries(km)) {
    const e = byDof.get(dof) ?? { pos: "", neg: "" };
    if (sign > 0) e.pos ||= key; else e.neg ||= key;
    byDof.set(dof, e);
  }
  const out: PadAxis[] = [];
  for (const dof of AXIS_ORDER) {
    const keys = byDof.get(dof);
    const meta = AXIS_META[dof];
    if (!keys || !meta || !keys.pos || !keys.neg) continue;
    out.push({
      dof, label: meta.label, posKey: keys.pos, negKey: keys.neg,
      posLabel: meta.pos, negLabel: meta.neg,
    });
  }
  return out;
}

// Split for layout: X/Y drive the thumb d-pad, everything else stacks as ± rows.
export function splitArmAxes(axes: PadAxis[]): { pad: PadAxis[]; rows: PadAxis[] } {
  return {
    pad: axes.filter((a) => a.dof === "x" || a.dof === "y"),
    rows: axes.filter((a) => a.dof !== "x" && a.dof !== "y"),
  };
}
