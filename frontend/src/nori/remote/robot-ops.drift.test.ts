// NORI: drift guard for the robot command vocabulary (@nori/sdk robot-ops.ts).
//
// The manifest (ROBOT_OPS) is the single source the LLM tool schemas + API-reference prose are
// generated from. This test makes drift LOUD instead of silent: if someone adds/renames/removes a
// ScriptDriver op or an agent tool without updating the manifest, CI fails here — the manifest can
// no longer quietly fall out of step with what the robot actually executes.
//
// The executor/agent dispatch tables are `switch` statements, not data, so we read their source and
// extract the `case "…":` labels — the real, running vocabulary — and set-compare BOTH directions
// against the manifest. We also golden-compare the committed robot-tools.json (what LeLab's Python
// reads) against a fresh render; regenerate it with:  UPDATE_ROBOT_TOOLS=1 npx vitest run robot-ops.drift

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ROBOT_OPS,
  buildRobotToolsBundle,
  driverOps,
  agentToolNames,
  agentMotionTools,
} from "@nori/sdk";

const ROBOT_TOOLS_JSON = new URL("../../../packages/nori-sdk/robot-tools.json", import.meta.url);

// Pull `case "x":` labels out of the named method's body (delimited by the next method), so we scope
// to the ONE switch we mean and don't pick up cases from unrelated code.
function caseLabels(fileUrl: URL, from: string, until: string): string[] {
  const src = readFileSync(fileUrl, "utf8");
  const start = src.indexOf(from);
  if (start < 0) throw new Error(`marker not found: ${from}`);
  const end = src.indexOf(until, start);
  const body = src.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/case "(\w+)":/g)].map((m) => m[1]);
}

const sorted = (a: string[]) => [...a].sort();

describe("robot-ops manifest ↔ executor/agent dispatch", () => {
  it("every ScriptDriver.exec case is in the manifest, and vice versa", () => {
    const execCases = caseLabels(
      new URL("./ScriptDriver.ts", import.meta.url),
      "exec(op",
      "private enqueue",
    );
    // Both directions: a new driver op with no manifest entry, OR a manifest driverOp that no longer
    // dispatches, both fail here.
    expect(sorted(driverOps())).toEqual(sorted(execCases));
  });

  it("every agent tool is dispatched in AgentSession, and vice versa", () => {
    const execToolCases = caseLabels(
      new URL("./AgentSession.ts", import.meta.url),
      "private async execTool",
      "private async doLook",
    );
    // look is handled by execTool ("look" case → doLook); done/give_up are loop control handled in
    // loop() (b.name === "done"|"give_up"), not execTool — so add them to the dispatched set.
    const dispatched = new Set([...execToolCases, "done", "give_up"]);
    expect(sorted([...dispatched])).toEqual(sorted(agentToolNames()));
  });

  it("manifest motion tools match AgentSession MOTION_TOOLS", () => {
    const src = readFileSync(new URL("./AgentSession.ts", import.meta.url), "utf8");
    const literal = src.match(/MOTION_TOOLS = new Set\(\[([^\]]*)\]/)![1];
    const motion = [...literal.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(sorted(agentMotionTools())).toEqual(sorted(motion));
  });

  it("every manifest capability exposes at least one surface", () => {
    const orphans = ROBOT_OPS.filter((o) => !o.agent && !o.codegen).map((o) => o.cap);
    expect(orphans).toEqual([]);
  });

  it("robot-tools.json is up to date with the manifest", () => {
    const fresh = JSON.stringify(buildRobotToolsBundle(), null, 2) + "\n";
    if (process.env.UPDATE_ROBOT_TOOLS) {
      writeFileSync(ROBOT_TOOLS_JSON, fresh);
      return;
    }
    const committed = readFileSync(ROBOT_TOOLS_JSON, "utf8");
    expect(committed).toBe(fresh); // stale? run: UPDATE_ROBOT_TOOLS=1 npx vitest run robot-ops.drift
  });
});

// ---- descriptor-driven joint vocabulary (H2) --------------------------------------------
// The static rendering above is the L2 legacy view (what robot-tools.json ships for LeLab's
// L2-era server path). A LIVE session rebuilds move_to from the connected robot's descriptor,
// so an A3 agent is taught elbow_pitch and friends instead of six joints it doesn't have.

import { buildAgentTools, jointDofsFor, L2_JOINT_DOFS, type RobotDescriptor } from "@nori/sdk";

const A3_JOINTS = [
  "shoulder_pitch", "shoulder_roll", "bicep_yaw", "elbow_pitch",
  "forearm_yaw", "wrist_pitch", "wrist_roll", "gripper",
];
const A3_DESCRIPTOR: RobotDescriptor = {
  joints: ["left", "right"].flatMap((s) => A3_JOINTS.map((j) => `${s}_arm_${j}.pos`)),
  base: ["x.vel", "theta.vel"],
  aux: ["lift"],
  cameras: ["front"],
  ranges: {},
};

describe("descriptor-driven joint vocabulary", () => {
  it("jointDofsFor: descriptor wins; L2 set is ONLY the no-descriptor fallback", () => {
    expect(jointDofsFor(undefined, "right")).toEqual([...L2_JOINT_DOFS]);
    expect(jointDofsFor(A3_DESCRIPTOR, "right")).toEqual(A3_JOINTS);
    // A descriptor that lacks the arm yields [] — never a substituted vocabulary.
    expect(jointDofsFor({ joints: ["left_arm_gripper.pos"], ranges: {} } as RobotDescriptor, "right"))
      .toEqual([]);
  });

  it("buildAgentTools(descriptor) rewrites the move_to targets vocabulary", () => {
    const moveTo = buildAgentTools(A3_DESCRIPTOR).find((t) => t.name === "move_to")!;
    const desc = (moveTo.input_schema.properties as Record<string, { description: string }>)
      .targets.description;
    expect(desc).toContain("elbow_pitch");
    expect(desc).not.toContain("elbow_flex"); // the L2 joint an A3 doesn't have
  });

  it("buildAgentTools() with no descriptor is byte-identical to the static manifest", () => {
    expect(buildAgentTools()).toEqual(
      ROBOT_OPS.filter((o) => o.agent).map((o) => ({
        name: o.agent!.tool, description: o.agent!.summary, input_schema: o.agent!.input_schema,
      })),
    );
  });

  it("describes the runtime's multi-camera look requirement", () => {
    const look = buildAgentTools().find((tool) => tool.name === "look")!;
    expect(look.description).toContain("multiple roles");
    expect(look.description).toContain("MUST pass `camera`");
    const camera = (look.input_schema.properties as Record<string, { description: string }>).camera;
    expect(camera.description).toContain("required when the layout lists multiple roles");
  });
});
