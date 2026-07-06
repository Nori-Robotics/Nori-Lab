// NORI: Additive file. Remote-mode page (M1 §e: laptop app as the single control
// client). Drives the Pi robot over WAN — live WebRTC video + keyboard control over a
// data channel, brokered by Supabase signaling. The heavy lifting lives in
// nori/remote/teleop.ts (the RemoteTeleop class); this page is settings + video + status.
//
// The Supabase project (URL/anon key) is the one already initialized by NoriContext from
// /nori/config, so there are no paste boxes for it here — only the remote-session
// settings (room, optional room token, ICE/TURN) which must match the Pi's .env.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNori } from "@/nori/NoriContext";
import { useApi } from "@/contexts/ApiContext";
import { getSupabase } from "@/nori/auth/supabase";
import {
  RemoteTeleop,
  type ArmSide,
  type CallState,
  type ControlMode,
  type TelemetryView,
} from "@nori/sdk";
import { SupabaseSignaling } from "@nori/sdk/supabase";
import { VrSession } from "@nori/sdk/vr";
import { TelemetryPanel, GripForce, ControlLegend, CallBar, RailHeight } from "@/nori/remote/TeleopStatus";
import { Robot3D } from "@/nori/remote/Robot3D";
import { LeaderDriver } from "@/nori/remote/LeaderDriver";
import { isM6VideoEnabled } from "@/nori/remote/flags";

const DEFAULT_STUN = "stun:stun.l.google.com:19302";

// Remote-session settings persist in localStorage (must match the Pi's .env).
type Settings = {
  room: string;
  token: string;
  stun: string;
  turn: string;
  turnUser: string;
  turnCred: string;
  forceRelay: boolean;
  arm: ArmSide;
};

const DEFAULTS: Settings = {
  // Empty = "not chosen yet" → auto-filled with the paired robot's serial once the
  // customer profile loads (see the effect below). A typed value always wins.
  room: "",
  token: "",
  stun: DEFAULT_STUN,
  turn: "",
  turnUser: "",
  turnCred: "",
  forceRelay: false,
  arm: "right",
};

const LS_KEY = "nori_remote_settings";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

const Remote = () => {
  const { ready, customer } = useNori();
  const { baseUrl, fetchWithHeaders } = useApi();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const selfViewRef = useRef<HTMLVideoElement>(null);
  const teleopRef = useRef<RemoteTeleop | null>(null);
  const vrRef = useRef<VrSession | null>(null);
  const leaderRef = useRef<LeaderDriver | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const m6 = isM6VideoEnabled();

  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [connecting, setConnecting] = useState(false);
  const [running, setRunning] = useState(false);
  const [inVr, setInVr] = useState(false);
  const [xrSupported, setXrSupported] = useState<boolean | null>(null);
  // Leader-arm control: when active the physical dual leaders drive the robot's arms
  // (absolute leader_action_deg); base + lift stay on the keyboard. leaderCount is how many
  // motors fed the last frame (0 = arms unplugged / bus paused).
  const [leaderActive, setLeaderActive] = useState(false);
  const [leaderCount, setLeaderCount] = useState(0);
  const [connState, setConnState] = useState("idle");
  const [controlActive, setControlActive] = useState(false);
  const [mode, setMode] = useState<ControlMode>("cylindrical");
  const [tel, setTel] = useState<TelemetryView>({
    loopHz: 0, safety: "-", watchdog: "-", tempC: 0, active: false, linkMode: null, currents: {}, state: {},
  });
  const [stale, setStale] = useState(false);
  const lastTelRef = useRef(0);
  const [call, setCall] = useState<CallState>({
    active: false, micMuted: true, micSending: false,
    robotAudio: false, robotMicLive: false, cameraOn: false,
  });
  const [logLines, setLogLines] = useState<string[]>([]);

  // Telemetry rides the control channel ~periodically; if it dries up while we still think
  // control is active, the readouts are no longer live. Flag it so the panel says "stale".
  const onTelemetry = useCallback((t: TelemetryView) => {
    lastTelRef.current = Date.now();
    setStale(false);
    setTel(t);
    vrRef.current?.setTelemetry(t); // mirror the same stats into the in-VR HUD
  }, []);
  useEffect(() => {
    if (!running) { setStale(false); return; }
    const id = setInterval(() => {
      if (lastTelRef.current && Date.now() - lastTelRef.current > 1500) setStale(true);
    }, 500);
    return () => clearInterval(id);
  }, [running]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings((s) => {
      const next = { ...s, [k]: v };
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return next;
    });

  const appendLog = useCallback((msg: string) => {
    setLogLines((prev) => [...prev.slice(-200), msg]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  // Live-update the active session's arm without reconnecting.
  useEffect(() => {
    teleopRef.current?.setArm(settings.arm);
  }, [settings.arm]);

  // Default the room to the paired robot's serial: the Supabase channel is keyed by
  // NORI_ROOM, and a paired robot's room == its serial, so a paired operator never has
  // to type it. Only fills when the room is still unset (a manual value always wins).
  const serial = customer?.robot_serial_number ?? "";
  useEffect(() => {
    if (!settings.room && serial) set("room", serial);
  }, [serial, settings.room]);

  // VR is an optional mode on top of the same session: detect headset support, and on any
  // link drop require a fresh squeeze before VR drive resumes (re-clutch-on-resume).
  useEffect(() => { VrSession.isSupported().then(setXrSupported); }, []);
  useEffect(() => {
    if (connState === "failed" || connState === "disconnected") vrRef.current?.reclutch();
  }, [connState]);

  const connect = async () => {
    if (!videoRef.current) return;
    setConnecting(true);
    setLogLines([]);
    const turnUrls = settings.turn.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const room = settings.room.trim() || serial || "nori-dev";
    const teleop = new RemoteTeleop({
      // The fork's transport is Supabase Realtime; the room lives on the transport now.
      signaling: new SupabaseSignaling(getSupabase(), room, appendLog),
      videoEl: videoRef.current,
      audioEl: audioRef.current ?? undefined,
      token: settings.token.trim(),
      stun: settings.stun.trim() || DEFAULT_STUN,
      turnUrls,
      turnUser: settings.turnUser.trim(),
      turnCred: settings.turnCred.trim(),
      forceRelay: settings.forceRelay,
      arm: settings.arm,
      onLog: appendLog,
      onConnState: setConnState,
      onTelemetry,
      onMode: setMode,
      onControlActive: setControlActive,
      onCurrents: (c) => vrRef.current?.setCurrents(c), // gripper current -> VR haptics
      onCall: setCall,
    });
    teleopRef.current = teleop;
    try {
      await teleop.start();
      setRunning(true);
    } catch (e) {
      appendLog("start failed: " + (e instanceof Error ? e.message : String(e)));
      teleopRef.current = null;
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = useCallback(async () => {
    leaderRef.current?.stop();
    leaderRef.current = null;
    setLeaderActive(false);
    setLeaderCount(0);
    await vrRef.current?.stop();
    vrRef.current = null;
    const t = teleopRef.current;
    teleopRef.current = null;
    if (t) await t.stop();
    setRunning(false);
    setInVr(false);
    setControlActive(false);
    setConnState("idle");
  }, []);

  // Enter the immersive (AR-passthrough) headset session on top of the live link. Reuses
  // the same RemoteTeleop + video element; VR feeds `jog` exactly like the keyboard.
  const enterVr = async () => {
    const teleop = teleopRef.current;
    if (!teleop || !videoRef.current) return;
    const session = new VrSession({
      teleop,
      videoEl: videoRef.current,
      onLog: appendLog,
      onEnd: () => { setInVr(false); vrRef.current = null; },
    });
    vrRef.current = session;
    try {
      await session.start();
      setInVr(true);
    } catch (e) {
      appendLog("enter VR failed: " + (e instanceof Error ? e.message : String(e)));
      vrRef.current = null;
    }
  };

  // ---- leader-arm control -------------------------------------------------
  // Start/stop the physical dual leader arms driving the robot's arms over the same live
  // session. The driver polls /nori/leader/live and feeds absolute targets to RemoteTeleop;
  // base + lift keep working on the keyboard. Toggling off releases the arms to the keyboard.
  const stopLeader = useCallback(() => {
    leaderRef.current?.stop();
    leaderRef.current = null;
    setLeaderActive(false);
    setLeaderCount(0);
  }, []);

  const enterLeader = useCallback(() => {
    const teleop = teleopRef.current;
    if (!teleop) return;
    const driver = new LeaderDriver({
      teleop,
      baseUrl,
      fetcher: fetchWithHeaders,
      onFrame: (count) => setLeaderCount(count),
      onError: (msg) => appendLog("leader read paused: " + msg),
    });
    leaderRef.current = driver;
    driver.start();
    setLeaderActive(true);
  }, [baseUrl, fetchWithHeaders, appendLog]);

  const toggleLeader = useCallback(() => {
    if (leaderActive) stopLeader();
    else enterLeader();
  }, [leaderActive, enterLeader, stopLeader]);

  // ---- two-way audio call (Phase 7 §B) ------------------------------------
  const joinCall = async () => {
    try {
      await teleopRef.current?.joinCall();
    } catch (e) {
      appendLog("join call failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };
  const leaveCall = () => teleopRef.current?.leaveCall();
  const toggleMute = () => teleopRef.current?.setMicMuted(!call.micMuted);
  const toggleCamera = async () => {
    const t = teleopRef.current;
    if (!t) return;
    try {
      if (call.cameraOn) {
        t.disableCamera();
        if (selfViewRef.current) selfViewRef.current.srcObject = null;
      } else {
        const stream = await t.enableCamera(); // M6-gated in the UI; capture is built now
        if (selfViewRef.current) selfViewRef.current.srcObject = stream;
      }
    } catch (e) {
      appendLog("camera toggle failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Keyboard control: only while a session is running. The class ignores keys typed in
  // form fields and only emits jog when the control channel is open.
  useEffect(() => {
    if (!running) return;
    const down = (e: KeyboardEvent) => { if (teleopRef.current?.onKeyDown(e)) e.preventDefault(); };
    const up = (e: KeyboardEvent) => teleopRef.current?.onKeyUp(e);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [running]);

  // Tear down on unmount / navigate away (also fires the robot 'bye' for a clean restart).
  useEffect(() => () => { leaderRef.current?.stop(); vrRef.current?.stop(); teleopRef.current?.stop(); }, []);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-3xl font-bold">Remote teleop</h1>
        <span className="text-sm text-muted-foreground">
          {running ? `conn: ${connState}` : "not connected"}
          {inVr ? "  · in VR" : ""}
          {controlActive ? "  · control active" : ""}
        </span>
      </div>

      {!ready && (
        <p className="text-sm text-destructive">
          Nori auth/config not ready — sign in first (Supabase config comes from the laptop server).
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <div className="relative">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              controls
              className="w-full rounded-md bg-background"
              style={{ aspectRatio: "4 / 3" }}
            />
            {/* Reserved operator self-view slot (M6). Hidden until the camera is on. */}
            <video
              ref={selfViewRef}
              autoPlay
              playsInline
              muted
              className={
                "absolute bottom-2 right-2 w-32 rounded border-2 border-background bg-background shadow " +
                (m6 && call.cameraOn ? "" : "hidden")
              }
              style={{ aspectRatio: "4 / 3" }}
            />
          </div>
          {/* Robot inbound audio — unmuted sink, no video element can play it (video is muted). */}
          <audio ref={audioRef} autoPlay className="hidden" />

          <div className="flex flex-wrap items-center gap-3">
            {!running ? (
              <Button onClick={connect} disabled={connecting || !ready}>
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            ) : (
              <Button variant="destructive" onClick={disconnect}>Disconnect</Button>
            )}
            {xrSupported && (
              <Button
                variant="secondary"
                onClick={enterVr}
                disabled={!running || inVr || connState !== "connected"}
                title="Open the headset (AR passthrough) on this same session"
              >
                {inVr ? "In VR" : "Enter VR"}
              </Button>
            )}
            <Button
              variant={leaderActive ? "default" : "secondary"}
              onClick={toggleLeader}
              disabled={!running || connState !== "connected"}
              title="Drive the robot's arms from the physical dual leader arms (base + lift stay on the keyboard)"
            >
              {leaderActive ? `Leader on · ${leaderCount}/12` : "Leader control"}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              Arm
              <select
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={settings.arm}
                onChange={(e) => set("arm", e.target.value as ArmSide)}
              >
                <option value="right">right</option>
                <option value="left">left</option>
              </select>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => teleopRef.current?.toggleMode()}
              disabled={!running}
              title="Switch between cylindrical (rpi4 feel) and per-motor control"
            >
              Mode: {mode === "joint" ? "per-motor" : "cylindrical"}
            </Button>
          </div>

          <CallBar
            call={call}
            running={running}
            connected={connState === "connected"}
            m6={m6}
            onJoin={joinCall}
            onLeave={leaveCall}
            onToggleMute={toggleMute}
            onToggleCamera={toggleCamera}
          />

          <TelemetryPanel
            connState={running ? connState : "idle"}
            tel={tel}
            controlActive={controlActive}
            stale={stale}
            inVr={inVr}
          />

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Robot 3D (schematic)</CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <Robot3D state={tel.state} activeArm={settings.arm} />
            </CardContent>
          </Card>

          <div className="rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// telemetry</p>
            <h2 className="mt-1 text-lg font-semibold">Rail height</h2>
            <div className="mt-3">
              <RailHeight state={tel.state} />
            </div>
          </div>

          <div className="rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// telemetry</p>
            <h2 className="mt-1 text-lg font-semibold">Grip force / motor current</h2>
            <div className="mt-3">
              <GripForce currents={tel.currents} />
            </div>
          </div>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Controls</CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <ControlLegend mode={mode} />
            </CardContent>
          </Card>

          <div
            ref={logRef}
            className="max-h-44 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs"
          >
            {logLines.join("\n")}
          </div>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Session settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="room">Room (NORI_ROOM — must match the Pi)</Label>
              <Input id="room" value={settings.room} onChange={(e) => set("room", e.target.value)}
                placeholder={serial || "nori-dev"} />
              {serial ? (
                settings.room === serial ? (
                  <p className="text-xs text-muted-foreground">
                    using paired robot <span className="font-mono">{serial}</span>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    paired robot: <span className="font-mono">{serial}</span>{" "}
                    <button type="button" className="underline hover:text-foreground"
                      onClick={() => set("room", serial)}>use it</button>
                  </p>
                )
              ) : (
                <p className="text-xs text-muted-foreground">
                  pair a robot (Pairing) to auto-fill this from its serial.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="token">Room token (your Nori serial number)</Label>
              <Input id="token" type="password" value={settings.token}
                onChange={(e) => set("token", e.target.value)}
                placeholder={serial || "your Nori serial number"} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stun">STUN</Label>
              <Input id="stun" value={settings.stun} onChange={(e) => set("stun", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="turn">TURN URL(s) (blank = STUN-only)</Label>
              <Input id="turn" value={settings.turn} onChange={(e) => set("turn", e.target.value)}
                placeholder="turn:turn.example.com:3478?transport=udp" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="turnUser">TURN user</Label>
                <Input id="turnUser" value={settings.turnUser}
                  onChange={(e) => set("turnUser", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="turnCred">TURN cred</Label>
                <Input id="turnCred" type="password" value={settings.turnCred}
                  onChange={(e) => set("turnCred", e.target.value)} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={settings.forceRelay}
                onCheckedChange={(c) => set("forceRelay", c === true)}
              />
              force relay (TURN-only — Step 6 test)
            </label>
            <p className="text-xs text-muted-foreground">
              Settings persist locally and must match the Pi's <span className="font-mono">.env</span>.
              Change while connected to apply on the next session (Disconnect → Connect).
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

export default Remote;
