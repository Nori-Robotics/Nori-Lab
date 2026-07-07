// NORI: Additive file. A teleop session that OUTLIVES page navigation.
//
// The RemoteTeleop peer connection used to live in a useRef inside the Remote page, so routing
// away unmounted the page and tore the session down (its cleanup called teleop.stop() -> robot
// `bye`). That made the Coding page's scripts run against a dead session, and dropped the video
// on every navigation. This provider hoists the whole session up to the /nori parent route
// element (mounted in App.tsx just inside NoriProvider, outside NoriLayout), so it survives every
// /nori/* child navigation (Remote <-> Coding <-> …) and only tears down on explicit Disconnect
// or when the user leaves /nori entirely.
//
// Pages become thin consumers: they read connState/telemetry/logs, call connect()/disconnect(),
// and — for the page that shows video — attach their <video>/<audio> via teleop.setVideoEl()
// (the SDK remembers the inbound stream and re-points a fresh element). No page owns the session.

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { RemoteTeleop, type ArmSide, type CallState, type ControlMode, type TelemetryView } from "@nori/sdk";
import { SupabaseSignaling } from "@nori/sdk/supabase";
import { getSupabase } from "@/nori/auth/supabase";
import { useNori } from "@/nori/NoriContext";

const DEFAULT_STUN = "stun:stun.l.google.com:19302";

// Remote-session settings persist in localStorage (must match the Pi's .env).
export type Settings = {
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
  room: "", token: "", stun: DEFAULT_STUN, turn: "", turnUser: "", turnCred: "", forceRelay: false, arm: "right",
};

const LS_SETTINGS = "nori_remote_settings";
const LS_SCRIPT = "nori_script_source";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

const EMPTY_TEL: TelemetryView = {
  loopHz: 0, safety: "-", watchdog: "-", tempC: 0, active: false, linkMode: null, currents: {}, state: {},
};

const EMPTY_CALL: CallState = {
  active: false, micMuted: true, micSending: false, robotAudio: false, robotMicLive: false, cameraOn: false,
};

export interface TeleopSessionValue {
  teleop: RemoteTeleop | null; // the live instance (null until connected)
  running: boolean; // a session exists (connected or connecting-through)
  connecting: boolean;
  connState: string;
  tel: TelemetryView;
  stale: boolean;
  controlActive: boolean;
  mode: ControlMode;
  call: CallState;
  logLines: string[];
  appendLog: (msg: string) => void;
  settings: Settings;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  // Pages that want gripper-current haptics (VR) register a listener; only one at a time.
  setCurrentsListener: (fn: ((c: Record<string, number>) => void) | null) => void;
  // The pasted/generated script text, persisted so it survives navigation + reload.
  scriptSource: string;
  setScriptSource: (s: string) => void;
}

const TeleopSessionContext = createContext<TeleopSessionValue | undefined>(undefined);

export const TeleopSessionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { activeRobotSerial, customer } = useNori();

  const teleopRef = useRef<RemoteTeleop | null>(null);
  const [teleop, setTeleop] = useState<RemoteTeleop | null>(null);
  const [running, setRunning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connState, setConnState] = useState("idle");
  const [controlActive, setControlActive] = useState(false);
  const [mode, setMode] = useState<ControlMode>("cylindrical");
  const [tel, setTel] = useState<TelemetryView>(EMPTY_TEL);
  const [stale, setStale] = useState(false);
  const [call, setCall] = useState<CallState>(EMPTY_CALL);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [scriptSource, setScriptSourceState] = useState<string>(() => {
    try { return localStorage.getItem(LS_SCRIPT) ?? ""; } catch { return ""; }
  });

  const lastTelRef = useRef(0);
  const currentsListenerRef = useRef<((c: Record<string, number>) => void) | null>(null);

  const appendLog = useCallback((msg: string) => {
    setLogLines((prev) => [...prev.slice(-300), msg]);
  }, []);

  const setSetting = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((s) => {
      const next = { ...s, [k]: v };
      try { localStorage.setItem(LS_SETTINGS, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const setScriptSource = useCallback((s: string) => {
    setScriptSourceState(s);
    try { localStorage.setItem(LS_SCRIPT, s); } catch { /* ignore */ }
  }, []);

  const setCurrentsListener = useCallback((fn: ((c: Record<string, number>) => void) | null) => {
    currentsListenerRef.current = fn;
  }, []);

  const onTelemetry = useCallback((t: TelemetryView) => {
    lastTelRef.current = Date.now();
    setStale(false);
    setTel(t);
  }, []);

  // Telemetry can dry up while control still reads "active"; flag it stale (matches old page logic).
  useEffect(() => {
    if (!running) { setStale(false); return; }
    const id = setInterval(() => {
      if (lastTelRef.current && Date.now() - lastTelRef.current > 1500) setStale(true);
    }, 500);
    return () => clearInterval(id);
  }, [running]);

  // Default the room to the paired robot's serial (only while unset — a typed value wins).
  const serial = activeRobotSerial ?? customer?.robot_serial_number ?? "";
  useEffect(() => {
    if (!settings.room && serial) setSetting("room", serial);
  }, [serial, settings.room, setSetting]);

  // Live-update the active session's arm without reconnecting.
  useEffect(() => {
    teleopRef.current?.setArm(settings.arm);
  }, [settings.arm]);

  const connect = useCallback(async () => {
    if (teleopRef.current) return; // already have a session
    setConnecting(true);
    setLogLines([]);
    const turnUrls = settings.turn.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const room = settings.room.trim() || serial || "nori-dev";
    const t = new RemoteTeleop({
      signaling: new SupabaseSignaling(getSupabase(), room, appendLog),
      // No videoEl/audioEl here: the session is page-independent. The page that shows video
      // attaches its elements via teleop.setVideoEl()/setAudioEl() on mount.
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
      onCurrents: (c) => currentsListenerRef.current?.(c),
      onCall: setCall,
    });
    teleopRef.current = t;
    setTeleop(t);
    try {
      await t.start();
      setRunning(true);
    } catch (e) {
      appendLog("start failed: " + (e instanceof Error ? e.message : String(e)));
      teleopRef.current = null;
      setTeleop(null);
    } finally {
      setConnecting(false);
    }
  }, [settings, serial, appendLog, onTelemetry]);

  const disconnect = useCallback(async () => {
    const t = teleopRef.current;
    teleopRef.current = null;
    setTeleop(null);
    if (t) await t.stop();
    setRunning(false);
    setControlActive(false);
    setConnState("idle");
    setTel(EMPTY_TEL);
    setCall(EMPTY_CALL);
  }, []);

  // Leaving /nori entirely unmounts this provider — tear the session down cleanly (robot `bye`).
  useEffect(() => () => { teleopRef.current?.stop(); }, []);

  const value = useMemo<TeleopSessionValue>(() => ({
    teleop, running, connecting, connState, tel, stale, controlActive, mode, call,
    logLines, appendLog, settings, setSetting, connect, disconnect, setCurrentsListener,
    scriptSource, setScriptSource,
  }), [
    teleop, running, connecting, connState, tel, stale, controlActive, mode, call,
    logLines, appendLog, settings, setSetting, connect, disconnect, setCurrentsListener,
    scriptSource, setScriptSource,
  ]);

  return <TeleopSessionContext.Provider value={value}>{children}</TeleopSessionContext.Provider>;
};

export const useTeleopSession = (): TeleopSessionValue => {
  const ctx = useContext(TeleopSessionContext);
  if (ctx === undefined) throw new Error("useTeleopSession must be used within a TeleopSessionProvider");
  return ctx;
};
