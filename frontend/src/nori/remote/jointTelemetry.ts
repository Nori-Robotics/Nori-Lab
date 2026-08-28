// NORI: Additive file. Pure logic behind the per-joint telemetry readout
// (JointTelemetry in TeleopStatus.tsx, mounted by layout/blocks.tsx).
//
// WHY THIS EXISTS
// `tel.state` is the robot's own per-joint truth and until now it was consumed
// only by the 3D viewer (which poses a model — a wrong number there looks like a
// slightly odd pose) and by hasJointTelemetry() (a boolean). There was no way to
// answer "what does left_arm_shoulder_roll actually read right now, in radians,
// and is that key still arriving?" — which is exactly the question a calibration
// investigation asks. Everything here is deliberately free of React so it can be
// tested directly.
//
// THREE SEPARATE FACTS, KEPT SEPARATE
//   * PRESENT   the key appeared in a frame  -> lastSeen / per-key Hz
//   * CHANGED   its value differed from the previous one -> lastChanged
//   * VALUE     what it reads, normalized and (when the robot advertises
//               calibrated bounds) in SI
// A joint held still legitimately stops CHANGING while still being PRESENT, so
// conflating the two would flag every stationary arm as broken. Only "not
// present" is ever treated as a fault.
//
// UNITS. Telemetry `state` is NORMALIZED (arm joints -100..100, grippers 0..100)
// except the lift keys, which are already physical millimetres. The only exact
// normalized->radian conversion is the robot's own `descriptor.ranges_si`
// (nori-protocol ack.json). When that is absent — the frozen L-series fleet
// never sends it — we say so rather than substituting the URDF's nominal limits
// or any other guess: a plausible wrong angle is worse than no angle in a
// calibration investigation.
//
// RELATIONSHIP TO liveJointPose.ts. That module maps telemetry onto URDF JOINT
// NAMES for the 3D viewer and CLAMPS the normalized fraction to 0..1 before
// interpolating, because a viewer must not fling a mesh past its stop. This
// module is value-per-TELEMETRY-KEY and deliberately does NOT clamp the number
// it prints: a joint reading past its advertised normalized bound is precisely
// the symptom we are hunting, and pinning it at the limit would hide it. The
// BAR is clamped (a bar cannot overflow); the printed value is not, and the row
// is marked out-of-range. Both modules read `ranges_si` the same way, including
// the inverted-bounds rule.

import { RAIL_TRAVEL_MM, type RobotDescriptor } from "@nori/sdk";

// Trailing window every rate is measured over. Long enough that a 15 Hz stream
// gives ~45 samples (a stable number), short enough that a stream stopping
// shows up as a collapsing rate within a few hundred ms rather than a slow
// decay over ten seconds.
export const FLOW_WINDOW_MS = 3000;

// Freshness bands for a key's LAST-SEEN age. At the A3's ~15 Hz a key is
// re-sent every ~67 ms, so 500 ms is already ~7 missed frames.
export const FRESH_MS = 500;
export const SLOW_MS = 2000;

// ---------------------------------------------------------------------------
// key naming

/** True for the lift/rail keys, whose values are already physical millimetres.
 * Both fleet shapes: the A-series bare "lift.pos" and the L-series per-arm
 * "<side>_lift.pos" (see the SDK's rail.ts for why this is never hand-matched
 * as `endsWith("_lift.pos")` alone). */
export function isLiftKey(key: string): boolean {
  return key === "lift.pos" || key.endsWith("_lift.pos");
}

/** Which arm a telemetry key belongs to; "other" for the lift, the base and
 * anything without a side prefix, so an unknown key still gets displayed. */
export function keySide(key: string): "left" | "right" | "other" {
  if (key.startsWith("left_")) return "left";
  if (key.startsWith("right_")) return "right";
  return "other";
}

/** Short readable label: "left_arm_shoulder_roll.pos" -> "L shoulder roll".
 * Mirrors shortMotor() in TeleopStatus.tsx (same L/R prefixing, same
 * underscore stripping) with one addition: telemetry keys carry a ".pos"/".vel"
 * suffix that the current-map keys shortMotor() was written for do not. The
 * suffix is kept for non-".pos" keys ("x.vel" -> "x.vel"), because for the base
 * the quantity IS the distinguishing part. */
export function jointLabel(key: string): string {
  const base = key.endsWith(".pos") ? key.slice(0, -".pos".length) : key;
  return base
    .replace(/^left_arm_/, "L ")
    .replace(/^right_arm_/, "R ")
    .replace(/^left_/, "L ")
    .replace(/^right_/, "R ")
    .replace(/_/g, " ");
}

/** Joint shorts PROXIMAL -> DISTAL, the order an operator reads the arm in.
 *
 * One list covers both fleet vocabularies, interleaved so each yields its own
 * anatomical order: A-series takes shoulder_pitch, shoulder_roll, bicep_yaw,
 * elbow_pitch, forearm_yaw, wrist_pitch, wrist_roll, gripper (matching
 * ARM_JOINT_ORDER in the gateway's calibration.py, which is itself the
 * controller's declared order); L-series takes shoulder_pan, shoulder_lift,
 * elbow_flex, wrist_flex, wrist_roll, gripper. The gripper sorts last on both
 * because it is the most distal thing on the chain.
 *
 * Rows used to inherit whatever order the descriptor listed. That is usually
 * anatomical, but it silently degraded to ALPHABETICAL for any key the
 * descriptor did not advertise, and for the whole table before the ack lands —
 * "bicep yaw, elbow pitch, forearm yaw, gripper, shoulder pitch..." reads as
 * an arbitrary list, and cross-checking it against the keyboard legend (which
 * ranks explicitly) meant hopping between two different orders. Ranking here
 * makes the table's order a property of the ROBOT, not of who filled the
 * descriptor in. */
const ANATOMICAL_ORDER = [
  "shoulder_pan", "shoulder_pitch", "shoulder_roll", "shoulder_lift",
  "bicep_yaw", "elbow_pitch", "elbow_flex", "forearm_yaw",
  "wrist_pitch", "wrist_flex", "wrist_roll", "gripper",
];

/** The joint short inside a telemetry key, or null when there isn't one
 * ("lift.pos", "x.vel"). "left_arm_shoulder_roll.pos" -> "shoulder_roll". */
export function jointShort(key: string): string | null {
  const m = /^(?:left|right)_arm_([a-z0-9_]+)\.pos$/.exec(key);
  return m ? m[1] : null;
}

/** Sort rank for a telemetry key: arm joints proximal->distal, then everything
 * else (lift, base, unknown) after them. Unrecognized joints sort at the end of
 * the arm block rather than vanishing or jumping to the front. */
export function anatomicalRank(key: string): number {
  const short = jointShort(key);
  if (short === null) return ANATOMICAL_ORDER.length + 1;
  const i = ANATOMICAL_ORDER.indexOf(short);
  return i < 0 ? ANATOMICAL_ORDER.length : i;
}

/** Every `state` key the descriptor says this robot HAS, in descriptor order
 * (joints first, then aux/lift) — the list an arriving-key count is measured
 * against. `aux` entries are actuator names without the ".pos" suffix telemetry
 * uses ("lift" -> "lift.pos"), matching liftAxes() in the SDK.
 *
 * `base` is deliberately EXCLUDED. It advertises drivable base DOFs ("x.vel"),
 * which a robot is not obliged to echo in telemetry — counting them would
 * report two permanently "missing" keys on a perfectly healthy A3, and a
 * missing-key alarm that is always on is worth nothing. */
export function advertisedStateKeys(descriptor?: RobotDescriptor | null): string[] {
  if (!descriptor) return [];
  const out: string[] = [];
  const push = (k: string) => { if (!out.includes(k)) out.push(k); };
  for (const j of descriptor.joints ?? []) if (typeof j === "string" && j) push(j);
  for (const a of descriptor.aux ?? []) {
    if (typeof a !== "string" || !a) continue;
    push(a.endsWith(".pos") ? a : `${a}.pos`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// value scaling

/** The normalized span a key's value lives in, and where that span came from. */
export interface NormRange {
  lo: number;
  hi: number;
  /** "descriptor" = the robot's own advertised `ranges`; "convention" = the
   * protocol's documented defaults for a key of this shape. */
  source: "descriptor" | "convention";
}

/** Resolve the normalized span for a key, preferring the robot's advertised
 * `ranges` and falling back to the protocol conventions (arm joints -100..100,
 * grippers 0..100, lift 0..RAIL_TRAVEL_MM). Returns null when nothing sane is
 * known — base velocities, unknown keys — so a caller renders no bar rather
 * than a bar against an invented scale. */
export function normalizedRange(
  key: string,
  descriptor?: RobotDescriptor | null,
): NormRange | null {
  const span = descriptor?.ranges?.[key];
  if (
    Array.isArray(span) && span.length === 2 &&
    Number.isFinite(span[0]) && Number.isFinite(span[1]) && span[0] !== span[1]
  ) {
    return { lo: span[0], hi: span[1], source: "descriptor" };
  }
  if (isLiftKey(key)) return { lo: 0, hi: RAIL_TRAVEL_MM, source: "convention" };
  if (!key.endsWith(".pos")) return null;
  if (key.endsWith("gripper.pos")) return { lo: 0, hi: 100, source: "convention" };
  if (key.includes("_arm_")) return { lo: -100, hi: 100, source: "convention" };
  return null;
}

/** Where `value` sits in its normalized span, 0..1 at the ends. NOT clamped —
 * see the module header: an out-of-range reading is signal, not noise. Null
 * when the span is unknown or the value isn't a finite number. */
export function normalizedFraction(
  value: number | null | undefined,
  range: NormRange | null,
): number | null {
  if (range === null || typeof value !== "number" || !Number.isFinite(value)) return null;
  return (value - range.lo) / (range.hi - range.lo);
}

export type SiUnit = "rad" | "mm";

/** A physical reading, or an honest statement of why there isn't one. */
export interface SiReading {
  known: boolean;
  /** Radians (revolute joints) or millimetres (lift). Only meaningful when known. */
  value: number;
  unit: SiUnit;
  /** Degrees, for the radian case only — convenience for the readout. */
  deg: number | null;
  /** Why `known` is false.
   *   no_value      the key carried no finite number this frame
   *   no_ranges_si  the robot advertises no calibrated SI bounds for this key
   *   bad_bounds    it advertises bounds, but they are degenerate/non-finite */
  reason: "ok" | "no_value" | "no_ranges_si" | "bad_bounds";
}

const NO_SI = (reason: SiReading["reason"]): SiReading => ({
  known: false, value: NaN, unit: "rad", deg: null, reason,
});

/**
 * Normalized value -> physical units, using ONLY the robot's own calibration.
 *
 * Lift keys are already millimetres and are passed through untouched; per spec
 * they never appear in `ranges_si` and an entry there would mean converting
 * twice. Everything else needs `ranges_si[key]`, and the bounds may be INVERTED
 * (lower > upper) where calibration reverses the axis — interpolate lower->upper
 * exactly as written, never sort, because the order carries the direction.
 *
 * `frac` is the UNCLAMPED normalized fraction, so an out-of-range normalized
 * reading extrapolates to the angle it actually implies.
 */
export function siReading(
  key: string,
  value: number | null | undefined,
  frac: number | null,
  descriptor?: RobotDescriptor | null,
): SiReading {
  if (typeof value !== "number" || !Number.isFinite(value)) return NO_SI("no_value");
  if (isLiftKey(key)) {
    return { known: true, value, unit: "mm", deg: null, reason: "ok" };
  }
  const si = descriptor?.ranges_si?.[key];
  if (!Array.isArray(si) || si.length !== 2) return NO_SI("no_ranges_si");
  const [lo, hi] = si;
  if (
    typeof lo !== "number" || typeof hi !== "number" ||
    !Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi
  ) {
    return NO_SI("bad_bounds");
  }
  if (frac === null) return NO_SI("no_value");
  const rad = lo + frac * (hi - lo);
  return { known: true, value: rad, unit: "rad", deg: (rad * 180) / Math.PI, reason: "ok" };
}

// ---------------------------------------------------------------------------
// flow tracking

/** One key's flow facts at sample time. */
export interface KeyFlowSample {
  key: string;
  /** Last value seen; null = never seen. */
  value: number | null;
  /** ms since this key was last PRESENT in a frame; null = never seen. */
  sinceSeenMs: number | null;
  /** ms since this key's value last CHANGED; null = never seen, or seen only
   * ever at one value (a joint parked since we started watching). */
  sinceChangedMs: number | null;
  /** Frames carrying this key per second, over the trailing window. */
  hz: number;
}

/** The whole stream's flow facts at sample time. */
export interface TelemetryFlowSample {
  /** Wall clock the sample was taken at. */
  nowMs: number;
  /** Frames carrying a `state` dict per second, measured CLIENT-SIDE over the
   * trailing window — what actually reached this browser, not the robot's own
   * loop_hz claim. */
  frameHz: number;
  /** Frames observed inside the window (the sample size behind frameHz). */
  frames: number;
  /** Frames observed since tracking started — 0 means "nothing has ever
   * arrived", which is a different statement from "nothing arrived lately". */
  totalFrames: number;
  /** ms since the last frame; null when none has ever arrived. */
  sinceFrameMs: number | null;
  keys: KeyFlowSample[];
}

interface KeyRecord {
  value: number;
  lastSeenMs: number;
  lastChangedMs: number | null;
  seenTimes: number[];
}

/**
 * Accumulates per-key freshness and rates from raw telemetry frames.
 *
 * Deliberately mutable and React-free: it is fed at the full frame rate (~15 Hz)
 * from a ref and read on a slow interval (~4 Hz) for display, which is the only
 * way a 17-row table can exist on this page without re-rendering it 15 times a
 * second. observe() allocates nothing per frame beyond the trailing timestamp
 * arrays, which are trimmed to FLOW_WINDOW_MS.
 *
 * Clock: caller-supplied `nowMs` (Date.now()) everywhere, so tests can drive it.
 */
export class TelemetryFlowTracker {
  private frameTimes: number[] = [];
  private total = 0;
  private lastFrameMs: number | null = null;
  private keys = new Map<string, KeyRecord>();

  /** Ingest one telemetry `state` dict. Non-finite values are ignored entirely
   * (the key is not counted as having arrived) — a NaN is not a reading. */
  observe(state: Record<string, number> | null | undefined, nowMs: number): void {
    this.total += 1;
    this.lastFrameMs = nowMs;
    this.frameTimes.push(nowMs);
    trim(this.frameTimes, nowMs);
    if (!state) return;
    for (const [key, value] of Object.entries(state)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const rec = this.keys.get(key);
      if (!rec) {
        // First sighting: lastChanged stays null. We have not observed a change,
        // and reporting "changed 0 ms ago" here would claim motion we never saw.
        this.keys.set(key, { value, lastSeenMs: nowMs, lastChangedMs: null, seenTimes: [nowMs] });
        continue;
      }
      if (value !== rec.value) {
        rec.value = value;
        rec.lastChangedMs = nowMs;
      }
      rec.lastSeenMs = nowMs;
      rec.seenTimes.push(nowMs);
      trim(rec.seenTimes, nowMs);
    }
  }

  /** Snapshot for display. Trims the trailing windows as a side effect so a
   * stream that stopped decays to 0 Hz even with no further observe() calls. */
  sample(nowMs: number): TelemetryFlowSample {
    trim(this.frameTimes, nowMs);
    const keys: KeyFlowSample[] = [];
    for (const [key, rec] of this.keys) {
      trim(rec.seenTimes, nowMs);
      keys.push({
        key,
        value: rec.value,
        sinceSeenMs: nowMs - rec.lastSeenMs,
        sinceChangedMs: rec.lastChangedMs === null ? null : nowMs - rec.lastChangedMs,
        hz: rateHz(rec.seenTimes),
      });
    }
    keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      nowMs,
      frameHz: rateHz(this.frameTimes),
      frames: this.frameTimes.length,
      totalFrames: this.total,
      sinceFrameMs: this.lastFrameMs === null ? null : nowMs - this.lastFrameMs,
      keys,
    };
  }

  /** Forget everything (session ended / panel closed). */
  reset(): void {
    this.frameTimes = [];
    this.total = 0;
    this.lastFrameMs = null;
    this.keys.clear();
  }
}

// Drop timestamps that fell out of the trailing window. In place — this runs at
// the frame rate.
function trim(times: number[], nowMs: number): void {
  const cutoff = nowMs - FLOW_WINDOW_MS;
  let drop = 0;
  while (drop < times.length && times[drop] < cutoff) drop += 1;
  if (drop > 0) times.splice(0, drop);
}

/**
 * Rate from a list of arrival timestamps, measured over the SPAN they actually
 * cover rather than over the nominal window: (n-1)/(last-first). Dividing by the
 * fixed window instead would under-report for the first FLOW_WINDOW_MS after a
 * connect — the panel would open reading "5 Hz" on a healthy 15 Hz stream and
 * settle upward, which looks exactly like the sag it is supposed to detect.
 *
 * Fewer than two samples in the window is not a rate; it reads 0. That is also
 * what a stopped stream decays to once the window empties.
 */
export function rateHz(times: number[]): number {
  if (times.length < 2) return 0;
  const span = times[times.length - 1] - times[0];
  if (span <= 0) return 0;
  return ((times.length - 1) * 1000) / span;
}

// ---------------------------------------------------------------------------
// coverage

export interface KeyCoverage {
  /** Keys the descriptor says exist. Empty when there is no descriptor — then
   * "missing" cannot be computed and callers must not imply completeness. */
  advertised: string[];
  /** Keys seen inside the trailing window (advertised or not). */
  arriving: string[];
  /** Advertised but NOT seen inside the window. The failure this panel exists
   * to make visible: a joint whose key silently stopped being published. */
  missing: string[];
  /** Seen but never advertised — a descriptor that under-describes the robot. */
  unadvertised: string[];
}

/** Compare what arrived against what the descriptor promised. "Arriving" means
 * seen within FLOW_WINDOW_MS, so a key that dropped out mid-session moves into
 * `missing` rather than lingering as present forever. */
export function keyCoverage(
  sample: TelemetryFlowSample | null,
  advertised: string[],
): KeyCoverage {
  const arriving = (sample?.keys ?? [])
    .filter((k) => k.sinceSeenMs !== null && k.sinceSeenMs <= FLOW_WINDOW_MS)
    .map((k) => k.key);
  const arrivingSet = new Set(arriving);
  const advertisedSet = new Set(advertised);
  return {
    advertised,
    arriving,
    missing: advertised.filter((k) => !arrivingSet.has(k)),
    unadvertised: arriving.filter((k) => !advertisedSet.has(k)),
  };
}

// ---------------------------------------------------------------------------
// rows

export type FlowTone = "default" | "good" | "warn" | "bad";

/**
 * Tone for a key's LAST-SEEN age. Never keyed off last-CHANGED: a parked joint
 * legitimately never changes and must not read as a fault.
 *
 * `active` is "a session is live". With no session nothing is expected to
 * arrive, so everything stays neutral — an alarm about a robot you are not
 * connected to is noise, and the uncoloured default is what the status chips
 * already do pre-connect.
 */
export function flowTone(sinceSeenMs: number | null, active: boolean): FlowTone {
  if (!active || sinceSeenMs === null) return "default";
  if (sinceSeenMs <= FRESH_MS) return "good";
  if (sinceSeenMs <= SLOW_MS) return "warn";
  return "bad";
}

/** One rendered line of the panel. Everything the component needs, already
 * derived — the component only formats. */
export interface JointRow {
  key: string;
  label: string;
  side: "left" | "right" | "other";
  /** Last normalized value; null = this key has never arrived. */
  value: number | null;
  /** Unclamped position in the normalized span (see module header). */
  frac: number | null;
  /** Clamped to 0..1 for the bar, which cannot overflow. */
  barFrac: number | null;
  /** frac fell outside 0..1 — the joint reads past its advertised bound. */
  outOfRange: boolean;
  range: NormRange | null;
  si: SiReading;
  flow: KeyFlowSample | null;
  /** The descriptor promised this key. */
  advertised: boolean;
}

const clamp01 = (f: number) => (f < 0 ? 0 : f > 1 ? 1 : f);

/**
 * Build the panel's rows: every advertised key plus any unadvertised key that
 * actually arrived, ordered ANATOMICALLY — shoulder outward to wrist, gripper
 * last, then the lift and anything else. See ANATOMICAL_ORDER: the order is a
 * property of the arm, so it holds before the ack lands and for keys the
 * descriptor never mentioned, and it matches the keyboard legend's order.
 *
 * Advertised keys with no data still get a row, with null values: the whole
 * point is that an absent joint is visible, and a key that vanishes from the
 * table entirely is a key nobody notices is gone.
 */
export function buildJointRows(
  sample: TelemetryFlowSample | null,
  descriptor?: RobotDescriptor | null,
): JointRow[] {
  const advertised = advertisedStateKeys(descriptor);
  const advertisedSet = new Set(advertised);
  const flows = new Map((sample?.keys ?? []).map((k) => [k.key, k]));
  const extras = (sample?.keys ?? [])
    .map((k) => k.key)
    .filter((k) => !advertisedSet.has(k));
  // Side first (so the flat list reads as whole arms, not interleaved pairs —
  // left and right share every anatomical rank), then proximal->distal, then
  // alphabetical only to break ties among equally-ranked keys (two unknown
  // joints, or the lift against a base velocity) so the order is stable frame
  // to frame. groupJointRows filters by side and inherits this order.
  const sideRank = (k: string) => {
    const s = keySide(k);
    return s === "left" ? 0 : s === "right" ? 1 : 2;
  };
  const order = [...advertised, ...extras].sort(
    (a, b) =>
      sideRank(a) - sideRank(b) ||
      anatomicalRank(a) - anatomicalRank(b) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );

  return order.map((key) => {
    const flow = flows.get(key) ?? null;
    const value = flow?.value ?? null;
    const range = normalizedRange(key, descriptor);
    const frac = normalizedFraction(value, range);
    return {
      key,
      label: jointLabel(key),
      side: keySide(key),
      value,
      frac,
      barFrac: frac === null ? null : clamp01(frac),
      outOfRange: frac !== null && (frac < 0 || frac > 1),
      range,
      si: siReading(key, value, frac, descriptor),
      flow,
      advertised: advertisedSet.has(key),
    };
  });
}

/** Group rows for display the way GripForce groups current bars. Empty groups
 * are dropped so a robot with one arm doesn't render an empty "Right arm". */
export function groupJointRows(
  rows: JointRow[],
): { side: "left" | "right" | "other"; label: string; rows: JointRow[] }[] {
  const groups: { side: "left" | "right" | "other"; label: string; rows: JointRow[] }[] = [
    { side: "left", label: "Left arm", rows: rows.filter((r) => r.side === "left") },
    { side: "right", label: "Right arm", rows: rows.filter((r) => r.side === "right") },
    { side: "other", label: "Other", rows: rows.filter((r) => r.side === "other") },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** True when the robot advertises calibrated SI bounds for at least one key —
 * i.e. whether a radian column can mean anything at all on this robot. */
export function hasSiCalibration(descriptor?: RobotDescriptor | null): boolean {
  const si = descriptor?.ranges_si;
  return !!si && Object.keys(si).length > 0;
}
