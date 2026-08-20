// NORI: wires the kinematic drive model + parametric apartment into the URDF
// viewer, and renders the robot's own camera as a picture-in-picture.
//
// Everything here is reversible: startSim() records what it changes and its
// dispose() puts it back, so the page can toggle in and out of sim mode without
// reloading the 6.5 MB of meshes. That constraint is why this is a plain
// function over the existing viewer rather than a second viewer component.

import * as THREE from "three";

import type { URDFViewerElement } from "@/lib/urdfViewerHelpers";
import { buildApartment, PIP_ONLY_LAYER, roomAt, type Apartment } from "./apartment";
import {
  axesFromKeys,
  DEFAULT_DRIVE_GEOMETRY,
  DEFAULT_ROBOT_SLABS,
  rayBoxDistance,
  step,
  wheelRates,
  wrapAngle,
  type DriveGeometry,
  type Pose,
  type RobotSlab,
} from "./driveModel";

/** The four cameras the description actually carries. */
export const CAMERA_VIEWS = [
  { id: "front", label: "Front", frame: "front_camera_optical_frame" },
  { id: "overhead", label: "Overhead", frame: "overhead_camera_optical_frame" },
  { id: "left_wrist", label: "Left wrist", frame: "left_wrist_camera_optical_frame" },
  { id: "right_wrist", label: "Right wrist", frame: "right_wrist_camera_optical_frame" },
] as const;

export type CameraView = (typeof CAMERA_VIEWS)[number]["id"];

/**
 * Picture-in-picture geometry, shared between the WebGL scissor rect and the
 * HTML frame drawn over it. One definition, so the border cannot drift off the
 * image it is supposed to be framing.
 */
export const PIP = {
  widthFraction: 0.28,
  marginPx: 16,
  aspect: 16 / 9,
  /**
   * Width of the opaque bezel drawn AROUND the inset, in CSS pixels.
   *
   * It exists to hide corners. The inset is a WebGL scissor rectangle and a
   * scissor rectangle has square corners, so a rounded frame drawn over it left
   * a little nub of image poking past each corner of the arc. Nothing can round
   * the render itself short of masking it through a render target, so instead
   * the frame is grown by this much and its border painted opaque: the square
   * corners end up underneath the bezel rather than outside the radius.
   */
  bezelPx: 6,
  /** Outer corner radius of that bezel, CSS pixels. */
  radiusPx: 10,
};

/**
 * Nominal vertical field of view for the robot cameras, degrees.
 *
 * A GUESS, and flagged as one. The description publishes where every camera is
 * and which way it points — those are measured — but NOT its intrinsics, so
 * there is no published focal length to derive this from. 43 degrees vertical
 * on a 16:9 frame is about 70 horizontal, typical for the class of module used.
 * Treat the framing as indicative and the pose as exact.
 */
const CAMERA_VFOV = 43;

export type SimState = {
  pose: Pose;
  /** Body speed, m/s. Signed: negative is reversing. */
  speed: number;
  /** Yaw rate, rad/s. */
  turn: number;
  /** Lift extension, m. */
  lift: number;
  /** True while the footprint is resting against something. */
  contact: boolean;
  /** Which room the base is standing in. */
  room: string;
};

export type SimHandle = {
  setCameraView: (view: CameraView | null) => void;
  /** Put the robot back at the starting pose. */
  reset: () => void;
  dispose: () => void;
};

type SimOptions = {
  viewer: URDFViewerElement;
  /** The key light, so its shadow can follow the robot around the apartment. */
  keyLight: THREE.DirectionalLight | null;
  /** The floor grid, hidden while the apartment's own floor is in the scene. */
  grid: THREE.Object3D | null;
  /** Restart TAA accumulation — the image is moving every frame in here. */
  invalidate?: () => void;
  /** Switch the bloom chain off for the duration; see the note where it is called. */
  setBloomEnabled?: (enabled: boolean) => void;
  onState?: (state: SimState) => void;
  initialCameraView?: CameraView | null;
};

/**
 * Read the drive geometry off the loaded description instead of trusting the
 * constants.
 *
 * This is the whole argument for the URDF as a base layer, in eight lines: the
 * track width is the distance between two joint origins and the wheel radius is
 * the radius of a wheel's own collision cylinder, so re-measuring the robot and
 * re-exporting the model is all it takes for the sim to drive correctly. There
 * is no second copy of these numbers to update.
 */
export function measureDriveGeometry(robot: THREE.Object3D): DriveGeometry {
  const geom = { ...DEFAULT_DRIVE_GEOMETRY };
  const joints = (robot as unknown as { joints?: Record<string, THREE.Object3D> }).joints;
  const left = joints?.left_wheel_joint;
  const right = joints?.right_wheel_joint;
  if (left && right) {
    const separation = Math.abs(left.position.y - right.position.y);
    if (separation > 0.05) geom.wheelSeparation = separation;
  }
  const links = (robot as unknown as { links?: Record<string, THREE.Object3D> }).links;
  const wheel = links?.left_wheel_link;
  if (wheel) {
    let radius = 0;
    wheel.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.CylinderGeometry | undefined;
      const p = g?.parameters as { radiusTop?: number } | undefined;
      if (p?.radiusTop) radius = Math.max(radius, p.radiusTop);
    });
    if (radius > 0.01) geom.wheelRadius = radius;
  }
  return geom;
}

/** Height of each measured slice of the robot, metres. */
const SLAB_HEIGHT = 0.15;

/**
 * Slice the robot's own collision geometry into height bands, each a rectangle
 * in the robot's frame.
 *
 * This is what the robot is collided as. Measuring it rather than declaring it
 * means the collider is the shape the published description actually has, at
 * the pose it is actually in — tuck the arms and the robot narrows, drag one
 * out and it widens, raise the lift and the upper bands move up with it.
 *
 * URDFCollider is a CONTAINER in urdf-loader, not a mesh; the primitives are
 * meshes underneath it. Traversing for `isMesh && isURDFCollider` finds nothing
 * at all, silently, and returns an empty collider.
 */
export function measureRobotSlabs(robot: THREE.Object3D): RobotSlab[] {
  robot.updateMatrixWorld(true);
  const toRobot = robot.matrixWorld.clone().invert();
  const corner = new THREE.Vector3();

  // One entry per collision primitive: its own box in the robot's frame.
  const parts: RobotSlab[] = [];
  robot.traverse((node) => {
    if (!(node as unknown as { isURDFCollider?: boolean }).isURDFCollider) return;
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) return;
      const part = {
        minX: Infinity, maxX: -Infinity,
        minY: Infinity, maxY: -Infinity,
        minZ: Infinity, maxZ: -Infinity,
      };
      for (const x of [bb.min.x, bb.max.x])
        for (const y of [bb.min.y, bb.max.y])
          for (const z of [bb.min.z, bb.max.z]) {
            corner.set(x, y, z).applyMatrix4(mesh.matrixWorld).applyMatrix4(toRobot);
            part.minX = Math.min(part.minX, corner.x);
            part.maxX = Math.max(part.maxX, corner.x);
            part.minY = Math.min(part.minY, corner.y);
            part.maxY = Math.max(part.maxY, corner.y);
            part.minZ = Math.min(part.minZ, corner.z);
            part.maxZ = Math.max(part.maxZ, corner.z);
          }
      parts.push(part);
    });
  });
  if (!parts.length) return [...DEFAULT_ROBOT_SLABS];

  // Gather them into bands. A part that spans several bands widens all of them,
  // which is what keeps this conservative: the collider never sits inside the
  // robot, only ever on or outside it.
  const top = Math.max(...parts.map((p) => p.maxZ));
  const bandCount = Math.max(1, Math.ceil(top / SLAB_HEIGHT));
  const slabs: RobotSlab[] = [];
  for (let i = 0; i < bandCount; i++) {
    const minZ = i * SLAB_HEIGHT;
    const maxZ = minZ + SLAB_HEIGHT;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const part of parts) {
      if (part.maxZ <= minZ || part.minZ >= maxZ) continue;
      minX = Math.min(minX, part.minX);
      maxX = Math.max(maxX, part.maxX);
      minY = Math.min(minY, part.minY);
      maxY = Math.max(maxY, part.maxY);
    }
    // Bands with nothing in them are simply absent — a gap in the robot is a
    // gap it can be driven through something with.
    if (minX < maxX) slabs.push({ minZ, maxZ, minX, maxX, minY, maxY });
  }
  return slabs.length ? slabs : [...DEFAULT_ROBOT_SLABS];
}

/** Ignore driving keys while the user is typing into something. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

/**
 * The sim currently running, if any.
 *
 * There must only ever be one. Two live instances share the robot but keep
 * SEPARATE copies of the pose they are driving toward — so both write the lift
 * joint every frame from their own accumulator, and the visible result is a
 * lift that jumps between the two values, or snaps back to zero the moment the
 * younger instance takes a turn. Same for the wheels and the base pose.
 *
 * A React effect cleans up after itself, so this should be impossible. It is
 * not impossible during development: a hot module replacement can leave the
 * previous module's animation frame loop and key listeners alive next to the
 * new one. Adopting the previous instance and disposing it here costs a line
 * and removes the whole failure mode.
 */
let running: SimHandle | null = null;

export function startSim(opts: SimOptions): SimHandle | null {
  running?.dispose();
  const { viewer, keyLight, grid, invalidate, onState, setBloomEnabled } = opts;
  const robot = viewer.robot as
    | (THREE.Object3D & {
        joints?: Record<
          string,
          THREE.Object3D & {
            setJointValue: (v: number) => boolean;
            limit?: { lower?: number; upper?: number; velocity?: number };
          }
        >;
        links?: Record<string, THREE.Object3D>;
      })
    | undefined;
  const world = (viewer as unknown as { world?: THREE.Object3D }).world;
  const renderer = (viewer as unknown as { renderer?: THREE.WebGLRenderer }).renderer;
  const scene = viewer.scene;
  const camera = viewer.camera;
  const controls = viewer.controls as unknown as {
    target: THREE.Vector3;
    update: () => void;
    maxPolarAngle: number;
  };
  if (!robot || !world || !renderer) return null;

  const geom = measureDriveGeometry(robot);
  const apartment: Apartment = buildApartment();
  world.add(apartment.group);

  // ---- record everything we are about to change, for dispose()
  const restore = {
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    cameraPosition: camera.position.clone(),
    target: controls.target.clone(),
    robotPosition: robot.position.clone(),
    robotQuaternion: robot.quaternion.clone(),
    gridVisible: grid?.visible ?? true,
    autoRecenter: !viewer.hasAttribute("no-auto-recenter"),
    maxPolarAngle: controls.maxPolarAngle,
    background: scene.background,
    environmentIntensity: scene.environmentIntensity,
    exposure: renderer.toneMappingExposure,
    keyLightPosition: keyLight?.position.clone() ?? null,
    shadowBounds: keyLight
      ? (() => {
          const c = keyLight.shadow.camera as THREE.OrthographicCamera;
          return { left: c.left, right: c.right, top: c.top, bottom: c.bottom, far: c.far };
        })()
      : null,
  };

  // The element re-frames the camera on the robot's bounding box every frame
  // and parks its shadow plane under it. Both fight a robot that is driving
  // around a room, so recentring is switched off and the plane hidden — the
  // apartment brings its own floor.
  viewer.setAttribute("no-auto-recenter", "");

  // Render on demand.
  //
  // The viewer element ships with `auto-redraw`, which means it redraws sixty
  // times a second forever whether or not anything changed. That is already
  // wasteful for a static robot on a card; in here each of those frames costs
  // a scene render for the image, another for bloom, two more for ambient
  // occlusion and one for the inset — so a page left open on a laptop spins the
  // fans up and keeps them there.
  //
  // Switching it off hands the schedule to us: the loop below redraws when the
  // robot moves, and the controls listener redraws when the view does. Nothing
  // moving means nothing drawn.
  const hadAutoRedraw = viewer.hasAttribute("auto-redraw");
  viewer.removeAttribute("auto-redraw");
  const onControlsChange = () => viewer.redraw();
  (viewer.controls as unknown as {
    addEventListener?: (t: string, f: () => void) => void;
  }).addEventListener?.("change", onControlsChange);

  // Bloom exists to make the eyes glow. At sim distances they are a handful of
  // pixels, and it is the single most expensive pass in the chain.
  setBloomEnabled?.(false);
  // `no-auto-recenter` is not enough on its own. The element also subscribes
  // recenter() to OrbitControls' `change` event, and THAT path does not consult
  // the flag — so every camera move (including the follow below) snapped the
  // orbit target back onto the robot's bounding box and re-ran the environment
  // update. Neutralised for the duration; restored on the way out.
  const originalRecenter = (viewer as unknown as { recenter: () => void }).recenter;
  (viewer as unknown as { recenter: () => void }).recenter = () => {};
  if (grid) grid.visible = false;
  const elementPlane = (viewer as unknown as { plane?: THREE.Object3D }).plane;
  const planeVisible = elementPlane?.visible ?? true;
  if (elementPlane) elementPlane.visible = false;

  // A 16-degree lens frames a robot beautifully and a room not at all: at that
  // fov you would need to stand outside the building. Widen it, and pull the
  // near/far range out to cover the apartment while keeping the ratio tight
  // enough for SSAO's depth reads (see the note in RobotUrdfViewer).
  camera.fov = 34;
  camera.near = 0.12;
  camera.far = 45;
  camera.updateProjectionMatrix();

  // The viewer's lighting is tuned for ONE robot against a pale flat backdrop:
  // the environment is dialled right down (0.2) and the direct lights carry the
  // shading. Point that at a whole apartment and every surface comes out muddy
  // brown, because there is almost no ambient light for the walls and floor to
  // pick up. An interior needs the environment doing the work, so it goes back
  // up for the duration, with a little exposure to match.
  scene.environmentIntensity = 0.5;
  renderer.toneMappingExposure = 0.78;
  // A flat lift on top of that. The rig has one key and one weak fill, both
  // from the same side, which is flattering on a robot and leaves every
  // away-facing surface of a ROOM — the outside of walls, the backs of
  // furniture — reading as black. This is the floor under that.
  const simFill = new THREE.AmbientLight(0xfff2e0, 0.35);
  scene.add(simFill);

  // And a quieter sky.
  //
  // The viewer's background is a bright paper cream, picked to sit next to the
  // page's own backdrop behind a robot on a card. There are no ceilings here and
  // the walls are cut away, so any low angle looks straight out over them and
  // fills the frame with that cream — which is what "the light from the top is
  // too strong" actually was. A muted tone reads as "beyond the model" and stops
  // washing the robot out.
  const simBackground = new THREE.Color(0xb4ad9d);
  scene.background = simBackground;

  // The key light's shadow camera is sized for a robot standing at the origin.
  // It now travels, so the bounds widen a little and the whole light rides
  // along — a fixed shadow frustum would drop the shadow the moment the robot
  // left the middle of the room.
  const lightOffset = keyLight?.position.clone() ?? null;
  if (keyLight) {
    const c = keyLight.shadow.camera as THREE.OrthographicCamera;
    // Wide enough to cover a whole room around the robot rather than just the
    // robot. The shadow map is 2048 square, so this trades texel density for
    // reach: at +/-4 m that is 256 texels per metre, still several times what a
    // soft contact shadow at this scale needs.
    c.left = c.bottom = -4.0;
    c.right = c.top = 4.0;
    c.far = 26;
    c.updateProjectionMatrix();
    scene.add(keyLight.target);
  }

  // ---- pose the arms for driving
  // The zero pose is a T, which is both unflattering and wider than the
  // doorways. These are the same neutral angles the model page's demo uses.
  // Arms tucked against the body, not the half-open pose used elsewhere.
  //
  // This is a collision decision as much as a visual one. Measured about the
  // robot's own axis: the zero T-pose sweeps 0.73 m, the half-open pose 0.51 m,
  // and this one 0.34 m — barely more than the base itself. Since the drive
  // circle is sized from that measurement (see below), a wide pose would mean a
  // robot that cannot fit through its own doorways.
  const D = Math.PI / 180;
  const neutral: Record<string, number> = {
    left_shoulder_roll_joint: 85 * D,
    right_shoulder_roll_joint: -85 * D,
    left_elbow_pitch_joint: 90 * D,
    right_elbow_pitch_joint: 90 * D,
  };
  // Snapshot every joint this is about to move — the arms, the wheels and the
  // lift — so leaving the sim gives back the pose the user had posed, not the
  // one the sim happened to leave behind.
  const posedJoints = [
    ...Object.keys(neutral),
    "left_wheel_joint",
    "right_wheel_joint",
    "lift_extension_joint",
  ];
  const jointsBefore = new Map<string, number>();
  for (const name of posedJoints) {
    const j = robot.joints?.[name] as unknown as { angle?: number } | undefined;
    if (typeof j?.angle === "number") jointsBefore.set(name, j.angle);
  }
  for (const [name, value] of Object.entries(neutral)) {
    robot.joints?.[name]?.setJointValue(value);
  }
  // Applied straight to the joints, which does not fire the element's event, so
  // the page's joint readout would otherwise still show the zero pose.
  viewer.dispatchEvent(new CustomEvent("angle-change"));

  // The collider is the robot's real shape, re-measured as it moves.
  let slabs: RobotSlab[] = [...DEFAULT_ROBOT_SLABS];
  const applyCollider = () => {
    slabs = measureRobotSlabs(robot);
  };
  applyCollider();

  // ---- driving state
  let pose: Pose = { ...apartment.start };
  let twist = { linear: 0, angular: 0 };
  let contact = false;
  let leftWheelAngle = 0;
  let rightWheelAngle = 0;
  let lift = 0;
  const liftJoint = robot.joints?.lift_extension_joint;
  const liftMax = liftJoint?.limit?.upper ?? 0.7;
  // The description's own velocity limit for the lift, so it raises at the rate
  // the real one does rather than an invented one.
  const liftSpeed = liftJoint?.limit?.velocity ?? 0.15;

  const held = new Set<string>();

  const applyPose = () => {
    robot.position.set(pose.x, pose.y, 0);
    robot.rotation.set(0, 0, pose.yaw);
  };
  applyPose();

  // ---- camera follow
  //
  // `world` is a static container (rotated once to make the Z-up description
  // sit in three's Y-up scene), so a local point maps to world with one matrix
  // multiply and no scene-graph walk.
  const worldPoint = (x: number, y: number, z: number) =>
    new THREE.Vector3(x, y, z).applyMatrix4(world.matrixWorld);

  world.updateMatrixWorld();
  let lastFollow = worldPoint(pose.x, pose.y, 0);

  // Open behind and above the robot, looking down at it. The user can orbit and
  // zoom from here — the follow below moves the camera and its target together,
  // so it preserves whatever view they choose.
  //
  // The height is set by the walls, not by taste. A sight line from the camera
  // down to the robot has to clear the top of any wall it passes over, and at
  // 2.0 m it did not: driving into the next room put a wall exactly in the way
  // and the robot vanished behind it. 3.6 m over 3.2 m of setback clears a 1.0 m
  // wall with room to spare anywhere but hard against one.
  {
    const at = worldPoint(pose.x, pose.y, 0);
    const ahead = worldPoint(pose.x + Math.cos(pose.yaw), pose.y + Math.sin(pose.yaw), 0);
    const forward = ahead.clone().sub(at).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    controls.target.copy(at).addScaledVector(up, 0.5);
    camera.position
      .copy(at)
      .addScaledVector(forward, -3.2)
      .addScaledVector(up, 3.6);
    camera.lookAt(controls.target);
    controls.update();
  }

  // ---- seeing past walls
  //
  // The rooms are full height, so from most angles a wall stands between the
  // camera and the robot. Rather than shoving the camera around to avoid them —
  // which is what a collision arm does, and which fights the viewpoint the user
  // chose every time the robot drives into another room — the camera passes
  // straight through walls, and any wall that is in the way stops drawing for
  // as long as it is in the way.
  const worldInverse = world.matrixWorld.clone().invert();
  const toLocal = (v: THREE.Vector3) => v.clone().applyMatrix4(worldInverse);

  // Stop the orbit just short of the horizontal.
  //
  // This is the ONLY thing keeping the camera above the floor. It passes
  // through geometry by design, so without this cap it can be swung under the
  // building and left looking up at the underside of the slab.
  //
  // 80 degrees rather than 90 for a second reason: the last few degrees put the
  // camera at knee height looking flat along the floor, where most of the frame
  // is whatever lies beyond the model rather than the model itself.
  controls.maxPolarAngle = (80 * Math.PI) / 180;

  // Widen each wall for the test. The sight line is one infinitely thin ray but
  // the robot is two thirds of a metre across, so a wall the centre ray just
  // misses can still be covering half of it. Cheaper and steadier than casting
  // a ray per corner of the robot.
  const SIGHT_MARGIN = 0.45;
  const mainLayers = camera.layers;

  /**
   * How close a blocking wall has to be, in metres, before it gets out of the
   * way.
   *
   * Hiding EVERY wall on the sight line was correct and looked terrible: cross
   * a room and half the flat blinks in and out as different partitions take
   * turns intersecting the line. In practice the only wall that actually spoils
   * the shot is the one right in front of the lens — a wall over by the robot
   * reads as part of the room. So the rule is proximity, not mere intersection.
   */
  const NEAR_WALL = 2.2;
  const localCamera = new THREE.Vector3();
  const localTarget = new THREE.Vector3();
  const sightDir = new THREE.Vector3();

  const hideOccludingWalls = (): boolean => {
    localCamera.copy(toLocal(camera.position));
    localTarget.copy(toLocal(controls.target));
    sightDir.copy(localTarget).sub(localCamera);
    const reach = sightDir.length();
    if (reach < 1e-4) return false;
    sightDir.divideScalar(reach);

    let changed = false;
    for (const wall of apartment.walls) {
      const b = wall.box;
      const hit = rayBoxDistance(
        localCamera,
        sightDir,
        {
          minX: b.minX - SIGHT_MARGIN,
          maxX: b.maxX + SIGHT_MARGIN,
          minY: b.minY - SIGHT_MARGIN,
          maxY: b.maxY + SIGHT_MARGIN,
          minZ: b.minZ,
          maxZ: b.maxZ,
        },
        reach
      );
      const blocking = hit !== null && hit < NEAR_WALL;
      // Moved to the inset's layer rather than hidden outright. The chase camera
      // stops drawing it; the robot's own camera, which has that layer enabled,
      // carries on seeing a solid wall — which it must, since a first-person
      // view with a hole punched in it is worse than one with a wall in it.
      const hiddenNow = !wall.mesh.layers.test(mainLayers);
      if (hiddenNow !== blocking) {
        wall.mesh.layers.set(blocking ? PIP_ONLY_LAYER : 0);
        changed = true;
      }
    }
    return changed;
  };

  // ---- picture-in-picture camera
  const pipCamera = new THREE.PerspectiveCamera(CAMERA_VFOV, PIP.aspect, 0.03, 40);
  // The robot's camera, and only the robot's camera, sees the walls at their
  // real height. See PIP_ONLY_LAYER in apartment.ts.
  pipCamera.layers.enable(PIP_ONLY_LAYER);
  let pipView: CameraView | null = opts.initialCameraView ?? "front";

  const mountPip = (view: CameraView | null) => {
    pipCamera.removeFromParent();
    pipView = view;
    if (!view) return;
    const entry = CAMERA_VIEWS.find((v) => v.id === view);
    const frame = entry && robot.links?.[entry.frame];
    if (!frame) {
      pipView = null;
      return;
    }
    frame.add(pipCamera);
    pipCamera.position.set(0, 0, 0);
    // ROS optical frames are +z forward, +x right, +y DOWN; a three.js camera
    // looks down its own -z with +y up. A half turn about x reconciles the two,
    // which is the whole of the conversion — the frame itself already carries
    // the measured mount pose from the description.
    pipCamera.rotation.set(Math.PI, 0, 0);
  };
  mountPip(pipView);

  // ---- render the PiP right after the main image
  //
  // The viewer element owns its render loop and calls renderer.render directly,
  // and post-processing has already wrapped that call to run the composer. So
  // this wraps it once more: main image first (through whatever is underneath),
  // then a second pass from the robot's camera into a scissored corner.
  //
  // The guard matters twice over. `busy` stops the composer's own internal
  // render calls — which pass the same scene and camera — from recursing, and
  // the camera check means the PiP's own render falls straight through to the
  // layer below instead of triggering another PiP.
  const previousRender = renderer.render.bind(renderer);
  let busy = false;
  const bufferSize = new THREE.Vector2();
  const prevViewport = new THREE.Vector4();
  const prevScissor = new THREE.Vector4();
  const prevClearColor = new THREE.Color();

  const renderPip = () => {
    if (!pipView || !pipCamera.parent) return;
    // CSS pixels, NOT drawing-buffer pixels. setViewport and setScissor both
    // multiply by the renderer's pixel ratio internally, so measuring the
    // canvas in device pixels here drew the inset at twice its size, off the
    // corner of the screen, on every retina display — while looking perfect at
    // a pixel ratio of 1.
    renderer.getSize(bufferSize);
    const w = Math.round(bufferSize.x * PIP.widthFraction);
    const h = Math.round(w / PIP.aspect);
    if (w < 32 || h < 32) return;
    const x = bufferSize.x - w - PIP.marginPx;
    // WebGL's viewport origin is bottom-left; the frame is drawn top-right.
    const y = bufferSize.y - h - PIP.marginPx;

    pipCamera.aspect = w / h;
    pipCamera.updateProjectionMatrix();

    // Save the clear colour, because rendering a scene that HAS a background
    // colour silently changes it. See the note where it is restored below.
    renderer.getClearColor(prevClearColor);
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.getViewport(prevViewport);
    renderer.getScissor(prevScissor);
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);
    // autoClear is left ON: the clear is scissored too, so this paints the
    // scene background into the inset and nowhere else.
    renderer.render(scene, pipCamera);
    renderer.setViewport(prevViewport);
    renderer.setScissor(prevScissor);

    // Put the clear colour back, and do it through setClearColor so the change
    // reaches the GL state and not just three's bookkeeping.
    //
    // This one is worth spelling out. three sets the GL clear value from
    // `scene.background` on every render, and never puts it back — so after
    // this inset render it is the sky colour, at full alpha. EffectComposer's
    // RenderPass then calls `renderer.clear()` BEFORE the background module
    // gets a chance to reset it, which means the bloom pass's input target was
    // being cleared to a mid-bright colour across its whole surface. The bloom
    // threshold is 0 (the layer is what selects, not brightness), so all of it
    // bloomed, and a bright veil washed over the entire viewport — but only
    // while the inset was on, and regardless of what the inset was pointing at.
    renderer.setClearColor(prevClearColor, prevClearAlpha);

    // ALWAYS off, never "back to what it was".
    //
    // renderer.clear() obeys the scissor test, and the post chain clears its
    // internal targets with it — so a scissor rectangle left enabled here means
    // the next frame's bloom pass clears only this little corner and blurs
    // whatever stale brightness is in the rest of the target, over and over.
    // That is what put a bright veil across the whole viewport whenever the
    // inset was on.
    renderer.setScissorTest(false);
  };

  const patchedRender = (s: THREE.Scene, c: THREE.Camera) => {
    if (busy || s !== scene || c !== camera) return previousRender(s, c);
    busy = true;
    try {
      // Belt and braces against the scissor trap described in renderPip: the
      // composer's very first act is a full-target clear, and it has to be
      // full.
      renderer.setScissorTest(false);
      previousRender(s, c);
    } finally {
      busy = false;
    }
    renderPip();
  };
  (renderer as unknown as { render: unknown }).render = patchedRender;

  // ---- keyboard
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === "r") {
      resetPose();
      return;
    }
    // Only track and swallow keys that actually drive something — anything else
    // has to keep reaching the page, and the browser.
    const drives = axesFromKeys([k]);
    if (!drives.linear && !drives.angular && !drives.lift) return;
    held.add(k);
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => held.delete(e.key.toLowerCase());
  // A window that loses focus never delivers the keyup, which would otherwise
  // leave the robot driving into a wall while the user is in another tab.
  const onBlur = () => held.clear();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  function resetPose() {
    pose = { ...apartment.start };
    twist = { linear: 0, angular: 0 };
    lift = 0;
    held.clear();
    applyPose();
    liftJoint?.setJointValue(0);
  }

  // ---- the loop
  let raf = 0;
  let last = 0;
  let stateAt = 0;
  let jointsAt = 0;
  let lastSignature = "";
  let footprintAt = 0;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (!last) last = now;
    // Clamp: a backgrounded tab resumes with a multi-second gap, and stepping
    // that in one go would teleport the robot through a wall.
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (dt <= 0) return;

    const axes = axesFromKeys(held);
    const next = step({ pose, twist }, axes, dt, slabs, apartment.obstacles);
    const moving =
      Math.abs(next.twist.linear) > 1e-4 ||
      Math.abs(next.twist.angular) > 1e-4 ||
      axes.lift !== 0;
    pose = next.pose;
    twist = next.twist;
    contact = next.contact;

    if (moving) {
      applyPose();

      // Wheels turn at the rate their travel implies — the detail that makes
      // this read as driving rather than sliding. Wrapped so the accumulated
      // angle never grows large enough to lose float precision.
      const rates = wheelRates(twist, geom);
      leftWheelAngle = wrapAngle(leftWheelAngle + rates.left * dt);
      rightWheelAngle = wrapAngle(rightWheelAngle + rates.right * dt);
      robot.joints?.left_wheel_joint?.setJointValue(leftWheelAngle);
      robot.joints?.right_wheel_joint?.setJointValue(rightWheelAngle);

      if (axes.lift !== 0 && liftJoint) {
        lift = Math.max(0, Math.min(liftMax, lift + axes.lift * liftSpeed * dt));
        // Straight to the joint, not through viewer.setJointValue: the element's
        // wrapper fires `angle-change`, and at 60 Hz that would drive a React
        // state update per frame in the page above. The mimic joint (the lift's
        // middle stage, which travels at half this rate) is applied by
        // URDFJoint.setJointValue either way — it is a property of the model,
        // not of how it was called.
        liftJoint.setJointValue(lift);
      }

      // Follow: move the camera AND its orbit target by the same delta, so the
      // user's chosen angle and zoom survive.
      const followTo = worldPoint(pose.x, pose.y, 0);
      const delta = followTo.clone().sub(lastFollow);
      camera.position.add(delta);
      controls.target.add(delta);
      lastFollow = followTo;

      if (keyLight && lightOffset) {
        keyLight.position.copy(followTo).add(lightOffset);
        keyLight.target.position.copy(followTo);
        keyLight.target.updateMatrixWorld();
      }

      invalidate?.();

      // The joint readout in the page should track the lift, but not sixty
      // times a second. Ten is well past what anyone can read.
      if (now - jointsAt > 100) {
        jointsAt = now;
        viewer.dispatchEvent(new CustomEvent("angle-change"));
      }
    }

    // Cheap enough at 4 Hz, and it means dragging an arm out while driving
    // actually changes what the robot collides with.
    if (now - footprintAt > 250) {
      footprintAt = now;
      applyCollider();
    }

    // Outside the `moving` block on purpose: the view can be orbited while the
    // robot stands still, and that changes which walls are in the way.
    controls.update();
    if (hideOccludingWalls() || moving) viewer.redraw();

    if (onState && now - stateAt > 90) {
      stateAt = now;
      const next: SimState = {
        pose,
        speed: twist.linear,
        turn: twist.angular,
        lift,
        contact,
        room: roomAt(pose.x, pose.y),
      };
      // Only when it changed. This lands in React state, and re-rendering the
      // page eleven times a second to redisplay "0.00 m/s" is exactly the kind
      // of idle work the on-demand rendering above is there to avoid.
      const signature = `${next.room}|${next.contact}|${next.speed.toFixed(2)}|${next.turn.toFixed(2)}|${Math.round(next.lift * 1000)}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        onState(next);
      }
    }
  };
  raf = requestAnimationFrame(tick);

  // With auto-redraw off nothing is scheduled until something moves, so the
  // first frame has to be asked for.
  viewer.redraw();

  const handle: SimHandle = {
    setCameraView: (view) => {
      mountPip(view);
      viewer.redraw();
    },
    reset: resetPose,
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      // Only unwind if ours is still the outermost patch. On teardown the
      // post-processing chain may already have restored its own original, and
      // putting a stale wrapper back over that would point the render call at a
      // disposed composer.
      if ((renderer as unknown as { render: unknown }).render === patchedRender) {
        (renderer as unknown as { render: unknown }).render = previousRender;
      }
      pipCamera.removeFromParent();

      for (const wall of apartment.walls) wall.mesh.layers.set(0);
      world.remove(apartment.group);
      apartment.dispose();

      // Before touching the camera: controls.update() enforces the polar limit,
      // so restoring the limit afterwards would let it clamp the very position
      // being restored — the view came back tilted a few degrees higher than it
      // started every time.
      controls.maxPolarAngle = restore.maxPolarAngle;
      camera.fov = restore.fov;
      camera.near = restore.near;
      camera.far = restore.far;
      camera.position.copy(restore.cameraPosition);
      camera.updateProjectionMatrix();
      controls.target.copy(restore.target);
      controls.update();

      robot.position.copy(restore.robotPosition);
      robot.quaternion.copy(restore.robotQuaternion);
      for (const [name, value] of jointsBefore) {
        robot.joints?.[name]?.setJointValue(value);
      }

      scene.remove(simFill);
      simFill.dispose();
      scene.background = restore.background;
      simBackground.set(0x000000);
      scene.environmentIntensity = restore.environmentIntensity;
      renderer.toneMappingExposure = restore.exposure;
      if (grid) grid.visible = restore.gridVisible;
      if (elementPlane) elementPlane.visible = planeVisible;
      (viewer as unknown as { recenter: () => void }).recenter = originalRecenter;
      if (hadAutoRedraw) viewer.setAttribute("auto-redraw", "true");
      (viewer.controls as unknown as {
        removeEventListener?: (t: string, f: () => void) => void;
      }).removeEventListener?.("change", onControlsChange);
      setBloomEnabled?.(true);
      if (restore.autoRecenter) viewer.removeAttribute("no-auto-recenter");
      if (keyLight && restore.keyLightPosition && restore.shadowBounds) {
        keyLight.position.copy(restore.keyLightPosition);
        const c = keyLight.shadow.camera as THREE.OrthographicCamera;
        c.left = restore.shadowBounds.left;
        c.right = restore.shadowBounds.right;
        c.top = restore.shadowBounds.top;
        c.bottom = restore.shadowBounds.bottom;
        c.far = restore.shadowBounds.far;
        c.updateProjectionMatrix();
        scene.remove(keyLight.target);
      }
      viewer.redraw();
      invalidate?.();
      if (running === handle) running = null;
    },
  };

  running = handle;
  return handle;
}
