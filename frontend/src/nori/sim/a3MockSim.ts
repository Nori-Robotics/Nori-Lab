// NORI: Additive. A3MockSim: the SDK's MockDaemonSim with a GEOMETRICALLY TRUE `sendPose`.
//
// The stock mock rehearses only the pose PROTOCOL: an accepted pose nudges one joint by
// -5 so telemetry visibly responds, with no claim about where the arm ends up. For a
// point-and-click task that is useless — the arm must actually arrive at the clicked
// point. This subclass keeps every bit of the parent's lifecycle (accepted -> active ->
// done, clamping, the E-stop refusal, the watchdog) and changes exactly one thing: what a
// `control.pose` frame becomes. It is solved here with the SDK's own closed-form IK
// (`solveWristPoint`, @nori/sdk/vr — a 1:1 port of the gateway's arm_kinematics.py) and
// rewritten, before the parent sees it, as the equivalent `control.action` joint-target
// frame under the SAME action_id. The parent then slews to it exactly as it would any
// action, so the client sees the real robot's status sequence.
//
// WHAT THE TARGET IS. The solver places the WRIST POINT (where the forearm ends, the
// origin of the wrist_pitch joint), not the TCP, which sits ~180 mm further out along the
// hand. So `sendPose(side, p)` here means "put the wrist point at p"; the three wrist
// joints are held where they are. Orientation, if sent, is validated and ignored —
// position-only semantics, the same as the gateway's "solve at the current wrist".
//
// FRAMES. The wire target is metres in base_footprint (REP-103). The solver works in the
// arm-mount frame (URDF lift_top_link), so the target is shifted by the fixed
// base_footprint -> base_link -> lift offset PLUS the live lift extension. A pose sent at
// one lift height is therefore solved for that height, like the real robot (which refuses
// with `lift_moved` if the lift changes mid-solve; here the slew is joint-space so it
// simply finishes where it was solved).
//
// UNITS. The solver speaks radians; the mock stores normalized -100..100. The conversion
// runs through the descriptor's `ranges_si` (a3MockDescriptor.ts), the same table the
// viewer uses, so solved geometry and drawn geometry agree.
//
// REFUSALS. Gateway vocabulary, in the gateway's order: estop_latched -> empty_pose ->
// one_arm_per_pose -> frame:<name> -> bad_pose -> no_ik_solution. The solver's own joint
// limits (arm-kinematics JOINT_LIMITS, ±1.6581 rad on roll/elbow) are slightly WIDER than
// the URDF's ±pi/2, so a candidate is only accepted when it fits the URDF too; the swivel
// sweep continues past one that does not. No_ik_solution therefore means "at no elbow
// swivel, inside the URDF" — the real gateway's meaning.
//
// Pure TS, no DOM — unit-tested tick by tick in a3MockSim.test.ts.

import { MockDaemonSim, type MockSimOptions } from "@nori/sdk/mock";
import {
  solveWristPoint, swivelOf, sideSign, SOLVED_JOINTS, wristPoint,
  type ArmQ, type Vec3,
} from "@nori/sdk/vr";
import { a3MockSimOptions, armKey, normToRad, radToNorm, type A3Side } from "./a3MockDescriptor";

type Frame = Record<string, unknown>;

/** base_footprint -> lift_top_link at ZERO lift extension (nori.urdf: base_footprint_joint
 *  z 0.0762; lift_extension_joint origin (-0.11352316, 0, 0.35272764)). Add lift metres to z. */
export const ARM_MOUNT_OFFSET_M: Vec3 = [-0.11352316, 0, 0.0762 + 0.35272764];

/** Swivel fallback sweep when the seed's own elbow swivel cannot reach the target: a
 *  FIXED swivel solves ~38% of the reach sphere, a search ~52% (arm-kinematics.ts). The
 *  sweep walks outward from the current swivel so the nearest elbow wins. */
const SWIVEL_STEP = (6 * Math.PI) / 180;

export interface PoseSolveResult {
  q: ArmQ;
  swivel: number;
}

export class A3MockSim extends MockDaemonSim {
  constructor(opts?: Partial<MockSimOptions>) {
    super(a3MockSimOptions(opts));
  }

  // ---- geometry helpers (public so the page can draw markers and verify) --------------

  /** Live lift extension, metres. */
  liftM(): number {
    return (this.state()["lift.pos"] ?? 0) / 1000;
  }

  /** base_footprint -> arm-mount frame at the CURRENT lift height. */
  toMountFrame(p: Vec3): Vec3 {
    const lift = this.liftM();
    return [p[0] - ARM_MOUNT_OFFSET_M[0], p[1] - ARM_MOUNT_OFFSET_M[1], p[2] - ARM_MOUNT_OFFSET_M[2] - lift];
  }

  /** arm-mount -> base_footprint at the CURRENT lift height. */
  fromMountFrame(p: Vec3): Vec3 {
    const lift = this.liftM();
    return [p[0] + ARM_MOUNT_OFFSET_M[0], p[1] + ARM_MOUNT_OFFSET_M[1], p[2] + ARM_MOUNT_OFFSET_M[2] + lift];
  }

  /** The four proximal joints of one arm, radians, from the live normalized state. */
  armQ(side: A3Side): ArmQ {
    const st = this.state();
    return SOLVED_JOINTS.map((j) => normToRad(this.descriptor, armKey(side, j), st[armKey(side, j)] ?? 0)) as ArmQ;
  }

  /** Where one arm's wrist point is right now, metres in base_footprint (forward kinematics). */
  wristPointBf(side: A3Side): Vec3 {
    const q = this.armQ(side);
    return this.fromMountFrame(wristPoint(q[0], q[1], q[2], q[3], sideSign(side)));
  }

  /**
   * Solve a base_footprint wrist-point target for one arm at the current lift and seed.
   * Null = out of reach at every swivel. Exposed for the page's reachability preview.
   */
  solvePose(side: A3Side, targetBf: Vec3): PoseSolveResult | null {
    const sign = sideSign(side);
    const seed = this.armQ(side);
    const target = this.toMountFrame(targetBf);
    const s0 = swivelOf(seed, sign);
    // Current swivel first, then alternate outward: +step, -step, +2step, ... The solver's
    // own limits are a little wider than the URDF's, so a solution that only fits the
    // solver is skipped here and the sweep continues — an elbow a few degrees around
    // usually brings the roll back inside.
    const attempt = (s: number): PoseSolveResult | null => {
      const q = solveWristPoint(target, s, seed, sign);
      return q && this.withinUrdfLimits(side, q) ? { q, swivel: s } : null;
    };
    const first = attempt(s0);
    if (first) return first;
    for (let k = 1; k * SWIVEL_STEP <= Math.PI; k++) {
      for (const dir of [1, -1]) {
        const hit = attempt(s0 + dir * k * SWIVEL_STEP);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** True when every solved joint lies inside the descriptor's SI bounds (the URDF's). */
  withinUrdfLimits(side: A3Side, q: ArmQ): boolean {
    return SOLVED_JOINTS.every((j, i) => {
      const si = this.descriptor.ranges_si?.[armKey(side, j)];
      if (!si) return true;
      const lo = Math.min(si[0], si[1]), hi = Math.max(si[0], si[1]);
      return q[i] >= lo - 1e-9 && q[i] <= hi + 1e-9;
    });
  }

  // ---- the override ---------------------------------------------------------------------

  handleFrame(frame: Frame, nowMs: number): Frame[] {
    if (!frame || typeof frame !== "object" || frame.type !== "control"
        || !frame.pose || typeof frame.pose !== "object") {
      return super.handleFrame(frame, nowMs);
    }
    // Everything else on the frame (jog, reset, an explicit action) still reaches the
    // parent; only `pose` is consumed here and re-expressed as `action`.
    const { pose, ...rest } = frame;
    const id = typeof frame.action_id === "string" ? frame.action_id : "";
    const refuse = (reason: string): Frame[] => {
      const out = super.handleFrame(rest, nowMs); // keep the watchdog fed, apply any jog
      if (id) out.push(this.poseStatus(id, "blocked", reason));
      return out;
    };

    // The parent silently drops pose when "pose_targets" is not advertised — same here.
    if (!this.capabilities.includes("pose_targets")) return super.handleFrame(rest, nowMs);
    if (this.safetyState() === "latched") return refuse("estop_latched");

    const p = pose as Frame;
    const hasArm = (side: string) =>
      (this.descriptor.joints ?? []).some((j) => j.startsWith(`${side}_arm_`));
    const sides = Object.keys(p)
      .filter((k) => k.endsWith("_arm") && hasArm(k.slice(0, -4)))
      .map((k) => k.slice(0, -4)) as A3Side[];
    if (!sides.length) return refuse("empty_pose");
    if (sides.length > 1) return refuse("one_arm_per_pose");
    const side = sides[0];
    const target = p[`${side}_arm`] as Record<string, unknown>;
    if (!target || typeof target !== "object") return refuse("bad_pose");
    const frameName = String(target.frame ?? "");
    if (frameName !== "base_footprint") return refuse(`frame:${frameName || "missing"}`);
    const position = target.position_m;
    if (!Array.isArray(position) || position.length !== 3
        || !position.every((v) => typeof v === "number" && Number.isFinite(v))) return refuse("bad_pose");
    const orientation = target.orientation_xyzw;
    if (orientation !== undefined && (!Array.isArray(orientation) || orientation.length !== 4
        || !orientation.every((v) => typeof v === "number"))) return refuse("bad_pose");

    const solved = this.solvePose(side, position as Vec3);
    if (!solved) return refuse("no_ik_solution");

    const action: Record<string, number> = {};
    for (let i = 0; i < SOLVED_JOINTS.length; i++) {
      const key = armKey(side, SOLVED_JOINTS[i]);
      const norm = radToNorm(this.descriptor, key, solved.q[i]);
      const r = this.descriptor.ranges?.[key] ?? [-100, 100];
      // solvePose already rejected anything outside the URDF limits; this is the guard for a
      // descriptor without ranges_si. Refuse, never clamp — a clamped joint puts the wrist
      // somewhere other than the target under a "done" status.
      if (norm < r[0] - 1e-6 || norm > r[1] + 1e-6) return refuse(`limit:${side}_arm_${SOLVED_JOINTS[i]}`);
      action[key] = Math.max(r[0], Math.min(r[1], norm));
    }
    // The parent's action path owns everything from here: accepted now, active on the
    // first slewing tick, done when every joint arrives; estop mid-slew -> blocked.
    return super.handleFrame({ ...rest, action_id: id || undefined, action }, nowMs);
  }

  // The parent's actionStatus is private; this mirrors its shape (ts_ns of the last tick).
  private poseStatus(id: string, state: string, reason: string): Frame {
    const last = (this as unknown as { lastTickMs: number | null }).lastTickMs;
    return {
      type: "action_status", action_id: id, state, reason,
      ts_ns: last === null || last === undefined ? 0 : Math.round(last * 1e6),
    };
  }
}
