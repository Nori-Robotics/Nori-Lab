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
import { getSupabase } from "@/nori/auth/supabase";
import {
  RemoteTeleop,
  type ArmSide,
  type ControlMode,
  type TelemetryView,
} from "@/nori/remote/teleop";
import { VrSession } from "@/nori/remote/vr-session";

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const teleopRef = useRef<RemoteTeleop | null>(null);
  const vrRef = useRef<VrSession | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [connecting, setConnecting] = useState(false);
  const [running, setRunning] = useState(false);
  const [inVr, setInVr] = useState(false);
  const [xrSupported, setXrSupported] = useState<boolean | null>(null);
  const [connState, setConnState] = useState("idle");
  const [controlActive, setControlActive] = useState(false);
  const [mode, setMode] = useState<ControlMode>("cylindrical");
  const [tel, setTel] = useState<TelemetryView>({
    loopHz: 0, safety: "-", watchdog: "-", tempC: 0, active: false,
  });
  const [logLines, setLogLines] = useState<string[]>([]);

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
    const teleop = new RemoteTeleop({
      supabase: getSupabase(),
      videoEl: videoRef.current,
      room: settings.room.trim() || serial || "nori-dev",
      token: settings.token.trim(),
      stun: settings.stun.trim() || DEFAULT_STUN,
      turnUrls,
      turnUser: settings.turnUser.trim(),
      turnCred: settings.turnCred.trim(),
      forceRelay: settings.forceRelay,
      arm: settings.arm,
      onLog: appendLog,
      onConnState: setConnState,
      onTelemetry: setTel,
      onMode: setMode,
      onControlActive: setControlActive,
      onCurrents: (c) => vrRef.current?.setCurrents(c), // gripper current -> VR haptics
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
  useEffect(() => () => { vrRef.current?.stop(); teleopRef.current?.stop(); }, []);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Remote teleop</h1>
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
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            controls
            className="w-full rounded-md bg-black"
            style={{ aspectRatio: "4 / 3" }}
          />
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
            <span className="rounded bg-muted px-2 py-1 font-mono text-xs">
              {tel.active
                ? `loop ${tel.loopHz.toFixed(1)}Hz  safety=${tel.safety}  wd=${tel.watchdog}  temp=${tel.tempC.toFixed(0)}C`
                : "control inactive"}
            </span>
            <span className="text-xs text-muted-foreground">
              mode: {mode === "joint" ? "per-motor" : "cylindrical (rpi4)"} — press M to toggle
            </span>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">keyboard controls</summary>
            <pre className="mt-2 whitespace-pre-wrap text-xs">
{`M = toggle control mode (default: cylindrical / rpi4)
cylindrical:  Q/E shoulder_pan  W/S x(reach)  A/D y(reach)  Z/X pitch  R/F wrist_roll  T/G gripper
per-motor:    Q/A shoulder_pan  W/S shoulder_lift  E/D elbow_flex  R/F wrist_flex  T/G wrist_roll  Y/H gripper
base: I/K fwd/back   J/L turn   U/O lift (the SELECTED arm)     cmds: SPACE e-stop   P reset-latch   C reset
Click the video/page first so it has keyboard focus. Keys are ignored while typing in a field.`}
            </pre>
          </details>

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
