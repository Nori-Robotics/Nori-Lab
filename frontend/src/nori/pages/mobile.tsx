// NORI: Additive file. Mobile drive pad — a phone-sized subset of the Remote page.
//
// Why a separate page rather than a Remote layout: the Remote page is a keyboard/leader/VR
// console (mode cards, telemetry tables, log box, layout picker) and none of that survives a
// 390 px screen. This is the small thing a phone can actually do: watch the camera, drive the
// base, run the lift, and nudge one arm in task space.
//
// It owns NO session state. The session lives in TeleopSessionProvider (same instance the
// Remote page drives), so a phone can join a link that is already up, and navigating here from
// Remote never drops it. Every button presses the SAME held-key set the keyboard does
// (teleop.holdKey / releaseKey) — sensitivity, arm scoping and the leader/policy gates in the
// SDK's jog tick all apply unchanged, so there is no second control path to keep honest.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type ArmSide } from "@nori/sdk";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { useConnectGate } from "@/nori/components/ConnectionPanel";
import { ArmControlView } from "@/nori/remote/ArmControl";
import { armPadAxes, basePad, liftPad, splitArmAxes, type PadAxis } from "@/nori/remote/mobilePads";

// Touch button that holds a jog key for as long as the finger is down. pointer* (not
// touch*/mouse*) so it works with finger, pen and a desktop mouse from one code path, and
// setPointerCapture keeps the release event coming to THIS button even if the finger slides
// off it — a lost pointerup would otherwise latch the jog until the next release-all.
const HoldButton = ({
  jogKey, label, sub, disabled, onHold, onRelease, className = "",
}: {
  jogKey: string; label: string; sub?: string; disabled: boolean;
  onHold: (k: string) => void; onRelease: (k: string) => void; className?: string;
}) => {
  const [down, setDown] = useState(false);
  const press = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDown(true);
    onHold(jogKey);
  };
  const release = () => { setDown(false); onRelease(jogKey); };
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
      // touch-none: without it the browser treats a held button as the start of a
      // scroll/zoom gesture and cancels the pointer mid-jog.
      className={
        "flex touch-none select-none flex-col items-center justify-center rounded-xl border " +
        "border-nori-h14131a/10 font-mono text-sm font-semibold uppercase tracking-wide " +
        "transition-colors disabled:pointer-events-none disabled:opacity-40 " +
        (down ? "bg-nori-h8ab135/40 text-nori-h4d6a1e " : "bg-nori-hf3f1e8 text-nori-h14131a ") +
        className
      }
    >
      <span>{label}</span>
      {sub && <span className="mt-0.5 font-sans text-[10px] font-normal normal-case tracking-normal text-muted-foreground">{sub}</span>}
    </button>
  );
};

// A ± row for one task axis (z / pitch / roll / gripper / turn).
const AxisRow = ({ axis, disabled, onHold, onRelease }: {
  axis: PadAxis; disabled: boolean; onHold: (k: string) => void; onRelease: (k: string) => void;
}) => (
  <div className="flex items-center gap-2">
    <span className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
      {axis.label}
    </span>
    <HoldButton
      jogKey={axis.negKey} label={axis.negLabel} disabled={disabled}
      onHold={onHold} onRelease={onRelease} className="h-12 flex-1"
    />
    <HoldButton
      jogKey={axis.posKey} label={axis.posLabel} disabled={disabled}
      onHold={onHold} onRelease={onRelease} className="h-12 flex-1"
    />
  </div>
);

const Mobile = () => {
  const {
    teleop, running, connecting, connState, tel, mode, daemonStatus, settings, setSetting,
    connect, disconnect, toggleControlMode,
  } = useTeleopSession();
  const connectBlocked = useConnectGate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const connected = running && connState === "connected";
  const arm = settings.arm as ArmSide;

  // Same contract as the Remote page: point the persistent session at THIS page's video
  // element and resume the robot encoder while we're showing it; detach (never stop) on leave.
  useEffect(() => {
    if (!teleop) return;
    teleop.setVideoEl(videoRef.current);
    teleop.resumeVideo();
    return () => { teleop.setVideoEl(null); teleop.pauseVideo(); };
  }, [teleop]);

  // The pad's arm buttons are the TASK keymap (x/y/z...). In per-motor mode those same
  // letters drive individual joints, so a pad shown there would be lying about what it
  // sends — flip to task mode on arrival and leave it there.
  useEffect(() => {
    if (mode === "joint") toggleControlMode();
  }, [mode, toggleControlMode]);

  const hold = useCallback((k: string) => { teleop?.holdKey(k); }, [teleop]);
  const release = useCallback((k: string) => { teleop?.releaseKey(k); }, [teleop]);

  // Nothing may keep jogging once this page is out of the way: a backgrounded tab stops
  // delivering pointerup, and the session outlives the page. Release everything on hide,
  // on unmount, and whenever the link drops.
  useEffect(() => {
    const releaseAll = () => teleop?.releaseAllKeys();
    const onVis = () => { if (document.hidden) releaseAll(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", releaseAll);
    window.addEventListener("pagehide", releaseAll);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", releaseAll);
      window.removeEventListener("pagehide", releaseAll);
      releaseAll();
    };
  }, [teleop]);
  useEffect(() => { if (!connected) teleop?.releaseAllKeys(); }, [connected, teleop]);

  const base = useMemo(basePad, []);
  const lift = useMemo(liftPad, []);
  const descriptor = teleop?.robotInfo()?.descriptor ?? null;
  const { pad: xy, rows } = useMemo(
    () => splitArmAxes(armPadAxes(descriptor)),
    [descriptor],
  );
  const xAxis = xy.find((a) => a.dof === "x");
  const yAxis = xy.find((a) => a.dof === "y");

  const latched = tel.safety === "latched";
  const disabled = !connected;
  const status = connected
    ? "connected"
    : connecting ? "connecting…" : running ? connState : "not connected";

  return (
    <section className="mx-auto max-w-md space-y-3 pb-8">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Drive</h1>
        <span className={
          "rounded-full px-3 py-1 font-mono text-[11px] " +
          (connected ? "bg-nori-h8ab135/25 text-nori-h4d6a1e" : "bg-nori-h14131a/8 text-nori-h857b6b")
        }>● {status}</span>
      </div>

      <video
        ref={videoRef} autoPlay playsInline muted
        className={"w-full rounded-md " + (connected ? "bg-background" : "bg-nori-he5e1d2 dark:bg-[hsl(240_4%_20%)]")}
        style={{ aspectRatio: "4 / 3" }}
      />

      {/* Connect + the two safety controls. E-STOP is full-width and always reachable
          without scrolling past the video — on a phone it is the one button that must
          never be hunted for. */}
      <div className="flex flex-wrap items-center gap-2">
        {!running ? (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={connecting || !!connectBlocked}
            title={connectBlocked ?? undefined}
            className="rounded-md bg-nori-h14131a px-4 py-2 text-sm font-semibold text-background disabled:opacity-40"
          >
            {connecting ? "connecting…" : "Connect"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void disconnect()}
            className="rounded-md border border-nori-h14131a/20 px-4 py-2 text-sm font-semibold"
          >
            Disconnect
          </button>
        )}
        <ArmControlView teleop={teleop} running={running} daemonStatus={daemonStatus} compact />
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => teleop?.command(latched ? "reset_latch" : "estop")}
        className={
          "w-full rounded-xl py-3 font-mono text-sm font-semibold uppercase tracking-[0.1em] " +
          "disabled:pointer-events-none disabled:opacity-40 " +
          (latched ? "bg-nori-h14131a text-background" : "bg-nori-hd24a3d text-white")
        }
      >
        {latched ? "latched — reset" : "e-stop"}
      </button>

      {!connected && (
        <p className="text-xs text-muted-foreground">
          Connect to drive. The full console (leader arms, VR, recording, logs) lives on{" "}
          <Link to="/nori/remote" className="underline">Remote</Link>.
        </p>
      )}

      {/* Base + lift: one row, drive cluster on the left, column on the right. */}
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div className="grid grid-cols-3 grid-rows-2 gap-2">
          <div />
          <HoldButton jogKey={base.forward} label="▲" sub="fwd" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />
          <div />
          <HoldButton jogKey={base.left} label="↺" sub="left" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />
          <HoldButton jogKey={base.back} label="▼" sub="back" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />
          <HoldButton jogKey={base.right} label="↻" sub="right" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />
        </div>
        <div className="grid w-20 grid-rows-2 gap-2">
          <HoldButton jogKey={lift.upKey} label="▲" sub="lift" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />
          <HoldButton jogKey={lift.downKey} label="▼" sub="lower" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />
        </div>
      </div>

      {/* Arm. The pills scope every arm button below to one side — the same
          `settings.arm` the keyboard and leader modes use. */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">arm</span>
        <div className="flex gap-1">
          {(["left", "right"] as ArmSide[]).map((side) => (
            <button
              key={side}
              type="button"
              onClick={() => { teleop?.releaseAllKeys(); setSetting("arm", side); }}
              className={
                "rounded-full px-4 py-1.5 text-xs font-semibold " +
                (arm === side ? "bg-nori-h14131a text-background" : "bg-nori-h14131a/8 text-nori-h857b6b")
              }
            >
              {side}
            </button>
          ))}
        </div>
      </div>

      {/* X/Y as a thumb pad (reach + sideways), the remaining task axes as ± rows.
          A robot whose task vocabulary has no Z (every L2) simply shows no Z row —
          the axes come from the descriptor, never from a hardcoded list. */}
      <div className="grid grid-cols-3 grid-rows-2 gap-2">
        <div />
        {xAxis && <HoldButton jogKey={xAxis.posKey} label="▲" sub="reach out" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />}
        <div />
        {yAxis && <HoldButton jogKey={yAxis.posKey} label="◀" sub="left" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />}
        {xAxis && <HoldButton jogKey={xAxis.negKey} label="▼" sub="reach in" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />}
        {yAxis && <HoldButton jogKey={yAxis.negKey} label="▶" sub="right" disabled={disabled} onHold={hold} onRelease={release} className="h-14" />}
      </div>

      <div className="space-y-2">
        {rows.map((axis) => (
          <AxisRow key={axis.dof} axis={axis} disabled={disabled} onHold={hold} onRelease={release} />
        ))}
      </div>

      <p className="pt-1 text-[11px] text-muted-foreground">
        Buttons jog while held, at the sensitivity set on the Remote page.
      </p>
    </section>
  );
};

export default Mobile;
