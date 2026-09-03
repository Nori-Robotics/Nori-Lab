// NORI: Additive file. The arm/disarm sequencing behind the ArmControl block
// (remote/layout/blocks.tsx), split out so it is unit-testable in node — the
// block itself is JSX and drags the whole telemetry/3D import chain with it.
//
// Two robot-reported fields disagree in TIME (bench, 2026-08-27):
//   daemon_status.armed       arbiter ownership — pushed the INSTANT it changes
//   daemon_status.activation  the motion stack's own state file — reaches
//                             "disarming" a second or two later, and "inactive"
//                             (torque actually off) 20-45 s after that
// So on disarm `armed: false` lands while the arms are still holding torque.
// Rendering it straight showed "disarmed" first and "disarming…" AFTER —
// backwards from the operator's mental model (reported 2026-08-27) and a
// safety-relevant lie about live torque. Everything here exists to hold the
// transitional label until the robot says the motion stack actually settled.

// Activation values that mean "moving between states" — never a resting place.
export const TRANSITIONAL = ["arming", "running", "disarming"];
// The only nominal resting states. Anything else non-transitional is a fault
// the operator has to clear (physical_blocked / configuration_fault / failed,
// or a state this build doesn't know yet).
export const NOMINAL = ["active", "inactive"];

export const isPreparing = (activation: string) => TRANSITIONAL.includes(activation);
export const isStuck = (activation: string) =>
  activation !== "" && !NOMINAL.includes(activation) && !isPreparing(activation);

// Has the robot caught up with the click? `armed` alone is not enough on the
// DISARM path: it flips a beat before the activation state even starts moving,
// so armed=false while activation is still "active" is the race window, not a
// resting place — hold. Arming settles on "active": that IS its terminal.
// A gateway that reports `armed` but no `activation` sends "" and settles on
// `armed` alone, exactly as this control behaved before the field existed.
// Fault states settle too — they are terminal, and "blocked" plus the robot's
// verbatim detail is the honest render, not a spinner that never ends.
export function isSettled(target: boolean, armed: boolean, activation: string): boolean {
  if (armed !== target) return false;
  if (isPreparing(activation)) return false;
  return target || activation !== "active";
}

// The `motors: …` chip. Order matters: a click still in flight outranks
// everything (it is the whole point of the lock), then the robot's own
// transitions, and only a settled robot gets to say ARMED / disarmed.
export function motorsLabel(o: {
  pendingTarget: boolean | null; armed: boolean; activation: string; enabled: boolean;
}): string {
  if (o.pendingTarget !== null && !isSettled(o.pendingTarget, o.armed, o.activation))
    return o.pendingTarget ? "arming…" : "disarming…";
  if (o.activation === "disarming") return "disarming…";
  if (isPreparing(o.activation)) return "preparing…";
  if (isStuck(o.activation)) return "blocked";
  if (!o.enabled) return "—";
  return o.armed ? "ARMED" : "disarmed";
}
