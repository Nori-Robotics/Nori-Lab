// NORI: a parametric apartment for the in-browser sim.
//
// Built from boxes and cylinders in code rather than loaded as a scanned or
// modelled scene, for three reasons that all matter more than looking pretty:
//
//   1. SCALE IS GUARANTEED. The robot is 1.3 m tall and metric, and the single
//      most common way a downloaded interior asset wastes an afternoon is being
//      authored in centimetres, or in "whatever the artist felt". Every number
//      below is a real-world measurement in metres.
//   2. IT WEIGHS NOTHING. The app bundle is already ~3 MB and the robot meshes
//      6.5 MB; a scanned apartment is 50-300 MB. This is a few hundred bytes of
//      geometry parameters.
//   3. IT MATCHES THE COLLISION MODEL. The robot's own collision geometry in
//      the URDF is deliberately boxes, cylinders and spheres. A room made of
//      the same primitives means what you see IS what you collide with, with
//      nothing approximated in between.
//
// Coordinates are the URDF's: metres, +x forward, +y left, +z up, floor at
// z = 0. The group is added to the viewer's `world` container, which is where
// the robot lives, so these axes line up with the robot's own.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Box2, Box3 } from "./driveModel";

/**
 * Walls are their real height.
 *
 * They used to be cut off at knee height, the architectural-cutaway trick,
 * because a full-height room traps an orbiting camera behind whichever wall it
 * happens to be outside of. That is solved properly now: the chase camera
 * passes straight through walls, and any wall standing between it and the robot
 * hides itself for as long as it is in the way (see hideOccludingWalls in
 * simRuntime). Full rooms, and you can always see in.
 */
const WALL_H = 2.6;
const WALL_T = 0.12;

/**
 * How high the OUTSIDE walls go for the ROBOT's cameras only.
 *
 * Far taller than a room, and not a mistake. There is no ceiling, so a camera
 * low inside the flat looking down its length sees over the far wall into the
 * page's background — which blew out the top of the robot's camera view. The
 * sight line from the front camera (0.51 m, level) rises about 0.39 m per metre
 * travelled, so covering the 9 m diagonal takes a shell around 4.5 m.
 *
 * Only the shell gets this, and only on the inset's layer. Giving it to the
 * main view too would leave the exterior towering two metres over the interior
 * partitions, which looks like a mistake from outside; giving it to the
 * partitions would wall the rooms off from each other in the inset. Cheaper and
 * steadier than a ceiling either way, which would seal the interior into a dark
 * box the key light cannot reach.
 */
const SHELL_WALL_H = 4.6;

export const PIP_ONLY_LAYER = 2;


/** Interior envelope. 9.0 x 7.2 m of floor, about 65 m2 of rooms. */
const BOUNDS = { minX: -1.0, maxX: 8.0, minY: -3.6, maxY: 3.6 };

/** Doorways are 0.95 m clear — the robot's collision circle is 0.66 m across. */
const DOOR = 0.95;

/** One run of wall: where it is, and the mesh the main camera draws for it. */
export type WallSegment = { box: Box3; mesh: THREE.Mesh };

export type Apartment = {
  /** Everything to draw, ready to add to the viewer's `world`. */
  group: THREE.Group;
  /** What the robot collides against, with heights. Decorative items are absent. */
  obstacles: Box3[];
  /**
   * Every wall segment, with the meshes that draw it, so one standing between
   * the camera and the robot can be hidden while it is in the way.
   */
  walls: WallSegment[];
  /** Where the robot starts: in the living room, aimed at the kitchen doorway. */
  start: { x: number; y: number; yaw: number };
  /** Free every buffer this allocated. */
  dispose: () => void;
};

/**
 * Muted, warm, and close to the page's own paper palette so the sim doesn't
 * look like a different product bolted on. Kept low-saturation on purpose: the
 * robot is the only thing here that should draw the eye.
 */
const PALETTE = {
  floor: 0xcbb08a,
  wall: 0xeee6d9,
  wood: 0xa5825d,
  darkWood: 0x6f5642,
  fabric: 0x86937f,
  fabricAlt: 0xb8a894,
  metal: 0xc6c9ce,
  dark: 0x3c3c3f,
  porcelain: 0xf2f1ee,
};

type Solid = {
  /** Centre in the ground plane, metres. */
  x: number;
  y: number;
  /** Footprint, metres. */
  sx: number;
  sy: number;
  /** Height above `base`, metres. */
  h: number;
  color: number;
  /** Underside height. Non-zero for anything mounted off the floor. */
  base?: number;
  /** Round, not rectangular. Uses sx as the diameter. */
  round?: boolean;
  /**
   * Excluded from the collision set. Used for anything the base can drive over
   * (rugs) — NOT for anything it would actually hit.
   */
  passable?: boolean;
  roughness?: number;
  metalness?: number;
  /** Part of the shell or a partition, so it gets an upper section too. */
  wall?: boolean;
  /** An OUTSIDE wall, whose upper section is the tall one. */
  shell?: boolean;
};

/**
 * A straight run of wall with doorways cut out of it.
 *
 * Gaps are given as spans along the run's own axis, which keeps the plan below
 * readable: a doorway is "the wall from here to here isn't there", the same way
 * you'd describe it pointing at a floor plan.
 */
function wallRun(
  axis: "x" | "y",
  fixed: number,
  from: number,
  to: number,
  gaps: Array<[number, number]> = [],
  shell = false
): Solid[] {
  const out: Solid[] = [];
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  let cursor = from;
  const emit = (a: number, b: number) => {
    if (b - a < 1e-6) return;
    const mid = (a + b) / 2;
    const len = b - a;
    out.push(
      axis === "x"
        ? { x: mid, y: fixed, sx: len, sy: WALL_T, h: WALL_H, color: PALETTE.wall, roughness: 0.95, wall: true, shell }
        : { x: fixed, y: mid, sx: WALL_T, sy: len, h: WALL_H, color: PALETTE.wall, roughness: 0.95, wall: true, shell }
    );
  };
  for (const [a, b] of sorted) {
    emit(cursor, a);
    cursor = b;
  }
  emit(cursor, to);
  return out;
}

/** Centre a doorway of the standard width on `at`. */
const doorAt = (at: number): [number, number] => [at - DOOR / 2, at + DOOR / 2];

/**
 * The floor plan. A two-bedroom-sized flat: living room and kitchen/dining
 * across the south half, bedroom / bathroom / study across the north, all off a
 * single dividing wall.
 *
 *      y=3.6  +-------------------+---------+-----------+
 *             |     bedroom       | bathrm  |   study   |
 *      y=1.2  +----[ ]------------+--[ ]----+---[ ]-----+
 *             |                   |                     |
 *             |   living room     [ ]  kitchen/dining   |
 *     y=-3.6  +-------------------+---------------------+
 *            x=-1.0             x=3.6                 x=8.0
 */
function plan(): { solids: Solid[]; start: Apartment["start"] } {
  const { minX, maxX, minY, maxY } = BOUNDS;

  const solids: Solid[] = [
    // --- exterior shell
    ...wallRun("x", minY, minX, maxX, [], true),
    ...wallRun("x", maxY, minX, maxX, [], true),
    ...wallRun("y", minX, minY, maxY, [], true),
    ...wallRun("y", maxX, minY, maxY, [], true),

    // --- the dividing wall, with a door into each of the three north rooms
    ...wallRun("x", 1.2, minX, maxX, [doorAt(1.075), doorAt(4.375), doorAt(6.675)]),
    // --- living | kitchen, with the doorway between them
    ...wallRun("y", 3.6, minY, 1.2, [doorAt(-0.575)]),
    // --- bedroom | bathroom | study
    ...wallRun("y", 3.0, 1.2, maxY),
    ...wallRun("y", 5.2, 1.2, maxY),

    // --- living room
    { x: 0.95, y: -1.95, sx: 2.6, sy: 2.8, h: 0.012, color: PALETTE.fabricAlt, passable: true, roughness: 1 },
    { x: -0.44, y: -1.95, sx: 0.92, sy: 2.1, h: 0.8, color: PALETTE.fabric, roughness: 0.9 },
    { x: 0.95, y: -1.95, sx: 1.1, sy: 0.6, h: 0.42, color: PALETTE.wood },
    { x: 3.3, y: -2.1, sx: 0.42, sy: 1.7, h: 0.5, color: PALETTE.darkWood },
    // The screen, sitting on the unit. Above the floor, so it is drawn but not
    // collided — the base drives under nothing, but it never reaches this either.
    { x: 3.34, y: -2.1, sx: 0.06, sy: 1.3, h: 0.72, base: 0.5, color: PALETTE.dark, passable: true, roughness: 0.25 },
    { x: 1.4, y: 0.92, sx: 0.9, sy: 0.34, h: 1.85, color: PALETTE.wood },
    { x: -0.4, y: 0.55, sx: 0.8, sy: 0.8, h: 0.85, color: PALETTE.fabric, roughness: 0.9 },

    // --- kitchen / dining
    { x: 6.15, y: -3.2, sx: 3.1, sy: 0.65, h: 0.92, color: PALETTE.wood },
    { x: 4.1, y: -3.15, sx: 0.72, sy: 0.72, h: 1.85, color: PALETTE.metal, roughness: 0.3, metalness: 0.7 },
    { x: 5.6, y: -1.5, sx: 1.8, sy: 0.9, h: 0.92, color: PALETTE.wood },
    // Table at seated height, chairs at SEAT height — below the tabletop, the
    // way chairs actually sit when tucked in. As full-height boxes they read as
    // four posts standing around a table.
    { x: 5.85, y: 0.35, sx: 1.6, sy: 0.9, h: 0.75, color: PALETTE.darkWood },
    { x: 5.2, y: 0.35, sx: 0.45, sy: 0.45, h: 0.45, color: PALETTE.wood },
    { x: 6.5, y: 0.35, sx: 0.45, sy: 0.45, h: 0.45, color: PALETTE.wood },
    { x: 5.85, y: -0.28, sx: 0.45, sy: 0.45, h: 0.45, color: PALETTE.wood },
    { x: 5.85, y: 0.88, sx: 0.45, sy: 0.45, h: 0.45, color: PALETTE.wood },

    // --- bedroom
    { x: 0.95, y: 2.75, sx: 2.05, sy: 1.55, h: 0.55, color: PALETTE.fabricAlt, roughness: 0.95 },
    { x: -0.62, y: 2.3, sx: 0.64, sy: 1.7, h: 1.95, color: PALETTE.wood },

    // --- bathroom
    { x: 4.15, y: 3.15, sx: 1.7, sy: 0.75, h: 0.58, color: PALETTE.porcelain, roughness: 0.2 },
    { x: 3.35, y: 2.05, sx: 0.55, sy: 0.48, h: 0.86, color: PALETTE.porcelain, roughness: 0.25 },
    { x: 4.95, y: 2.0, sx: 0.4, sy: 0.66, h: 0.78, color: PALETTE.porcelain, roughness: 0.2 },

    // --- study
    { x: 6.6, y: 3.15, sx: 1.5, sy: 0.7, h: 0.74, color: PALETTE.wood },
    { x: 6.6, y: 2.55, sx: 0.58, sy: 0.58, h: 0.98, color: PALETTE.dark, roughness: 0.7 },
    { x: 7.62, y: 2.2, sx: 0.36, sy: 1.6, h: 1.85, color: PALETTE.darkWood },
  ];

  // Living room, on the centreline of the kitchen doorway and facing it, so the
  // very first press of W drives through it rather than into the sofa.
  //
  // Deliberately toward the MIDDLE of the flat rather than against the west
  // wall. The chase camera stands about 3 m behind the robot, and starting any
  // further west put that camera outside the building — so the view opened on
  // the back of an exterior wall instead of on a room.
  return { solids, start: { x: 2.2, y: -0.575, yaw: 0 } };
}

/**
 * The same five rooms the walls above enclose, as plain rectangles.
 *
 * A second description of the layout, which is normally a smell — but the walls
 * are runs-with-gaps and deriving "which room is this point in" from them means
 * flood-filling a floor plan. Five rectangles is the honest trade. They are
 * checked against the wall coordinates by the unit test.
 */
const ROOMS = [
  { name: "Living room", minX: -1.0, maxX: 3.6, minY: -3.6, maxY: 1.2 },
  { name: "Kitchen", minX: 3.6, maxX: 8.0, minY: -3.6, maxY: 1.2 },
  { name: "Bedroom", minX: -1.0, maxX: 3.0, minY: 1.2, maxY: 3.6 },
  { name: "Bathroom", minX: 3.0, maxX: 5.2, minY: 1.2, maxY: 3.6 },
  { name: "Study", minX: 5.2, maxX: 8.0, minY: 1.2, maxY: 3.6 },
] as const;

/** Which room a ground-plane point falls in. "Doorway" while between two. */
export function roomAt(x: number, y: number): string {
  for (const r of ROOMS) {
    if (x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY) return r.name;
  }
  return "Doorway";
}

/** Footprint of a solid, as the drive model wants it. */
const footprint = (s: Solid): Box2 => ({
  minX: s.x - s.sx / 2,
  maxX: s.x + s.sx / 2,
  minY: s.y - s.sy / 2,
  maxY: s.y + s.sy / 2,
});

/** The same, with the height band it occupies — what the robot collides with. */
const volume = (s: Solid): Box3 => ({
  ...footprint(s),
  minZ: s.base ?? 0,
  maxZ: (s.base ?? 0) + s.h,
});

export function buildApartment(): Apartment {
  const group = new THREE.Group();
  group.name = "nori-sim-apartment";

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // One material per distinct look, shared across every solid that uses it.
  // ~40 solids drawn with ~10 materials rather than 40 keeps the draw calls
  // batched and the disposal list short.
  const matCache = new Map<string, THREE.MeshStandardMaterial>();
  const lookKey = (s: Pick<Solid, "color" | "roughness" | "metalness">) =>
    `${s.color}|${s.roughness ?? 0.8}|${s.metalness ?? 0}`;
  const materialFor = (color: number, roughness = 0.8, metalness = 0.0) => {
    const key = `${color}|${roughness}|${metalness}`;
    const hit = matCache.get(key);
    if (hit) return hit;
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    matCache.set(key, m);
    materials.push(m);
    return m;
  };

  /**
   * Furniture waiting to be merged, gathered by the look it is drawn with.
   *
   * Every piece is a separate box, and a separate box is a separate draw call
   * in every pass — the main image, the shadow map, each anti-aliasing sample,
   * the bloom blackout, the inset. Nothing about a sofa needs to be addressed
   * individually, so they are baked into one geometry per material and drawn in
   * one call each. WALLS are excluded: those get hidden individually when they
   * stand between the camera and the robot, which needs a mesh apiece.
   */
  const mergeable = new Map<
    string,
    { material: THREE.MeshStandardMaterial; parts: THREE.BufferGeometry[] }
  >();

  const add = (mesh: THREE.Mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Invisible to raycasts, for exactly the reason the floor grid is (see
    // RobotUrdfViewer): urdf-loader's PointerURDFDragControls raycasts the WHOLE
    // scene and takes the nearest hit, so a room full of furniture in front of
    // the robot would win every pick and joint dragging would stop working.
    mesh.raycast = () => {};
    group.add(mesh);
  };

  // Floor. Exactly the outer face of the walls — the plan sits on its own
  // footprint with no apron, which is what stops the model reading as a diorama
  // on a tray. Sunk just below zero so it can never z-fight with a rug or with
  // the robot's wheel contact patch.
  const floorGeo = new THREE.BoxGeometry(
    BOUNDS.maxX - BOUNDS.minX + WALL_T,
    BOUNDS.maxY - BOUNDS.minY + WALL_T,
    0.04
  );
  geometries.push(floorGeo);
  const floor = new THREE.Mesh(floorGeo, materialFor(PALETTE.floor, 0.75));
  floor.position.set(
    (BOUNDS.minX + BOUNDS.maxX) / 2,
    (BOUNDS.minY + BOUNDS.maxY) / 2,
    -0.021
  );
  floor.castShadow = false;
  add(floor);

  // The extra height only the robot's cameras see, on the shell alone.
  //
  // NOT added to the wall segment. Segments are the things the chase camera
  // hides to see past, and this section is already invisible to it — while the
  // robot's own camera, which does see it, must keep seeing it.
  const addShellUpper = (s: Solid, wall: THREE.Mesh) => {
    if (!s.shell) return;
    const upperH = SHELL_WALL_H - s.h;
    const upperGeo = new THREE.BoxGeometry(s.sx, s.sy, upperH);
    geometries.push(upperGeo);
    const upper = new THREE.Mesh(upperGeo, wall.material);
    upper.position.set(s.x, s.y, s.h + upperH / 2);
    upper.raycast = () => {};
    upper.layers.set(PIP_ONLY_LAYER);
    group.add(upper);
  };

  const { solids, start } = plan();
  const obstacles: Box3[] = [];
  const walls: WallSegment[] = [];

  for (const s of solids) {
    const geo = s.round
      ? new THREE.CylinderGeometry(s.sx / 2, s.sx / 2, s.h, 20)
      : new THREE.BoxGeometry(s.sx, s.sy, s.h);
    // CylinderGeometry is built along ITS OWN +Y. These coordinates are Z-up, so
    // stand it upright; box geometry is already axis-aligned and needs nothing.
    if (s.round) geo.rotateX(Math.PI / 2);
    const material = materialFor(s.color, s.roughness ?? 0.8, s.metalness ?? 0);
    if (!s.passable) obstacles.push(volume(s));

    if (s.wall) {
      geometries.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(s.x, s.y, (s.base ?? 0) + s.h / 2);
      add(mesh);
      walls.push({ box: { ...footprint(s), minZ: 0, maxZ: s.h }, mesh });
      addShellUpper(s, mesh);
      continue;
    }

    // Not a wall: bake its position into the geometry and set it aside to be
    // merged, rather than giving it a mesh of its own.
    geo.translate(s.x, s.y, (s.base ?? 0) + s.h / 2);
    const key = lookKey(s);
    const bucket = mergeable.get(key);
    if (bucket) bucket.parts.push(geo);
    else mergeable.set(key, { material, parts: [geo] });
  }

  for (const { material, parts } of mergeable.values()) {
    const merged = mergeGeometries(parts);
    // Never rendered, so they hold no GPU buffers; disposed anyway rather than
    // leaving the intent unclear.
    parts.forEach((p) => p.dispose());
    if (!merged) continue;
    geometries.push(merged);
    add(new THREE.Mesh(merged, material));
  }

  return {
    group,
    obstacles,
    walls,
    start,
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      group.clear();
    },
  };
}
