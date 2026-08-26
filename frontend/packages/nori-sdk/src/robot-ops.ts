// NORI: single source of truth for the robot COMMAND VOCABULARY exposed to the LLM.
//
// Three surfaces speak slightly different dialects of the SAME capabilities:
//   * executor  — ScriptDriver.exec(op) switch cases (frontend/src/nori/remote/ScriptDriver.ts):
//                 the ground-truth dispatch that actually moves the robot.
//   * codegen   — the injected `robot.*` JS API (scriptWorker.ts + primitives.ts) the Coding page
//                 generates against.
//   * agent     — the Anthropic tool schemas the Tier-1.5 vision loop calls (AgentSession.ts).
//
// Historically each of these was mirrored BY HAND in lelab/server.py (NORI_AGENT_TOOLS + the
// "THE ROBOT / TOOLS" and "THE ROBOT API" prose), with only a "keep in sync" comment guarding
// drift. This file makes the vocabulary declarative: each ROBOT_OPS entry names a capability once
// and records how (if at all) it appears on each surface, so the tool schemas + the API reference
// blocks can be GENERATED from here. LeLab's Python reads the generated robot-tools.json; the
// frontend imports these helpers directly. Change an op here → regenerate → the executor drift test
// and the LLM context move together (see robot-ops.drift.test.ts).
//
// DOF vocabularies are deliberately NOT re-listed — task/base derive from TASK_KEYS/BASE_KEYS
// (gateway-static vocabularies), and the JOINT vocabulary is rebuilt from the LIVE descriptor
// once the ack arrives (buildAgentTools(descriptor); ScriptDriver validates the same way), so
// neither can drift from what the connected robot accepts. The static JOINT_DOFS below is the
// L2 legacy rendering only — it is what robot-tools.json ships (LeLab's Python drives the
// L2-era stack) and what a session without a descriptor falls back to, per the spec's
// discovery rules (MODELS.md: the no-descriptor fallback is the ONLY legitimate hardcoded
// joint list).

import { TASK_KEYS, JOINT_KEYS, BASE_KEYS, jointDofsFor, taskKeymapFor } from "./teleop";
import type { RobotDescriptor } from "./teleop";

// Unique DOF names per mode, in declaration order, from the same keybind maps the jog stream uses.
const dofNames = (m: Record<string, [string, number]>): string[] => [
  ...new Set(Object.values(m).map(([dof]) => dof)),
];

/** Cylindrical (task-space) DOFs a `reach` accepts — derived from TASK_KEYS. */
export const REACH_DOFS = dofNames(TASK_KEYS);
/**
 * Task-space DOFs `reach` accepts on THIS robot — resolved from the live descriptor the same
 * way jointDofsFor resolves joints (branch on descriptor, never on model). With
 * descriptor.jog_scale.task advertised (A3) that is the cartesian vocabulary (yaw canonical,
 * z included); no descriptor / no task scale (every L2) yields exactly REACH_DOFS.
 */
export function reachDofsFor(descriptor: RobotDescriptor | undefined | null): string[] {
  return dofNames(taskKeymapFor(descriptor));
}
/** Per-joint DOFs `joint`/`move_to` accept — derived from JOINT_KEYS. */
export const JOINT_DOFS = dofNames(JOINT_KEYS);
/** Mobile-base DOFs `base` accepts — derived from BASE_KEYS. */
export const BASE_DOFS = dofNames(BASE_KEYS);

// ---- types -------------------------------------------------------------------

/** How a capability is exposed as an Anthropic tool to the agent loop. */
export interface AgentSurface {
  /** Anthropic tool name (what the model calls, dispatched in AgentSession.execTool). */
  tool: string;
  /** `description` sent to the model. */
  summary: string;
  /** Anthropic `input_schema` (JSON Schema). Kept verbatim-equal to the shipped schema. */
  input_schema: Record<string, unknown>;
  /** True if this tool commands motion (trips confirm-before-first-motion; see MOTION_TOOLS). */
  motion: boolean;
}

/** How a capability is exposed on the codegen `nori.*` JS API (`robot` is a legacy alias). */
export interface CodegenSurface {
  /** Method name: `nori.<js>`. */
  js: string;
  /** Human signature for the API reference, e.g. "(side, targets, opts?)". */
  signature: string;
  /** One-line reference summary. */
  summary: string;
}

/** One robot capability and its per-surface exposure. */
export interface RobotOp {
  /** Stable capability id (surface-independent). */
  cap: string;
  /**
   * The ScriptDriver.exec(op) case this maps to, if any. Undefined for capabilities that don't go
   * through the driver: agent meta-tools (look/get_state/done/give_up) and composed codegen
   * primitives (home/stow/…). The drift test asserts every defined driverOp is a real exec case.
   */
  driverOp?: string;
  agent?: AgentSurface;
  codegen?: CodegenSurface;
}

// ---- the manifest ------------------------------------------------------------
//
// Ordering follows the agent tool list (the LLM-facing order). Agent `input_schema`/`summary` are
// copied VERBATIM from lelab/server.py NORI_AGENT_TOOLS so switching LeLab to the generated JSON is a
// zero-diff change to the model prompt.

export const ROBOT_OPS: RobotOp[] = [
  {
    cap: "look",
    // Agent-only: served by AgentSession.doLook via teleop.snapshot(), not a ScriptDriver op.
    agent: {
      tool: "look",
      motion: false,
      summary:
        "Capture a fresh still from one robot camera. Use before and after acting to verify the " +
        "effect. Your only visual input. When the \"Camera layout\" context lists multiple roles, " +
        "you MUST pass `camera` with one of those role names (for example, \"overhead\" or " +
        "\"left_wrist\"); bare `look` returns an error naming the valid roles. On a single-camera " +
        "robot, omit `camera`. An unknown role returns an error, not an image. Arms can be easily " +
        "moved to get different view angles of the scene.",
      input_schema: {
        type: "object",
        properties: {
          camera: {
            type: "string",
            description:
              "camera role from the layout; required when the layout lists multiple roles, " +
              "otherwise omit it for a single-camera robot",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    cap: "get_state",
    // Agent-only meta: AgentSession returns lastTelemetry.state directly. The codegen sibling is the
    // `telemetry` capability below (richer object). Same proprioception, different surface + shape.
    agent: {
      tool: "get_state",
      motion: false,
      summary: "Current joint positions + lift + base (proprioception, normalized). No image.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    cap: "move_absolute",
    driverOp: "moveTo",
    agent: {
      tool: "move_to",
      motion: true,
      summary:
        "Move one arm's joints to ABSOLUTE normalized targets and WAIT for arrival. Returns " +
        "done|blocked|clamped|timeout. Best for 'go to pose X'.",
      input_schema: {
        type: "object",
        required: ["side", "targets"],
        additionalProperties: false,
        properties: {
          side: { enum: ["left", "right"] },
          targets: {
            type: "object",
            additionalProperties: { type: "number" },
            description:
              'subset of {shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper} -> target, e.g. {"shoulder_pan": 30, "gripper": 0}',
          },
          slew: { type: "number", description: "optional units/sec, capped" },
        },
      },
    },
    codegen: {
      js: "moveTo",
      signature: "(side, targets, opts?)",
      summary:
        "Absolute joint move: go to a pose and HOLD it (not timed). Returns 'done' | 'blocked' | " +
        "'timeout'. Best tool for 'go to pose X'.",
    },
  },
  {
    cap: "reach",
    driverOp: "reach",
    agent: {
      tool: "reach",
      motion: true,
      summary:
        "Task-space (cylindrical) jog held for ms, then stopped. Timed and open-loop — use short " +
        "pulses and re-look.",
      input_schema: {
        type: "object",
        required: ["side", "dofs", "ms"],
        additionalProperties: false,
        properties: {
          side: { enum: ["left", "right"] },
          dofs: {
            type: "object",
            additionalProperties: { type: "number" },
            description:
              "subset of the robot's advertised task DOFs (yaw is canonical, shoulder_pan is a deprecated alias), each a rate in [-1,1]; +x forward, +y left, +z up",
          },
          ms: { type: "number" },
        },
      },
    },
    codegen: {
      js: "reach",
      signature: "(side, dofs, ms)",
      summary:
        "Task-space jog via IK. dofs: a subset of the robot's advertised task DOFs (yaw is " +
        "canonical, shoulder_pan is a deprecated alias), each a rate in [-1,1]; +x forward, " +
        "+y left, +z up. Held ms, then zeroed.",
    },
  },
  {
    cap: "joint",
    driverOp: "joint",
    // Codegen-only: the agent loop deliberately steers with move_to/reach, not raw per-joint jog.
    codegen: {
      js: "joint",
      signature: "(side, dofs, ms)",
      summary:
        "Per-motor jog (no IK). dofs subset of {shoulder_pan, shoulder_lift, elbow_flex, " +
        "wrist_flex, wrist_roll, gripper}, each a rate in [-1,1].",
    },
  },
  {
    cap: "grip",
    driverOp: "grip",
    agent: {
      tool: "grip",
      motion: true,
      summary: "Open or close the gripper on one arm.",
      input_schema: {
        type: "object",
        required: ["side", "action"],
        additionalProperties: false,
        properties: {
          side: { enum: ["left", "right"] },
          action: { enum: ["open", "close"] },
        },
      },
    },
    codegen: { js: "grip", signature: '(side, "open"|"close")', summary: "Convenience gripper open/close." },
  },
  {
    cap: "base",
    driverOp: "base",
    agent: {
      tool: "base",
      motion: true,
      summary:
        "Drive the mobile base for ms. linear (+forward) and angular (+turn left), rates in " +
        "[-1,1]. Open-loop, timed.",
      input_schema: {
        type: "object",
        required: ["ms"],
        additionalProperties: false,
        properties: {
          linear: { type: "number" },
          angular: { type: "number" },
          ms: { type: "number" },
        },
      },
    },
    codegen: {
      js: "base",
      signature: "(vec, ms)",
      summary: "Mobile base. vec: { linear, angular } in [-1,1]. +linear = forward, +angular = turn left.",
    },
  },
  {
    cap: "lift",
    driverOp: "lift",
    agent: {
      tool: "lift",
      motion: true,
      summary: "Raise/lower one arm's vertical rail for ms. dir in [-1,1], + = up. Open-loop, timed.",
      input_schema: {
        type: "object",
        required: ["side", "dir", "ms"],
        additionalProperties: false,
        properties: {
          side: { enum: ["left", "right"] },
          dir: { type: "number" },
          ms: { type: "number" },
        },
      },
    },
    codegen: {
      js: "lift",
      signature: "(side, dir, ms)",
      summary: "Raise/lower that arm's vertical rail. dir in [-1,1], + = up.",
    },
  },
  {
    cap: "wait",
    driverOp: "wait",
    agent: {
      tool: "wait",
      motion: false,
      summary: "Hold position for ms.",
      input_schema: {
        type: "object",
        required: ["ms"],
        additionalProperties: false,
        properties: { ms: { type: "number" } },
      },
    },
    codegen: { js: "wait", signature: "(ms)", summary: "Hold position (the 50 Hz keep-alive continues)." },
  },
  {
    cap: "play_audio",
    driverOp: "playAudio",
    agent: {
      tool: "play_audio",
      motion: false,
      summary:
        "Play a short audio clip on the robot's speaker from a URL (CORS-enabled https:// or a " +
        "data: URL to an audio file; clips only, not live streams). Returns ok or an error.",
      input_schema: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            description: "https:// (CORS-enabled) or data: URL to an audio file",
          },
        },
      },
    },
    codegen: {
      js: "playAudio",
      signature: "(url)",
      summary: "Stream an audio clip (blob/data/https) to the robot speaker; resolves when playback ends.",
    },
  },
  {
    cap: "done",
    // Agent-only loop control (handled in AgentSession.loop, not dispatched to the driver).
    agent: {
      tool: "done",
      motion: false,
      summary: "The goal is achieved. Ends the run.",
      input_schema: {
        type: "object",
        required: ["summary"],
        additionalProperties: false,
        properties: { summary: { type: "string" } },
      },
    },
  },
  {
    cap: "give_up",
    agent: {
      tool: "give_up",
      motion: false,
      summary: "The goal can't be done safely or at all. Ends the run.",
      input_schema: {
        type: "object",
        required: ["reason"],
        additionalProperties: false,
        properties: { reason: { type: "string" } },
      },
    },
  },
  // ---- codegen-only capabilities (no agent tool) -----------------------------
  {
    cap: "telemetry",
    driverOp: "telemetry",
    codegen: {
      js: "telemetry",
      signature: "()",
      summary:
        "-> { loopHz, safety, tempC, state:{...}, currents:{...} } or null. Proprioceptive only " +
        "(joint positions + currents). NO camera/vision.",
    },
  },
  {
    cap: "perceive",
    driverOp: "perceive",
    codegen: {
      js: "perceive",
      signature: "()",
      summary:
        "-> structured world-state from the on-Pi detector (or null if none). Lets a script react " +
        "to what the robot sees.",
    },
  },
  {
    cap: "reset",
    driverOp: "reset",
    codegen: {
      js: "reset",
      signature: "()",
      summary:
        "Re-sync the IK task cursor to current joint positions. Call before a reach() that follows " +
        "any joint() move.",
    },
  },
  {
    cap: "estop",
    driverOp: "estop",
    codegen: {
      js: "estop",
      signature: "()",
      summary: "Emergency latch (the on-screen button is the primary path).",
    },
  },
  {
    cap: "log",
    // Codegen helper resolved inside the worker (postMessage), not a ScriptDriver op.
    codegen: {
      js: "log",
      signature: "(...args)",
      summary: "Print to the operator's run-output panel.",
    },
  },
  // ---- composed codegen primitives (installPrimitives; no driver op) ----------
  { cap: "home", codegen: { js: "home", signature: "(side)", summary: "Move the arm to a neutral straight pose and hold." } },
  { cap: "stow", codegen: { js: "stow", signature: "(side)", summary: "Move the arm to a compact parked pose and hold." } },
  { cap: "gripSequence", codegen: { js: "gripSequence", signature: "(side)", summary: "Open, pause, then close the gripper (a simple pick)." } },
  { cap: "wave", codegen: { js: "wave", signature: "(side, times=3)", summary: "Wave the wrist." } },
];

// ---- derived views (consumed by LeLab via robot-tools.json, and by the frontend directly) ----

// The live joint vocabulary rendered for the move_to schema. One list when both arms match
// (the common case), per-arm lists when a descriptor is asymmetric — the LLM must never be
// taught a joint that only exists on the other arm.
function jointTargetsDescription(descriptor: RobotDescriptor): string {
  const left = jointDofsFor(descriptor, "left");
  const right = jointDofsFor(descriptor, "right");
  const example = (dofs: string[]) => {
    const first = dofs.find((d) => d !== "gripper") ?? dofs[0] ?? "gripper";
    return dofs.includes("gripper")
      ? `{"${first}": 30, "gripper": 0}`
      : `{"${first}": 30}`;
  };
  if (left.join(",") === right.join(",")) {
    return `subset of {${left.join(", ")}} -> target, e.g. ${example(left)}`;
  }
  return (
    `per-arm vocabulary: left arm subset of {${left.join(", ")}}; ` +
    `right arm subset of {${right.join(", ")}} -> target, e.g. ${example(right)}`
  );
}

/**
 * The Anthropic tools array — drop-in for lelab/server.py NORI_AGENT_TOOLS.
 *
 * Pass the CONNECTED robot's descriptor (RobotInfo.descriptor, from the ack) so the move_to
 * schema teaches the joints this robot actually has — without it the L2 legacy vocabulary is
 * rendered, which on an A3 names six joints that don't exist while omitting the seven that do
 * (every hallucinated call then costs a round-trip unknown_joint refusal).
 */
export function buildAgentTools(
  descriptor?: RobotDescriptor | null,
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return ROBOT_OPS.filter((o) => o.agent).map((o) => {
    let schema = o.agent!.input_schema;
    if (descriptor && o.agent!.tool === "move_to") {
      const props = schema.properties as Record<string, Record<string, unknown>>;
      schema = {
        ...schema,
        properties: {
          ...props,
          targets: { ...props.targets, description: jointTargetsDescription(descriptor) },
        },
      };
    }
    return {
      name: o.agent!.tool,
      description: o.agent!.summary,
      input_schema: schema,
    };
  });
}

/** Tool names that command motion (mirror of AgentSession MOTION_TOOLS). */
export function agentMotionTools(): string[] {
  return ROBOT_OPS.filter((o) => o.agent?.motion).map((o) => o.agent!.tool);
}

/** Every ScriptDriver.exec case named by the manifest (for the executor drift test). */
export function driverOps(): string[] {
  return ROBOT_OPS.filter((o) => o.driverOp).map((o) => o.driverOp!);
}

/** Every agent tool name (for the AgentSession dispatch drift test). */
export function agentToolNames(): string[] {
  return ROBOT_OPS.filter((o) => o.agent).map((o) => o.agent!.tool);
}

/** Render the "THE ROBOT / TOOLS" reference block for the agent system prompt. */
export function renderAgentToolsRef(): string {
  return ROBOT_OPS.filter((o) => o.agent)
    .map((o) => `  ${o.agent!.tool.padEnd(11)}${o.agent!.summary}`)
    .join("\n");
}

/** Render the "THE ROBOT API" reference block for the codegen system prompt. */
export function renderCodegenApiRef(): string {
  return ROBOT_OPS.filter((o) => o.codegen)
    .map((o) => `  nori.${o.codegen!.js}${o.codegen!.signature}  ${o.codegen!.summary}`)
    .join("\n");
}

/**
 * The full generated bundle LeLab's Python reads (robot-tools.json). Stable key order + the derived
 * DOF lists (resolved here so Python doesn't need the SDK's TS). The drift test golden-compares the
 * committed file against this.
 */
export function buildRobotToolsBundle(): Record<string, unknown> {
  return {
    tools: buildAgentTools(),
    motionTools: agentMotionTools(),
    dofs: { reach: REACH_DOFS, joint: JOINT_DOFS, base: BASE_DOFS },
    agentToolsRef: renderAgentToolsRef(),
    codegenApiRef: renderCodegenApiRef(),
  };
}
