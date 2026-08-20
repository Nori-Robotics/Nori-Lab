// NORI: unit tests for the in-browser sim's drive model.
//
// The whole point of keeping the kinematics free of three.js is that they are
// reachable from Node like this — no WebGL, no canvas, no robot. The apartment
// is pulled in for the last block because "can it actually get through a
// doorway" is the only question about the floor plan worth asserting.

import { describe, expect, it } from "vitest";

import { buildApartment, roomAt } from "./apartment";
import {
  axesFromKeys,
  DEFAULT_DRIVE_GEOMETRY,
  DRIVE_LIMITS,
  integrate,
  DEFAULT_ROBOT_SLABS,
  rayBoxDistance,
  resolveCollisions,
  step,
  wheelRates,
  wrapAngle,
  type Box3,
  type Pose,
  type RobotSlab,
} from "./driveModel";

const geom = DEFAULT_DRIVE_GEOMETRY;

// The chassis alone: 0.39 m long, 0.34 m wide, and only 0.16 m tall — which is
// the point of the type. Its half-width to the left and right is 0.17.
const SLABS = DEFAULT_ROBOT_SLABS;
const HALF_WIDTH = 0.17;
const at = (x: number, y: number, yaw = 0): Pose => ({ x, y, yaw });

describe("axesFromKeys", () => {
  it("drives on the SDK's own base bindings", () => {
    expect(axesFromKeys(["w"]).linear).toBe(1);
    expect(axesFromKeys(["s"]).linear).toBe(-1);
    expect(axesFromKeys(["a"]).angular).toBe(1);
    expect(axesFromKeys(["d"]).angular).toBe(-1);
    // The keypad-style aliases the real robot also answers to.
    expect(axesFromKeys(["i"]).linear).toBe(1);
    expect(axesFromKeys(["k"]).linear).toBe(-1);
    expect(axesFromKeys(["j"]).angular).toBe(1);
    expect(axesFromKeys(["l"]).angular).toBe(-1);
  });

  it("drives the lift on the robot's own u/o", () => {
    expect(axesFromKeys(["u"]).lift).toBe(1);
    expect(axesFromKeys(["o"]).lift).toBe(-1);
  });

  it("also drives the lift on q/e, for one-handed driving", () => {
    expect(axesFromKeys(["q"]).lift).toBe(1);
    expect(axesFromKeys(["e"]).lift).toBe(-1);
    // Additive, so both pairs coexist and opposing ones still cancel.
    expect(axesFromKeys(["q", "o"]).lift).toBe(0);
    expect(axesFromKeys(["u", "e"]).lift).toBe(0);
  });

  it("cancels opposing keys instead of picking one", () => {
    expect(axesFromKeys(["a", "d"]).angular).toBe(0);
    expect(axesFromKeys(["w", "s"]).linear).toBe(0);
  });

  it("ignores keys that drive nothing, and is case-insensitive", () => {
    expect(axesFromKeys(["z", "Escape", "1"])).toEqual({
      linear: 0,
      angular: 0,
      lift: 0,
    });
    expect(axesFromKeys(["W"]).linear).toBe(1);
  });
});

describe("integrate", () => {
  it("goes straight when not turning", () => {
    const p = integrate({ x: 0, y: 0, yaw: 0 }, { linear: 1, angular: 0 }, 2);
    expect(p.x).toBeCloseTo(2, 9);
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.yaw).toBeCloseTo(0, 9);
  });

  it("turns on the spot without translating", () => {
    const p = integrate({ x: 3, y: -1, yaw: 0 }, { linear: 0, angular: 1 }, 1);
    expect(p.x).toBeCloseTo(3, 9);
    expect(p.y).toBeCloseTo(-1, 9);
    expect(p.yaw).toBeCloseTo(1, 9);
  });

  it("closes a full circle exactly — this is why the arc is not Euler-stepped", () => {
    // v/w = 0.5 m radius. One full revolution must land back on the start; an
    // Euler integrator drifts outward by a visible margin here.
    const twist = { linear: 0.5, angular: 1 };
    const steps = 240;
    const dt = (2 * Math.PI) / twist.angular / steps;
    let p: Pose = { x: 0, y: 0, yaw: 0 };
    for (let i = 0; i < steps; i++) p = integrate(p, twist, dt);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });

  it("keeps yaw wrapped", () => {
    const p = integrate({ x: 0, y: 0, yaw: 3.0 }, { linear: 0, angular: 1 }, 1);
    expect(p.yaw).toBeGreaterThan(-Math.PI);
    expect(p.yaw).toBeLessThanOrEqual(Math.PI);
    expect(wrapAngle(4.0)).toBeCloseTo(4.0 - 2 * Math.PI, 12);
  });
});

describe("wheelRates", () => {
  it("spins both wheels together when driving straight", () => {
    const r = wheelRates({ linear: 1, angular: 0 }, geom);
    expect(r.left).toBeCloseTo(r.right, 12);
    expect(r.left).toBeCloseTo(1 / geom.wheelRadius, 12);
  });

  it("spins them opposite when turning on the spot", () => {
    const r = wheelRates({ linear: 0, angular: 1 }, geom);
    expect(r.left).toBeCloseTo(-r.right, 12);
    // Positive yaw rate (left turn) means the RIGHT wheel drives forward.
    expect(r.right).toBeGreaterThan(0);
  });
});

describe("resolveCollisions", () => {
  // A wall across the world, from the floor to head height.
  const wall: Box3 = { minX: -5, maxX: 5, minY: 1, maxY: 1.2, minZ: 0, maxZ: 2.4 };

  it("leaves a clear robot alone", () => {
    const r = resolveCollisions(at(0, -2), SLABS, [wall]);
    expect(r.contact).toBe(false);
    expect(r.x).toBe(0);
    expect(r.y).toBe(-2);
  });

  it("pushes an overlapping robot out to exactly touching", () => {
    const r = resolveCollisions(at(0, 0.9), SLABS, [wall]);
    expect(r.contact).toBe(true);
    expect(r.y).toBeCloseTo(1 - HALF_WIDTH, 9);
    // Along the shortest axis, so it must not have slid sideways.
    expect(r.x).toBeCloseTo(0, 9);
  });

  it("uses the robot's shape and heading, not a circle around it", () => {
    // Side-on to the wall, only the 0.17 m half-width is in the way.
    const alongside = resolveCollisions(at(0, 0.95, 0), SLABS, [wall]);
    expect(alongside.y).toBeCloseTo(1 - HALF_WIDTH, 9);

    // Backed up to it, the plate reaches 0.31 m behind the wheel axis — it is
    // held more than twice as far off, from the same starting point. A circle
    // cannot tell these two apart, which is the whole reason for the change.
    const tailFirst = resolveCollisions(at(0, 0.95, -Math.PI / 2), SLABS, [wall]);
    expect(tailFirst.y).toBeCloseTo(1 - 0.31, 9);
    expect(alongside.y).toBeGreaterThan(tailFirst.y);
  });

  it("ignores a box that is below the part of the robot passing over it", () => {
    // A 0.42 m coffee table against a slab that spans 0.5 to 0.65 m — an arm
    // held out at that height sweeps over it and must not be pushed.
    const arm: RobotSlab = { minZ: 0.5, maxZ: 0.65, minX: -0.1, maxX: 0.6, minY: -0.1, maxY: 0.1 };
    const table: Box3 = { minX: -1, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 0.42 };
    expect(resolveCollisions(at(0, 0.2), [arm], [table]).contact).toBe(false);
    // The same arm against a 0.92 m counter DOES hit it.
    const counter: Box3 = { ...table, maxZ: 0.92 };
    expect(resolveCollisions(at(0, 0.2), [arm], [counter]).contact).toBe(true);
  });

  it("evicts a robot whose centre is inside the box", () => {
    const r = resolveCollisions(at(0, 1.05), SLABS, [wall]);
    expect(r.contact).toBe(true);
    expect(r.y).toBeCloseTo(1 - HALF_WIDTH, 9);
  });

  it("settles in an inside corner rather than ping-ponging", () => {
    const other: Box3 = { minX: 1, maxX: 3, minY: -5, maxY: 5, minZ: 0, maxZ: 2.4 };
    const r = resolveCollisions(at(0.95, 0.95), SLABS, [wall, other]);
    expect(r.x).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y).toBeLessThanOrEqual(1 - HALF_WIDTH + 1e-9);
  });
});

describe("step", () => {
  const wall: Box3 = { minX: -5, maxX: 5, minY: 3, maxY: 3.2, minZ: 0, maxZ: 2.4 };

  it("ramps up to the speed limit rather than jumping to it", () => {
    let s = { pose: at(0, 0), twist: { linear: 0, angular: 0 } };
    const first = step(s, { linear: 1, angular: 0 }, 1 / 60, SLABS, []);
    expect(first.twist.linear).toBeCloseTo(DRIVE_LIMITS.linearAccel / 60, 9);

    for (let i = 0; i < 120; i++) {
      s = step(s, { linear: 1, angular: 0 }, 1 / 60, SLABS, []);
    }
    expect(s.twist.linear).toBeCloseTo(DRIVE_LIMITS.maxLinear, 9);
  });

  it("cannot drive through a wall", () => {
    let s = { pose: at(0, 0, Math.PI / 2), twist: { linear: 0, angular: 0 } };
    let touched = false;
    for (let i = 0; i < 600; i++) {
      const next = step(s, { linear: 1, angular: 0 }, 1 / 60, SLABS, [wall]);
      s = { pose: next.pose, twist: next.twist };
      touched ||= next.contact;
    }
    expect(touched).toBe(true);
    expect(s.pose.y).toBeLessThan(3);
  });

  it("slides along a wall it is driven into at an angle", () => {
    let s = { pose: at(0, 0, Math.PI / 4), twist: { linear: 0, angular: 0 } };
    for (let i = 0; i < 600; i++) {
      const next = step(s, { linear: 1, angular: 0 }, 1 / 60, SLABS, [wall]);
      s = { pose: next.pose, twist: next.twist };
    }
    expect(s.pose.y).toBeLessThan(3);
    expect(s.pose.x).toBeGreaterThan(1);
  });
});

describe("the apartment", () => {
  const apartment = buildApartment();

  it("starts the robot in the living room, clear of everything", () => {
    expect(roomAt(apartment.start.x, apartment.start.y)).toBe("Living room");
    const settled = resolveCollisions(
      { ...apartment.start },
      SLABS,
      apartment.obstacles
    );
    expect(settled.contact).toBe(false);
  });

  it("has doorways the robot actually fits through", () => {
    // Straight out of the start pose, through the kitchen doorway. If the door
    // were too narrow the base would wedge and never reach the far room.
    let s = { pose: { ...apartment.start }, twist: { linear: 0, angular: 0 } };
    for (let i = 0; i < 900; i++) {
      const next = step(s, { linear: 1, angular: 0 }, 1 / 60, SLABS, apartment.obstacles);
      s = { pose: next.pose, twist: next.twist };
    }
    expect(roomAt(s.pose.x, s.pose.y)).toBe("Kitchen");
  });

  it("never lets the base end up inside a solid", () => {
    // Sweep a lap of headings from the middle of the living room and check the
    // resolved pose is always outside every obstacle.
    for (let h = 0; h < 24; h++) {
      let s = {
        pose: { x: 1.5, y: -0.6, yaw: (h / 24) * 2 * Math.PI },
        twist: { linear: 0, angular: 0 },
      };
      for (let i = 0; i < 300; i++) {
        const next = step(s, { linear: 1, angular: 0 }, 1 / 60, SLABS, apartment.obstacles);
        s = { pose: next.pose, twist: next.twist };
      }
      const settled = resolveCollisions(s.pose, SLABS, apartment.obstacles);
      expect(settled.x).toBeCloseTo(s.pose.x, 6);
      expect(settled.y).toBeCloseTo(s.pose.y, 6);
    }
  });

  it("keeps the walls out of the collision set only where doorways are", () => {
    // Every room's centre must be free, or a room is unusable.
    for (const [x, y] of [
      [2.2, -0.5],
      [7.0, -2.0],
      [2.5, 1.75],
      [4.2, 2.3],
      [6.0, 2.0],
    ] as const) {
      const r = resolveCollisions(at(x, y), SLABS, apartment.obstacles);
      expect({ x, y, contact: r.contact }).toEqual({ x, y, contact: false });
    }
  });
});

describe("rayBoxDistance", () => {
  const box: Box3 = { minX: 1, maxX: 2, minY: -1, maxY: 1, minZ: 0, maxZ: 1 };
  const O = { x: 0, y: 0, z: 0.5 };

  it("reports the distance to the near face", () => {
    expect(rayBoxDistance(O, { x: 1, y: 0, z: 0 }, box, 10)).toBeCloseTo(1, 9);
  });

  it("misses when the ray passes over the box", () => {
    expect(rayBoxDistance({ x: 0, y: 0, z: 2 }, { x: 1, y: 0, z: 0 }, box, 10)).toBeNull();
  });

  it("misses when the ray points away", () => {
    expect(rayBoxDistance(O, { x: -1, y: 0, z: 0 }, box, 10)).toBeNull();
  });

  it("respects the search limit, so a distant wall does not shorten the arm", () => {
    expect(rayBoxDistance(O, { x: 1, y: 0, z: 0 }, box, 0.5)).toBeNull();
  });

  it("returns 0 when the origin is already inside", () => {
    expect(rayBoxDistance({ x: 1.5, y: 0, z: 0.5 }, { x: 1, y: 0, z: 0 }, box, 10)).toBe(0);
  });

  it("does not return NaN for a ray grazing exactly along a face", () => {
    // The origin sits exactly level with the top of the box. The branchless
    // slab test makes this 0/0 and returns NaN, which then wipes out the
    // caller's running minimum. Regression guard.
    const grazing = rayBoxDistance({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, box, 10);
    expect(grazing === null || Number.isFinite(grazing)).toBe(true);
    for (const z of [0, 0.5, 1]) {
      const t = rayBoxDistance({ x: 0, y: 0, z }, { x: 1, y: 0, z: 0 }, box, 10);
      expect(Number.isNaN(t as number)).toBe(false);
    }
  });

  it("handles a ray exactly parallel to two of the three slabs", () => {
    // Straight up, offset sideways: parallel to the x and y slabs and clear of
    // both, so the ±Infinity bounds those produce must not manufacture a hit.
    expect(rayBoxDistance({ x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, box, 10)).toBeNull();
    // Straight up from inside the footprint: must hit the underside.
    expect(rayBoxDistance({ x: 1.5, y: 0, z: -2 }, { x: 0, y: 0, z: 1 }, box, 10)).toBeCloseTo(2, 9);
  });
});

describe("walls the camera sees past", () => {
  const apartment = buildApartment();

  const blocked = (
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number }
  ) => {
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const reach = Math.hypot(d.x, d.y, d.z);
    const dir = { x: d.x / reach, y: d.y / reach, z: d.z / reach };
    return apartment.walls.filter(
      (w) => rayBoxDistance(from, dir, w.box, reach) !== null
    ).length;
  };

  it("builds a wall segment for every run, doorways excepted", () => {
    expect(apartment.walls.length).toBeGreaterThan(10);
    // Full height, not a cutaway: the camera passes through them instead.
    expect(Math.max(...apartment.walls.map((w) => w.box.maxZ))).toBeGreaterThan(2);
    // One mesh each — the inset-only upper sections are deliberately not here.
    expect(apartment.walls.every((w) => !!w.mesh)).toBe(true);
  });

  it("finds the wall between a camera outside and the robot inside", () => {
    // Looking in from west of the building at the start pose.
    expect(blocked({ x: -3.5, y: -0.575, z: 2.0 }, { x: 2.2, y: -0.575, z: 0.5 })).toBeGreaterThan(0);
  });

  it("finds nothing between a camera in the same room and the robot", () => {
    // Both inside the living room, well clear of the partitions.
    expect(blocked({ x: 0.2, y: -1.2, z: 1.6 }, { x: 2.2, y: -0.9, z: 0.5 })).toBe(0);
  });

  it("never reports NaN for any angle around the robot", () => {
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * 2 * Math.PI;
      for (const h of [0.6, 1.6, 3.6]) {
        const from = { x: 2.2 + 4 * Math.cos(a), y: -0.575 + 4 * Math.sin(a), z: h };
        expect(Number.isNaN(blocked(from, { x: 2.2, y: -0.575, z: 0.5 }))).toBe(false);
      }
    }
  });
});
