// NORI: Additive. /nori/sim-task — the A3 simulation driven THROUGH the SDK.
//
// What is wired here, and in which direction:
//   A3MockSim (geometric sendPose) -> createMockRobot (real WebRTC, loopback signaling)
//     -> RemoteTeleop (the unmodified SDK) -> onTelemetry -> RobotUrdfViewer.liveState
//   RobotUrdfViewer sim (apartment + robot cameras) -> cameraComposite -> mock's video track
//     -> teleop.cameraView(role) shows the rendered scene
//
// So a script that calls `teleop.sendPose("right", [x, y, z])` moves the model you are
// looking at, and `teleop.cameraView("overhead")` shows the apartment from the robot's
// overhead camera. That is the fixture for the point-and-click task: the SDK surface is
// the real one; only the robot behind it is simulated.
//
// The pose target is the WRIST POINT (see a3MockSim.ts), and cartesian JOG is NOT
// geometric in the mock (it nudges single joints) — use sendPose, not jog, for anything
// that must end up somewhere.
//
// Dev handles on window: `__simTask.teleop` (RemoteTeleop), `__simTask.sim` (A3MockSim),
// `__simTask.setTarget([x, y, z])`.

import * as THREE from "three";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { RemoteTeleop, type ActionStatus, type TelemetryView } from "@nori/sdk";
import { createMockRobot, type MockRobotHandle } from "@nori/sdk/mock";
import type { Vec3 } from "@nori/sdk/vr";

import RobotUrdfViewer, { type ViewerApi } from "@/nori/components/RobotUrdfViewer";
import { CAMERA_VIEWS, type CameraView, type SimHandle } from "@/nori/sim/simRuntime";
import { A3MockSim } from "@/nori/sim/a3MockSim";
import { A3_MOCK_CAMERAS } from "@/nori/sim/a3MockDescriptor";
import { createCameraComposite, type CameraComposite } from "@/nori/sim/cameraComposite";
import { Button } from "@/components/ui/button";

const PANEL_HEIGHT = "h-[clamp(560px,72vh,900px)]";
type Side = "left" | "right";

// A wrist-point target the right arm can reach from the zero pose at lift 100 mm:
// forward of the shoulder, a little outboard, at shoulder height.
const DEFAULT_TARGET: Vec3 = [0.15, -0.25, 0.65];

const fmt = (v: Vec3) => v.map((x) => x.toFixed(3)).join(", ");
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Base-frame position of a URDF link, metres, from the loaded model — the independent
 *  check that the sim's FK frame offset matches the description. */
function linkPositionBf(root: THREE.Object3D, linkName: string): Vec3 | null {
  const link = root.getObjectByName(linkName);
  if (!link) return null;
  const p = new THREE.Vector3();
  link.getWorldPosition(p);
  root.worldToLocal(p);
  return [p.x, p.y, p.z];
}

const SimTaskPage = () => {
  const [liveState, setLiveState] = useState<Record<string, number> | undefined>(undefined);
  const [conn, setConn] = useState("idle");
  const [tel, setTel] = useState<TelemetryView | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [side, setSide] = useState<Side>("right");
  const [target, setTarget] = useState<Vec3>(DEFAULT_TARGET);
  const [draft, setDraft] = useState<[string, string, string]>(
    DEFAULT_TARGET.map((v) => v.toFixed(2)) as [string, string, string]);
  const [camRole, setCamRole] = useState<CameraView>("overhead");
  const [wrist, setWrist] = useState<{ fk: Vec3; urdf: Vec3 | null } | null>(null);
  const [ready, setReady] = useState(false);

  const apiRef = useRef<ViewerApi | null>(null);
  const simRef = useRef<A3MockSim>(new A3MockSim());
  const teleopRef = useRef<RemoteTeleop | null>(null);
  const robotRef = useRef<MockRobotHandle | null>(null);
  const compositeRef = useRef<CameraComposite | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const markerRef = useRef<THREE.Mesh | null>(null);
  const wristMarkerRef = useRef<THREE.Mesh | null>(null);

  const addLog = useCallback((m: string) => {
    setLog((l) => [...l.slice(-60), `${new Date().toLocaleTimeString()} ${m}`]);
  }, []);

  // ---- session: built once the sim (apartment + cameras) is running
  const onSimHandle = useCallback((handle: SimHandle | null) => {
    if (!handle) {
      teleopRef.current?.stop();
      teleopRef.current = null;
      robotRef.current?.stop();
      robotRef.current = null;
      compositeRef.current?.dispose();
      compositeRef.current = null;
      setReady(false);
      return;
    }
    const composite = createCameraComposite(handle, { views: [...A3_MOCK_CAMERAS] });
    compositeRef.current = composite;
    const robot = createMockRobot({
      sim: simRef.current,
      videoStream: composite.stream,
      log: (m) => addLog(`robot: ${m}`),
    });
    robotRef.current = robot;
    const teleop = new RemoteTeleop({
      signaling: robot.signaling,
      stun: "",
      turnUrls: [],
      turnUser: "",
      turnCred: "",
      forceRelay: false,
      arm: "right",
      onLog: (m) => addLog(`sdk: ${m}`),
      onConnState: setConn,
      onTelemetry: (t) => {
        setTel(t);
        // The ~1 Hz video/ABR tick carries an EMPTY state — posing the model from it
        // would snap every joint to its default. Only frames with joints count.
        if (t.state && Object.keys(t.state).length) setLiveState(t.state);
      },
      onActionStatus: (s: ActionStatus) =>
        addLog(`action ${s.action_id}: ${s.state}${s.reason ? ` (${s.reason})` : ""}`),
      onMode: () => {},
      onControlActive: () => {},
    });
    teleopRef.current = teleop;
    void teleop.start().then(() => setReady(true));
    (window as unknown as { __simTask?: unknown }).__simTask = {
      teleop, sim: simRef.current, composite: composite.canvas,
      setTarget: (t: Vec3) => setTarget([...t] as Vec3),
    };
  }, [addLog]);

  useEffect(() => () => onSimHandle(null), [onSimHandle]);

  // ---- markers in the robot's base frame: target (amber) and the sim's wrist point (cyan)
  const onViewerReady = useCallback((api: ViewerApi) => {
    apiRef.current = api;
    const root = api.getRobotRoot();
    if (!root) return;
    const mk = (color: number) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.015, 16, 12),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
      m.renderOrder = 999;
      root.add(m);
      return m;
    };
    markerRef.current = mk(0xe8b23a);
    wristMarkerRef.current = mk(0x3ac8e8);
  }, []);

  useEffect(() => {
    markerRef.current?.position.set(target[0], target[1], target[2]);
    apiRef.current?.redraw();
  }, [target]);

  // Each telemetry frame: move the wrist marker, and compare the sim's FK against where the
  // loaded URDF actually put the wrist link — the frame-offset check.
  useEffect(() => {
    if (!liveState) return;
    const fk = simRef.current.wristPointBf(side);
    wristMarkerRef.current?.position.set(fk[0], fk[1], fk[2]);
    const root = apiRef.current?.getRobotRoot();
    setWrist({ fk, urdf: root ? linkPositionBf(root, `${side}_wrist_pitch_link`) : null });
  }, [liveState, side]);

  // ---- camera view through the SDK (crops the composite track by role)
  useEffect(() => {
    const teleop = teleopRef.current;
    const el = videoRef.current;
    if (!ready || !teleop || !el) return;
    // cameraView() is null until BOTH the camera_layout frame and the first decoded video
    // frame are in, which can be a beat after start() resolves — so retry until it takes.
    let handle: ReturnType<RemoteTeleop["cameraView"]> = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const attach = () => {
      handle = teleop.cameraView(camRole, { fps: 15 });
      if (!handle) {
        retry = setTimeout(attach, 500);
        return;
      }
      el.srcObject = handle.stream;
      void el.play().catch(() => {});
    };
    attach();
    return () => {
      if (retry) clearTimeout(retry);
      handle?.stop();
      el.srcObject = null;
    };
  }, [ready, camRole]);

  const sendPose = () => {
    const teleop = teleopRef.current;
    if (!teleop) return;
    const id = `pose-${Date.now().toString(36)}`;
    addLog(`sendPose(${side}, [${fmt(target)}]) id=${id}`);
    try {
      teleop.sendPose(side, target, undefined, id);
      void teleop.awaitAction(id, { timeoutMs: 10000 }).then((s) => {
        const err = dist(simRef.current.wristPointBf(side), target);
        addLog(`${id} -> ${s.state}${s.reason ? ` (${s.reason})` : ""}; wrist error ${(err * 1000).toFixed(1)} mm`);
      });
    } catch (e) {
      addLog(`sendPose threw: ${(e as Error).message}`);
    }
  };

  const applyDraft = () => {
    const v = draft.map(Number);
    if (v.every(Number.isFinite)) setTarget(v as Vec3);
  };

  const reach = simRef.current.solvePose(side, target) !== null;
  const safety = tel?.safety ?? "—";
  const frameErr = wrist?.urdf ? dist(wrist.fk, wrist.urdf) : null;

  return (
    <main className="relative mx-auto max-w-[1600px] space-y-6 p-8">
      <header className="nori-rise space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-4xl font-bold">Sim task bench</h1>
          <span className="inline-flex -rotate-2 items-center rounded-full bg-sticker px-3 py-1 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink shadow-soft">
            SDK-driven A3 mock
          </span>
          <Link to="/nori/model?sim=1" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            plain sim <ArrowRight className="inline h-3 w-3" />
          </Link>
        </div>
        <p className="max-w-3xl text-base text-muted-foreground">
          The model is posed from the mock robot&apos;s telemetry through the real SDK, and the
          robot&apos;s cameras are its video feed. <code>sendPose</code> places the <b>wrist point</b>{" "}
          (amber = target, cyan = where the sim says the wrist is). Cartesian jog is not geometric
          in the mock — use <code>sendPose</code>. Handles: <code>window.__simTask</code>.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <RobotUrdfViewer
          className={`${PANEL_HEIGHT} nori-rise w-full [animation-delay:120ms]`}
          sim
          simCameraView={null}
          onSimHandle={onSimHandle}
          onViewerReady={onViewerReady}
          liveState={liveState}
          descriptor={simRef.current.descriptor}
          finish="realistic"
        />

        <div className={`flex ${PANEL_HEIGHT} nori-rise min-h-0 flex-col gap-3 overflow-y-auto rounded-md border bg-muted/30 p-4 [animation-delay:240ms]`}>
          <section className="rounded-md border bg-background/60 px-2.5 py-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">Session</span>
              <span className="font-mono text-xs text-muted-foreground">{conn}</span>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-1.5 text-center">
              {([
                ["safety", safety],
                ["loop", tel ? `${tel.loopHz.toFixed(0)} Hz` : "—"],
                ["lift", liveState ? `${Math.round(liveState["lift.pos"] ?? 0)} mm` : "—"],
              ] as const).map(([label, reading]) => (
                <div key={label} className="rounded bg-muted/60 py-1">
                  <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
                  <dd className="font-mono text-xs">{reading}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="destructive" disabled={!ready}
                onClick={() => { try { teleopRef.current?.command("estop"); } catch (e) { addLog((e as Error).message); } }}>
                E-stop
              </Button>
              <Button size="sm" variant="outline" disabled={!ready}
                onClick={() => { try { teleopRef.current?.command("reset_latch"); } catch (e) { addLog((e as Error).message); } }}>
                Reset latch
              </Button>
            </div>
          </section>

          <section className="rounded-md border bg-background/60 px-2.5 py-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">Pose target (base_footprint, m)</span>
              <span className={`font-mono text-xs ${reach ? "text-muted-foreground" : "text-destructive"}`}>
                {reach ? "reachable" : "no IK solution"}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              {(["left", "right"] as const).map((s) => (
                <Button key={s} size="sm" variant={side === s ? "default" : "outline"} onClick={() => setSide(s)}>
                  {s}
                </Button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {(["x", "y", "z"] as const).map((axis, i) => (
                <label key={axis} className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {axis}
                  <input
                    className="rounded border bg-background px-1.5 py-1 font-mono text-xs text-foreground"
                    value={draft[i]}
                    onChange={(e) => setDraft((d) => { const n = [...d] as typeof d; n[i] = e.target.value; return n; })}
                    onBlur={applyDraft}
                    onKeyDown={(e) => { if (e.key === "Enter") applyDraft(); }}
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" disabled={!ready} onClick={sendPose}>sendPose</Button>
              <Button size="sm" variant="outline" onClick={() => {
                const t = simRef.current.wristPointBf(side);
                setTarget(t); setDraft(t.map((v) => v.toFixed(2)) as [string, string, string]);
              }}>
                target = current wrist
              </Button>
            </div>
            <dl className="mt-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
              <div>wrist (sim FK): {wrist ? fmt(wrist.fk) : "—"}</div>
              <div>wrist (URDF link): {wrist?.urdf ? fmt(wrist.urdf) : "—"}</div>
              <div>
                FK vs URDF: {frameErr === null ? "—" : `${(frameErr * 1000).toFixed(1)} mm`}
                {" · "}to target: {wrist ? `${(dist(wrist.fk, target) * 1000).toFixed(1)} mm` : "—"}
              </div>
            </dl>
          </section>

          <section className="rounded-md border bg-background/60 px-2.5 py-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">teleop.cameraView(role)</span>
              <select
                className="rounded border bg-background px-1 py-0.5 font-mono text-xs"
                value={camRole}
                onChange={(e) => setCamRole(e.target.value as CameraView)}
              >
                {CAMERA_VIEWS.map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
              </select>
            </div>
            <video ref={videoRef} muted playsInline autoPlay className="mt-2 aspect-[4/3] w-full rounded bg-black" />
          </section>

          <section className="min-h-0 flex-1 rounded-md border bg-background/60 px-2.5 py-2 text-sm">
            <span className="font-medium">Log</span>
            <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-snug text-muted-foreground">
              {log.join("\n")}
            </pre>
          </section>
        </div>
      </div>
    </main>
  );
};

export default SimTaskPage;
