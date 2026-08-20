import { describe, expect, it } from "vitest";

import {
  BLOCKED_ROBOT_MODELS,
  hasUrdfModel,
  usesStylisedSchematic,
  isRobotModelBlocked,
  serialModelCode,
  servoThermalThresholds,
} from "@/nori/robotModels";

describe("serialModelCode", () => {
  it("extracts the model code from a fleet serial", () => {
    expect(serialModelCode("NORI-L2-0042")).toBe("L2");
    expect(serialModelCode("NORI-L3-0007")).toBe("L3");
    expect(serialModelCode("NORI-A3-0000")).toBe("A3");
  });

  it("is casing- and whitespace-insensitive", () => {
    expect(serialModelCode("  nori-l3-1 ")).toBe("L3");
  });

  it("returns null for non-fleet / unrecognized serials", () => {
    expect(serialModelCode("nori-dev")).toBeNull();
    expect(serialModelCode("random-serial")).toBeNull();
    expect(serialModelCode("")).toBeNull();
  });
});

describe("isRobotModelBlocked", () => {
  it("blocks L3 (the shipped default)", () => {
    expect(BLOCKED_ROBOT_MODELS).toContain("L3");
    expect(isRobotModelBlocked("NORI-L3-0007")).toBe(true);
    expect(isRobotModelBlocked(" nori-l3-9 ")).toBe(true);
  });

  it("allows L2", () => {
    expect(isRobotModelBlocked("NORI-L2-0042")).toBe(false);
  });

  it("never blocks unknown / non-fleet serials", () => {
    expect(isRobotModelBlocked("nori-dev")).toBe(false);
    expect(isRobotModelBlocked("whatever")).toBe(false);
  });
});

describe("hasUrdfModel", () => {
  it("is true for A-series robots, which ship a URDF", () => {
    expect(hasUrdfModel("NORI-A3-0000")).toBe(true);
    expect(hasUrdfModel("nori-a3-0012")).toBe(true);
  });

  it("is false for L-series, which use the stylised model", () => {
    expect(hasUrdfModel("NORI-L2-0042")).toBe(false);
    expect(hasUrdfModel("NORI-L3-0007")).toBe(false);
  });

  it("is false for unknown, empty, and missing serials", () => {
    expect(hasUrdfModel("nori-dev")).toBe(false);
    expect(hasUrdfModel("")).toBe(false);
    expect(hasUrdfModel(null)).toBe(false);
    expect(hasUrdfModel(undefined)).toBe(false);
  });
});

describe("usesStylisedSchematic", () => {
  it("keeps the old stylised model for an L2", () => {
    expect(usesStylisedSchematic("NORI-L2-0042")).toBe(true);
    expect(usesStylisedSchematic("  nori-l2-1 ")).toBe(true);
  });

  it("gives the A3 description to everything else, including the A-series", () => {
    expect(usesStylisedSchematic("NORI-A3-0000")).toBe(false);
    expect(usesStylisedSchematic("NORI-L3-0007")).toBe(false);
  });

  it("defaults an unknown or absent serial to the current robot, not the old one", () => {
    // The remote page renders this before the room is known; the A3 is the
    // right thing to show while waiting, not the previous generation.
    expect(usesStylisedSchematic("nori-dev")).toBe(false);
    expect(usesStylisedSchematic("")).toBe(false);
    expect(usesStylisedSchematic(null)).toBe(false);
    expect(usesStylisedSchematic(undefined)).toBe(false);
  });
});

describe("servoThermalThresholds", () => {
  it("uses the A3's 60 C cut for A-series serials", () => {
    expect(servoThermalThresholds("NORI-A3-0001")).toEqual({
      warnC: 52, hotC: 58, cutC: 60,
    });
  });

  it("uses the L2's 58 C cut for L-series serials", () => {
    expect(servoThermalThresholds("NORI-L2-0042").cutC).toBe(58);
    expect(servoThermalThresholds("NORI-L3-0007").cutC).toBe(58);
  });

  it("defaults an unknown serial to the LOWEST cut, so it warns earliest", () => {
    // Guessing high on an unknown robot warns too late -- the one error that
    // costs a servo.
    expect(servoThermalThresholds("dev-room").cutC).toBe(58);
    expect(servoThermalThresholds(null).cutC).toBe(58);
    expect(servoThermalThresholds(undefined).cutC).toBe(58);
  });

  it("keeps red strictly below the cut", () => {
    for (const serial of ["NORI-A3-0001", "NORI-L2-0042", null]) {
      const t = servoThermalThresholds(serial);
      expect(t.warnC).toBeLessThan(t.hotC);
      expect(t.hotC).toBeLessThan(t.cutC);
    }
  });
});
