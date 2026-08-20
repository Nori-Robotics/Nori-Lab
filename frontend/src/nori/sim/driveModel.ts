// NORI: kinematic differential-drive model for the in-browser sim.
//
// There is NO physics engine here, deliberately. This integrates the unicycle
// model and resolves the base against static boxes as a circle-vs-AABB push-out.
// What that buys: it is exact, deterministic, dependency-free, unit-testable in
// Node, and it cannot explode. What it costs: no friction, no slip, no momentum
// transfer, nothing gets knocked over. That trade is the right one for "drive
// the robot around a room in a browser tab" and the wrong one for anything
// claiming sim-to-real, which is why the page says so.
//
// Every number that describes the ROBOT is read off the published description
// at load time (see measureDriveGeometry in simRuntime) rather than written
// here. The constants below are fallbacks for when that fails, and they are the
// values currently in the URDF.

import { BASE_KEYS, ZLIFT_KEYS } from "@nori/sdk";

/**
 * Extra lift bindings, for the sim only.
 *
 * The robot's own lift keys are `u` and `o`, which sit under the right hand
 * while `wasd` sits under the left — fine at a desk with both hands on the
 * keyboard, awkward when someone is driving one-handed with a mouse in the
 * other. `q` and `e` fall under the same hand as `wasd`.
 *
 * ADDED to the SDK's bindings, not substituted for them: `u` and `o` keep
 * working here exactly as they do on hardware, so nothing anyone learned on a
 * real robot stops working in the sim. Changing the SDK itself would change
 * what a paired robot answers to, which is not this feature's call to make.
 */
export const SIM_LIFT_KEYS: Record<string, number> = { q: 1, e: -1 };

/** Ground pose in the URDF's own frame: +x forward, +y left, yaw about +z. */
export type Pose = { x: number; y: number; yaw: number };

/** Body-frame velocity command. Same two DOFs the real base takes. */
export type Twist = { linear: number; angular: number };

/** Axis-aligned footprint of a wall or a piece of furniture, in metres. */
export type Box2 = { minX: number; minY: number; maxX: number; maxY: number };

/** The same box with a height, for the things the camera has to see around. */
export type Box3 = Box2 & { minZ: number; maxZ: number };

export type DriveGeometry = {
  /** Wheel radius, m — only used to convert body speed into wheel spin. */
  wheelRadius: number;
  /** Track width (distance between the two driven wheels), m. */
  wheelSeparation: number;
};

/**
 * One horizontal slice of the robot, as a rectangle in the robot's OWN frame.
 *
 * The robot is collided as a stack of these rather than as a single circle,
 * because a circle is wrong in both directions at once. The base is 0.38 m long
 * and 0.33 m wide; the circle that contains it is 0.65 m across, so the robot
 * refused to fit through gaps it passes through easily — and it had no height,
 * so an arm held out at 0.6 m collided with a 0.42 m coffee table it should
 * sweep straight over.
 *
 * Slices are measured off the description's own collision primitives, so this
 * is the robot's real shape rather than a hand-written approximation of it, and
 * it changes when the arms or the lift move.
 */
export type RobotSlab = {
  /** Height band this rectangle applies to, metres above the floor. */
  minZ: number;
  maxZ: number;
  /** Extent in the robot frame: +x forward, +y left. Not centred on the origin. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

/**
 * Fallbacks, measured off `nori.urdf`:
 *   wheelRadius       the wheel links' collision cylinders (0.0762 m = 3")
 *   wheelSeparation   |left_wheel_joint.y| + |right_wheel_joint.y| = 0.30
 */
export const DEFAULT_DRIVE_GEOMETRY: DriveGeometry = {
  wheelRadius: 0.0762,
  wheelSeparation: 0.3,
};

/**
 * Fallback shape, for when the loaded model cannot be measured: the chassis and
 * nothing else. base_link's collision plate is 0.35 x 0.20 with its origin
 * 0.133 m behind the wheel axis, and the wheels themselves reach 0.163 m out to
 * each side and 0.076 m fore and aft.
 */
export const DEFAULT_ROBOT_SLABS: readonly RobotSlab[] = [
  { minZ: 0, maxZ: 0.16, minX: -0.31, maxX: 0.08, minY: -0.17, maxY: 0.17 },
];

/**
 * Speed envelope. Below what the hardware will do, on purpose: this is a
 * viewport a few metres wide and a robot that crosses it in one second is
 * unreadable. Acceleration limits exist for the same reason — instant velocity
 * steps read as teleporting.
 */
export const DRIVE_LIMITS = {
  maxLinear: 0.65, // m/s
  maxAngular: 1.5, // rad/s
  linearAccel: 1.8, // m/s^2
  angularAccel: 6.0, // rad/s^2
};

/** Normalised -1..1 demand on each DOF the keyboard can drive. */
export type Axes = { linear: number; angular: number; lift: number };

/**
 * Held keys -> axis demands, using the SDK's OWN keymaps.
 *
 * Imported rather than redeclared so the sim cannot drift from the real robot:
 * `w`/`s`/`a`/`d` (and `i`/`k`/`j`/`l`) drive the base here for exactly the same
 * reason they do over WebRTC, and `u`/`o` raise and lower the lift. If someone
 * remaps driving in the SDK, this follows. SIM_LIFT_KEYS adds `q`/`e` on top;
 * see the note there for why that one is additive rather than a replacement.
 *
 * Keys arrive lowercased. Opposing keys cancel, so holding `a`+`d` goes
 * straight rather than picking whichever was pressed last.
 */
export function axesFromKeys(held: Iterable<string>): Axes {
  const axes: Axes = { linear: 0, angular: 0, lift: 0 };
  for (const raw of held) {
    const k = raw.toLowerCase();
    const base = BASE_KEYS[k];
    if (base) {
      const [dof, sign] = base;
      if (dof === "linear") axes.linear += sign;
      else if (dof === "angular") axes.angular += sign;
    }
    const lift = ZLIFT_KEYS[k] ?? SIM_LIFT_KEYS[k];
    if (lift !== undefined) axes.lift += lift;
  }
  const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    linear: clamp1(axes.linear),
    angular: clamp1(axes.angular),
    lift: clamp1(axes.lift),
  };
}

/** Move `current` toward `target` at no more than `rate` per second. */
export function approach(
  current: number,
  target: number,
  rate: number,
  dt: number
): number {
  const step = rate * dt;
  const delta = target - current;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

/** Rate-limit a twist toward the commanded one. */
export function approachTwist(
  current: Twist,
  target: Twist,
  dt: number,
  limits = DRIVE_LIMITS
): Twist {
  return {
    linear: approach(current.linear, target.linear, limits.linearAccel, dt),
    angular: approach(current.angular, target.angular, limits.angularAccel, dt),
  };
}

/**
 * Advance the pose by one step, integrating the arc EXACTLY rather than
 * Euler-stepping it.
 *
 * Euler (`x += v*cos(yaw)*dt`) drifts outward on every turn — drive a circle
 * back to your starting heading and you end up metres away from where you
 * began, which on a floor plan reads as the robot sliding through walls. The
 * closed form below costs two extra trig calls and has no such error.
 */
export function integrate(pose: Pose, twist: Twist, dt: number): Pose {
  const { linear: v, angular: w } = twist;
  const yaw = pose.yaw + w * dt;
  // Straight-line case, and the limit that keeps v/w from blowing up as w -> 0.
  if (Math.abs(w) < 1e-6) {
    return {
      x: pose.x + v * Math.cos(pose.yaw) * dt,
      y: pose.y + v * Math.sin(pose.yaw) * dt,
      yaw: wrapAngle(yaw),
    };
  }
  const r = v / w; // signed turning radius
  return {
    x: pose.x + r * (Math.sin(yaw) - Math.sin(pose.yaw)),
    y: pose.y - r * (Math.cos(yaw) - Math.cos(pose.yaw)),
    yaw: wrapAngle(yaw),
  };
}

/** Fold an angle into (-pi, pi]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/**
 * Body twist -> wheel angular rates, rad/s. This is the whole of differential
 * drive: each wheel's ground speed is the body speed plus the turn's
 * contribution at its offset from centreline.
 *
 * Used only to spin the wheel meshes at the rate their travel implies, which is
 * the difference between a robot driving and a robot sliding.
 */
export function wheelRates(
  twist: Twist,
  geom: DriveGeometry
): { left: number; right: number } {
  const half = geom.wheelSeparation / 2;
  return {
    left: (twist.linear - twist.angular * half) / geom.wheelRadius,
    right: (twist.linear + twist.angular * half) / geom.wheelRadius,
  };
}

/**
 * How far, and which way, to push a robot slab out of a box — or null if they
 * are not overlapping.
 *
 * The separating axis test, on the four axes that can matter for two rectangles
 * in a plane: the box's two (world x and y) and the robot's two. If any axis
 * shows a gap they are apart. Otherwise the axis with the SMALLEST overlap is
 * the shortest way out, which is what produces sliding — drive into a wall at
 * an angle and the along-wall component of the motion survives while the
 * into-wall component is cancelled.
 */
function slabPush(
  x: number,
  y: number,
  cos: number,
  sin: number,
  slab: RobotSlab,
  box: Box3
): { x: number; y: number } | null {
  // Slab centre and half-extents in the robot frame, then its centre in world.
  const sx = (slab.minX + slab.maxX) / 2;
  const sy = (slab.minY + slab.maxY) / 2;
  const hx = (slab.maxX - slab.minX) / 2;
  const hy = (slab.maxY - slab.minY) / 2;
  const cx = x + sx * cos - sy * sin;
  const cy = y + sx * sin + sy * cos;

  const bhx = (box.maxX - box.minX) / 2;
  const bhy = (box.maxY - box.minY) / 2;
  const dx = cx - (box.minX + box.maxX) / 2;
  const dy = cy - (box.minY + box.maxY) / 2;

  let bestDepth = Infinity;
  let bestX = 0;
  let bestY = 0;

  // World x, world y, robot forward, robot left.
  const axes = [1, 0, 0, 1, cos, sin, -sin, cos];
  for (let i = 0; i < axes.length; i += 2) {
    const ax = axes[i];
    const ay = axes[i + 1];
    const reachBox = bhx * Math.abs(ax) + bhy * Math.abs(ay);
    const reachSlab =
      hx * Math.abs(ax * cos + ay * sin) + hy * Math.abs(-ax * sin + ay * cos);
    const gap = dx * ax + dy * ay;
    const overlap = reachBox + reachSlab - Math.abs(gap);
    if (overlap <= 0) return null; // a gap on any axis means they are apart
    if (overlap < bestDepth) {
      bestDepth = overlap;
      // Push AWAY from the box. gap === 0 means the centres coincide, where
      // either direction is equally right; pick one rather than producing NaN.
      const away = gap < 0 ? -1 : 1;
      bestX = ax * away;
      bestY = ay * away;
    }
  }
  return { x: bestX * bestDepth, y: bestY * bestDepth };
}

/**
 * Push the robot out of every box any part of it is inside.
 *
 * A slab and a box only ever interact when their HEIGHTS overlap, which is the
 * other half of collidng the real shape: the base stops at the coffee table,
 * and the arm above it does not.
 *
 * Iterated a few times so inside corners (two boxes pushing at right angles)
 * settle instead of ping-ponging between them.
 */
export function resolveCollisions(
  pose: Pose,
  slabs: readonly RobotSlab[],
  boxes: readonly Box3[],
  iterations = 3
): { x: number; y: number; contact: boolean } {
  const cos = Math.cos(pose.yaw);
  const sin = Math.sin(pose.yaw);
  let px = pose.x;
  let py = pose.y;
  let contact = false;

  for (let i = 0; i < iterations; i++) {
    let moved = false;
    for (const box of boxes) {
      for (const slab of slabs) {
        if (slab.maxZ <= box.minZ || slab.minZ >= box.maxZ) continue;
        const push = slabPush(px, py, cos, sin, slab, box);
        if (!push) continue;
        px += push.x;
        py += push.y;
        moved = true;
        contact = true;
      }
    }
    if (!moved) break;
  }
  return { x: px, y: py, contact };
}

/**
 * One simulation step: keys in, new pose out.
 *
 * Split from the caller so the whole of the driving behaviour is reachable from
 * a test with no browser, no WebGL and no robot model.
 */
export function step(
  state: { pose: Pose; twist: Twist },
  axes: Pick<Axes, "linear" | "angular">,
  dt: number,
  slabs: readonly RobotSlab[],
  boxes: readonly Box3[],
  limits = DRIVE_LIMITS
): { pose: Pose; twist: Twist; contact: boolean } {
  const commanded: Twist = {
    linear: axes.linear * limits.maxLinear,
    angular: axes.angular * limits.maxAngular,
  };
  const twist = approachTwist(state.twist, commanded, dt, limits);
  const moved = integrate(state.pose, twist, dt);
  const { x, y, contact } = resolveCollisions(moved, slabs, boxes);
  return {
    pose: { x, y, yaw: moved.yaw },
    // Bleed off forward speed on contact so holding W against a wall doesn't
    // leave the wheels spinning at full rate against something solid.
    twist: contact ? { linear: twist.linear * 0.25, angular: twist.angular } : twist,
    contact,
  };
}

/**
 * Distance along a ray to the near face of a box, or null if it misses.
 *
 * The slab test, written with an explicit parallel case rather than leaning on
 * IEEE infinities. The branchless form is tempting and WRONG here: a ray that
 * grazes exactly along a face makes one bound `0 / 0`, the NaN survives every
 * comparison (they all evaluate false), and the function returns NaN — which
 * then poisons the running minimum in the caller and collapses the camera arm
 * to nothing. That is not hypothetical; it happens the moment the orbit target
 * sits level with the top of the TV unit, which is exactly 0.5 m tall.
 *
 * Everything in the apartment is axis-aligned in the description's own frame,
 * so testing there — rather than transforming boxes into world space — keeps
 * this exact and cheap enough to run against every solid on every frame.
 */
export function rayBoxDistance(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  box: Box3,
  maxDistance: number
): number | null {
  let near = -Infinity;
  let far = Infinity;

  const axis = (o: number, d: number, min: number, max: number): boolean => {
    if (Math.abs(d) < 1e-12) {
      // Parallel to this pair of planes: either the ray is inside the slab for
      // its whole length, in which case this axis constrains nothing, or it is
      // outside and can never enter the box.
      return o >= min && o <= max;
    }
    const t1 = (min - o) / d;
    const t2 = (max - o) / d;
    near = Math.max(near, Math.min(t1, t2));
    far = Math.min(far, Math.max(t1, t2));
    return near <= far;
  };

  if (!axis(origin.x, dir.x, box.minX, box.maxX)) return null;
  if (!axis(origin.y, dir.y, box.minY, box.maxY)) return null;
  if (!axis(origin.z, dir.z, box.minZ, box.maxZ)) return null;

  if (far < 0 || near > maxDistance) return null;
  // A negative `near` means the origin is already inside the box.
  return Math.max(0, near);
}
