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
import {
  RemoteTeleop,
  type ArmSide, type CallState, type ConnectStatus, type ControlMode, type DaemonStatus,
  type RecordState, type TelemetryView,
} from "@nori/sdk";
import { SupabaseSignaling } from "@nori/sdk/supabase";
import { getSupabase } from "@/nori/auth/supabase";
import { getAccessToken } from "@/nori/auth/session";
import { useNori } from "@/nori/NoriContext";
import { useApi } from "@/contexts/ApiContext";
import { getTurnCredentials } from "@/nori/api/client";
import { isTurnMintEnabled, isPrivateRoomEnabled } from "@/nori/remote/flags";

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
  // Sensitivity tuning (per-browser, like everything else here). kbSpeed scales every
  // held-key jog rate (RemoteTeleop.setKeyboardSpeed); the vr* fields feed
  // VrJogMapper.setTuning. Defaults reproduce the hardware-tuned behavior exactly.
  kbSpeed: number;       // (0..1] fraction of the daemon's full per-tick step
  vrSensitivity: number; // multiplier on VR hand-motion response
  vrGripperOpen: number; // (0..1] VR gripper opening rate; close is always 1.5× this (capped)
};

const DEFAULTS: Settings = {
  room: "", token: "", stun: DEFAULT_STUN, turn: "", turnUser: "", turnCred: "", forceRelay: false, arm: "right",
  kbSpeed: 1, vrSensitivity: 1, vrGripperOpen: 0.25,
};

const LS_SETTINGS = "nori_remote_settings";
const LS_SCRIPT = "nori_script_source";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    // turnCred is memory-only: it's supplied per-session by minting (nori_turn_mint),
    // or a stale static value the use-auth-secret relay rejects. Never rehydrate it from
    // localStorage — drops any secret persisted by older builds. (Room token still
    // persists until it becomes a minted JWT at signaling Phase 2.)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw), turnCred: "" };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

const EMPTY_TEL: TelemetryView = {
  loopHz: 0, safety: "-", watchdog: "-", tempC: 0, active: false, linkMode: null, currents: {},
  state: {}, videoNet: null,
};

const EMPTY_CALL: CallState = {
  active: false, micMuted: true, micSending: false, robotAudio: false, robotMicLive: false,
  robotMicMuted: false, cameraOn: false,
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
  // Robot-daemon health from the Pi bridge (daemon_status frames), null until one arrives.
  // Distinguishes "robot online but daemon down/restarting/refusing" from a healthy session —
  // connState alone cannot (the media bridge stays connected while the daemon is dead).
  daemonStatus: DaemonStatus | null;
  // On-robot episode recorder state (W2.11 record_status replies), null until the first
  // reply — recording-disabled robots answer {ok:false, error:"recorder unreachable"}.
  recordState: RecordState | null;
  // What the connect attempt is doing, and why it failed if it did (see ConnectStatus in the SDK).
  // connState is the raw WebRTC state and is "idle" for the whole waiting-for-the-robot window,
  // so it cannot answer "what is wrong" — this can.
  connectStatus: ConnectStatus;
  logLines: string[];
  appendLog: (msg: string) => void;
  settings: Settings;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  // Flip cylindrical <-> per-motor. Works offline too: the choice is kept here and passed
  // to the next session at connect, so the displayed mode is always the mode you get.
  toggleControlMode: () => void;
  // Pages that want gripper-current haptics (VR) register a listener; only one at a time.
  setCurrentsListener: (fn: ((c: Record<string, number>) => void) | null) => void;
  // Dataset capture (browser catcher) taps: full-rate telemetry rows and every outbound
  // control frame. One listener each, same single-consumer contract as currents above.
  setTelemetryListener: (fn: ((t: TelemetryView) => void) | null) => void;
  setControlSentListener: (fn: ((frame: Record<string, unknown>, tWallMs: number) => void) | null) => void;
  // The pasted/generated script text, persisted so it survives navigation + reload.
  scriptSource: string;
  setScriptSource: (s: string) => void;
}

const TeleopSessionContext = createContext<TeleopSessionValue | undefined>(undefined);

export const TeleopSessionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { activeRobotSerial, customer } = useNori();
  const { baseUrl, fetchWithHeaders } = useApi();

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
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);
  const [recordState, setRecordState] = useState<RecordState | null>(null);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>({ phase: "idle" });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [scriptSource, setScriptSourceState] = useState<string>(() => {
    try { return localStorage.getItem(LS_SCRIPT) ?? ""; } catch { return ""; }
  });

  const lastTelRef = useRef(0);
  const currentsListenerRef = useRef<((c: Record<string, number>) => void) | null>(null);

  const appendLog = useCallback((msg: string) => {
    setLogLines((prev) => {
      // Collapse consecutive duplicates into one line with a counter ("… (x12)") — a daemon
      // refusal loop re-sends the same fatal error every ~1 s, which used to bury everything
      // else in the log box. Only CONSECUTIVE repeats collapse, so interleaved events keep
      // their order.
      const last = prev[prev.length - 1];
      const m = last?.match(/^(.*) \(x(\d+)\)$/);
      const lastBase = m ? m[1] : last;
      if (lastBase === msg) {
        const n = m ? parseInt(m[2], 10) + 1 : 2;
        return [...prev.slice(0, -1), `${msg} (x${n})`];
      }
      return [...prev.slice(-300), msg];
    });
  }, []);

  const setSetting = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((s) => {
      const next = { ...s, [k]: v };
      // Persist everything EXCEPT the TURN credential — it's minted per-session or dead,
      // so it must not sit in localStorage in plaintext (retires the earlier finding).
      try {
        const { turnCred: _omit, ...persist } = next;
        localStorage.setItem(LS_SETTINGS, JSON.stringify(persist));
      } catch { /* ignore */ }
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

  const telemetryListenerRef = useRef<((t: TelemetryView) => void) | null>(null);
  const setTelemetryListener = useCallback((fn: ((t: TelemetryView) => void) | null) => {
    telemetryListenerRef.current = fn;
  }, []);
  const controlSentListenerRef = useRef<((frame: Record<string, unknown>, tWallMs: number) => void) | null>(null);
  const setControlSentListener = useCallback(
    (fn: ((frame: Record<string, unknown>, tWallMs: number) => void) | null) => {
      controlSentListenerRef.current = fn;
    }, []);

  const onTelemetry = useCallback((t: TelemetryView) => {
    lastTelRef.current = Date.now();
    setStale(false);
    setTel(t);
    telemetryListenerRef.current?.(t);
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

  // Live-update keyboard speed the same way (also applied at connect for a new session,
  // since this effect only fires on slider changes).
  useEffect(() => {
    teleopRef.current?.setKeyboardSpeed(settings.kbSpeed);
  }, [settings.kbSpeed]);

  const connect = useCallback(async () => {
    if (teleopRef.current) return; // already have a session
    setConnecting(true);
    setLogLines([]);
    setDaemonStatus(null);
    setRecordState(null);
    setConnectStatus({ phase: "joining" });
    let turnUrls = settings.turn.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    let turnUser = settings.turnUser.trim();
    let turnCred = settings.turnCred.trim();
    // §2.4 minted TURN creds: fetch short-lived coturn credentials at session start
    // instead of using the static typed/persisted ones. The relay cutover to
    // use-auth-secret is done (2026-07-15), so minting is now driven by whether the
    // operator is SIGNED IN — the mint endpoint (GET /api/v1/turn/credentials) needs a
    // provisioned-customer JWT and 401s anonymously, so an anonymous LAN session (the
    // hosted /nori/drive quick-start) correctly skips the fetch and stays on STUN. The
    // isTurnMintEnabled() flag remains as a manual override for dev/testing. ANY failure
    // falls back to the configured creds, so this can never make connect worse than before.
    const signedIn = !!(await getAccessToken());
    if (isTurnMintEnabled() || signedIn) {
      try {
        const c = await getTurnCredentials(baseUrl, fetchWithHeaders);
        turnUrls = c.urls;
        turnUser = c.username;
        turnCred = c.credential;
        appendLog(`TURN: using minted credentials (ttl ${c.ttl}s)`);
      } catch (e) {
        appendLog("TURN: mint failed, using configured creds — " + (e instanceof Error ? e.message : String(e)));
      }
    }
    const room = settings.room.trim() || serial || "nori-dev";
    // getSupabase() throws when the app never got its config. That throw used to happen OUTSIDE
    // the try below (it's an argument to the constructor), so `connecting` was never cleared and
    // the button sat on "Connecting…" forever with no error.
    let supabase: ReturnType<typeof getSupabase>;
    try {
      supabase = getSupabase();
    } catch (e) {
      appendLog("start failed: " + (e instanceof Error ? e.message : String(e)));
      setConnectStatus({ phase: "failed", reason: "signaling_unreachable" });
      setConnecting(false);
      return;
    }
    const t = new RemoteTeleop({
      signaling: new SupabaseSignaling(supabase, room, appendLog, { private: isPrivateRoomEnabled() }),
      // No videoEl/audioEl here: the session is page-independent. The page that shows video
      // attaches its elements via teleop.setVideoEl()/setAudioEl() on mount.
      token: settings.token.trim(),
      stun: settings.stun.trim() || DEFAULT_STUN,
      turnUrls,
      turnUser,
      turnCred,
      forceRelay: settings.forceRelay,
      arm: settings.arm,
      // Honor the CURRENT UI selection: a fresh RemoteTeleop defaults to cylindrical, which
      // used to silently override a pre-connect (or previous-session) per-motor choice.
      mode,
      onLog: appendLog,
      onConnState: setConnState,
      onTelemetry,
      onMode: setMode,
      onControlActive: setControlActive,
      onCurrents: (c) => currentsListenerRef.current?.(c),
      onControlSent: (f, t) => controlSentListenerRef.current?.(f, t),
      onCall: setCall,
      // Note which cameras the composite is showing, once, on connect. (Per-move completion is
      // surfaced by moveTo itself in the script output, so action_status isn't logged here.)
      onCameraLayout: (l) => appendLog(`camera layout: ${l.tiles.join(", ")}`),
      // Daemon health transitions (the SDK already appends them to the log; this drives the
      // banner/chip so "daemon down/restarting" never reads as random dead control).
      onDaemonStatus: setDaemonStatus,
      // On-robot recorder replies (W2.11) — drives the CallBar record control.
      onRecord: setRecordState,
      // The connect-phase machine — drives the connection banner.
      onConnectStatus: setConnectStatus,
      // The handshake ack. It was never wired, so a robot that REFUSED the session (accepted:false)
      // or spoke a different protocol version left no trace outside the collapsed log box. The SDK
      // turns a refusal into a `session_rejected` phase; this is here for the advisory mismatch.
      onReady: (info) => {
        if (info.versionMismatch) {
          appendLog("this robot is running different software than the app expects");
        }
      },
    });
    teleopRef.current = t;
    setTeleop(t);
    t.setKeyboardSpeed(settings.kbSpeed);
    // Default video OFF for power: the robot's software x264 encoder is idle until a page that
    // shows video resumes it (the Remote page does, on mount). Applied when the control channel
    // opens even though it's set here pre-connect.
    t.pauseVideo();
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
  }, [settings, serial, appendLog, onTelemetry, mode, baseUrl, fetchWithHeaders]);

  const toggleControlMode = useCallback(() => {
    const t = teleopRef.current;
    if (t) t.toggleMode(); // onMode callback updates `mode`
    else setMode((m) => (m === "joint" ? "cylindrical" : "joint"));
  }, []);

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
    setDaemonStatus(null);  // health is per-session; don't show a stale banner next connect
    setRecordState(null);   // same: recorder state is a per-session probe
    setConnectStatus({ phase: "idle" });
  }, []);

  // Leaving /nori entirely unmounts this provider — tear the session down cleanly (robot `bye`).
  useEffect(() => () => { teleopRef.current?.stop(); }, []);

  const value = useMemo<TeleopSessionValue>(() => ({
    teleop, running, connecting, connState, tel, stale, controlActive, mode, call, daemonStatus,
    recordState, connectStatus,
    logLines, appendLog, settings, setSetting, connect, disconnect, toggleControlMode,
    setCurrentsListener, setTelemetryListener, setControlSentListener, scriptSource, setScriptSource,
  }), [
    teleop, running, connecting, connState, tel, stale, controlActive, mode, call, daemonStatus,
    recordState, connectStatus,
    logLines, appendLog, settings, setSetting, connect, disconnect, toggleControlMode,
    setCurrentsListener, setTelemetryListener, setControlSentListener, scriptSource, setScriptSource,
  ]);

  return <TeleopSessionContext.Provider value={value}>{children}</TeleopSessionContext.Provider>;
};

export const useTeleopSession = (): TeleopSessionValue => {
  const ctx = useContext(TeleopSessionContext);
  if (ctx === undefined) throw new Error("useTeleopSession must be used within a TeleopSessionProvider");
  return ctx;
};
