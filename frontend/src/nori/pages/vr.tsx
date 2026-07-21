// NORI: Additive. Standalone VR landing surface — the LeLab-free hosted headset entry point.
//
// Unlike the full Remote page, this renders OUTSIDE NoriLayout (no app nav) and does NOT require
// a signed-in session: the VR drive loop only needs the public Supabase config (from /nori/config
// or the VITE_SUPABASE_* build-time fallback) and a room. A consumer opens this URL in the Meta
// Quest browser, enters the robot code, connects, and taps "Enter VR". (Private-room access is
// gated by the robot via Supabase RLS; the room-token HMAC is retired, so no token is collected.)
//
// It reuses the exact session + VR machinery the Remote page uses (TeleopSessionContext.connect +
// VrSession), so there is no parallel control path — this is purely a trimmed, headset-first shell.
// See DEPLOY_FRONTEND.md ("Vehicle 2 — the VR counterpart").

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { VrSession } from "@nori/sdk/vr";
import { useNori } from "@/nori/NoriContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function VrLanding() {
  const { loading, error, ready } = useNori();
  const {
    teleop, running, connecting, connState,
    settings, setSetting: set, connect, disconnect, appendLog, tel,
    setCurrentsListener, daemonStatus,
  } = useTeleopSession();

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const vrRef = useRef<VrSession | null>(null);
  const [inVr, setInVr] = useState(false);
  const [xrSupported, setXrSupported] = useState<boolean | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Pre-fill from the laptop→headset handoff link so a headset that opened the app's shared
  // link doesn't have to retype on a VR keyboard. Room comes via the query (?room=). Applied
  // once on mount; a value in the URL wins over what was persisted. (Room-token auth is retired
  // — the robot gates private rooms via Supabase RLS — so there's no token to carry or scrub.)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const room = q.get("room");
    if (room) set("room", room);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connected = running && connState === "connected";
  const status = connected
    ? "connected"
    : connecting ? "connecting…" : running ? connState : "not connected";

  // Show the robot video here (and resume the Pi encoder while this page is open); VrSession reuses
  // the same <video> element as its in-headset scene panel. Detach + pause on leave.
  useEffect(() => {
    if (!teleop) return;
    teleop.setVideoEl(videoRef.current);
    teleop.setAudioEl(audioRef.current);
    teleop.resumeVideo();
    return () => { teleop.setVideoEl(null); teleop.setAudioEl(null); teleop.pauseVideo(); };
  }, [teleop]);

  // Feed gripper currents (haptics) + telemetry into the in-VR HUD while a session is live.
  useEffect(() => {
    setCurrentsListener((c) => vrRef.current?.setCurrents(c));
    return () => setCurrentsListener(null);
  }, [setCurrentsListener]);
  useEffect(() => { vrRef.current?.setTelemetry(tel); }, [tel]);
  // Keep the HUD's control row honest about motor health (same rule as the 2D chip).
  useEffect(() => {
    vrRef.current?.setMotorsOnline(!daemonStatus || daemonStatus.state === "online");
  }, [daemonStatus]);

  // Detect headset support once, and force a fresh clutch squeeze after any link drop (no snap).
  useEffect(() => { VrSession.isSupported().then(setXrSupported); }, []);
  useEffect(() => {
    if (connState === "failed" || connState === "disconnected") vrRef.current?.reclutch();
  }, [connState]);
  // Apply the sensitivity sliders live to a running headset session (this page runs on the
  // headset browser, so the values live in ITS localStorage — separate from the laptop's).
  useEffect(() => {
    vrRef.current?.setTuning({
      sensitivity: settings.vrSensitivity,
      gripperOpenRate: settings.vrGripperOpen,
    });
  }, [settings.vrSensitivity, settings.vrGripperOpen]);

  // Stop the VR driver if the page unmounts (the session itself lives in the provider).
  useEffect(() => () => { vrRef.current?.stop(); }, []);

  const enterVr = useCallback(async () => {
    if (!teleop || !videoRef.current) return;
    const session = new VrSession({
      teleop,
      videoEl: videoRef.current,
      onLog: appendLog,
      onEnd: () => { setInVr(false); vrRef.current = null; },
      tuning: { sensitivity: settings.vrSensitivity, gripperOpenRate: settings.vrGripperOpen },
      // In-VR poke-panel changes persist here too, so this page's sliders stay in sync.
      onTuningChange: (t) => {
        set("vrSensitivity", t.sensitivity);
        set("vrGripperOpen", t.gripperOpenRate);
      },
    });
    vrRef.current = session;
    try {
      await session.start();
      setInVr(true);
    } catch (e) {
      appendLog("enter VR failed: " + (e instanceof Error ? e.message : String(e)));
      vrRef.current = null;
    }
  }, [teleop, appendLog, settings.vrSensitivity, settings.vrGripperOpen, set]);

  const handleDisconnect = useCallback(async () => {
    await vrRef.current?.stop();
    vrRef.current = null;
    setInVr(false);
    await disconnect();
  }, [disconnect]);

  const canConnect = ready && !connecting && settings.room.trim().length > 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Hidden media sinks: the SDK points these at the inbound tracks. The <video> doubles as the
          VR scene panel; the preview below mirrors it so the operator can frame up before entering. */}
      <audio ref={audioRef} autoPlay className="hidden" />

      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-10">
        <header className="mb-8 flex items-center gap-3">
          <img src="/nori-logo.png" alt="Nori" className="h-9 w-9" />
          <div>
            <h1 className="text-2xl font-bold leading-none">Nori VR</h1>
            <p className="mt-1 text-sm text-muted-foreground">Drive your robot from the headset.</p>
          </div>
          <span
            className={
              "ml-auto inline-flex h-9 items-center rounded-full px-3 font-mono text-xs " +
              (connected ? "bg-nori-h8ab135/25 text-nori-h4d6a1e" : "bg-nori-h14131a/8 text-nori-h857b6b")
            }
          >
            ● {status}
          </span>
        </header>

        {loading ? (
          <p className="rounded-2xl border bg-muted/40 px-5 py-6 text-center text-sm text-muted-foreground">
            Connecting to Nori…
          </p>
        ) : error ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-6 text-sm text-destructive">
            <p className="font-medium">Nori isn’t configured for this page.</p>
            <p className="mt-1 opacity-90">{error}</p>
            <p className="mt-3 text-xs opacity-80">
              A hosted VR build needs <span className="font-mono">VITE_SUPABASE_URL</span> and{" "}
              <span className="font-mono">VITE_SUPABASE_ANON_KEY</span> set at build time. See
              DEPLOY_FRONTEND.md.
            </p>
          </div>
        ) : (
          <div className="rounded-[24px] border-2 border-ink bg-card p-6 shadow-pop">
            {/* Live preview once a session exists, so the operator can aim before entering VR. */}
            <div className="mb-6 aspect-video w-full overflow-hidden rounded-2xl border bg-black/90">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full object-contain"
              />
            </div>

            {!running ? (
              <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); if (canConnect) void connect(); }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="room">Robot code</Label>
                  <Input
                    id="room"
                    value={settings.room}
                    onChange={(e) => set("room", e.target.value)}
                    placeholder="your Nori serial number"
                    autoComplete="off"
                    className="h-11 text-base"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="text-xs font-semibold text-muted-foreground hover:text-foreground"
                >
                  {showAdvanced ? "hide network settings ▲" : "network settings (STUN / TURN) ▼"}
                </button>
                {showAdvanced && (
                  <div className="space-y-3 border-t pt-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="stun">STUN</Label>
                      <Input id="stun" value={settings.stun}
                        onChange={(e) => set("stun", e.target.value)} />
                    </div>
                    {/* TURN URL/user/cred inputs intentionally removed (§2.4 minted creds), same
                        as Home's ConnectionSettings: the backend mints per-session coturn
                        credentials at connect and overrides these settings, so a hand-typed
                        static cred could only make a working session fail. The underlying
                        settings + connect() fallback are unchanged (a dev can still inject
                        via localStorage). */}
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={settings.forceRelay}
                        onChange={(e) => set("forceRelay", e.target.checked)} />
                      force relay (TURN-only)
                    </label>
                  </div>
                )}

                <Button type="submit" size="lg" disabled={!canConnect} className="h-12 w-full text-base">
                  {connecting ? "Connecting…" : "Connect"}
                </Button>
                {!ready && (
                  <p className="text-center text-xs text-muted-foreground">Preparing…</p>
                )}
              </form>
            ) : (
              <div className="space-y-4">
                {xrSupported === false && (
                  <p className="rounded-lg bg-nori-h14131a/5 px-3 py-2 text-sm text-nori-h4d463a">
                    No VR headset detected in this browser. You can see the video here — open this same
                    URL in a headset browser (e.g. Meta Quest) to enter VR.
                  </p>
                )}
                <Button
                  onClick={enterVr}
                  size="lg"
                  disabled={!connected || inVr || xrSupported !== true}
                  className="h-14 w-full text-lg"
                >
                  {inVr ? "In VR — put on your headset" : "Enter VR"}
                </Button>
                {/* Sensitivity — persisted in THIS (headset) browser, applied live while in VR. */}
                <div className="space-y-2 rounded-lg bg-nori-h14131a/5 px-3 py-2">
                  <label className="flex items-center gap-2 text-sm" title="How much the robot moves per hand movement (100% = default)">
                    <span className="w-20 text-muted-foreground">motion</span>
                    <input
                      type="range" min={0.25} max={2} step={0.05}
                      value={settings.vrSensitivity}
                      onChange={(e) => set("vrSensitivity", Number(e.target.value))}
                      className="h-1 flex-1 cursor-pointer accent-nori-h14131a"
                    />
                    <span className="w-10 text-right font-mono text-xs">{Math.round(settings.vrSensitivity * 100)}%</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm" title="How fast the gripper opens (closing always runs 1.5× this speed)">
                    <span className="w-20 text-muted-foreground">grip open</span>
                    <input
                      type="range" min={0.05} max={1} step={0.05}
                      value={settings.vrGripperOpen}
                      onChange={(e) => set("vrGripperOpen", Number(e.target.value))}
                      className="h-1 flex-1 cursor-pointer accent-nori-h14131a"
                    />
                    <span className="w-10 text-right font-mono text-xs">{Math.round(settings.vrGripperOpen * 100)}%</span>
                  </label>
                </div>
                <Button
                  variant="destructive"
                  onClick={handleDisconnect}
                  className="w-full"
                >
                  Disconnect
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Squeeze a grip to move · B/Y·A/X = lift up/down · left stick-press = E-STOP · hold right stick-press to reset.
                </p>
              </div>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Need to pair a robot or set up controls?{" "}
          <Link to="/nori" className="underline hover:text-foreground">Open the full app</Link>.
        </p>
      </main>
    </div>
  );
}
