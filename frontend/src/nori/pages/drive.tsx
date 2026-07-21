// NORI: Additive. The hosted "drive it now" page (SDK v1 finalization item 5).
//
// A 2D, keyboard-driven sibling of the VR landing page (vr.tsx). Same session machinery
// (TeleopSessionContext.connect + RemoteTeleop), so there is NO parallel control path —
// this is purely a trimmed shell for driving your own robot from a browser, no install.
//
// Two ways to connect, and the page needs no network-detection toggle to tell them apart:
//   - Same network as the robot: enter the robot code and Connect. STUN is enough; no
//     login. This is the ~30-second quick-start.
//   - A different network: sign in (below). A signed-in session unlocks minted coturn
//     credentials (TeleopSessionContext gates minting on being signed in), so the relay is
//     available as an ICE fallback automatically. If a remote connect is attempted without
//     signing in it will fail on STUN — the page says so and points at sign-in.
//
// Private-room access is gated by the robot via Supabase RLS (room-token HMAC auth retired),
// so the page collects no room token.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { useNori } from "@/nori/NoriContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { ControlLegend } from "@/nori/remote/TeleopStatus";
import { signInWithPassword, signOut, getSession, onAuthStateChange } from "@/nori/auth/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function DrivePage() {
  const { loading, error, ready } = useNori();
  const {
    teleop, running, connecting, connState, connectStatus,
    settings, setSetting: set, connect, disconnect, mode, toggleControlMode,
  } = useTeleopSession();

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Cross-network sign-in state. A live Supabase session is what unlocks minted TURN
  // credentials at connect (see TeleopSessionContext); signing in here (inside NoriProvider)
  // also auto-provisions the customer row the mint endpoint requires.
  const [session, setSession] = useState<Session | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signInErr, setSignInErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSession().then((s) => { if (alive) setSession(s); });
    const unsub = onAuthStateChange((s) => setSession(s));
    return () => { alive = false; unsub(); };
  }, []);

  // Pre-fill from a shared link: room via ?room=. Applied once; a URL value wins over what was
  // persisted. (Room-token auth is retired — the robot gates private rooms via Supabase RLS —
  // so there's no secret to capture from the URL fragment anymore.)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const room = q.get("room");
    if (room) set("room", room);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the robot video here and resume the Pi encoder while this page is open; detach + pause
  // on leave. Same attach contract as the Remote/VR pages — the session owns the stream.
  useEffect(() => {
    if (!teleop) return;
    teleop.setVideoEl(videoRef.current);
    teleop.setAudioEl(audioRef.current);
    teleop.resumeVideo();
    return () => { teleop.setVideoEl(null); teleop.setAudioEl(null); teleop.pauseVideo(); };
  }, [teleop]);

  // Keyboard driving: only while a session is running. The SDK ignores keys typed in form
  // fields and only emits jog once the control channel is open. Click the video first for focus.
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

  const connected = running && connState === "connected";
  const status = connected
    ? "connected"
    : connecting ? "connecting…" : running ? connState : "not connected";
  const canConnect = ready && !connecting && settings.room.trim().length > 0;
  const failed = connectStatus.phase === "failed";

  const doSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setSigningIn(true);
    setSignInErr(null);
    try {
      await signInWithPassword(email.trim(), password);
      setShowSignIn(false);
      setPassword("");
    } catch (err) {
      setSignInErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <audio ref={audioRef} autoPlay className="hidden" />

      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-10">
        <header className="mb-8 flex items-center gap-3">
          <img src="/nori-logo.png" alt="Nori" className="h-9 w-9" />
          <div>
            <h1 className="text-2xl font-bold leading-none">Drive your Nori</h1>
            <p className="mt-1 text-sm text-muted-foreground">Connect and drive from your browser.</p>
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
              A hosted build needs <span className="font-mono">VITE_SUPABASE_URL</span> and{" "}
              <span className="font-mono">VITE_SUPABASE_ANON_KEY</span> set at build time. See
              DEPLOY_FRONTEND.md.
            </p>
          </div>
        ) : (
          <div className="rounded-[24px] border-2 border-ink bg-card p-6 shadow-pop">
            {/* Live video (rendered in both pre-connect and connected states). */}
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
                    {/* TURN URL/user/cred are minted server-side at connect (§2.4) when signed
                        in, so there are no paste boxes for them. force-relay is kept for
                        debugging a cross-network path. */}
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

                {failed && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    Couldn’t connect{connectStatus.reason ? ` (${connectStatus.reason})` : ""}.
                    {!session && (
                      <> If your robot is on a different network, sign in below and reconnect so the
                        session can use the relay.</>
                    )}
                  </div>
                )}

                {/* Cross-network sign-in. Optional: same-network driving needs no login. */}
                <div className="border-t pt-3">
                  {session ? (
                    <p className="text-xs text-muted-foreground">
                      Signed in as <span className="font-medium">{session.user.email}</span> —
                      cross-network driving enabled.{" "}
                      <button
                        type="button"
                        onClick={() => void signOut()}
                        className="underline hover:text-foreground"
                      >
                        sign out
                      </button>
                    </p>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowSignIn((v) => !v)}
                        className="text-xs font-semibold text-muted-foreground hover:text-foreground"
                      >
                        {showSignIn ? "hide sign-in ▲" : "Driving from a different network? Sign in ▼"}
                      </button>
                      {showSignIn && (
                        <div className="mt-3 space-y-3">
                          <div className="space-y-1.5">
                            <Label htmlFor="email">Email</Label>
                            <Input id="email" type="email" value={email}
                              onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="password">Password</Label>
                            <Input id="password" type="password" value={password}
                              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                          </div>
                          {signInErr && (
                            <p className="text-xs text-destructive">{signInErr}</p>
                          )}
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={signingIn || !email.trim() || !password}
                            onClick={doSignIn}
                            className="w-full"
                          >
                            {signingIn ? "Signing in…" : "Sign in"}
                          </Button>
                          <p className="text-xs text-muted-foreground">
                            Your Nori account — the same one you use in{" "}
                            <Link to="/nori" className="underline hover:text-foreground">the app</Link>.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Keyboard control</span>
                  <button
                    type="button"
                    onClick={toggleControlMode}
                    className="rounded-md border px-2 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                  >
                    {mode === "joint" ? "per-motor" : "cylindrical"} · switch
                  </button>
                </div>

                <ControlLegend mode={mode} />

                <label className="flex items-center gap-2 text-sm" title="Held-key jog speed (100% = full)">
                  <span className="w-16 text-muted-foreground">speed</span>
                  <input
                    type="range" min={0.05} max={1} step={0.05}
                    value={settings.kbSpeed}
                    onChange={(e) => set("kbSpeed", Number(e.target.value))}
                    className="h-1 flex-1 cursor-pointer accent-nori-h14131a"
                  />
                  <span className="w-10 text-right font-mono text-xs">{Math.round(settings.kbSpeed * 100)}%</span>
                </label>

                <Button variant="destructive" onClick={() => void disconnect()} className="w-full">
                  Disconnect
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Press <span className="font-mono">Space</span> for E-STOP · click the video to give the page keyboard focus.
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
