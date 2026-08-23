// Lift/rail resolution across BOTH fleet shapes.
//
// These exist because the A-series went unsupported here silently: the helpers matched
// hand-written key names ("_arm_shoulder_pan.pos", "_lift.pos") that an A3 does not have, so a
// fully live robot reported "no telemetry" and the rail gauge read ~24% short. Nothing failed
// — it just quietly showed the wrong thing, which is the failure mode a key-name list always
// has and a descriptor lookup never does.
//
// The A3 descriptor below is the LIVE one from NORI-A3-0000 (2026-08-21), not an invention.

import { describe, it, expect } from "vitest";
import { liftAxes, liftJogKey, railReading, hasJointTelemetry, RAIL_TRAVEL_MM } from "@nori/sdk";
import type { RobotDescriptor } from "@nori/sdk";

const A3_JOINTS = [
  "shoulder_pitch", "shoulder_roll", "bicep_yaw", "elbow_pitch",
  "forearm_yaw", "wrist_pitch", "wrist_roll", "gripper",
];

const A3: RobotDescriptor = {
  joints: ["left", "right"].flatMap((s) => A3_JOINTS.map((j) => `${s}_arm_${j}.pos`)),
  base: ["x.vel", "theta.vel"],
  aux: ["lift"],
  cameras: ["left_wrist", "right_wrist", "overhead", "front"],
  ranges: { "lift.pos": [0, 720] },
};

const L_SERIES: RobotDescriptor = {
  joints: ["left_arm_shoulder_pan.pos", "right_arm_shoulder_pan.pos"],
  aux: ["left_lift", "right_lift"],
  ranges: { "left_lift.pos": [0, 600], "right_lift.pos": [0, 600] },
};

describe("liftAxes", () => {
  it("resolves the A-series single central column", () => {
    const axes = liftAxes(A3);
    expect(axes).toHaveLength(1);
    expect(axes[0]).toMatchObject({
      key: "lift.pos", side: null, travelMm: 720, advertised: true,
    });
    // One column earns no L/R prefix — there is nothing to tell it apart from.
    expect(axes[0].label).toBe("Rail");
  });

  it("resolves the L-series per-arm pair", () => {
    const axes = liftAxes(L_SERIES);
    expect(axes.map((a) => a.key)).toEqual(["left_lift.pos", "right_lift.pos"]);
    expect(axes.map((a) => a.label)).toEqual(["L rail", "R rail"]);
    expect(axes.every((a) => a.travelMm === 600)).toBe(true);
  });

  it("assumes the L-series pair when the robot sends no descriptor at all", () => {
    // A legacy robot that sends no descriptor IS an L-series unit, so this preserves exactly
    // what the hardcoded gauge did before — the frozen fleet must not change behavior.
    const axes = liftAxes(undefined);
    expect(axes.map((a) => a.key)).toEqual(["left_lift.pos", "right_lift.pos"]);
    expect(axes.every((a) => a.travelMm === RAIL_TRAVEL_MM)).toBe(true);
    expect(axes.every((a) => a.advertised)).toBe(false);
  });

  it("reports no rail for a robot that advertises none", () => {
    // A real answer, not a missing one: it must render as "no rail", never as a rail at zero.
    expect(liftAxes({ joints: ["left_arm_gripper.pos"], aux: [] })).toEqual([]);
  });

  it("falls back to the constant when a lift is advertised without a range", () => {
    const axes = liftAxes({ aux: ["lift"] });
    expect(axes[0].travelMm).toBe(RAIL_TRAVEL_MM);
    expect(axes[0].advertised).toBe(false); // callers can surface "travel unknown"
  });

  it("uses the SPAN of the range, not its maximum", () => {
    // A lift whose zero is offset still has only (high - low) of usable travel; dividing by
    // `high` would under-read every fraction.
    expect(liftAxes({ aux: ["lift"], ranges: { "lift.pos": [100, 820] } })[0].travelMm).toBe(720);
  });

  it("ignores aux entries that are not lifts", () => {
    expect(liftAxes({ aux: ["gripper_pump", "lift"] }).map((a) => a.key)).toEqual(["lift.pos"]);
  });
});

describe("railReading", () => {
  it("scales against the travel it is given", () => {
    const [axis] = liftAxes(A3);
    expect(railReading({ "lift.pos": 360 }, axis.key, axis.travelMm).frac).toBeCloseTo(0.5);
  });

  it("under-reads an A-series rail when handed the L-series default", () => {
    // Pins the bug the travelMm argument exists to fix: 360 of 720 is halfway, but against
    // the 950 default it reads 38% — the gauge, the 3D carriage and VR all sat 24% high.
    expect(railReading({ "lift.pos": 360 }, "lift.pos").frac).toBeCloseTo(0.379, 3);
  });

  it("clamps a negative reading to zero instead of mirroring it", () => {
    // Direction is calibrated per-unit on the Pi, so a negative depth is a real fault signal
    // (axis desynced or zeroed mid-travel) and should read as an obviously-wrong pinned 0.
    expect(railReading({ "lift.pos": -50 }, "lift.pos", 720)).toMatchObject({
      known: true, depthMm: 0, frac: 0,
    });
  });

  it("clamps past full travel and reports absence honestly", () => {
    expect(railReading({ "lift.pos": 9999 }, "lift.pos", 720).frac).toBe(1);
    expect(railReading({}, "lift.pos", 720).known).toBe(false);
  });

  it("survives a zero or negative travel without dividing by it", () => {
    expect(railReading({ "lift.pos": 100 }, "lift.pos", 0).frac).toBeCloseTo(100 / 950);
  });
});

describe("hasJointTelemetry", () => {
  it("is true for a live A-series robot", () => {
    // The regression that motivated all of this: A3 arms are shoulder_pitch (no shoulder_pan)
    // and its lift is the bare "lift.pos", so the old name-matching predicate said false and
    // the operator saw a permanent "waiting for telemetry" hint against a working robot.
    expect(hasJointTelemetry({ "left_arm_shoulder_pitch.pos": 12, "lift.pos": 300 })).toBe(true);
    expect(hasJointTelemetry({ "lift.pos": 300 })).toBe(true);
    expect(hasJointTelemetry({ "right_arm_bicep_yaw.pos": 1 })).toBe(true);
  });

  it("is still true for the L-series", () => {
    expect(hasJointTelemetry({ "left_arm_shoulder_pan.pos": 0 })).toBe(true);
    expect(hasJointTelemetry({ "right_lift.pos": 42 })).toBe(true);
  });

  it("is false for telemetry with nothing posable in it", () => {
    expect(hasJointTelemetry({})).toBe(false);
    expect(hasJointTelemetry({ "x.vel": 0.4, "theta.vel": 0 })).toBe(false);
  });
});

// --- the accessor the descriptor-driven path depends on ---------------------------------

describe("RemoteTeleop.robotInfo", () => {
  it("is callable", async () => {
    // It was not. A private field named `robotInfo` — holding the same value as `ackInfo`,
    // assigned 12 lines away in the same method — shadowed the public method on every
    // instance, so `teleop.robotInfo()` threw "is not a function" for the entire session.
    // Nothing caught it: mockSmoke.ts already called it, and the package's own `tsc` reported
    // the duplicate identifier but had 5 pre-existing errors so nobody ran it.
    //
    // This matters beyond tidiness: reading the descriptor is how any caller resolves which
    // lift shape a robot has, so the accessor being dead blocked the A-series fix.
    const { RemoteTeleop } = await import("@nori/sdk");
    const t = new RemoteTeleop({ signaling: {} as never, room: "probe" } as never);
    expect(typeof (t as unknown as { robotInfo: unknown }).robotInfo).toBe("function");
    expect(t.robotInfo()).toBeNull(); // null until an ack arrives, not a throw
  });
});

describe("liftJogKey", () => {
  it("returns the bare central key on an A-series robot, for either arm selection", () => {
    // The bug this replaces: the keybind composed `${arm}_lift`, so an A3 got "left_lift" —
    // a key it does not have. The robot ignores unknown jog keys in SILENCE, so the operator
    // pressed the lift key and nothing moved, with no error anywhere.
    expect(liftJogKey(A3, "left")).toBe("lift");
    expect(liftJogKey(A3, "right")).toBe("lift");
  });

  it("returns the per-arm key on an L-series robot", () => {
    expect(liftJogKey(L_SERIES, "left")).toBe("left_lift");
    expect(liftJogKey(L_SERIES, "right")).toBe("right_lift");
  });

  it("keeps the L-series shape when no descriptor was sent", () => {
    expect(liftJogKey(undefined, "right")).toBe("right_lift");
  });

  it("is null when the robot has no lift, so the caller omits the key", () => {
    expect(liftJogKey({ aux: [] }, "left")).toBeNull();
  });

  it("strips .pos — jog and telemetry are different namespaces", () => {
    // liftAxes() keys are telemetry ("lift.pos"); a jog uses the bare group name. Sending the
    // telemetry spelling in a jog is a key the robot does not recognise.
    expect(liftJogKey(A3, "left")).not.toContain(".pos");
    expect(liftAxes(A3)[0].key).toBe("lift.pos");
  });
});
