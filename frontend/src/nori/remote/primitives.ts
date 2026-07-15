// NORI: D2 primitive library (docs/llm_integration_plan.md). Small, named routines COMPOSED from
// the base `robot` API — the "harvest": recurring op sequences promoted into reusable primitives
// (and the seed for Tier-2 distilled behaviors). They run in the worker (installed onto the injected
// `robot`), so pasted/generated scripts call e.g. `await nori.home("left")`. Each logs a `[lib]`
// marker so you can observe which primitives scripts actually use.
//
// Poses are ABSOLUTE normalized targets ([-100,100]) and go through nori.moveTo (client-slewed +
// arrival-checked). Tune the pose constants on hardware.

// The subset of the base robot API these primitives build on.
export interface ScriptRobot {
  joint(side: "left" | "right", dofs: Record<string, number>, ms: number): Promise<unknown>;
  moveTo(
    side: "left" | "right",
    targets: Record<string, number>,
    opts?: { slew?: number; timeoutMs?: number },
  ): Promise<unknown>;
  grip(side: "left" | "right", action: "open" | "close"): Promise<unknown>;
  wait(ms: number): Promise<unknown>;
  log(...parts: unknown[]): void;
}

// The primitives added onto the robot by installPrimitives().
export interface Primitives {
  home(side: "left" | "right"): Promise<unknown>;
  stow(side: "left" | "right"): Promise<unknown>;
  gripSequence(side: "left" | "right"): Promise<void>;
  wave(side: "left" | "right", times?: number): Promise<void>;
}

// Neutral "arms out straight" pose — all body joints ~0. Gripper left as-is.
const HOME_POSE = { shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0 };
// Compact parked pose — elbow folded in, shoulder dropped. Conservative; tune on hardware.
const STOW_POSE = { shoulder_pan: 0, shoulder_lift: -30, elbow_flex: 60, wrist_flex: 0, wrist_roll: 0 };

export function installPrimitives(nori: ScriptRobot): void {
  const r = robot as ScriptRobot & Primitives;

  r.home = (side) => {
    nori.log(`[lib] home(${side})`);
    return nori.moveTo(side, HOME_POSE);
  };

  r.stow = (side) => {
    nori.log(`[lib] stow(${side})`);
    return nori.moveTo(side, STOW_POSE);
  };

  r.gripSequence = async (side) => {
    nori.log(`[lib] gripSequence(${side})`);
    await nori.grip(side, "open");
    await nori.wait(300);
    await nori.grip(side, "close");
  };

  r.wave = async (side, times = 3) => {
    nori.log(`[lib] wave(${side}, ${times})`);
    for (let i = 0; i < times; i++) {
      await nori.joint(side, { wrist_flex: 0.4 }, 400);
      await nori.joint(side, { wrist_flex: -0.4 }, 400);
    }
  };
}
