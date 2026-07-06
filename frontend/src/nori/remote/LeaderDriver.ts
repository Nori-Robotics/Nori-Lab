// NORI: Additive file. Bridges the laptop-attached SO101 dual leader arms into the remote
// teleop stream. It polls the local /nori/leader/live endpoint (the shared-bus reader in
// lelab/nori_leader_setup.py), reshapes each frame's per-joint targets into the daemon's
// absolute leader_action_deg vocabulary, and feeds them to a live RemoteTeleop via
// setLeaderAction(). RemoteTeleop's 50 Hz jogTick then attaches them to the control frame,
// so the arms follow the leaders while base + lift stay on the keyboard.
//
// When only ONE leader arm is connected, its targets are routed to the currently-selected
// follower arm (the on-screen arm switch) instead of its own side — so a single leader can
// drive both follower arms, one at a time, by flipping the selector. See frameToLeaderAction.
//
// This is the operator-app half of NoriTeleop m3_m5 §5.6.3: the daemon already accepts
// absolute leader_action_deg (degrees / gripper [0,100]) and does the calibration-normalize
// + IK + server-side slew clamp (NORI_LEADER_SLEW). We send raw leader degrees straight
// through — no client-side IK or rate conversion. The leader joint layout and the
// "<side>_arm_<joint>.pos" key format match l2_leader_common.py exactly, so this is the
// same wire the daemon-native leader_teleop_client.py produces.

import type { RemoteTeleop, LeaderActionDeg, ArmSide } from "@nori/sdk";
import { readLeaderLive, type LeaderLiveResponse } from "@/nori/api/leaderSetup";
import type { Fetcher } from "@/lib/apiClient";

export const DEFAULT_LEADER_CALIBRATION_ID = "nori_l2_dual_leader_dev";

// Poll target for the leader bus. The daemon holds the newest leader targets between
// RemoteTeleop's 50 Hz frames, so ~30 Hz here is plenty and bounds serial-bus load. The
// await-then-schedule loop self-throttles, so this is a floor, not a fixed rate.
const DEFAULT_POLL_MS = 33;

const SIDES: ArmSide[] = ["left", "right"];

export interface LeaderDriverOptions {
  teleop: RemoteTeleop;
  baseUrl: string;
  fetcher: Fetcher;
  calibrationId?: string;
  pollMs?: number;
  // Called after each successful frame with (targetsSent, frame) so the page can show a
  // live status pill (how many motors are feeding the robot, connected/paused, etc.).
  onFrame?: (targetCount: number, frame: LeaderLiveResponse) => void;
  onError?: (message: string) => void;
}

// Pull each leader side's readable joint targets out of a live frame. Only motors the bus
// actually read this frame (ok + non-null target) are included; a momentarily-missing motor
// is simply omitted so the daemon holds that joint's last target rather than yanking it.
function readSideTargets(frame: LeaderLiveResponse): Record<ArmSide, Record<string, number>> {
  const bySide: Record<ArmSide, Record<string, number>> = { left: {}, right: {} };
  if (!frame?.leaders) return bySide;
  for (const side of SIDES) {
    const motors = frame.leaders[side]?.motors ?? {};
    for (const [joint, m] of Object.entries(motors)) {
      if (m.ok && m.target !== null && m.target !== undefined) {
        bySide[side][joint] = m.target;
      }
    }
  }
  return bySide;
}

// Turn a /nori/leader/live frame into the flat absolute leader_action_deg dict the daemon
// expects, keyed "<follower_side>_arm_<joint>.pos" (the follower motor names the daemon keys on).
//
// SINGLE-LEADER routing: when exactly ONE leader arm is readable this frame, its joints are
// routed to `soloArm` — the currently-selected follower arm (the on-screen arm switch) — so a
// single physical leader can drive BOTH follower arms, one at a time, by flipping the selector.
// When BOTH leaders are connected we keep the natural left->left / right->right mapping and
// ignore soloArm. Returns an empty object when nothing was readable.
export function frameToLeaderAction(frame: LeaderLiveResponse, soloArm?: ArmSide): LeaderActionDeg {
  const bySide = readSideTargets(frame);
  const connected = SIDES.filter((side) => Object.keys(bySide[side]).length > 0);
  const targets: LeaderActionDeg = {};
  // Solo leader -> the selected follower arm; otherwise each leader drives its own side.
  const routeFor = (src: ArmSide): ArmSide => (connected.length === 1 && soloArm ? soloArm : src);
  for (const src of connected) {
    const dst = routeFor(src);
    for (const [joint, target] of Object.entries(bySide[src])) {
      targets[`${dst}_arm_${joint}.pos`] = target;
    }
  }
  return targets;
}

export class LeaderDriver {
  private readonly o: LeaderDriverOptions;
  private readonly calibrationId: string;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: LeaderDriverOptions) {
    this.o = opts;
    this.calibrationId = opts.calibrationId || DEFAULT_LEADER_CALIBRATION_ID;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  }

  start() {
    if (this.timer !== null || this.stopped) return;
    void this.tick();
  }

  // Stop polling and release the arms back to the keyboard/VR. Idempotent.
  stop() {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.o.teleop.setLeaderAction(null);
  }

  private tick = async () => {
    if (this.stopped) return;
    try {
      const frame = await readLeaderLive(this.o.baseUrl, this.o.fetcher, this.calibrationId);
      if (this.stopped) return;
      // Route a solo leader to the currently-selected follower arm, read live so flipping the
      // on-screen arm switch re-targets the single leader mid-session (the "switch arm" flow).
      const targets = frameToLeaderAction(frame, this.o.teleop.getArm());
      // Only push when we actually read something. If the whole frame is empty (arms
      // unplugged / bus dropped), leave the last targets in place so the daemon's slew
      // guard holds the pose instead of us clearing to null and handing control back.
      if (Object.keys(targets).length > 0) {
        this.o.teleop.setLeaderAction(targets);
      }
      this.o.onFrame?.(Object.keys(targets).length, frame);
    } catch (err) {
      if (this.stopped) return;
      this.o.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(this.tick, this.pollMs);
      }
    }
  };
}
