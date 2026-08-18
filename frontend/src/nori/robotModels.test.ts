import { describe, expect, it } from "vitest";

import {
  BLOCKED_ROBOT_MODELS,
  isRobotModelBlocked,
  serialModelCode,
} from "@/nori/robotModels";

describe("serialModelCode", () => {
  it("extracts the model code from a fleet serial", () => {
    expect(serialModelCode("NORI-L2-0042")).toBe("L2");
    expect(serialModelCode("NORI-L3-0007")).toBe("L3");
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
