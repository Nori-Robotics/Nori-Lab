// NORI: Public, auth-free robot model viewer.
//
// Same standalone pattern as /nori/vr and /nori/drive: providers, but NO
// NoriLayout nav and NO auth gate. This one goes further and needs no robot
// either — the model is a static asset, so the page works for someone who has
// never signed in and does not own an A3. That is the point: it is the link we
// hand a developer who is evaluating the robot.
import { Link } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";

import RobotUrdfViewer, {
  type HoveredJoint,
  type ViewerApi,
} from "@/nori/components/RobotUrdfViewer";
import type { CollisionPair } from "@/nori/components/selfCollision";
import { Button } from "@/components/ui/button";

/**
 * Height of the viewer and the joint column, shared so the two cannot drift
 * apart. Viewport-relative rather than a fixed pixel height: this page is the
 * whole point of the route, so it should fill a large screen — but clamped so
 * it never overflows a laptop.
 */
const PANEL_HEIGHT = "h-[clamp(560px,72vh,900px)]";

const jointRange = (type: string, lower?: number, upper?: number): string => {
  if (lower === undefined || upper === undefined) return "";
  if (type === "prismatic")
    return `${Math.round(lower * 1000)}–${Math.round(upper * 1000)} mm`;
  if (type === "continuous") return "continuous";
  const d = (rad: number) => Math.round((rad * 180) / Math.PI);
  return `${d(lower)}° to ${d(upper)}°`;
};

/** Ease in-out, the only easing the choreography needs. */
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * The ?demo=1 choreography for the release video. A plain timed script rather
 * than anything clever: each segment gets a duration and a tick(t) with t in
 * 0..1, and drives the page through its REAL surfaces — the same ViewerApi
 * paths a user's drag takes, the same React state the panels read — so what
 * the video shows is what the page actually does.
 */
type Segment = {
  dur: number;
  begin?: () => void;
  tick?: (t: number) => void;
  end?: () => void;
};

const ModelPage = () => {
  const [hovered, setHovered] = useState<HoveredJoint | null>(null);
  const [pose, setPose] = useState<Record<string, number>>({});
  const [joints, setJoints] = useState<HoveredJoint[]>([]);
  const [collisions, setCollisions] = useState<CollisionPair[]>([]);
  const [checkCollisions, setCheckCollisions] = useState(false);
  const [demoTitle, setDemoTitle] = useState(false);
  const apiRef = useRef<ViewerApi | null>(null);
  const jointsRef = useRef<HoveredJoint[]>([]);
  jointsRef.current = joints;
  const demo =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("demo");

  const runDemo = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const J = (name: string) =>
      jointsRef.current.find((j) => j.name === name) ?? null;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * ease(t);

    // Camera path state, advanced by segments.
    let az = 0.88, el = 0.32, dist = 3.4;
    const look = () => api.orbit(az, el, dist);

    const armSweep = [
      "left_shoulder_pitch_joint", "left_shoulder_roll_joint",
      "left_bicep_yaw_joint", "left_elbow_pitch_joint",
      "left_forearm_yaw_joint", "left_wrist_pitch_joint",
      "left_wrist_roll_joint", "left_gripper_joint",
    ];

    const segments: Segment[] = [
      // Settle: let the panels' entrance animations play.
      { dur: 1.6, tick: () => look() },

      // Slow orbit while the highlight walks down the left arm — each joint
      // lights green in the viewport and its row lights in the panel.
      {
        dur: 6.4,
        tick: (t) => {
          az = 0.88 + t * 1.9;
          look();
          const i = Math.min(armSweep.length - 1, Math.floor(t * armSweep.length));
          const j = J(armSweep[i]);
          api.highlightJoint(j ? j.name : null);
          setHovered(j);
        },
        end: () => {
          api.highlightJoint(null);
          setHovered(null);
        },
      },

      // The lift: full commanded travel up, partway back down. Mimic middle
      // stage follows; the readout's height estimate ticks live.
      {
        dur: 2.6,
        begin: () => {
          api.highlightJoint("lift_extension_joint");
          setHovered(J("lift_extension_joint"));
        },
        tick: (t) => {
          az += 0.0018; el = lerp(0.32, 0.16, t); look();
          api.setJoint("lift_extension_joint", lerp(0, 0.7, t));
        },
      },
      {
        dur: 1.8,
        tick: (t) => {
          look();
          api.setJoint("lift_extension_joint", lerp(0.7, 0.25, t));
        },
        end: () => {
          api.highlightJoint(null);
          setHovered(null);
        },
      },

      // Poses: both arms move together — reach, curl, gripper open/close.
      {
        dur: 3.2,
        tick: (t) => {
          az += 0.002; look();
          const k = ease(Math.min(1, t * 1.4));
          api.setJoint("left_shoulder_pitch_joint", -0.85 * k);
          api.setJoint("right_shoulder_pitch_joint", -0.85 * k);
          api.setJoint("left_elbow_pitch_joint", 0.9 * k);
          api.setJoint("right_elbow_pitch_joint", 0.9 * k);
          api.setJoint("left_wrist_pitch_joint", -0.5 * k);
          api.setJoint("right_wrist_pitch_joint", -0.5 * k);
          const g = t < 0.5 ? ease(t * 2) : ease(2 - t * 2);
          api.setJoint("left_gripper_joint", 1.2 * g);
          api.setJoint("right_gripper_joint", 1.2 * g);
        },
      },

      // Self-collision: flip the check on, fold an arm into the body until the
      // panel reports it, then back off.
      {
        dur: 3.4,
        begin: () => setCheckCollisions(true),
        tick: (t) => {
          look();
          const k = t < 0.55 ? ease(t / 0.55) : ease((1 - t) / 0.45);
          api.setJoint("left_shoulder_roll_joint", -1.35 * k);
          api.setJoint("left_elbow_pitch_joint", 0.9 - 0.5 * k);
        },
        end: () => setCheckCollisions(false),
      },

      // Return to zero and settle on the hero angle; title card up.
      {
        dur: 3.0,
        tick: (t) => {
          az = lerp(az, 0.62, t * 0.08); el = lerp(el, 0.24, t * 0.08);
          dist = lerp(dist, 3.0, t * 0.06); look();
          const k = 1 - ease(t);
          api.setJoint("left_shoulder_pitch_joint", -0.85 * k);
          api.setJoint("right_shoulder_pitch_joint", -0.85 * k);
          api.setJoint("left_elbow_pitch_joint", 0.9 * k);
          api.setJoint("right_elbow_pitch_joint", 0.9 * k);
          api.setJoint("left_wrist_pitch_joint", -0.5 * k);
          api.setJoint("right_wrist_pitch_joint", -0.5 * k);
          api.setJoint("lift_extension_joint", 0.25 * k);
          if (t > 0.55) setDemoTitle(true);
        },
      },
      { dur: 2.6, tick: () => look() },
    ];

    let seg = 0, segStart = performance.now();
    segments[0].begin?.();
    const step = (now: number) => {
      const s = segments[seg];
      const t = Math.min(1, (now - segStart) / (s.dur * 1000));
      s.tick?.(t);
      if (t >= 1) {
        s.end?.();
        seg += 1;
        if (seg >= segments.length) {
          (window as unknown as { __noriDemoDone?: boolean }).__noriDemoDone = true;
          return;
        }
        segStart = now;
        segments[seg].begin?.();
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  const onReady = useCallback(
    (api: ViewerApi) => {
      apiRef.current = api;
      if (demo) {
        // Give the HDRI and layout a beat to land before filming starts.
        setTimeout(runDemo, 1200);
      }
    },
    [demo, runDemo]
  );

  const value = (j: HoveredJoint) => {
    const v = pose[j.name];
    if (typeof v !== "number") return "—";
    return j.type === "prismatic"
      ? `${Math.round(v * 1000)} mm`
      : `${Math.round((v * 180) / Math.PI)}°`;
  };

  return (
    // Same backdrop family as the coding/agent pages: dot-grid wash plus the
    // two blurred colour orbs. This route is standalone (no NoriLayout), so a
    // full-height wrapper carries them instead of coding.tsx's negative-margin
    // bleed. Content sits in a `relative` main so it paints above.
    <div className="relative min-h-screen overflow-hidden bg-nori-hfffdf7">
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
      <div
        className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-leaf opacity-70 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-20 top-32 h-64 w-64 rounded-full bg-sticker opacity-60 blur-3xl"
        aria-hidden
      />
    <main className="relative mx-auto max-w-[1600px] space-y-6 p-8">
      {demoTitle && (
        <div className="pointer-events-none fixed inset-x-0 bottom-14 z-20 flex justify-center">
          <div className="nori-rise rounded-xl border bg-background/90 px-8 py-5 text-center shadow-lg backdrop-blur">
            <p className="text-3xl font-bold">Nori A3 — URDF now available</p>
            <p className="mt-1 text-base text-muted-foreground">
              docs.norirobotics.com/guide/a3
            </p>
          </div>
        </div>
      )}
      <header className="nori-rise space-y-2">
        <h1 className="text-4xl font-bold">Nori A3 Model</h1>
        <p className="max-w-3xl text-base text-muted-foreground">
          The robot description we publish for simulation. Drag to orbit, scroll
          to zoom, and drag a joint to pose it. Nothing here needs an account or
          a robot.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <RobotUrdfViewer
          className={`${PANEL_HEIGHT} nori-rise w-full [animation-delay:120ms]`}
          onHoverJoint={setHovered}
          onPoseChange={setPose}
          onJointsLoaded={setJoints}
          onCollisions={setCollisions}
          onViewerReady={onReady}
          collisionCheck={checkCollisions}
        />

        <div
          className={`flex ${PANEL_HEIGHT} nori-rise min-h-0 flex-col gap-3 rounded-md border bg-muted/30 p-4 [animation-delay:240ms]`}
        >
          {/* Kinematic self-collision — opt-in. Geometry and joint limits only,
              both measured, so it says nothing that depends on the model's
              estimated mass or inertia. */}
          <div className="rounded-md border bg-background/60 px-2.5 py-2">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-sm font-medium">Self-collision check</span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-nori-h8ab135"
                checked={checkCollisions}
                onChange={(e) => setCheckCollisions(e.target.checked)}
              />
            </label>
            {checkCollisions && (
              <div className="mt-2">
                <p
                  className={`text-sm font-medium ${
                    collisions.length ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {collisions.length === 0
                    ? "Clear in this pose"
                    : `${collisions.length} collision${collisions.length > 1 ? "s" : ""}`}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {collisions.slice(0, 4).map((c) => (
                    <li key={`${c.a}|${c.b}`} className="font-mono text-xs text-destructive">
                      {c.a.replace(/_link$/, "")} ↔ {c.b.replace(/_link$/, "")}
                    </li>
                  ))}
                  {collisions.length > 4 && (
                    <li className="text-xs text-destructive">
                      +{collisions.length - 4} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>

          <div>
            <p className="text-sm text-muted-foreground">Selected part</p>
            <p className="truncate text-base font-medium">
              {hovered ? (
                <>
                  <span className="font-mono text-sm">{hovered.name}</span>
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {hovered.type}
                    {jointRange(hovered.type, hovered.lower, hovered.upper) &&
                      ` · ${jointRange(hovered.type, hovered.lower, hovered.upper)}`}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">Hover a joint</span>
              )}
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <p className="sticky top-0 bg-muted/30 pb-1 text-sm font-medium text-muted-foreground">
              Joints {joints.length > 0 && `(${joints.length})`}
            </p>
            <ul className="space-y-1">
              {joints.map((j) => (
                <li
                  key={j.name}
                  className={`rounded px-1.5 py-1 ${
                    hovered?.name === j.name ? "bg-nori-h8ab135/20" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-xs">
                      {j.name.replace(/_joint$/, "")}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums">
                      {value(j)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* The same caveats the bundle's NOTICE carries. A developer who finds
          these after building something loses trust; one who reads them first
          trusts everything else. */}
      <section className="nori-rise space-y-3 rounded-md border p-5 text-base [animation-delay:360ms]">
        <h2 className="font-medium">What to trust</h2>
        <ul className="ml-5 list-disc space-y-1.5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Kinematics are measured</strong>{" "}
            and verified against hardware — joint axes, limits, link transforms.
          </li>
          <li>
            <strong className="text-foreground">Inertia is approximate.</strong>{" "}
            Masses are weighed, but each link is a uniform-density primitive. Not
            suitable for torque-level sim-to-real.
          </li>
          <li>
            <strong className="text-foreground">
              The lift limit is an operating ceiling.
            </strong>{" "}
            700 mm commanded of a 720 mm stroke — that reserve is what the real
            controllers respect.
          </li>
          <li>
            Torso, neck and head <strong className="text-foreground">shapes</strong>{" "}
            are visual placeholders only, but their masses are measured.
          </li>
          <li>
            <strong className="text-foreground">
              Self-collision is kinematic.
            </strong>{" "}
            It uses the collision primitives and joint limits, both measured, so
            it is independent of the mass and inertia caveats above. It is not a
            physics simulation.
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Licensed CC BY-NC-SA 4.0 — free for research and simulation, not for
          commercial use. Commercial enquiries:{" "}
          <a className="underline" href="mailto:info@norirobotics.com">
            info@norirobotics.com
          </a>
        </p>
      </section>

      <p className="text-base">
        <Link className="underline" to="/nori">
          Nori app
        </Link>
      </p>
    </main>
    </div>
  );
};

export default ModelPage;
