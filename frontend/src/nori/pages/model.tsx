// NORI: Public, auth-free robot model viewer.
//
// Same standalone pattern as /nori/vr and /nori/drive: providers, but NO
// NoriLayout nav and NO auth gate. This one goes further and needs no robot
// either — the model is a static asset, so the page works for someone who has
// never signed in and does not own an A3. That is the point: it is the link we
// hand a developer who is evaluating the robot.
import { Link } from "react-router-dom";
import { useState } from "react";

import RobotUrdfViewer, {
  type HoveredJoint,
} from "@/nori/components/RobotUrdfViewer";
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

const ModelPage = () => {
  const [hovered, setHovered] = useState<HoveredJoint | null>(null);
  const [pose, setPose] = useState<Record<string, number>>({});
  const [joints, setJoints] = useState<HoveredJoint[]>([]);

  const value = (j: HoveredJoint) => {
    const v = pose[j.name];
    if (typeof v !== "number") return "—";
    return j.type === "prismatic"
      ? `${Math.round(v * 1000)} mm`
      : `${Math.round((v * 180) / Math.PI)}°`;
  };

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <header className="space-y-2">
        <h1 className="text-4xl font-bold">Nori A3 Model</h1>
        <p className="max-w-3xl text-base text-muted-foreground">
          The robot description we publish for simulation. Drag to orbit, scroll
          to zoom, and drag a joint to pose it. Nothing here needs an account or
          a robot.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <RobotUrdfViewer
          className={`${PANEL_HEIGHT} w-full`}
          onHoverJoint={setHovered}
          onPoseChange={setPose}
          onJointsLoaded={setJoints}
        />

        <div
          className={`flex ${PANEL_HEIGHT} min-h-0 flex-col gap-3 rounded-md border bg-muted/30 p-4`}
        >
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
      <section className="space-y-3 rounded-md border p-5 text-base">
        <h2 className="font-medium">What to trust</h2>
        <ul className="ml-5 list-disc space-y-1.5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Kinematics are measured</strong>{" "}
            and verified against hardware — joint axes, limits, link transforms.
          </li>
          <li>
            <strong className="text-foreground">Mass is ~8.7% light.</strong> The
            model sums to 18.3 kg; a real robot weighs 20.1 kg. The difference is
            hubs, wiring and fasteners, assumed distributed.
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
            are placeholders; their masses are measured.
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
  );
};

export default ModelPage;
