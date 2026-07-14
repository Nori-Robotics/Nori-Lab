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
import { Pill } from "@/components/ui/pill";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNori } from "@/nori/NoriContext";
import { useApi } from "@/contexts/ApiContext";
import { type ArmSide, type CameraViewHandle } from "@nori/sdk";
import { VrSession } from "@nori/sdk/vr";
import { VrHandoff } from "@/nori/components/VrHandoff";
import { TelemetryPanel, GripForce, ControlLegend, BaseCommandLegend, CallBar, ConnectionBanner, ControlOfflineBanner, RailHeight, RailHeightHelp } from "@/nori/remote/TeleopStatus";
import { Robot3D, hasJointTelemetry } from "@/nori/remote/Robot3D";
import { LeaderDriver } from "@/nori/remote/LeaderDriver";
import LeaderSetup from "@/nori/pages/leader-setup";
import { playAudioFile, type ClipHandle } from "@/nori/remote/audioClip";
import { DatasetCaptureCard } from "@/nori/remote/DatasetCaptureCard";
import { isM6VideoEnabled } from "@/nori/remote/flags";
import { useTeleopSession } from "@/nori/TeleopSessionContext";

// Small left/right arm toggle rendered in the header of whichever control card is
// active (keyboard legend, leader setup) — the arm choice belongs to the control
// method, not the // controls mode strip.
const ArmPills = ({
  value,
  onChange,
}: {
  value: ArmSide;
  onChange: (arm: ArmSide) => void;
}) => (
  // The ENTER binding that switches arms is advertised as a keycap in the Commands row of
  // BaseCommandLegend (next to SPACE / E-STOP), which renders in both cards this appears in —
  // so it isn't repeated here.
  <div className="flex items-center gap-1.5">
    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
      arm
    </span>
    {(["left", "right"] as ArmSide[]).map((arm) => (
      <Pill key={arm} size="sm" active={value === arm} onClick={() => onChange(arm)}>
        {arm}
      </Pill>
    ))}
  </div>
);

const Remote = () => {
  const { ready } = useNori();
  const { baseUrl, fetchWithHeaders } = useApi();
  // The session now lives in TeleopSessionProvider so it survives navigation (Remote <-> Coding).
  // This page is a consumer: it renders video/telemetry/settings and drives VR/leader/clip, but
  // it no longer owns the RemoteTeleop instance and must NOT stop it on unmount.
  const {
    teleop, running, connecting, connState, tel, stale, controlActive, mode, call, daemonStatus,
    connectStatus,
    logLines, appendLog, settings, setSetting: set, connect, disconnect: sessionDisconnect,
    toggleControlMode, setCurrentsListener,
  } = useTeleopSession();

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const selfViewRef = useRef<HTMLVideoElement>(null);
  const vrRef = useRef<VrSession | null>(null);
  const leaderRef = useRef<LeaderDriver | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const m6 = isM6VideoEnabled();

  const [showLog, setShowLog] = useState(false);
  // Each control-mode card (keyboard / leader / VR) collapses like Robot logs and
  // Session settings; expanded by default, remembered per mode while on the page.
  const [showKeyboardCard, setShowKeyboardCard] = useState(true);
  const [showLeaderCard, setShowLeaderCard] = useState(true);
  const [showVrCard, setShowVrCard] = useState(true);
  // Playback volume of the robot's inbound audio (the hidden <audio> sink), 0..1.
  const [volume, setVolume] = useState(1);
  const [inVr, setInVr] = useState(false);
  const [xrSupported, setXrSupported] = useState<boolean | null>(null);
  // Leader-arm control: when active the physical dual leaders drive the robot's arms
  // (absolute leader_action_deg); base + lift stay on the keyboard. leaderCount is how many
  // motors fed the last frame (0 = arms unplugged / bus paused). leaderSides is which
  // leader arms produced usable targets — with exactly one, the driver solo-routes it to
  // the SELECTED follower arm (the arm pills), so the UI must say where it's going.
  const [leaderActive, setLeaderActive] = useState(false);
  const [leaderCount, setLeaderCount] = useState(0);
  const [leaderSides, setLeaderSides] = useState<ArmSide[]>([]);
  // SAFETY GATE: the driver auto-starts in monitor-only mode (polls + shows live joints,
  // sends NOTHING). The robot only follows the leaders after the operator presses Engage —
  // so connecting mid-setup / pre-calibration can never slam the arms to garbage targets.
  const [leaderEngaged, setLeaderEngaged] = useState(false);
  // Calibration-health messages from the live frame (stale wrap schema, corrupted spans).
  const [leaderWarnings, setLeaderWarnings] = useState<string[]>([]);
  const [leaderCalibrating, setLeaderCalibrating] = useState(false);
  // Control mode SELECTION is independent of the session: leader doubles as the hardware
  // setup surface and VR as the headset entry point, so both are selectable while
  // disconnected. The actual drivers (leaderActive / inVr) only run on a live session.
  const [selectedMode, setSelectedMode] = useState<"keyboard" | "vr" | "leader">("keyboard");
  // Per-camera view (P4.6): the Pi always sends ONE composite track; this picks which tile to show.
  // "composite" = the full grid; a role = a live client-side crop of that tile (no Pi-side change).
  const [selectedCamera, setSelectedCamera] = useState("composite");
  const [cameraTiles, setCameraTiles] = useState<string[]>([]); // roles from the bridge layout, "" if none
  const cameraViewRef = useRef<CameraViewHandle | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  // Attach THIS page's media elements to the persistent session, and detach (not stop) on leave.
  // The SDK remembers the inbound stream and re-points these elements, so video survives a
  // round-trip to another page. Also RESUME the robot video encoder while Remote is showing video,
  // and PAUSE it on leave — the encoder is idle (and the Pi draws less power) whenever no page is
  // watching. The session default is paused (set in the provider), so other pages get no video.
  useEffect(() => {
    if (!teleop) return;
    teleop.setVideoEl(videoRef.current);
    teleop.setAudioEl(audioRef.current);
    teleop.resumeVideo();
    return () => { teleop.setVideoEl(null); teleop.setAudioEl(null); teleop.pauseVideo(); };
  }, [teleop]);

  // Track which camera tiles the composite carries (the bridge sends the layout ~2 s after connect,
  // re-sent a few times). Poll rather than subscribe — the provider owns onCameraLayout — and reset
  // the picker to composite when the layout goes away (disconnect).
  useEffect(() => {
    if (!teleop || connState !== "connected") { setCameraTiles([]); setSelectedCamera("composite"); return; }
    const read = () => {
      const tiles = teleop.cameraLayoutInfo()?.tiles ?? [];
      setCameraTiles((prev) => (prev.length === tiles.length && prev.every((t, i) => t === tiles[i]) ? prev : tiles));
    };
    read();
    const id = setInterval(read, 1500);
    return () => clearInterval(id);
  }, [teleop, connState]);

  // Point the <video> at either the full composite or a live per-tile crop. cameraView() crops the
  // named tile from the SAME composite track into its own canvas-captured stream (client-side; the Pi
  // is unaware), so switching costs nothing on the robot. Falls back to composite if the crop can't be
  // built yet (track/layout not ready) or the selected role vanished.
  useEffect(() => {
    if (!teleop) return;
    cameraViewRef.current?.stop();
    cameraViewRef.current = null;
    if (selectedCamera === "composite" || !cameraTiles.includes(selectedCamera)) {
      teleop.setVideoEl(videoRef.current); // re-points srcObject back to the composite
      return;
    }
    const handle = teleop.cameraView(selectedCamera);
    if (handle && videoRef.current) {
      videoRef.current.srcObject = handle.stream;
      cameraViewRef.current = handle;
    } else {
      teleop.setVideoEl(videoRef.current);
    }
    return () => { cameraViewRef.current?.stop(); cameraViewRef.current = null; };
  }, [teleop, selectedCamera, cameraTiles, connState]);

  // Keep the robot-audio sink at the chosen volume (also re-applies after re-attach above).
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, teleop]);

  // Feed gripper currents (haptics) + telemetry into the in-VR HUD while VR is active. Currents
  // arrive via a session-level listener (only one page registers at a time); telemetry mirrors
  // the value we already read from the context.
  useEffect(() => {
    setCurrentsListener((c) => vrRef.current?.setCurrents(c));
    return () => setCurrentsListener(null);
  }, [setCurrentsListener]);
  useEffect(() => { vrRef.current?.setTelemetry(tel); }, [tel]);
  // Keep the HUD's control row honest about motor health (same rule as the 2D chip). No status
  // yet = treat as online; the HUD's own staleness timer still catches a dead controller.
  useEffect(() => {
    vrRef.current?.setMotorsOnline(!daemonStatus || daemonStatus.state === "online");
  }, [daemonStatus]);


  // VR is an optional mode on top of the same session: detect headset support, and on any
  // link drop require a fresh squeeze before VR drive resumes (re-clutch-on-resume).
  useEffect(() => { VrSession.isSupported().then(setXrSupported); }, []);
  useEffect(() => {
    if (connState === "failed" || connState === "disconnected") vrRef.current?.reclutch();
  }, [connState]);

  // Connect/disconnect the session itself live in the provider. This page's disconnect also
  // stops the page-local drivers (leader / VR / clip) first, then tears the session down.
  const disconnect = useCallback(async () => {
    leaderRef.current?.stop();
    leaderRef.current = null;
    setLeaderActive(false);
    setLeaderCount(0);
    setLeaderSides([]);
    setLeaderEngaged(false);
    setLeaderCalibrating(false);
    await vrRef.current?.stop();
    vrRef.current = null;
    setInVr(false);
    await sessionDisconnect();
  }, [sessionDisconnect]);

  // Enter the immersive (AR-passthrough) headset session on top of the live link. Reuses
  // the same RemoteTeleop + video element; VR feeds `jog` exactly like the keyboard.
  const enterVr = async () => {
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
    setLeaderSides([]);
    setLeaderEngaged(false);
    setLeaderCalibrating(false);
  }, []);

  const enterLeader = useCallback(() => {
    if (!teleop) return;
    const driver = new LeaderDriver({
      teleop,
      baseUrl,
      fetcher: fetchWithHeaders,
      onFrame: (count, frame) => {
        setLeaderCount(count);
        setLeaderWarnings(frame.warnings ?? []);
        setLeaderCalibrating(Boolean(frame.calibrating));
        // Which leader arms produced usable targets this frame — drives the solo-routing
        // hint ("left leader -> right arm") and the no-targets warning below.
        setLeaderSides(
          (["left", "right"] as ArmSide[]).filter((s) =>
            Object.values(frame.leaders?.[s]?.motors ?? {}).some(
              (m) => m.ok && m.target !== null && m.target !== undefined,
            ),
          ),
        );
      },
      onError: (msg) => appendLog("leader read paused: " + msg),
      onEngagedChange: (engaged, reason) => {
        setLeaderEngaged(engaged);
        appendLog(`leader ${engaged ? "ENGAGED — robot arms following leaders" : `disengaged${reason ? ` (${reason})` : ""}`}`);
      },
    });
    leaderRef.current = driver;
    driver.start();
    setLeaderActive(true);
  }, [teleop, baseUrl, fetchWithHeaders, appendLog]);

  // Keep the leader driver's lifecycle tied to (mode, session) instead of the click that
  // selected the mode. Previously the driver only started if you clicked "Leader arm"
  // while ALREADY connected — pick Leader first, then Connect (the natural order), and
  // nothing ever drove the arms. This effect starts it whenever leader mode is selected
  // on a live session, and stops it when the session drops (a reconnect re-enters here
  // with a driver bound to the CURRENT teleop instance, not a stale one).
  useEffect(() => {
    if (selectedMode === "leader" && connState === "connected" && teleop && !leaderRef.current) {
      enterLeader();
    } else if (connState !== "connected" && leaderRef.current) {
      stopLeader();
    }
  }, [selectedMode, connState, teleop, enterLeader, stopLeader]);

  // ---- two-way audio call (Phase 7 §B) ------------------------------------
  const joinCall = async () => {
    try {
      await teleop?.joinCall();
    } catch (e) {
      appendLog("join call failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };
  const leaveCall = () => teleop?.leaveCall();
  const toggleMute = () => teleop?.setMicMuted(!call.micMuted);

  // ---- clip audio (laptop file -> robot speaker; reuses the M3b downlink) ----
  const clipRef = useRef<ClipHandle | null>(null);
  const [clipPlaying, setClipPlaying] = useState(false);
  const stopClip = useCallback(() => {
    clipRef.current?.stop();
    clipRef.current = null;
    setClipPlaying(false);
    teleop?.setVideoQuality("normal"); // restore camera bitrate
  }, [teleop]);
  const playClipFile = async (file: File) => {
    const t = teleop;
    if (!t) return;
    stopClip(); // one clip at a time (single audio uplink)
    try {
      const handle = await playAudioFile(t, file);
      clipRef.current = handle;
      setClipPlaying(true);
      t.setVideoQuality("low"); // free Pi headroom while the clip streams
      appendLog(`clip: streaming "${file.name}" to robot speaker`);
      handle.done.then(() => { // clears when the clip ends naturally or is stopped
        if (clipRef.current === handle) {
          clipRef.current = null;
          setClipPlaying(false);
          teleop?.setVideoQuality("normal"); // covers natural end (stopClip not called)
        }
      });
    } catch (e) {
      appendLog("clip failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };
  // Tear the clip down the moment the session drops — src.onended only fires on a clip's
  // NATURAL end, so a mid-clip disconnect would otherwise leak the AudioContext + track and
  // leave the SDK re-attaching a stale track on every reconnect.
  useEffect(() => {
    if (clipPlaying && connState !== "connected") stopClip();
  }, [clipPlaying, connState, stopClip]);
  const toggleCamera = async () => {
    const t = teleop;
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
    const down = (e: KeyboardEvent) => { if (teleop?.onKeyDown(e)) e.preventDefault(); };
    const up = (e: KeyboardEvent) => teleop?.onKeyUp(e);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [running, teleop]);

  // Enter toggles the active follower arm — same as the left/right pills — in the modes that
  // scope by it (keyboard + leader). Kept out of the SDK jog keymap since it's a UI selection,
  // not a jog. Ignored while typing in a field so it never hijacks form input.
  useEffect(() => {
    if (selectedMode !== "keyboard" && selectedMode !== "leader") return;
    const onEnter = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      set("arm", settings.arm === "left" ? "right" : "left");
      e.preventDefault();
    };
    window.addEventListener("keydown", onEnter);
    return () => window.removeEventListener("keydown", onEnter);
  }, [selectedMode, settings.arm, set]);

  // On unmount / navigate away, stop only the PAGE-LOCAL drivers (leader / VR / clip) and detach
  // media. The session itself lives in TeleopSessionProvider and stays connected across pages —
  // do NOT stop it here (that was the old bug that killed the link on every navigation).
  useEffect(() => () => { clipRef.current?.stop(); leaderRef.current?.stop(); vrRef.current?.stop(); }, []);

  const connected = running && connState === "connected";
  // Keep the pill terse — just the connection state. Loop rate / VR / control-active
  // detail lives in the telemetry card, not up here.
  // The pill speaks the connect PHASE, not the raw WebRTC state: `connState` is "idle" for the
  // whole waiting-for-the-robot window, so the old pill read "conn: idle" while the real answer
  // was "waiting for your robot" (or, after the deadline, "couldn't connect").
  const PHASE_PILL: Record<string, string> = {
    joining: "connecting…",
    waiting: "waiting for robot…",
    negotiating: "connecting…",
    connected: "connected",
    failed: "couldn't connect",
  };
  const status = connected
    ? "connected"
    : running || connecting ? (PHASE_PILL[connectStatus.phase] ?? "connecting…") : "not connected";
  // Which control method is selected (keyboard is the passive default — base + lift always
  // stay on the keyboard regardless). Each mode shows its own card below // controls.
  const controlMode = selectedMode;
  const selectKeyboard = useCallback(async () => {
    setSelectedMode("keyboard");
    stopLeader();
    await vrRef.current?.stop(); // onEnd clears inVr
  }, [stopLeader]);
  const selectVr = useCallback(async () => {
    setSelectedMode("vr");
    stopLeader();
    // Entering the headset itself is the card's "Enter VR" button — not automatic.
  }, [stopLeader]);
  const selectLeader = useCallback(async () => {
    setSelectedMode("leader");
    await vrRef.current?.stop();
    // The lifecycle effect above starts the arm driver once (mode=leader, connected) holds —
    // whether the session is live now or connects later. Offline the card is setup-only.
  }, []);

  return (
    <section className="space-y-4">
      {!ready && (
        <p className="text-sm text-destructive">
          Nori auth/config not ready — sign in first (Supabase config comes from the laptop server).
        </p>
      )}

      {/* One grid holds header + video (left) and the side panels (right), so the right
          column starts at the very top, level with the page title. */}
      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        <div className="space-y-3">
          {/* Header: connection status + Connect/Disconnect. The session itself lives in
              TeleopSessionProvider, so connecting from here is the same action as connecting on
              Home — it just saves the round trip. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-bold">Remote Operation</h1>
            <div className="flex items-center gap-3">
              <span
                className={
                  "inline-flex h-9 items-center rounded-full px-3 font-mono text-xs " +
                  (connected ? "bg-[#8ab135]/25 text-[#4d6a1e]" : "bg-[#14131a]/8 text-[#857b6b]")
                }
              >
                ● {status}
              </span>
              {running ? (
                <Button size="sm" variant="destructive" onClick={disconnect}>Disconnect</Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={connect} disabled={connecting}>
                  {connecting ? "Connecting…" : "Connect"}
                </Button>
              )}
            </div>
          </div>
          {/* Connection banner: what the connect attempt is doing, or why it failed + the remedy.
              Every connect failure used to land ONLY in the collapsed "Robot logs" box. */}
          <ConnectionBanner status={connectStatus} />
          {/* Motor-control outage banner: video/link can be perfectly healthy while the robot's
              controller is down or refusing sessions (dead arm) — say so, with the remedy,
              instead of letting it read as random dead control. */}
          {running && <ControlOfflineBanner status={daemonStatus} />}
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
            {/* Camera picker — only when the composite carries more than one tile. Crops client-side;
                the Pi keeps sending the single composite track regardless of the selection. */}
            {cameraTiles.length > 1 && (
              <select
                value={cameraTiles.includes(selectedCamera) ? selectedCamera : "composite"}
                onChange={(e) => setSelectedCamera(e.target.value)}
                title="Choose which camera to view. The robot always sends the full composite; this crops one tile locally."
                className="absolute left-2 top-2 rounded border border-background/40 bg-background/80 px-2 py-1 font-mono text-[11px] text-foreground shadow backdrop-blur"
              >
                <option value="composite">all cameras (composite)</option>
                {cameraTiles.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            )}
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

          {/* Dataset capture (browser catcher) — records this session into a LeRobot dataset.
              Sits under the video, where the operator is already looking while recording, rather
              than in the right rail among the control-mode cards. Renders only when a local lelab
              spool answers (hidden on the hosted app). */}
          <DatasetCaptureCard />

          {/* Single combined telemetry card: link/loop chips, then rail height, then grip force. */}
          <div className="rounded-md border border-[#14131a]/10 bg-[#f3f1e8] p-4 text-[#14131a] shadow-sm">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// telemetry</p>
            <div className="mt-3">
              <TelemetryPanel
                connState={running ? connState : "idle"}
                tel={tel}
                controlActive={controlActive}
                stale={stale}
                inVr={inVr}
                daemonStatus={running ? daemonStatus : null}
              />
            </div>
            <h2 className="mt-4 flex items-center gap-1.5 text-sm font-semibold">
              Rail height <RailHeightHelp />
            </h2>
            <div className="mt-2">
              <RailHeight state={tel.state} />
            </div>
            <h2 className="mt-4 text-sm font-semibold">Grip force / motor current</h2>
            <div className="mt-2">
              <GripForce currents={tel.currents} />
            </div>
          </div>

          {/* The script console now lives on the Coding page (/nori/coding), driving the same
              persistent session. */}
        </div>

        <div className="h-fit space-y-4">
        {/* Audio: two-way call plus clip-to-robot-speaker (reuses the M3b downlink; needs the
            robot's voice downlink on — --voice / NORI_SPEAKER). Always shown; disabled offline.
            Kept tight: in this 400px rail an active call fits on two rows, so joining doesn't
            shove the control cards down the page. */}
        <div className="rounded-md border border-[#14131a]/10 bg-[#f3f1e8] p-4 text-[#14131a] shadow-sm">
          {/* Clip-to-speaker rides on the "// audio" eyebrow line — it's a one-off action, not
              part of the call, and parking it here keeps the call controls and the you/nori
              indicators together on the rows below. */}
          <div className="flex min-h-5 flex-wrap items-center gap-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// audio</p>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#857b6b]">Play clip</span>
              <label
                className={
                  "rounded border border-[#14131a]/20 px-2 py-0.5 text-xs " +
                  (connected ? "cursor-pointer hover:bg-[#14131a]/5" : "pointer-events-none opacity-50")
                }
                title="Play an audio file out of the robot's speaker"
              >
                Choose file…
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  disabled={!connected}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = ""; // allow re-picking the same file
                    if (f) void playClipFile(f);
                  }}
                />
              </label>
              {clipPlaying && (
                <Button size="sm" variant="secondary" onClick={stopClip}>
                  Stop clip
                </Button>
              )}
            </div>
          </div>
          <div className="mt-3">
            <CallBar
              call={call}
              running={running}
              connected={connState === "connected"}
              m6={m6}
              onJoin={joinCall}
              onLeave={leaveCall}
              onToggleMute={toggleMute}
              onToggleCamera={toggleCamera}
              volume={volume}
              onVolumeChange={setVolume}
            />
          </div>
        </div>

        {/* Control-mode picker: which method drives the arms. All options are always shown
            (even when a headset / the leader arms aren't present); keyboard is the default. */}
        {/* min-h-16 = the collapsed control cards' 64px, so this strip lines up with them. */}
        <div className="flex min-h-16 flex-wrap items-center gap-3 rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-4 py-2 text-[#14131a] shadow-sm">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// controls</p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Pill
              active={controlMode === "keyboard"}
              onClick={selectKeyboard}
              title="Drive with the keyboard (default)"
            >
              Keyboard
            </Pill>
            <Pill
              active={controlMode === "leader"}
              onClick={selectLeader}
              title="Drive the robot's arms from the physical dual leader arms (base + lift stay on the keyboard). Selectable offline for hardware setup."
            >
              Leader arm
            </Pill>
            <Pill
              active={controlMode === "vr"}
              onClick={selectVr}
              title="Drive with a VR headset (AR passthrough) on this same session"
            >
              {inVr ? "In VR" : "VR"}
            </Pill>
          </div>
        </div>

        {/* VR mode card: the headset entry point on supported devices, a plain hint otherwise. */}
        {controlMode === "vr" && (
          <div className="rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-4 pb-4 pt-3 text-[#14131a] shadow-sm">
            <div
              className="flex min-h-9 cursor-pointer items-center justify-between"
              onClick={() => setShowVrCard((v) => !v)}
            >
              <h3 className="text-base font-semibold leading-none tracking-tight">VR control</h3>
              <span className="text-sm text-muted-foreground">{showVrCard ? "▲ hide" : "▼ show"}</span>
            </div>
            {showVrCard && (
              <div className="mt-3 space-y-3">
                {/* On a headset browser: enter VR directly on this same session. */}
                {xrSupported && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      onClick={enterVr}
                      disabled={!connected || inVr}
                      title="Open the headset (AR passthrough) on this same session"
                    >
                      {inVr ? "In VR" : "Enter VR"}
                    </Button>
                    {!connected && (
                      <span className="text-sm text-[#6f6858]">connect to the robot first</span>
                    )}
                  </div>
                )}
                {/* On a laptop: hand off a link to the hosted VR page to open on the headset. */}
                <VrHandoff room={settings.room} token={settings.token} />
              </div>
            )}
          </div>
        )}

        {/* Leader-arm hardware setup — the full leader-setup surface, embedded. Shown while
            leader mode is selected; usable offline (calibration doesn't need the session). */}
        {controlMode === "leader" && (
          <div className="rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-4 pb-4 pt-3 shadow-sm">
            {/* Routing status: with ONE leader arm connected the driver solo-routes it to the
                selected follower arm (the pills in the header) — say so, since otherwise a
                left leader silently driving the right arm reads as a wiring bug. Also flag
                the silent-failure state: driver running but no usable targets (arms unplugged
                or calibration missing/stale), where nothing is sent to the robot at all. */}
            {/* Live joint count + engagement — moved off the mode pill (which stays a plain
                "Leader arm" label) into the card's status area, right below the pills. */}
            {leaderActive && (
              <p className="mb-2 rounded bg-[#14131a]/5 px-2 py-1 text-xs font-medium text-[#4d463a]">
                {leaderCount}/{leaderSides.length === 1 ? 6 : 12} leader joints readable ·{" "}
                {leaderEngaged
                  ? leaderSides.length === 1 ? `engaged → ${settings.arm} arm` : "engaged"
                  : "standby (monitor-only)"}
              </p>
            )}
            {/* Calibration health, summary only — the embedded Leader setup below lists the
                per-joint details, so repeating them here just doubles the wall of text. */}
            {leaderActive && leaderWarnings.length > 0 && (
              <p className="mb-2 rounded bg-[#d24a3d]/10 px-2 py-1 text-xs font-semibold text-[#8f2318]">
                Calibration problems — recalibrate before engaging. Details in Leader setup below.
              </p>
            )}
            {leaderActive && leaderSides.length === 1 && (
              <p className="mb-2 rounded bg-[#8ab135]/15 px-2 py-1 text-xs text-[#4d6a1e]">
                One leader arm connected ({leaderSides[0]}) — {leaderEngaged ? "driving" : "will drive"} the{" "}
                <strong>{settings.arm}</strong> follower arm. Use the arm pills to switch sides.
              </p>
            )}
            {leaderActive && leaderSides.length === 0 && (
              <p className="mb-2 rounded bg-[#b06a1c]/15 px-2 py-1 text-xs text-[#7a4a13]">
                Leader mode is on but no leader joints are readable — nothing is being sent to
                the robot. Check the USB connection and that this machine has a leader
                calibration for the configured ID.
              </p>
            )}
            <LeaderSetup
              embedded
              collapsed={!showLeaderCard}
              onToggleCollapse={() => setShowLeaderCard((v) => !v)}
              titleExtra={
                /* ENGAGE gate lives next to the title: the driver auto-starts in standby
                   (monitor-only); the robot only follows the leaders after this explicit
                   engage. Always visible in leader mode (disabled with a reason) so it never
                   seems to vanish — locked while disconnected, no joints readable, or
                   calibration is running. */
                <Button
                  size="sm"
                  variant={leaderEngaged ? "destructive" : "default"}
                  onClick={() => leaderRef.current?.setEngaged(!leaderEngaged)}
                  disabled={!leaderActive || (!leaderEngaged && (leaderCount === 0 || leaderCalibrating))}
                  className={
                    leaderEngaged
                      ? "rounded-md"
                      : "rounded-md bg-[#8ab135] text-foreground hover:bg-[#799c2a]"
                  }
                  title={
                    !leaderActive
                      ? "Connect to the robot first — engage sends leader poses to the arms"
                      : leaderEngaged
                        ? "Robot arms are following the leaders — disengage before letting go of them"
                        : leaderCalibrating
                          ? "Calibration in progress — engagement is locked until it finishes"
                          : leaderCount === 0
                            ? "Waiting for readable leader joints"
                            : "Hold the leaders near the robot's current pose, then engage; the arms will move to match"
                  }
                >
                  {leaderEngaged ? "Disengage" : "Engage"}
                </Button>
              }
              headerExtra={<ArmPills value={settings.arm} onChange={(arm) => set("arm", arm)} />}
              headerBelow={
                /* Base + lift + commands stay on the keyboard while the leaders drive the
                   arms — keep those bindings visible right where leader driving happens. */
                <div className="rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-3">
                  <BaseCommandLegend
                    wasd
                    hint="Base + lift stay on the keyboard while the leaders drive the arms; once engaged, WASD drives the base too (until then it still jogs the arm). Click the video first so keys register."
                  />
                </div>
              }
            />
          </div>
        )}

        {/* Keyboard legend only shows for its own mode, like the VR and leader cards. */}
        {controlMode === "keyboard" && (
        <Card className="border-[#14131a]/10 bg-[#f3f1e8] text-[#14131a]">
          <CardHeader
            className={`cursor-pointer px-4 pt-3 ${showKeyboardCard ? "pb-0" : "pb-4"}`}
            onClick={() => setShowKeyboardCard((v) => !v)}
          >
            {/* min-h-9 lives on the unpadded title row (not the padded header) so the
                collapsed height matches the VR / leader / logs / settings cards exactly. */}
            <CardTitle className="flex min-h-9 items-center justify-between text-base font-semibold">
              Keyboard controls
              <span className="text-sm font-normal text-muted-foreground">
                {showKeyboardCard ? "▲ hide" : "▼ show"}
              </span>
            </CardTitle>
          </CardHeader>
          {showKeyboardCard && (
          <CardContent className="p-4 pt-3">
            {/* Arm + drive mode live on their own row between the title and the legend. */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <ArmPills value={settings.arm} onChange={(arm) => set("arm", arm)} />
              {/* Cylindrical vs per-motor only affects keyboard driving, so it lives here. */}
              {/* Toggleable offline too: the choice is held in the session context and passed
                  to the next RemoteTeleop at connect, so pre-connect selection sticks. */}
              <Button
                variant="outline"
                size="sm"
                onClick={toggleControlMode}
                title="Switch between cylindrical (rpi4 feel) and per-motor control"
              >
                Mode: {mode === "joint" ? "per-motor" : "cylindrical"}
              </Button>
            </div>
            <ControlLegend mode={mode} />
          </CardContent>
          )}
        </Card>
        )}

        <div className="rounded-md border border-[#14131a]/10 bg-[#f3f1e8] p-4 text-[#14131a] shadow-sm">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// 3d schematic</p>
            {!hasJointTelemetry(tel.state) && (
              <span className="text-[11px] text-muted-foreground">waiting for joint telemetry…</span>
            )}
          </div>
          <div className="mt-3">
            <Robot3D state={tel.state} activeArm={settings.arm} />
          </div>
        </div>

        <Card className="border-[#14131a]/10 bg-[#f3f1e8] text-[#14131a]">
          <CardHeader
            className={`cursor-pointer px-4 pt-3 ${showLog ? "pb-0" : "pb-4"}`}
            onClick={() => setShowLog((v) => !v)}
          >
            <CardTitle className="flex min-h-9 items-center justify-between text-base font-semibold">
              Robot logs
              <span className="text-sm font-normal text-muted-foreground">{showLog ? "▲ hide" : "▼ show"}</span>
            </CardTitle>
          </CardHeader>
          {showLog && (
          <CardContent className="p-4 pt-3">
            <div
              ref={logRef}
              className="max-h-96 min-h-44 overflow-auto whitespace-pre-wrap rounded border border-[#14131a]/10 bg-[#f3f1e8] p-2 font-mono text-xs"
            >
              {logLines.length > 0 ? (
                logLines.join("\n")
              ) : (
                <span className="text-muted-foreground">Connect to Nori to view logs</span>
              )}
            </div>
          </CardContent>
          )}
        </Card>
        </div>
      </div>
    </section>
  );
};

export default Remote;
