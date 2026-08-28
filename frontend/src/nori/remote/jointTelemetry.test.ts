import { describe, expect, it } from "vitest";

import type { RobotDescriptor } from "@nori/sdk";
import {
  FLOW_WINDOW_MS,
  TelemetryFlowTracker,
  advertisedStateKeys,
  anatomicalRank,
  jointShort,
  buildJointRows,
  flowTone,
  groupJointRows,
  hasSiCalibration,
  isLiftKey,
  jointLabel,
  keyCoverage,
  keySide,
  normalizedFraction,
  normalizedRange,
  rateHz,
  siReading,
} from "@/nori/remote/jointTelemetry";

const ARM_SHORTS = [
  "shoulder_pitch", "shoulder_roll", "bicep_yaw", "elbow_pitch",
  "forearm_yaw", "wrist_pitch", "wrist_roll",
] as const;

// Shaped like the live A3 ack: 16 arm keys + the single central lift, normalized
// ranges, and calibrated SI bounds for the normalized keys only.
function a3Descriptor(): RobotDescriptor {
  const joints: string[] = [];
  const ranges: Record<string, [number, number]> = {};
  const rangesSi: Record<string, [number, number]> = {};
  for (const side of ["left", "right"] as const) {
    for (const short of ARM_SHORTS) {
      const k = `${side}_arm_${short}.pos`;
      joints.push(k);
      ranges[k] = [-100, 100];
      rangesSi[k] = [-1.5, 2.5];
    }
    const g = `${side}_arm_gripper.pos`;
    joints.push(g);
    ranges[g] = [0, 100];
    rangesSi[g] = [0, 0.8];
  }
  return {
    joints,
    aux: ["lift"],
    base: ["x.vel", "theta.vel"],
    ranges: { ...ranges, "lift.pos": [0, 720] },
    ranges_si: rangesSi,
  };
}

// The frozen L-series shape: per-arm lifts, no ranges_si at all.
const l2Descriptor: RobotDescriptor = {
  joints: ["left_arm_shoulder_pan.pos", "right_arm_shoulder_pan.pos"],
  aux: ["left_lift", "right_lift"],
  ranges: { "left_arm_shoulder_pan.pos": [-100, 100] },
};

describe("key naming", () => {
  it("recognises both fleet lift shapes and nothing else", () => {
    expect(isLiftKey("lift.pos")).toBe(true);
    expect(isLiftKey("left_lift.pos")).toBe(true);
    expect(isLiftKey("right_lift.pos")).toBe(true);
    expect(isLiftKey("left_arm_wrist_roll.pos")).toBe(false);
    expect(isLiftKey("x.vel")).toBe(false);
  });

  it("groups by side, with everything unsided in 'other'", () => {
    expect(keySide("left_arm_elbow_pitch.pos")).toBe("left");
    expect(keySide("right_lift.pos")).toBe("right");
    expect(keySide("lift.pos")).toBe("other");
    expect(keySide("x.vel")).toBe("other");
  });

  it("mirrors shortMotor()'s label style and strips the .pos suffix", () => {
    expect(jointLabel("left_arm_shoulder_roll.pos")).toBe("L shoulder roll");
    expect(jointLabel("right_arm_gripper.pos")).toBe("R gripper");
    expect(jointLabel("left_lift.pos")).toBe("L lift");
    expect(jointLabel("lift.pos")).toBe("lift");
    // Non-.pos keeps its quantity: for the base that IS the distinguishing part.
    expect(jointLabel("theta.vel")).toBe("theta.vel");
  });
});

describe("advertisedStateKeys", () => {
  it("takes joints plus aux (suffixed), in descriptor order", () => {
    const keys = advertisedStateKeys(a3Descriptor());
    expect(keys).toHaveLength(17);
    expect(keys[0]).toBe("left_arm_shoulder_pitch.pos");
    expect(keys[keys.length - 1]).toBe("lift.pos");
  });

  it("never counts base DOFs — a robot need not echo them in telemetry", () => {
    expect(advertisedStateKeys(a3Descriptor())).not.toContain("x.vel");
    expect(advertisedStateKeys(a3Descriptor())).not.toContain("theta.vel");
  });

  it("handles the L-series pair of lifts", () => {
    expect(advertisedStateKeys(l2Descriptor)).toEqual([
      "left_arm_shoulder_pan.pos", "right_arm_shoulder_pan.pos",
      "left_lift.pos", "right_lift.pos",
    ]);
  });

  it("is empty with no descriptor, so nothing can be claimed missing", () => {
    expect(advertisedStateKeys(null)).toEqual([]);
    expect(advertisedStateKeys(undefined)).toEqual([]);
  });
});

describe("normalizedRange / normalizedFraction", () => {
  it("prefers the robot's advertised ranges", () => {
    const r = normalizedRange("left_arm_elbow_pitch.pos", a3Descriptor());
    expect(r).toEqual({ lo: -100, hi: 100, source: "descriptor" });
  });

  it("falls back to protocol conventions with no descriptor", () => {
    expect(normalizedRange("left_arm_elbow_pitch.pos", null))
      .toEqual({ lo: -100, hi: 100, source: "convention" });
    expect(normalizedRange("right_arm_gripper.pos", null))
      .toEqual({ lo: 0, hi: 100, source: "convention" });
    expect(normalizedRange("left_lift.pos", null)?.source).toBe("convention");
  });

  it("returns null for keys with no known scale, so no bar is drawn", () => {
    expect(normalizedRange("x.vel", a3Descriptor())).toBeNull();
    expect(normalizedRange("something_odd", a3Descriptor())).toBeNull();
  });

  it("ignores degenerate advertised ranges", () => {
    const d: RobotDescriptor = { ranges: { "left_arm_wrist_roll.pos": [5, 5] } };
    expect(normalizedRange("left_arm_wrist_roll.pos", d)?.source).toBe("convention");
  });

  it("does NOT clamp: an out-of-range reading is the signal we are hunting", () => {
    const r = normalizedRange("left_arm_shoulder_roll.pos", a3Descriptor());
    expect(normalizedFraction(0, r)).toBeCloseTo(0.5, 10);
    expect(normalizedFraction(-140, r)).toBeCloseTo(-0.2, 10);
    expect(normalizedFraction(120, r)).toBeCloseTo(1.1, 10);
  });

  it("is null for a missing value or an unknown span", () => {
    expect(normalizedFraction(null, { lo: -100, hi: 100, source: "convention" })).toBeNull();
    expect(normalizedFraction(NaN, { lo: -100, hi: 100, source: "convention" })).toBeNull();
    expect(normalizedFraction(12, null)).toBeNull();
  });
});

describe("siReading", () => {
  const d = a3Descriptor();

  it("interpolates the calibrated bounds and reports degrees too", () => {
    const key = "left_arm_shoulder_roll.pos";
    const r = normalizedRange(key, d);
    const si = siReading(key, 0, normalizedFraction(0, r), d); // midpoint of [-1.5, 2.5]
    expect(si.known).toBe(true);
    expect(si.unit).toBe("rad");
    expect(si.value).toBeCloseTo(0.5, 10);
    expect(si.deg).toBeCloseTo((0.5 * 180) / Math.PI, 10);
  });

  it("honours INVERTED bounds as written, never sorting them", () => {
    const inv: RobotDescriptor = {
      ranges: { "left_arm_wrist_roll.pos": [-100, 100] },
      ranges_si: { "left_arm_wrist_roll.pos": [2.5, -1.5] },
    };
    const key = "left_arm_wrist_roll.pos";
    const at = (v: number) => siReading(key, v, normalizedFraction(v, normalizedRange(key, inv)), inv).value;
    // Normalized minimum maps to the SI *lower field*, which here is the larger number.
    expect(at(-100)).toBeCloseTo(2.5, 10);
    expect(at(100)).toBeCloseTo(-1.5, 10);
    expect(at(0)).toBeCloseTo(0.5, 10);
    // Direction is preserved: increasing normalized -> decreasing radians.
    expect(at(50)).toBeLessThan(at(-50));
  });

  it("extrapolates past the bounds rather than pinning at them", () => {
    const key = "left_arm_shoulder_roll.pos";
    const si = siReading(key, 120, normalizedFraction(120, normalizedRange(key, d)), d);
    // frac 1.1 over span [-1.5, 2.5] -> -1.5 + 1.1*4
    expect(si.value).toBeCloseTo(2.9, 10);
  });

  it("passes lift through as millimetres and never touches ranges_si for it", () => {
    const si = siReading("lift.pos", 412.5, 0.57, d);
    expect(si).toMatchObject({ known: true, unit: "mm", deg: null });
    expect(si.value).toBe(412.5);
    // Both fleet shapes.
    expect(siReading("left_lift.pos", 120, 0.12, l2Descriptor))
      .toMatchObject({ known: true, unit: "mm", value: 120 });
    // Even if a robot wrongly published SI bounds for a lift, mm wins — the
    // value is already physical and converting it would convert twice.
    const bogus: RobotDescriptor = { ranges_si: { "lift.pos": [0, 0.72] } };
    expect(siReading("lift.pos", 400, 0.55, bogus)).toMatchObject({ unit: "mm", value: 400 });
  });

  it("says so rather than guessing when the robot publishes no ranges_si", () => {
    const key = "left_arm_shoulder_pan.pos";
    const si = siReading(key, 10, normalizedFraction(10, normalizedRange(key, l2Descriptor)), l2Descriptor);
    expect(si.known).toBe(false);
    expect(si.reason).toBe("no_ranges_si");
  });

  it("rejects degenerate or non-finite advertised bounds", () => {
    const bad: RobotDescriptor = {
      ranges_si: {
        "left_arm_a.pos": [1, 1],
        "left_arm_b.pos": [0, Number.NaN] as unknown as [number, number],
      },
    };
    expect(siReading("left_arm_a.pos", 0, 0.5, bad).reason).toBe("bad_bounds");
    expect(siReading("left_arm_b.pos", 0, 0.5, bad).reason).toBe("bad_bounds");
  });

  it("has no reading with no value", () => {
    expect(siReading("left_arm_shoulder_roll.pos", null, null, d))
      .toMatchObject({ known: false, reason: "no_value" });
  });

  it("reports which robots can express radians at all", () => {
    expect(hasSiCalibration(a3Descriptor())).toBe(true);
    expect(hasSiCalibration(l2Descriptor)).toBe(false);
    expect(hasSiCalibration(null)).toBe(false);
    expect(hasSiCalibration({ ranges_si: {} })).toBe(false);
  });
});

describe("rateHz", () => {
  it("measures over the span actually covered, not the nominal window", () => {
    // 16 stamps 1/15 s apart -> 15 intervals over 1 s.
    const t: number[] = [];
    for (let i = 0; i <= 15; i += 1) t.push(1000 + (i * 1000) / 15);
    expect(rateHz(t)).toBeCloseTo(15, 6);
  });

  it("is 0 below two samples — one arrival is not a rate", () => {
    expect(rateHz([])).toBe(0);
    expect(rateHz([1000])).toBe(0);
    expect(rateHz([1000, 1000])).toBe(0);
  });
});

describe("TelemetryFlowTracker", () => {
  const frame = (t: number, over: Record<string, number> = {}) => ({
    "left_arm_shoulder_roll.pos": 10,
    "left_arm_elbow_pitch.pos": 20,
    "lift.pos": 300,
    ...over,
  });

  it("measures the observed frame rate client-side", () => {
    const tr = new TelemetryFlowTracker();
    let t = 1000;
    for (let i = 0; i < 30; i += 1) { tr.observe(frame(t), t); t += 1000 / 15; }
    const s = tr.sample(t);
    expect(s.frameHz).toBeCloseTo(15, 1);
    expect(s.totalFrames).toBe(30);
  });

  it("separates 'not changing' from 'not arriving'", () => {
    const tr = new TelemetryFlowTracker();
    let t = 1000;
    // A joint parked at 10 while its neighbour sweeps — both keep arriving.
    for (let i = 0; i < 20; i += 1) {
      tr.observe(frame(t, { "left_arm_elbow_pitch.pos": 20 + i }), t);
      t += 100;
    }
    const s = tr.sample(t);
    const parked = s.keys.find((k) => k.key === "left_arm_shoulder_roll.pos")!;
    const moving = s.keys.find((k) => k.key === "left_arm_elbow_pitch.pos")!;
    // Both are equally FRESH...
    expect(parked.sinceSeenMs).toBe(100);
    expect(moving.sinceSeenMs).toBe(100);
    // ...but only one has ever changed. A parked joint reports null, not 0 —
    // we never observed a change and must not claim one.
    expect(parked.sinceChangedMs).toBeNull();
    expect(moving.sinceChangedMs).toBe(100);
  });

  it("ages a key that stops arriving while the rest of the stream continues", () => {
    const tr = new TelemetryFlowTracker();
    let t = 1000;
    for (let i = 0; i < 10; i += 1) { tr.observe(frame(t), t); t += 100; }
    // shoulder_roll's key vanishes from the frame — the exact failure this panel exists for.
    for (let i = 0; i < 30; i += 1) {
      const f = frame(t);
      delete (f as Record<string, number>)["left_arm_shoulder_roll.pos"];
      tr.observe(f, t);
      t += 100;
    }
    const s = tr.sample(t);
    const gone = s.keys.find((k) => k.key === "left_arm_shoulder_roll.pos")!;
    const alive = s.keys.find((k) => k.key === "lift.pos")!;
    expect(gone.sinceSeenMs).toBe(3100); // last carried at t=1900, sampled at t=5000
    expect(gone.hz).toBe(0); // its window emptied
    expect(alive.sinceSeenMs).toBe(100);
    expect(alive.hz).toBeCloseTo(10, 1);
    // The overall stream is still healthy — which is why a per-key signal is needed.
    expect(s.frameHz).toBeCloseTo(10, 1);
  });

  it("decays to zero once the stream stops, with no further observations", () => {
    const tr = new TelemetryFlowTracker();
    let t = 1000;
    for (let i = 0; i < 20; i += 1) { tr.observe(frame(t), t); t += 100; }
    const later = t + FLOW_WINDOW_MS + 1;
    const s = tr.sample(later);
    expect(s.frameHz).toBe(0);
    expect(s.frames).toBe(0);
    expect(s.totalFrames).toBe(20);      // it DID arrive once — a different fact
    expect(s.sinceFrameMs).toBe(later - (t - 100));
  });

  it("ignores non-finite values — a NaN is not a reading", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe({ "left_arm_wrist_roll.pos": Number.NaN }, 1000);
    expect(tr.sample(1000).keys).toHaveLength(0);
  });

  it("survives a frame with no state dict, still counting it as a frame", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe(null, 1000);
    tr.observe(undefined, 1100);
    const s = tr.sample(1100);
    expect(s.totalFrames).toBe(2);
    expect(s.keys).toHaveLength(0);
  });

  it("forgets everything on reset", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe(frame(1000), 1000);
    tr.reset();
    const s = tr.sample(1000);
    expect(s.totalFrames).toBe(0);
    expect(s.keys).toHaveLength(0);
    expect(s.sinceFrameMs).toBeNull();
  });
});

describe("keyCoverage", () => {
  const d = a3Descriptor();

  it("names the advertised keys that are not arriving", () => {
    const tr = new TelemetryFlowTracker();
    const full: Record<string, number> = {};
    for (const k of advertisedStateKeys(d)) full[k] = 0;
    delete full["left_arm_shoulder_roll.pos"];
    let t = 1000;
    for (let i = 0; i < 20; i += 1) { tr.observe(full, t); t += 100; }
    const cov = keyCoverage(tr.sample(t), advertisedStateKeys(d));
    expect(cov.advertised).toHaveLength(17);
    expect(cov.arriving).toHaveLength(16);
    expect(cov.missing).toEqual(["left_arm_shoulder_roll.pos"]);
    expect(cov.unadvertised).toEqual([]);
  });

  it("moves a key that drops out mid-session into missing once its window empties", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe({ "lift.pos": 1 }, 1000);
    expect(keyCoverage(tr.sample(1100), ["lift.pos"]).missing).toEqual([]);
    expect(keyCoverage(tr.sample(1000 + FLOW_WINDOW_MS + 1), ["lift.pos"]).missing).toEqual(["lift.pos"]);
  });

  it("flags keys arriving that the descriptor never promised", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe({ "x.vel": 0.2, "lift.pos": 5 }, 1000);
    const cov = keyCoverage(tr.sample(1000), ["lift.pos"]);
    expect(cov.unadvertised).toEqual(["x.vel"]);
    expect(cov.missing).toEqual([]);
  });

  it("claims nothing missing with no descriptor and no sample", () => {
    expect(keyCoverage(null, [])).toEqual({
      advertised: [], arriving: [], missing: [], unadvertised: [],
    });
  });
});

describe("flowTone", () => {
  it("stays neutral with no session — an alarm about a robot you aren't connected to is noise", () => {
    expect(flowTone(50, false)).toBe("default");
    expect(flowTone(99999, false)).toBe("default");
  });

  it("stays neutral for a key that has never been seen", () => {
    expect(flowTone(null, true)).toBe("default");
  });

  it("bands on last-SEEN age only", () => {
    expect(flowTone(0, true)).toBe("good");
    expect(flowTone(500, true)).toBe("good");
    expect(flowTone(501, true)).toBe("warn");
    expect(flowTone(2000, true)).toBe("warn");
    expect(flowTone(2001, true)).toBe("bad");
  });
});

describe("buildJointRows / groupJointRows", () => {
  const d = a3Descriptor();

  it("renders a row for every advertised key even with no data at all", () => {
    const rows = buildJointRows(null, d);
    expect(rows).toHaveLength(17);
    expect(rows.every((r) => r.value === null)).toBe(true);
    expect(rows.every((r) => r.flow === null)).toBe(true);
    expect(rows.every((r) => !r.si.known)).toBe(true);
    // No fake zeros, no invented fractions — nothing to draw a bar from.
    expect(rows.every((r) => r.barFrac === null)).toBe(true);
  });

  it("orders whole arms proximal->distal, then the lift and base keys", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe({ "x.vel": 0.1, "theta.vel": 0.2, "lift.pos": 10 }, 1000);
    const rows = buildJointRows(tr.sample(1000), d);
    expect(rows.slice(0, 3).map((r) => r.key)).toEqual([
      "left_arm_shoulder_pitch.pos", "left_arm_shoulder_roll.pos", "left_arm_bicep_yaw.pos",
    ]);
    // Sides stay whole: the left arm finishes before the right one starts,
    // rather than interleaving the two shoulder_pitches.
    expect(rows[7].key).toBe("left_arm_gripper.pos");
    expect(rows[8].key).toBe("right_arm_shoulder_pitch.pos");
    expect(rows.slice(-2).map((r) => r.key)).toEqual(["theta.vel", "x.vel"]);
    expect(rows.find((r) => r.key === "x.vel")?.advertised).toBe(false);
    // No scale is known for a base velocity, so no bar is drawn for it.
    expect(rows.find((r) => r.key === "x.vel")?.barFrac).toBeNull();
  });

  it("carries value, bar position, SI and flow for a live joint", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe({ "left_arm_shoulder_roll.pos": 0, "lift.pos": 360 }, 1000);
    tr.observe({ "left_arm_shoulder_roll.pos": 50, "lift.pos": 360 }, 1100);
    const rows = buildJointRows(tr.sample(1100), d);
    const roll = rows.find((r) => r.key === "left_arm_shoulder_roll.pos")!;
    expect(roll.value).toBe(50);
    expect(roll.frac).toBeCloseTo(0.75, 10);
    expect(roll.barFrac).toBeCloseTo(0.75, 10);
    expect(roll.outOfRange).toBe(false);
    expect(roll.si).toMatchObject({ known: true, unit: "rad" });
    expect(roll.si.value).toBeCloseTo(-1.5 + 0.75 * 4, 10);
    expect(roll.flow?.sinceChangedMs).toBe(0);

    const lift = rows.find((r) => r.key === "lift.pos")!;
    expect(lift.si).toMatchObject({ known: true, unit: "mm", value: 360 });
    expect(lift.frac).toBeCloseTo(0.5, 10); // against the advertised [0, 720]
    expect(lift.flow?.sinceChangedMs).toBeNull(); // parked, never observed to change
  });

  it("clamps the BAR but not the printed value when a joint reads past its bound", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe({ "left_arm_shoulder_roll.pos": 140 }, 1000);
    const roll = buildJointRows(tr.sample(1000), d)
      .find((r) => r.key === "left_arm_shoulder_roll.pos")!;
    expect(roll.outOfRange).toBe(true);
    expect(roll.frac).toBeCloseTo(1.2, 10);
    expect(roll.barFrac).toBe(1);
    expect(roll.si.value).toBeCloseTo(-1.5 + 1.2 * 4, 10);
  });

  it("works with no descriptor at all — rows come purely from what arrived", () => {
    const tr = new TelemetryFlowTracker();
    tr.observe({ "left_arm_wrist_roll.pos": 25, "right_lift.pos": 88 }, 1000);
    const rows = buildJointRows(tr.sample(1000), null);
    expect(rows.map((r) => r.key)).toEqual(["left_arm_wrist_roll.pos", "right_lift.pos"]);
    expect(rows.every((r) => !r.advertised)).toBe(true);
    // Conventions still place the bar, but no SI is invented for the arm joint.
    expect(rows[0].frac).toBeCloseTo(0.625, 10);
    expect(rows[0].si.reason).toBe("no_ranges_si");
    expect(rows[1].si).toMatchObject({ known: true, unit: "mm", value: 88 });
  });

  it("groups by side and drops empty groups", () => {
    const groups = groupJointRows(buildJointRows(null, d));
    expect(groups.map((g) => g.side)).toEqual(["left", "right", "other"]);
    expect(groups[0].rows).toHaveLength(8);
    expect(groups[2].rows.map((r) => r.key)).toEqual(["lift.pos"]);

    const oneArm = groupJointRows(buildJointRows(null, {
      joints: ["left_arm_gripper.pos"],
    }));
    expect(oneArm.map((g) => g.side)).toEqual(["left"]);
  });
});

describe("anatomical ordering", () => {
  const A3_SHORTS = [
    "shoulder_pitch", "shoulder_roll", "bicep_yaw", "elbow_pitch",
    "forearm_yaw", "wrist_pitch", "wrist_roll", "gripper",
  ];

  it("extracts the joint short, and nothing for lift/base keys", () => {
    expect(jointShort("left_arm_shoulder_roll.pos")).toBe("shoulder_roll");
    expect(jointShort("right_arm_gripper.pos")).toBe("gripper");
    expect(jointShort("lift.pos")).toBeNull();
    expect(jointShort("x.vel")).toBeNull();
  });

  it("ranks an A3 arm proximal to distal, gripper last", () => {
    const keys = A3_SHORTS.map((s) => `left_arm_${s}.pos`);
    const shuffled = [...keys].sort();          // alphabetical, the old order
    shuffled.sort((a, b) => anatomicalRank(a) - anatomicalRank(b));
    expect(shuffled).toEqual(keys);
  });

  it("ranks an L2 arm proximal to distal too", () => {
    const l2 = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex",
                "wrist_roll", "gripper"].map((s) => `right_arm_${s}.pos`);
    const shuffled = [...l2].sort();
    shuffled.sort((a, b) => anatomicalRank(a) - anatomicalRank(b));
    expect(shuffled).toEqual(l2);
  });

  it("sorts lift and base after every arm joint", () => {
    expect(anatomicalRank("lift.pos")).toBeGreaterThan(
      anatomicalRank("left_arm_gripper.pos"));
    expect(anatomicalRank("x.vel")).toBeGreaterThan(
      anatomicalRank("left_arm_wrist_roll.pos"));
  });

  it("puts an unrecognized joint after the known ones, not first", () => {
    expect(anatomicalRank("left_arm_wrist_yaw.pos")).toBeGreaterThan(
      anatomicalRank("left_arm_gripper.pos") - 1);
    expect(anatomicalRank("left_arm_wrist_yaw.pos")).toBeLessThan(
      anatomicalRank("lift.pos"));
  });

  it("orders rows anatomically even with NO descriptor", () => {
    // The regression: with no ack yet every key fell through to the
    // alphabetical extras path, so the table opened in a nonsense order.
    const tracker = new TelemetryFlowTracker();
    const state: Record<string, number> = {};
    for (const s of A3_SHORTS) state[`left_arm_${s}.pos`] = 0;
    state["lift.pos"] = 200;
    tracker.observe(state, 0);
    const rows = buildJointRows(tracker.sample(0), null);
    expect(rows.map((r) => r.key)).toEqual([
      ...A3_SHORTS.map((s) => `left_arm_${s}.pos`),
      "lift.pos",
    ]);
  });

  it("places an unadvertised key in anatomical position, not at the end", () => {
    const descriptor = {
      joints: ["left_arm_shoulder_pitch.pos", "left_arm_gripper.pos"],
    } as unknown as RobotDescriptor;
    const tracker = new TelemetryFlowTracker();
    tracker.observe({
      "left_arm_shoulder_pitch.pos": 0,
      "left_arm_elbow_pitch.pos": 0,   // arriving but never advertised
      "left_arm_gripper.pos": 0,
    }, 0);
    const rows = buildJointRows(tracker.sample(0), descriptor);
    expect(rows.map((r) => r.key)).toEqual([
      "left_arm_shoulder_pitch.pos",
      "left_arm_elbow_pitch.pos",
      "left_arm_gripper.pos",
    ]);
    // It still reads as unadvertised — ordering must not hide the anomaly.
    expect(rows[1].advertised).toBe(false);
  });
});
