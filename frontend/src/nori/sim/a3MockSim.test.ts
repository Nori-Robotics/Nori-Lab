// NORI: Additive. A3MockSim driven tick by tick through control.pose: the lifecycle the
// stock mock already proves (accepted -> active -> done, E-stop -> blocked) now has to
// hold with a GEOMETRIC target, and the arm has to actually arrive. Forward kinematics of
// the final joint state is the oracle: the wrist point must land within 1 cm of the
// request, in base_footprint, at the lift height it was solved for.
import { describe, expect, it } from "vitest";
import { sideSign, wristPoint, type ArmQ, type Vec3 } from "@nori/sdk/vr";
import { A3MockSim } from "./a3MockSim";
import { armKey, normToRad } from "./a3MockDescriptor";

type Frame = Record<string, unknown>;

const poseFrame = (side: "left" | "right", position: number[], id = "pose-1", extra?: Frame): Frame => ({
  type: "control", seq: 1, action_id: id,
  pose: { [`${side}_arm`]: { frame: "base_footprint", position_m: position, ...extra } },
});

// Feed the watchdog and advance the clock, collecting everything the sim emits.
function drive(sim: A3MockSim, fromMs: number, toMs: number, stepMs = 20): Frame[] {
  const out: Frame[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    sim.handleFrame({ type: "control", seq: t, jog: {} }, t);
    out.push(...sim.tick(t));
  }
  return out;
}

const statuses = (frames: Frame[], id: string) =>
  frames.filter((f) => f.type === "action_status" && f.action_id === id).map((f) => f.state);

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// A target the arm can certainly reach: the wrist point of a known configuration, pushed
// through FK and the sim's own frame shift. Bent elbow, arm forward-ish.
function reachableTarget(sim: A3MockSim, side: "left" | "right"): { target: Vec3; q: ArmQ } {
  const q: ArmQ = [0.4, 0.9, 0.3, -0.9];
  const mount = wristPoint(q[0], q[1], q[2], q[3], sideSign(side));
  return { target: sim.fromMountFrame(mount), q };
}

describe("A3MockSim.sendPose (control.pose -> solved joint action)", () => {
  it("accepted -> active -> done, and the wrist point lands within 1 cm", () => {
    const sim = new A3MockSim();
    sim.tick(0);
    const { target } = reachableTarget(sim, "right");
    const before = sim.wristPointBf("right");
    expect(dist(before, target)).toBeGreaterThan(0.05); // the move is not a no-op

    const first = sim.handleFrame(poseFrame("right", target), 0);
    expect(statuses(first, "pose-1")).toEqual(["accepted"]);

    const frames = drive(sim, 20, 4000);
    const seq = statuses(frames, "pose-1");
    expect(seq[0]).toBe("active");
    expect(seq[seq.length - 1]).toBe("done");
    expect(dist(sim.wristPointBf("right"), target)).toBeLessThan(0.01);

    // Wrist joints are held: the task target is the wrist point, not the TCP.
    const st = sim.state();
    for (const j of ["forearm_yaw", "wrist_pitch", "wrist_roll"]) expect(st[armKey("right", j)]).toBe(0);
    // The left arm never moved.
    expect(st[armKey("left", "shoulder_pitch")]).toBe(0);
  });

  it("the solved joints are the normalized image of the solver's radians", () => {
    const sim = new A3MockSim();
    sim.tick(0);
    const { target } = reachableTarget(sim, "left");
    sim.handleFrame(poseFrame("left", target), 0);
    drive(sim, 20, 4000);
    const q = sim.armQ("left");
    const fk = sim.fromMountFrame(wristPoint(q[0], q[1], q[2], q[3], sideSign("left")));
    expect(dist(fk, target)).toBeLessThan(0.01);
    // Round trip through ranges_si is the identity to float precision.
    const key = armKey("left", "shoulder_roll");
    expect(normToRad(sim.descriptor, key, sim.state()[key])).toBeCloseTo(q[1], 9);
  });

  it("an unreachable target is blocked: no_ik_solution, and nothing moves", () => {
    const sim = new A3MockSim();
    sim.tick(0);
    const before = sim.state();
    const out = sim.handleFrame(poseFrame("right", [2.0, 0, 1.0], "far"), 0);
    expect(out.filter((f) => f.type === "action_status")).toEqual([
      expect.objectContaining({ action_id: "far", state: "blocked", reason: "no_ik_solution" }),
    ]);
    drive(sim, 20, 500);
    expect(sim.state()).toEqual(before);
  });

  it("E-stop mid-move halts the arm and ends the action as blocked: estop_latched", () => {
    const sim = new A3MockSim();
    sim.tick(0);
    const { target } = reachableTarget(sim, "right");
    sim.handleFrame(poseFrame("right", target), 0);
    const early = drive(sim, 20, 200);
    expect(statuses(early, "pose-1")).toEqual(["active"]);
    const midway = sim.state();
    expect(dist(sim.wristPointBf("right"), target)).toBeGreaterThan(0.01);

    const stop = sim.handleFrame({ type: "command", name: "estop" }, 220);
    expect(statuses(stop, "pose-1")).toEqual(["blocked"]);
    expect((stop.find((f) => f.action_id === "pose-1") as Frame).reason).toBe("estop_latched");

    drive(sim, 240, 2000);
    expect(sim.state()).toEqual(midway); // frozen where the latch caught it
    // And a new pose while latched is refused up front, before any geometry.
    const again = sim.handleFrame(poseFrame("right", target, "pose-2"), 2020);
    expect(again.filter((f) => f.type === "action_status")).toEqual([
      expect.objectContaining({ action_id: "pose-2", state: "blocked", reason: "estop_latched" }),
    ]);
  });

  it("keeps the gateway's refusal order for malformed frames", () => {
    const sim = new A3MockSim();
    sim.tick(0);
    const reason = (frame: Frame) =>
      (sim.handleFrame(frame, 0).find((f) => f.type === "action_status") as Frame | undefined)?.reason;
    expect(reason({ type: "control", seq: 1, action_id: "a", pose: {} })).toBe("empty_pose");
    expect(reason({ type: "control", seq: 1, action_id: "a", pose: {
      left_arm: { frame: "base_footprint", position_m: [0.3, 0.2, 1] },
      right_arm: { frame: "base_footprint", position_m: [0.3, -0.2, 1] },
    } })).toBe("one_arm_per_pose");
    expect(reason(poseFrame("right", [0.3, -0.2, 1], "a", { frame: "map" }))).toBe("frame:map");
    expect(reason({ type: "control", seq: 1, action_id: "a",
      pose: { right_arm: { frame: "base_footprint", position_m: [1, 2] } } })).toBe("bad_pose");
    expect(reason(poseFrame("right", [0.3, -0.2, 1], "a", { orientation_xyzw: [0, 0, 1] }))).toBe("bad_pose");
    // Nothing above touched the arm.
    expect(sim.wristPointBf("right")).toEqual(new A3MockSim().wristPointBf("right"));
  });

  it("solves at the CURRENT lift height: the same target needs a different arm when lifted", () => {
    const low = new A3MockSim({ initialState: { "lift.pos": 0 } });
    const high = new A3MockSim({ initialState: { "lift.pos": 300 } });
    low.tick(0); high.tick(0);
    const { target } = reachableTarget(low, "right");
    low.handleFrame(poseFrame("right", target), 0);
    high.handleFrame(poseFrame("right", target), 0);
    drive(low, 20, 4000); drive(high, 20, 4000);
    expect(dist(low.wristPointBf("right"), target)).toBeLessThan(0.01);
    expect(dist(high.wristPointBf("right"), target)).toBeLessThan(0.01);
    expect(low.armQ("right")).not.toEqual(high.armQ("right"));
  });

  it("an un-tagged pose (no action_id) still moves the arm and emits no status", () => {
    const sim = new A3MockSim();
    sim.tick(0);
    const { target } = reachableTarget(sim, "right");
    const f = poseFrame("right", target);
    delete f.action_id;
    expect(sim.handleFrame(f, 0)).toEqual([]);
    const frames = drive(sim, 20, 4000);
    expect(frames.filter((x) => x.type === "action_status")).toEqual([]);
    expect(dist(sim.wristPointBf("right"), target)).toBeLessThan(0.01);
  });

  it("A3 telemetry keys are the URDF's, with ranges_si for every arm joint", () => {
    const sim = new A3MockSim();
    const ack = sim.ackFrame() as { descriptor: { joints: string[]; ranges_si: Record<string, unknown> } };
    expect(ack.descriptor.joints).toContain("right_arm_shoulder_pitch.pos");
    expect(ack.descriptor.joints).toContain("left_arm_gripper.pos");
    expect(ack.descriptor.joints).not.toContain("right_arm_shoulder_pan.pos");
    for (const j of ack.descriptor.joints) expect(ack.descriptor.ranges_si[j]).toBeDefined();
    expect(sim.state()["lift.pos"]).toBe(100);
    expect((sim.cameraLayoutFrame() as { tiles: string[] }).tiles).toEqual(["front", "overhead", "left_wrist", "right_wrist"]);
  });
});
