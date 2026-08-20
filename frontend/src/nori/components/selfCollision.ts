import * as THREE from "three";
import { OBB } from "three/examples/jsm/math/OBB.js";

/**
 * Kinematic self-collision for the robot model.
 *
 * Deliberately NOT a physics engine. It answers one question — "does this pose
 * put the robot through itself?" — from geometry and joint limits alone, both of
 * which are measured and hardware-verified. It touches none of the model's soft
 * numbers (inertia is estimated, total mass is ~8.7% light, the lift's mass
 * split is a guess), so nothing it reports can be wrong for those reasons.
 *
 * Every collision shape here is a primitive — 23 boxes, 3 cylinders, 2 spheres,
 * no meshes — so an oriented-bounding-box test is exact for the boxes and a
 * tight over-approximation for the rest. 31 bodies is a few hundred pairs,
 * which is nothing per frame.
 */

export type Collider = { link: string; half: THREE.Vector3; object: THREE.Object3D };
export type CollisionPair = { a: string; b: string };

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Pairs that overlap by construction and can never actually collide.
 *
 * The lift's three stages are concentric telescoping tubes — nested inside one
 * another by design — so their bounding boxes intersect at every extension.
 * Reporting that is an artifact of representing tubes as boxes, not a finding,
 * and it would fire constantly and train the reader to ignore the panel.
 *
 * Only add a pair here when the mechanism makes contact impossible. A pair that
 * merely LOOKS wrong belongs in the report.
 */
const NEVER_COLLIDE: ReadonlyArray<[string, string]> = [
  ["lift_bottom_link", "lift_middle_link"],
  ["lift_bottom_link", "lift_top_link"],
  ["lift_middle_link", "lift_top_link"],
  // The torso shell is a cosmetic sleeve around the lift's top section.
  ["torso_shell_link", "lift_top_link"],
  ["torso_shell_link", "lift_middle_link"],
  ["torso_shell_link", "lift_bottom_link"],
  // The two fingers of each claw are geared together and counter-rotate through
  // a mimic joint, so they close in step and cannot drive into one another. They
  // are siblings rather than parent and child, so the adjacency rule above does
  // not cover them, and their boxes overlap across most of the closing range.
  ["left_gripper_link", "left_gripper_idler_link"],
  ["right_gripper_link", "right_gripper_idler_link"],
];
const isLink = (o: THREE.Object3D | null): boolean => !!o && /_link$/i.test(o.name);

function findLink(o: THREE.Object3D | null): string | null {
  let n = o;
  while (n && !isLink(n)) n = n.parent;
  return n ? n.name : null;
}

/** Link pairs that always touch — a joint's own parent and child. Reporting
 *  those would bury the real collisions in noise. */
function adjacency(robot: THREE.Object3D): Set<string> {
  const pairs = new Set<string>();
  robot.traverse((o) => {
    if (!isLink(o)) return;
    const parent = findLink(o.parent);
    if (parent) pairs.add(key(parent, o.name));
  });
  return pairs;
}

/**
 * One collider per collision shape. urdf-loader must have been built with
 * `parseCollision` — without it the robot carries visuals only, this finds
 * nothing, and every pose would silently report "no collisions".
 */
export function collectColliders(robot: THREE.Object3D): Collider[] {
  const out: Collider[] = [];
  robot.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    let n: THREE.Object3D | null = o;
    let isCollider = false;
    while (n && !isCollider) {
      if ((n as unknown as { isURDFCollider?: boolean }).isURDFCollider) isCollider = true;
      n = n.parent;
    }
    if (!isCollider) return;
    const link = findLink(o);
    if (!link) return;
    mesh.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    mesh.geometry.boundingBox!.getSize(size);
    out.push({ link, half: size.multiplyScalar(0.5), object: o });
  });
  return out;
}

const _a = new OBB();
const _b = new OBB();

/** Every pair of links currently intersecting, excluding jointed neighbours. */
export function findCollisions(
  robot: THREE.Object3D,
  colliders: Collider[]
): CollisionPair[] {
  const skip = adjacency(robot);
  NEVER_COLLIDE.forEach(([a, b]) => skip.add(key(a, b)));
  const hits = new Map<string, CollisionPair>();

  const boxes = colliders.map((c) => {
    c.object.updateWorldMatrix(true, false);
    const m = c.object.matrixWorld;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    // Decompose rather than reading the basis directly: OBB wants a pure
    // rotation, and the URDF applies mesh scale on these nodes.
    m.decompose(pos, quat, scale);
    const rot = new THREE.Matrix3().setFromMatrix4(
      new THREE.Matrix4().makeRotationFromQuaternion(quat)
    );
    const half = c.half.clone().multiply(scale.clone().set(
      Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)
    ));
    return { link: c.link, obb: new OBB(pos, half, rot) };
  });

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const x = boxes[i];
      const y = boxes[j];
      if (x.link === y.link) continue;
      const k = key(x.link, y.link);
      if (skip.has(k) || hits.has(k)) continue;
      _a.copy(x.obb);
      _b.copy(y.obb);
      if (_a.intersectsOBB(_b)) hits.set(k, { a: x.link, b: y.link });
    }
  }
  return [...hits.values()];
}
