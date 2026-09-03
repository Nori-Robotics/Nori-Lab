// NORI: arm/disarm — the ONE implementation, shared by every page that can command motion.
//
// Extracted from remote/layout/blocks.tsx (unchanged behaviour) when the Agent page needed it.
// It could not simply be imported: the original read teleop/running/daemonStatus from
// useRemoteUi(), the Remote page's own layout context, and throws outside that provider. So the
// component takes them as props and blocks.tsx keeps a thin `ArmControl` wrapper that supplies
// them from the context.
//
// It is DELIBERATELY not re-implemented per page. Arming energizes hardware; the truth-lag
// pending lock below exists because a free-running toggle sent the wrong verb off a stale label
// on a live robot (0003, 2026-08-27). A second copy of this control is a second chance to get
// that wrong.

import { useState } from "react";
import type { RemoteTeleop, DaemonStatus } from "@nori/sdk";
import { isPreparing, isSettled, isStuck, motorsLabel } from "@/nori/remote/armPhase";

// Longest a click's pending lock may hold before the control falls back to the
// robot's last report (see the lock comment inside ArmControl).
const SETTLE_TIMEOUT_MS = 90000;

// Bench-grade arm/disarm (2026-08-25). Renders ONLY robot-reported state
// (daemon_status.armed) — never the button press; hidden entirely on robots
// whose gateway doesn't report `armed`. Confirm dialogs are deliberate:
// arming energizes hardware, disarming lets gravity-loaded arms drop after
// the robot's idle timer. Customer-grade needs role gating + a real dialog.
export const ArmControlView = ({ teleop, running, daemonStatus, compact = false }: {
  teleop: RemoteTeleop | null;
  running: boolean;
  daemonStatus: DaemonStatus | null;
  compact?: boolean;
}) => {
  // Truth-lag pending lock (2026-08-27): the robot's armed state reaches us
  // with cadence + pipe delay, and a free-running toggle sent the WRONG verb
  // off a stale label (operator's disarm clicks arrived as arm — observed
  // live on 0003). After a click, lock the button until the robot's armed
  // actually changes; a timeout unlocks it so a lost verb can't brick it.
  // The lock now holds until the ACTIVATION state settles too, not just
  // `armed` — see armPhase.ts for the two fields' timing skew — so the
  // timeout has to outlast the slowest real transition (20-45 s of torque
  // release on the bench, "up to a minute" for a cold arm), not race it.
  const [pendingTarget, setPendingTarget] = useState<boolean | null>(null);
  // Always rendered; greyed out until the robot can actually take the verb.
  // `armed` present in daemon_status is the capability signal — an older
  // gateway never reports it, so the button stays disabled with the reason.
  const online = running && daemonStatus?.state === "online";
  const supported = daemonStatus?.armed !== undefined;
  const armed = daemonStatus?.armed === true;
  // Guarded activation in progress: motors exist but aren't commandable yet.
  // Rendering this state was a direct operator request (2026-08-26) — before
  // it, the window between Arm and motion was indistinguishable from broken.
  const activation = daemonStatus?.activation ?? "";
  const preparing = isPreparing(activation);
  // Stuck activation (2026-08-27): physical_blocked / configuration_fault /
  // failed — or any other non-nominal state we don't know yet — means the
  // motion stack can't proceed on its own. Only "active"/"inactive" are
  // nominal. The button stays ENABLED here: re-clicking arm is harmless and
  // is the retry path once the operator clears the physical cause.
  const stuck = isStuck(activation);
  // Settling (not just `armed` matching) drops the lock — armPhase.ts carries
  // the why: on disarm, `armed: false` arrives while torque is still on.
  const pending = pendingTarget !== null && !isSettled(pendingTarget, armed, activation);
  if (pendingTarget !== null && !pending) setPendingTarget(null);
  // While a click is in flight the control renders the state the robot is
  // LEAVING, not the half-applied one: the button's verb and colour flipping
  // the instant ownership changes is the same early "disarmed" lie as the
  // label, just louder. It is disabled throughout, so the verb can't misfire.
  const showArmed = pending ? !pendingTarget : armed;
  const enabled = online && supported && teleop !== null && !preparing && !pending;
  const why = !running ? "Connect to the robot first"
    : !online ? "Robot motion control is offline"
    : !supported ? "This robot's gateway doesn't support remote arming yet"
    : pending ? (pendingTarget
        ? "Arming — waiting for the robot to report the motor buses live"
        : "Disarming — waiting for the robot to report torque released")
    : preparing ? "Motion stack is activating (safety gate, buses, controllers) — up to a minute"
    : stuck ? "Motion activation is blocked — clear the reported cause, then click arm to retry"
    : armed ? "Robot arms are holding torque — disarm de-torques them (support the arms)"
    : "Arm the motor buses so keyboard/VR commands move the robot";
  // No confirms in either direction (bench decision, 2026-08-25): the button
  // tooltip carries the support-the-arms warning for disarm.
  const onClick = () => {
    if (!teleop) return;
    const target = !armed;
    teleop.setArmed(target);
    setPendingTarget(target);
    // Fallback only — on expiry the control goes back to rendering whatever the
    // robot last reported, however unfinished that looks.
    setTimeout(() => setPendingTarget((cur) => (cur === target ? null : cur)), SETTLE_TIMEOUT_MS);
  };
  return (
    // compact drops the bordered wrapper — for hosts (the controls strip) that
    // already provide a panel around it.
    <div className={"flex items-center gap-3" +
        (compact ? "" : " rounded-md border border-nori-h14131a/15 px-4 py-2")
        + (enabled ? "" : " opacity-50")}>
      <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
        motors: {motorsLabel({ pendingTarget, armed, activation, enabled })}
      </span>
      {/* The robot's verbatim activation_detail is NOT rendered here: the
          strings run to a full sentence ("blocked: <joint> raw=… STEPS ABOVE
          MAX") and wrecked this row, worst in the compact variant. It moved to
          ActivationBanner (TeleopStatus.tsx), gated off the same armPhase
          helpers so banner and chip can never disagree. */}
      {/* Same retro recipe as EStopButton — hard drop shadow, press-down on
          click — so the safety cluster reads as one family of controls. Green
          arms; ink disarms (amber/red stay reserved for warnings and E-STOP). */}
      <button
        type="button" disabled={!enabled} onClick={onClick} title={why}
        className={
          "rounded-xl px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors disabled:pointer-events-none disabled:opacity-40 " +
          (showArmed
            ? "bg-nori-h14131a text-background shadow-[0_2px_0_#000] hover:bg-nori-h14131a/85 active:translate-y-px active:shadow-none"
            : "bg-nori-h8ab135 text-nori-h14131a shadow-[0_2px_0_theme(colors.nori.h4d6a1e)] hover:bg-nori-h799c2a active:translate-y-px active:shadow-none")
        }
      >
        {showArmed ? "disarm" : "arm"}
      </button>
    </div>
  );
};

