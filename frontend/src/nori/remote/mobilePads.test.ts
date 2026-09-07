// Pad derivation: the mobile buttons must send the keys the SDK's task keymap actually
// maps, and must NOT invent an axis the robot never advertised (L2 has no Z).
import { describe, it, expect } from "vitest";
import { TASK_KEYS, CARTESIAN_TASK_KEYS, type RobotDescriptor } from "@nori/sdk";
import { armPadAxes, basePad, liftPad, splitArmAxes } from "./mobilePads";

const A3: RobotDescriptor = { jog_scale: { task: { x: 1, y: 1, z: 1 } } } as unknown as RobotDescriptor;

describe("armPadAxes", () => {
  it("omits Z on a legacy (L2 / no descriptor) robot", () => {
    const dofs = armPadAxes(null).map((a) => a.dof);
    expect(dofs).toContain("x");
    expect(dofs).toContain("y");
    expect(dofs).not.toContain("z");
    expect(dofs).toContain("gripper");
  });

  it("exposes Z when the descriptor advertises a cartesian task jog", () => {
    const axes = armPadAxes(A3);
    const z = axes.find((a) => a.dof === "z");
    expect(z).toBeDefined();
    expect([z!.posKey, z!.negKey]).toEqual(["y", "h"]);
  });

  it("uses the SDK keymap's keys, not a private copy", () => {
    for (const [map, desc] of [[TASK_KEYS, null], [CARTESIAN_TASK_KEYS, A3]] as const) {
      for (const axis of armPadAxes(desc)) {
        expect(map[axis.posKey]).toEqual([axis.dof, 1]);
        expect(map[axis.negKey]).toEqual([axis.dof, -1]);
      }
    }
  });

  it("splits X/Y into the thumb pad and leaves the rest as rows", () => {
    const { pad, rows } = splitArmAxes(armPadAxes(A3));
    expect(pad.map((a) => a.dof)).toEqual(["x", "y"]);
    expect(rows.map((a) => a.dof)).not.toContain("x");
    expect(rows.map((a) => a.dof)).toContain("gripper");
  });
});

describe("base + lift pads", () => {
  it("uses the primary IJKL cluster, not the WASD alias", () => {
    expect(basePad()).toEqual({ forward: "i", back: "k", left: "j", right: "l" });
  });
  it("maps lift up/down from ZLIFT_KEYS signs", () => {
    expect(liftPad()).toEqual({ upKey: "u", downKey: "o" });
  });
});
