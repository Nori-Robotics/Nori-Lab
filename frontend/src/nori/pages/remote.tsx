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
import { type ArmSide } from "@nori/sdk";
import { VrSession } from "@nori/sdk/vr";
import { TelemetryPanel, GripForce, ControlLegend, CallBar, RailHeight, RailHeightHelp } from "@/nori/remote/TeleopStatus";
import { Robot3D, hasJointTelemetry } from "@/nori/remote/Robot3D";
import { LeaderDriver } from "@/nori/remote/LeaderDriver";
import LeaderSetup from "@/nori/pages/leader-setup";
import { playAudioFile, type ClipHandle } from "@/nori/remote/audioClip";
import { isM6VideoEnabled } from "@/nori/remote/flags";
import { useTeleopSession } from "@/nori/TeleopSessionContext";

const Remote = () => {
  const { ready, customer, activeRobotSerial } = useNori();
  const { baseUrl, fetchWithHeaders } = useApi();
  // The session now lives in TeleopSessionProvider so it survives navigation (Remote <-> Coding).
  // This page is a consumer: it renders video/telemetry/settings and drives VR/leader/clip, but
  // it no longer owns the RemoteTeleop instance and must NOT stop it on unmount.
  const {
    teleop, running, connecting, connState, tel, stale, controlActive, mode, call,
    logLines, appendLog, settings, setSetting: set, connect, disconnect: sessionDisconnect,
    setCurrentsListener,
  } = useTeleopSession();

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const selfViewRef = useRef<HTMLVideoElement>(null);
  const vrRef = useRef<VrSession | null>(null);
  const leaderRef = useRef<LeaderDriver | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const m6 = isM6VideoEnabled();

  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  // Playback volume of the robot's inbound audio (the hidden <audio> sink), 0..1.
  const [volume, setVolume] = useState(1);
  const [inVr, setInVr] = useState(false);
  const [xrSupported, setXrSupported] = useState<boolean | null>(null);
  // Leader-arm control: when active the physical dual leaders drive the robot's arms
  // (absolute leader_action_deg); base + lift stay on the keyboard. leaderCount is how many
  // motors fed the last frame (0 = arms unplugged / bus paused).
  const [leaderActive, setLeaderActive] = useState(false);
  const [leaderCount, setLeaderCount] = useState(0);
  // Control mode SELECTION is independent of the session: leader doubles as the hardware
  // setup surface and VR as the headset entry point, so both are selectable while
  // disconnected. The actual drivers (leaderActive / inVr) only run on a live session.
  const [selectedMode, setSelectedMode] = useState<"keyboard" | "vr" | "leader">("keyboard");

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

  const serial = activeRobotSerial ?? customer?.robot_serial_number ?? "";

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
  }, []);

  const enterLeader = useCallback(() => {
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
  }, [teleop, baseUrl, fetchWithHeaders, appendLog]);

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

  // On unmount / navigate away, stop only the PAGE-LOCAL drivers (leader / VR / clip) and detach
  // media. The session itself lives in TeleopSessionProvider and stays connected across pages —
  // do NOT stop it here (that was the old bug that killed the link on every navigation).
  useEffect(() => () => { clipRef.current?.stop(); leaderRef.current?.stop(); vrRef.current?.stop(); }, []);

  const connected = running && connState === "connected";
  const status = connected
    ? `connected · ${Math.round(tel.loopHz)} Hz`
    : connecting ? "connecting…" : running ? `conn: ${connState}` : "not connected";
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
    // Only start the arm driver on a live session; offline the card is setup-only.
    if (connState === "connected" && !leaderRef.current) enterLeader();
  }, [connState, enterLeader]);

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
          {/* Header: connection status + connect/disconnect, matching the Coding page. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-bold">Remote Operation</h1>
            <div className="flex items-center gap-3">
              <span
                className={
                  "rounded-full px-3 py-1 font-mono text-xs " +
                  (connected ? "bg-[#8ab135]/25 text-[#4d6a1e]" : "bg-[#14131a]/8 text-[#857b6b]")
                }
              >
                ● {status}
                {inVr ? " · in VR" : ""}
                {controlActive ? " · control active" : ""}
              </span>
              {!running ? (
                <Button size="sm" variant="secondary" onClick={connect} disabled={connecting || !ready}>
                  {connecting ? "Connecting…" : "Connect"}
                </Button>
              ) : (
                <Button size="sm" variant="destructive" onClick={disconnect}>Disconnect</Button>
              )}
            </div>
          </div>
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

          {/* Control-mode picker: which method drives the arms. All options are always shown
              (even when a headset / the leader arms aren't present); keyboard is the default. */}
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-4 py-2 text-[#14131a] shadow-sm">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// controls</p>
            <div className="ml-auto flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant={controlMode === "keyboard" ? "default" : "secondary"}
                className={controlMode === "keyboard" ? "" : "border border-[#14131a]/20"}
                onClick={selectKeyboard}
                title="Drive with the keyboard (default)"
              >
                Keyboard
              </Button>
              <Button
                size="sm"
                variant={controlMode === "leader" ? "default" : "secondary"}
                className={controlMode === "leader" ? "" : "border border-[#14131a]/20"}
                onClick={selectLeader}
                title="Drive the robot's arms from the physical dual leader arms (base + lift stay on the keyboard). Selectable offline for hardware setup."
              >
                {leaderActive ? `Leader arm · ${leaderCount}/12` : "Leader arm"}
              </Button>
              <Button
                size="sm"
                variant={controlMode === "vr" ? "default" : "secondary"}
                className={controlMode === "vr" ? "" : "border border-[#14131a]/20"}
                onClick={selectVr}
                title="Drive with a VR headset (AR passthrough) on this same session"
              >
                {inVr ? "In VR" : "VR"}
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
            </div>
          </div>

          {/* VR mode card: the headset entry point on supported devices, a plain hint otherwise. */}
          {controlMode === "vr" && (
            <div className="rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-4 pb-4 pt-3 text-[#14131a] shadow-sm">
              <div className="flex min-h-9 items-center">
                <h3 className="text-base font-semibold leading-none tracking-tight">VR control</h3>
              </div>
              {xrSupported ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
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
              ) : (
                <p className="mt-3 text-sm text-[#6f6858]">Connect using a VR device</p>
              )}
            </div>
          )}

          {/* Leader-arm hardware setup — the full leader-setup surface, embedded. Shown while
              leader mode is selected; usable offline (calibration doesn't need the session). */}
          {controlMode === "leader" && (
            <div className="rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-4 pb-4 pt-3 shadow-sm">
              <LeaderSetup embedded />
            </div>
          )}

          {/* Keyboard legend only shows for its own mode, like the VR and leader cards. */}
          {controlMode === "keyboard" && (
          <Card className="border-[#14131a]/10 bg-[#f3f1e8] text-[#14131a]">
            <CardHeader className="flex min-h-9 flex-row items-center justify-between space-y-0 px-4 pb-0 pt-3">
              <CardTitle className="text-base">Keyboard controls</CardTitle>
              {/* Cylindrical vs per-motor only affects keyboard driving, so it lives here. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => teleop?.toggleMode()}
                disabled={!running}
                title="Switch between cylindrical (rpi4 feel) and per-motor control"
              >
                Mode: {mode === "joint" ? "per-motor" : "cylindrical"}
              </Button>
            </CardHeader>
            <CardContent className="p-4 pt-3">
              <ControlLegend mode={mode} />
            </CardContent>
          </Card>
          )}

          {/* The script console now lives on the Coding page (/nori/coding), driving the same
              persistent session. */}
        </div>

        <div className="h-fit space-y-4">
        {/* Audio: two-way call plus clip-to-robot-speaker (reuses the M3b downlink; needs the
            robot's voice downlink on — --voice / NORI_SPEAKER). Always shown; disabled offline. */}
        <div className="rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-4 py-3 text-[#14131a] shadow-sm">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// audio</p>
          <div className="mt-2 space-y-2">
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
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-[#857b6b]">Play to robot speaker</span>
              <label
                className={
                  "rounded border border-[#14131a]/20 px-2 py-1 " +
                  (connected ? "cursor-pointer hover:bg-[#14131a]/5" : "pointer-events-none opacity-50")
                }
              >
                Choose audio file…
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
        </div>

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
          <CardHeader className="cursor-pointer" onClick={() => setShowLog((v) => !v)}>
            <CardTitle className="flex items-center justify-between text-base">
              Robot logs
              <span className="text-sm text-muted-foreground">{showLog ? "▲ hide" : "▼ show"}</span>
            </CardTitle>
          </CardHeader>
          {showLog && (
          <CardContent className="pb-3">
            <div
              ref={logRef}
              className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-[#14131a]/10 bg-[#f3f1e8] p-2 font-mono text-xs"
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

        <Card className="border-[#14131a]/10 bg-[#f3f1e8] text-[#14131a]">
          <CardHeader className="cursor-pointer" onClick={() => setShowSettings((v) => !v)}>
            <CardTitle className="flex items-center justify-between text-base">
              Session settings
              <span className="text-sm text-muted-foreground">{showSettings ? "▲ hide" : "▼ show"}</span>
            </CardTitle>
          </CardHeader>
          {showSettings && (
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
          )}
        </Card>
        </div>
      </div>
    </section>
  );
};

export default Remote;
