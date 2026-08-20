// NORI: Public, auth-free robot model viewer.
//
// Same standalone pattern as /nori/vr and /nori/drive: providers, but NO
// NoriLayout nav and NO auth gate. This one goes further and needs no robot
// either — the model is a static asset, so the page works for someone who has
// never signed in and does not own an A3. That is the point: it is the link we
// hand a developer who is evaluating the robot.
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
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
  const demoMode =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("demo");
  // Stepped capture mode (?demo=1&stepped=1): the choreography advances ONLY
  // when the recorder calls window.__noriDemoStep(dtMs), never off the wall
  // clock. This is what makes frame capture deterministic — the page can take
  // any amount of real time per frame without the animation racing ahead.
  const steppedMode =
    demoMode && new URLSearchParams(window.location.search).has("stepped");
  // Opening card: "in" while it holds the frame, "out" while it fades, then
  // gone. Starts UP in demo mode — recording begins at page load, well before
  // the choreography's first segment runs, and the card is what should own
  // those first frames (it also hides the zero-pose T while the neutral pose
  // is applied).
  const [demoIntro, setDemoIntro] = useState<"in" | "out" | "done">(
    demoMode ? "in" : "done"
  );
  // Bumped when stepped capture begins: remounts the intro card's animated
  // content so its CSS entrances replay under virtual time. Without this the
  // animations run (and finish) during the real seconds before the recorder
  // freezes the clock, and frame 0 captures a static card.
  const [introEpoch, setIntroEpoch] = useState(0);
  const apiRef = useRef<ViewerApi | null>(null);
  const jointsRef = useRef<HoveredJoint[]>([]);
  jointsRef.current = joints;
  const demo = demoMode;

  // Ground truth for the demo recorder: video time compresses when the page
  // skips paints, so anything verifying the choreography reads these rather
  // than trusting timestamps in the captured file.
  useEffect(() => {
    (window as unknown as { __noriCollisions?: number }).__noriCollisions =
      collisions.length;
  }, [collisions]);

  const runDemo = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const J = (name: string) =>
      jointsRef.current.find((j) => j.name === name) ?? null;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * ease(t);
    const D = Math.PI / 180;

    // Rest pose: arms down at the sides, elbows tucked — how the robot actually
    // stands, rather than the URDF's zero-pose T. Signs verified by eye: the
    // shoulder mounts mirror (so roll is ±) while the elbows share a sign.
    const NEUTRAL: Record<string, number> = {
      left_shoulder_roll_joint: 50 * D,
      right_shoulder_roll_joint: -50 * D,
      left_elbow_pitch_joint: 50 * D,
      right_elbow_pitch_joint: 50 * D,
    };
    const applyNeutral = () =>
      Object.entries(NEUTRAL).forEach(([j, v]) => api.setJoint(j, v));
    applyNeutral();

    // Camera: piecewise targets + a continuous low-frequency wander on top, so
    // the shot breathes instead of moving in straight lines. Azimuth 0 faces
    // the robot; everything stays within the front hemisphere — the face is
    // the subject, and the wander amplitude is kept inside the clamp.
    let az = -0.55, el = 0.3, dist = 3.8, ty = 0.08;
    const t0 = performance.now();
    const look = () => {
      const T = (performance.now() - t0) / 1000;
      const wobA = 0.05 * Math.sin(T * 0.55 + 1.3);
      const wobE = 0.028 * Math.sin(T * 0.38);
      const wobD = 1 + 0.03 * Math.sin(T * 0.47 + 0.6);
      const a = Math.max(-0.85, Math.min(0.85, az + wobA));
      api.orbit(a, el + wobE, dist * wobD, ty);
    };

    const armSweep = [
      "left_shoulder_pitch_joint", "left_shoulder_roll_joint",
      "left_bicep_yaw_joint", "left_elbow_pitch_joint",
      "left_forearm_yaw_joint", "left_wrist_pitch_joint",
      "left_wrist_roll_joint", "left_gripper_joint",
    ];

    const segments: Segment[] = [
      // Opening title card: holds over the page while the panels animate in
      // behind it, then fades to reveal the robot already settling.
      // No dead air: the sweep segment below begins the moment this ends, so
      // the robot is already moving as the card finishes fading.
      {
        dur: 1.9,
        tick: (t) => {
          az = lerp(-0.55, -0.42, t); dist = lerp(4.1, 3.9, t); look();
          if (t > 0.72) setDemoIntro("out");
        },
        end: () => setDemoIntro("done"),
      },

      // Highlight sweep down the left arm with a motion ramp: the first joints
      // dwell, then the selection accelerates down the chain. Camera glides
      // across the front with a small push-in, riding the same ramp so the
      // move and the selection speed up together.
      {
        dur: 3.8,
        tick: (t) => {
          const r = t * t * (1.8 - 0.8 * t); // ease-in ramp: slow start, fast finish
          az = lerp(-0.42, 0.45, r);
          dist = lerp(3.9, 3.45, r) - 0.3 * Math.sin(r * Math.PI); // glide in with a mid push
          look();
          const i = Math.min(armSweep.length - 1, Math.floor(r * armSweep.length));
          const j = J(armSweep[i]);
          api.highlightJoint(j ? j.name : null);
          setHovered(j);
        },
        end: () => {
          api.highlightJoint(null);
          setHovered(null);
        },
      },

      // Lift up: pull back and raise the look point so the whole robot stays
      // framed at full height.
      {
        dur: 2.4,
        begin: () => {
          api.highlightJoint("lift_extension_joint");
          setHovered(J("lift_extension_joint"));
        },
        tick: (t) => {
          az = lerp(0.45, 0.7, t); dist = lerp(3.45, 4.3, t); ty = lerp(0.08, 0.3, t);
          look();
          // Peak kept well under the commanded ceiling — full extension read as
          // taller than the real unit stands. The quick up-and-partway-down
          // shape (the "bounce") is the part worth keeping.
          api.setJoint("lift_extension_joint", lerp(0, 0.35, t));
          // Shoulders TUCK from 50 deg to 80 deg as it rises, and REST there —
          // arms drawn in closer to the body for the remainder.
          api.setJoint("left_shoulder_roll_joint", lerp(50 * D, 80 * D, t));
          api.setJoint("right_shoulder_roll_joint", lerp(-50 * D, -80 * D, t));
        },
      },
      {
        dur: 1.6,
        tick: (t) => {
          dist = lerp(4.3, 3.7, t); ty = lerp(0.3, 0.16, t); look();
          api.setJoint("lift_extension_joint", lerp(0.35, 0.2, t));
        },
        end: () => {
          api.highlightJoint(null);
          setHovered(null);
        },
      },

      // Reach: both arms come forward out of the rest pose, grippers pulse.
      // DELIBERATELY not mirrored — the right arm trails the left by a beat,
      // reaches a little less far and adds a touch of yaw, and its gripper
      // pulses out of phase. Perfect symmetry reads as mechanical playback;
      // a slight lead/lag reads as behaviour.
      {
        dur: 3.0,
        tick: (t) => {
          az = lerp(0.7, -0.35, t); dist = lerp(3.7, 3.3, t); look();
          const kL = ease(Math.min(1, t * 1.35));
          const kR = ease(Math.min(1, Math.max(0, t - 0.14) * 1.35));
          api.setJoint("left_shoulder_pitch_joint", -0.78 * kL);
          api.setJoint("right_shoulder_pitch_joint", -0.62 * kR);
          api.setJoint("left_elbow_pitch_joint", (50 * D) + 0.38 * kL);
          api.setJoint("right_elbow_pitch_joint", (50 * D) + 0.28 * kR);
          api.setJoint("left_wrist_pitch_joint", -0.45 * kL);
          api.setJoint("right_wrist_pitch_joint", -0.36 * kR);
          api.setJoint("right_bicep_yaw_joint", 0.18 * kR);
          const gL = t < 0.5 ? ease(t * 2) : ease(2 - t * 2);
          const tR = Math.max(0, Math.min(1, (t - 0.18) / 0.64));
          const gR = tR < 0.5 ? ease(tR * 2) : ease(2 - tR * 2);
          api.setJoint("left_gripper_joint", 1.2 * gL);
          api.setJoint("right_gripper_joint", 1.0 * gR);
        },
      },

      // Ending: arms unwind to rest (left leads, right trails), lift comes
      // home, camera drifts to the hero angle, title card.
      {
        dur: 2.6,
        tick: (t) => {
          az = lerp(-0.35, 0.12, t); dist = lerp(3.3, 3.35, t); ty = lerp(0.16, 0.1, t);
          look();
          const kL = 1 - ease(Math.min(1, t * 1.2));
          const kR = 1 - ease(Math.min(1, Math.max(0, t - 0.1) * 1.2));
          api.setJoint("left_shoulder_pitch_joint", -0.78 * kL);
          api.setJoint("right_shoulder_pitch_joint", -0.62 * kR);
          api.setJoint("left_elbow_pitch_joint", (50 * D) + 0.38 * kL);
          api.setJoint("right_elbow_pitch_joint", (50 * D) + 0.28 * kR);
          api.setJoint("left_wrist_pitch_joint", -0.45 * kL);
          api.setJoint("right_wrist_pitch_joint", -0.36 * kR);
          api.setJoint("right_bicep_yaw_joint", 0.18 * kR);
          api.setJoint("lift_extension_joint", 0.2 * (1 - ease(t)));
          if (t > 0.5) setDemoTitle(true);
        },
      },
      { dur: 2.4, tick: () => look() },
    ];

    const stepped =
      new URLSearchParams(window.location.search).has("stepped");
    let seg = 0, segStart = stepped ? 0 : performance.now();
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
      if (!stepped) requestAnimationFrame(step);
    };
    if (stepped) {
      // The recorder owns the clock. First call also remounts the intro card
      // so its CSS entrances play inside the captured timeline.
      let vnow = 0;
      let first = true;
      (window as unknown as { __noriDemoStep?: (dt: number) => void }).__noriDemoStep =
        (dt: number) => {
          // The recorder keeps stepping for a tail on the end card; past the
          // last segment there is nothing to advance and step() would index
          // off the segments array.
          if (seg >= segments.length) return;
          if (first) {
            first = false;
            setIntroEpoch((e) => e + 1);
          }
          vnow += dt;
          step(vnow);
        };
    } else {
      requestAnimationFrame(step);
    }
  }, []);

  const onReady = useCallback(
    (api: ViewerApi) => {
      apiRef.current = api;
      const q = new URLSearchParams(window.location.search);
      // ?rig=1: hand the viewer controls to the page's window for scripted
      // probing (used to find choreography poses empirically — e.g. which
      // joint values actually produce a self-collision against the real
      // collision bodies). No choreography runs.
      if (q.has("rig")) {
        (window as unknown as { __noriRig?: object }).__noriRig = {
          setJoint: api.setJoint,
          orbit: api.orbit,
          setCheck: (on: boolean) => setCheckCollisions(on),
        };
      }
      if (demo) {
        if (steppedMode) {
          runDemo(); // installs __noriDemoStep; nothing moves until it's called
        } else {
          // Short beat for layout; the recorder gates on __noriEnvReady
          // separately, which is what the old longer delay was really for.
          setTimeout(runDemo, 400);
        }
      }
    },
    [demo, steppedMode, runDemo]
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
    {/* Demo overlays live OUTSIDE <main> on purpose. main uses space-y-6,
        which Tailwind implements as a `> * + *` top margin — and a `fixed`
        element still counts as a DOM sibling for that selector even though it
        takes no layout space. With the overlays as main's first child, every
        mount/unmount toggled a 24px margin on the header and the whole page
        visibly jumped. Out here they are layout-inert. */}
      {demoIntro !== "done" && (
        <div
          className={`pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-nori-hfffdf7 ${
            demoIntro === "out" ? "nori-fade-out" : ""
          }`}
        >
          <div key={introEpoch} className="relative text-center">
            {/* Same floaty sticker language as the agent page's "new" chip. */}
            {/* Delays keep the jump AFTER the encode's 0.55s head-trim: the
                recorder captures from page load, so an entrance that starts at
                t=0 gets cut off in the shipped video. */}
            <span className="nori-jump absolute -right-14 -top-8 inline-flex -rotate-6 items-center rounded-full bg-sticker px-3 py-1 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink shadow-soft [animation-delay:650ms]">
              open to sim
            </span>
            <p className="nori-jump text-6xl font-bold [animation-delay:150ms]">
              Nori A3 URDF release
            </p>
            <p className="nori-jump mt-4 text-xl text-muted-foreground [animation-delay:400ms]">
              simulate it — Isaac Sim · MuJoCo · Gazebo
            </p>
          </div>
        </div>
      )}
      {demoTitle && (
        <div className="pointer-events-none fixed inset-x-0 bottom-14 z-20 flex justify-center">
          <div className="nori-rise rounded-xl border bg-background/95 px-10 py-7 text-center shadow-lg backdrop-blur">
            <p className="text-5xl font-bold leading-tight">
              Nori A3 — URDF now available
            </p>
            <p className="mt-3 text-xl font-medium">
              github.com/Nori-Robotics/nori_description
            </p>
            <p className="mt-1 text-lg text-muted-foreground">
              docs.norirobotics.com/guide/a3
            </p>
          </div>
        </div>
      )}
    <main className="relative mx-auto max-w-[1600px] space-y-6 p-8">
      <header className="nori-rise space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-4xl font-bold">Nori A3 Model</h1>
          {/* Same sticker language as the agent page's chip. States what exists
              (the model, poseable now) and what is coming (simulation), without
              promising an engine or a date. */}
          <span className="inline-flex -rotate-2 items-center rounded-full bg-sticker px-3 py-1 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink shadow-soft">
            in-browser sim coming soon
          </span>
        </div>
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
            700 mm commanded of a 720 mm stroke — this padding is safe and what
            real controllers expect.
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

      <div className="flex justify-center pt-1">
        <Link
          className="inline-flex items-center gap-2 rounded-full border border-ink/20 bg-background px-4 py-2 text-[13px] font-semibold text-ink transition-[transform,box-shadow] duration-200 ease-bounce hover:-translate-y-0.5 hover:shadow-soft"
          to="/nori"
        >
          Nori app
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </main>
    </div>
  );
};

export default ModelPage;
