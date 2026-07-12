// NORI: Additive file. Presentational status surface for remote teleop (Phase 7 C1–C3).
// Pure/dumb components driven by props from pages/remote.tsx — no session logic lives here.
//   * TelemetryPanel — connection + link mode + loop_hz + safety/watchdog + temp + staleness.
//   * GripForce      — per-motor Present_Current bars (the "virtual tactile" signal), grippers first.
//   * ControlLegend  — mode-aware keybind legend, derived from teleop.ts's exported maps.

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpCircle, Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Volume2, VolumeX } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  baseKeyClusters,
  keybindLegend,
  type BaseKeyCluster,
  type CallState,
  type ControlMode,
  type DaemonStatus,
  type TelemetryView,
} from "@nori/sdk";

// A labelled stat chip: dim label over a mono value, with an optional tone.
function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  // Tinted chips in the leader-setup palette: neutral cream, green/amber/red badges.
  const toneClass = {
    default: "border-[#14131a]/12 bg-[#f3f1e8] text-[#14131a]",
    good: "border-[#4e9d55]/35 bg-[#e4f3e2] text-[#2a6b33]",
    warn: "border-[#db9346]/35 bg-[#fdf1de] text-[#8a5a12]",
    bad: "border-[#d24a3d]/35 bg-[#fde7e4] text-[#a3271c]",
  }[tone];
  return (
    <div className={cn("flex flex-col gap-1 rounded-md border px-2.5 py-1.5", toneClass)}>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#857b6b]">{label}</span>
      <span className="font-mono text-sm leading-none">{value}</span>
    </div>
  );
}

// Map the daemon's free-text safety string to a tone. Anything that isn't a plain
// "ok"/"normal"/"-" reads as a warning so a latch/hold stands out.
function safetyTone(safety: string): "good" | "warn" | "default" {
  const s = safety.toLowerCase();
  if (s === "-" || s === "") return "default";
  if (s === "ok" || s === "normal" || s === "nominal" || s === "clear") return "good";
  return "warn";
}

// Operator-facing remedy per daemon_status offline reason (nori_protocol_schema §5b). The bridge's
// `detail` usually carries the daemon's own message; this is the what-do-I-do line under it.
const DAEMON_REMEDIES: Record<string, string> = {
  startup_positions:
    "An arm isn't responding — it has likely lost power. Power-cycle (unplug/replug) the arm; the robot reconnects automatically.",
  bus_lost:
    "A servo bus disconnected (USB). The robot is restarting its controller — control should return in ~15 s. If it repeats, check the bus cable.",
  unauthorized:
    "The robot rejected the control token (provisioning problem). Contact support — this won't fix itself.",
  unreachable:
    "The robot's controller is down or restarting. Control should return shortly; video keeps working.",
  connection_lost:
    "The robot's controller restarted. Control should return shortly; video keeps working.",
};
export function daemonRemedy(reason?: string): string {
  return (reason && DAEMON_REMEDIES[reason]) || DAEMON_REMEDIES.unreachable;
}

// Full-width alert shown while the daemon is offline: the reason + remedy, so a dead-arm refusal
// loop reads as "power-cycle the arm" instead of random downtime with a connected video feed.
export function DaemonBanner({ status }: { status: DaemonStatus | null }) {
  if (!status || status.state === "online") return null;
  return (
    <div className="rounded-md border border-[#d24a3d]/35 bg-[#fde7e4] px-4 py-3 text-[#a3271c]">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em]">
        robot controller offline{status.reason ? ` — ${status.reason.replace(/_/g, " ")}` : ""}
      </p>
      <p className="mt-1 text-sm">{daemonRemedy(status.reason)}</p>
      {status.detail && <p className="mt-1 font-mono text-xs opacity-80">{status.detail}</p>}
    </div>
  );
}

export function TelemetryPanel({
  connState,
  tel,
  controlActive,
  stale,
  inVr,
  daemonStatus,
}: {
  connState: string;
  tel: TelemetryView;
  controlActive: boolean;
  stale: boolean; // no telemetry frame for a while -> the readouts below are not live
  inVr: boolean;
  daemonStatus?: DaemonStatus | null; // bridge-reported daemon health (null = none received yet)
}) {
  const connected = connState === "connected";
  // loop_hz should sit near 50; flag a sag so a struggling control loop is visible.
  const hzTone = !controlActive || stale ? "default" : tel.loopHz >= 45 ? "good" : tel.loopHz >= 30 ? "warn" : "bad";

  // Bare chip row — the page composes this into its combined // telemetry card.
  return (
    <div className="flex flex-wrap gap-2">
      <Stat
        label="link"
        value={connected ? connState : connState}
        tone={connected ? "good" : connState === "failed" ? "bad" : "warn"}
      />
      <Stat
        label="path"
        value={tel.linkMode ? tel.linkMode.toUpperCase() : "—"}
        tone={tel.linkMode === "lan" ? "good" : tel.linkMode === "wan" ? "warn" : "default"}
      />
      <Stat label="control" value={controlActive ? (stale ? "stale" : "active") : "inactive"}
        tone={!controlActive ? "default" : stale ? "warn" : "good"} />
      {/* Daemon health is a separate axis from link: the media bridge (video, this chip's
          transport) can be fully connected while the daemon behind it is dead/restarting. */}
      <Stat label="daemon"
        value={daemonStatus ? daemonStatus.state : "—"}
        tone={!daemonStatus ? "default" : daemonStatus.state === "online" ? "good" : "bad"} />
      <Stat label="loop" value={`${tel.loopHz.toFixed(1)} Hz`} tone={hzTone} />
      <Stat label="safety" value={tel.safety} tone={safetyTone(tel.safety)} />
      <Stat label="watchdog" value={tel.watchdog} tone={tel.watchdog === "-" ? "default" : "warn"} />
      <Stat label="temp" value={tel.tempC > 0 ? `${tel.tempC.toFixed(0)}°C` : "—"}
        tone={tel.tempC >= 80 ? "bad" : tel.tempC >= 70 ? "warn" : "default"} />
      {inVr && <Stat label="mode" value="VR" tone="good" />}
    </div>
  );
}

// Prettify a current key like "right_arm_gripper" -> "R gripper" for a compact label.
function shortMotor(key: string): string {
  return key
    .replace(/^left_arm_/, "L ")
    .replace(/^right_arm_/, "R ")
    .replace(/^left_/, "L ")
    .replace(/^right_/, "R ")
    .replace(/_/g, " ");
}

// Per-motor current bars. Grippers first (the primary grip-force signal), then the rest.
// FULL is the raw sign-magnitude value mapped to a full bar — same scale VR haptics uses.
const CURRENT_FULL = 600;
export function GripForce({ currents }: { currents: Record<string, number> }) {
  const keys = Object.keys(currents);
  if (keys.length === 0) {
    return <p className="font-mono text-xs text-[#857b6b]">no current telemetry yet</p>;
  }
  const grippers = keys.filter((k) => k.includes("gripper")).sort();
  const rest = keys.filter((k) => !k.includes("gripper")).sort();
  const ordered = [...grippers, ...rest];

  return (
    <div className="space-y-2">
      {ordered.map((k) => {
        const mag = Math.abs(currents[k] ?? 0);
        const pct = Math.min(100, (mag / CURRENT_FULL) * 100);
        const isGrip = k.includes("gripper");
        const tone = pct >= 80 ? "bg-[#d24a3d]" : pct >= 40 ? "bg-[#c97929]" : "bg-[#d98b3d]";
        return (
          <div key={k} className="grid grid-cols-[minmax(6rem,auto)_1fr_3rem] items-center gap-3 rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-3 py-2">
            <span className={cn("truncate font-mono text-xs", isGrip ? "text-[#14131a]" : "text-[#5c564b]")}>
              {shortMotor(k)}
            </span>
            <div className="h-1.5 overflow-hidden rounded-full bg-[#e5e1d2]">
              <div className={cn("h-full rounded-full transition-[width] duration-100", tone)} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-right font-mono text-xs text-[#5c564b]">
              {mag.toFixed(0)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Rail (lift) height per arm, from telemetry `state` `left_lift.pos`/`right_lift.pos` —
// real millimeters (28.455 mm/rev, Pi-side multi-turn tracker, m3_m5 §5.5). Zero is the
// pose at DAEMON START (startup-relative until stall-homing lands). The Pi OMITS the key
// whenever its tracker isn't valid (pre-first-read / desynced) — render as "unknown".
//
// SETUP ASSUMPTION (2026-07-03): the arms are ALWAYS parked at the TOP of the rails at
// daemon start, so boot pose (h≈0) IS the top and the carriage can only ever travel DOWN.
// That makes the old center-zero bar wrong (it reserved half the bar for "up", which never
// happens). We now render a TOP-ANCHORED descent gauge: empty at the top (home), filling as
// the rail dives. depth-below-top = |h| (sign-agnostic: NORI_LIFT_SIGN is still pending a HW
// test, and from the top the only direction is down, so magnitude is unambiguous).
//
// RAIL_TRAVEL_MM = full downward travel = the gauge's full scale. Per robot variant:
// 950 mm (tall) / 650 mm (short) — the Pi's NORI_LIFT_TRAVEL_MM. Not carried in telemetry
// yet, so it's a tunable constant here; default to the TALL variant since most of the fleet
// is 950. On a short 650 unit the gauge/3D just tops out at ~68% of the bar (mm text stays
// exact) — the safe direction, unlike 650-on-a-950 which pins the visual at "bottom" with
// 300 mm of real travel left and makes motion read ~1.5x too fast. (When the Pi starts
// publishing travel_mm, consume that instead of this constant.)
const RAIL_TRAVEL_MM = 950;

// Shared reading so the C6 3D scene and this gauge agree. `depthMm` = distance below the top
// (>=0), `frac` = fraction of full travel descended (0 = at top/home, 1 = at bottom).
export function railReading(state: Record<string, number>, key: string):
  { known: boolean; depthMm: number; frac: number } {
  const h = state[key];
  if (typeof h !== "number") return { known: false, depthMm: 0, frac: 0 };
  const depthMm = Math.min(RAIL_TRAVEL_MM, Math.abs(h));
  return { known: true, depthMm, frac: depthMm / RAIL_TRAVEL_MM };
}

export function RailHeight({ state }: { state: Record<string, number> }) {
  const rails: { key: string; label: string }[] = [
    { key: "left_lift.pos", label: "L rail" },
    { key: "right_lift.pos", label: "R rail" },
  ];
  return (
    <div className="space-y-2">
      {rails.map(({ key, label }) => {
        const { known, depthMm, frac } = railReading(state, key);
        const pct = frac * 100;
        // orange through descent, darker mid, red as it approaches the bottom hard stop.
        const tone = frac >= 0.85 ? "bg-[#d24a3d]" : frac >= 0.6 ? "bg-[#c97929]" : "bg-[#d98b3d]";
        const atTop = known && depthMm < 3;
        return (
          <div key={key} className="grid grid-cols-[minmax(6rem,auto)_1fr_6rem] items-center gap-3 rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-3 py-2">
            <span className="truncate font-mono text-xs text-[#14131a]">{label}</span>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-[#e5e1d2]">
              {/* top-anchored descent gauge: fills from the left (top/home) as the rail dives */}
              {known && (
                <div
                  className={cn("absolute left-0 top-0 h-full rounded-full transition-[width] duration-100", tone)}
                  style={{ width: `${pct}%` }}
                />
              )}
            </div>
            <span className="text-right font-mono text-xs text-[#5c564b]">
              {!known ? "unknown" : atTop ? "top" : `↓ ${depthMm.toFixed(0)} mm`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Hover question mark carrying the rail-gauge explainer — rendered next to the card
// heading (pages/remote.tsx) so the card itself stays compact.
export function RailHeightHelp() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-[#857b6b] hover:text-[#14131a]" aria-label="How to read the rail gauge">
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">
        0 = top of rail (start pose); bar fills as the carriage descends. Full scale ={" "}
        {RAIL_TRAVEL_MM} mm travel. “unknown” = tracker not valid.
      </TooltipContent>
    </Tooltip>
  );
}

// A pulsing "on air" dot + label. Bright red when live, dim otherwise.
function OnAir({ live, label }: { live: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          live ? "animate-pulse bg-red-500" : "bg-muted-foreground/40"
        )}
      />
      <span className={live ? "font-medium text-foreground" : "text-muted-foreground"}>{label}</span>
    </span>
  );
}

// Two-way call bar (Phase 7 §B/C5). Deliberately minimal — the front-end team will redo the
// visuals; this exists so every control + indicator we need is wired and exercisable:
//   join/leave, mic mute, operator + robot "on air" indicators, and (M6-gated) camera toggle.
// `micSending === false` while active means the robot hasn't offered an audio uplink yet
// (Pi M3 pending) — surfaced so it's obvious the mic is captured but not transmitting.
export function CallBar({
  call,
  running,
  connected,
  m6,
  volume,
  onVolumeChange,
  onJoin,
  onLeave,
  onToggleMute,
  onToggleCamera,
}: {
  call: CallState;
  running: boolean;
  connected: boolean;
  m6: boolean;
  volume: number; // robot inbound audio playback gain, 0..1
  onVolumeChange: (v: number) => void;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
}) {
  // Speaker icon toggles a compact inline slider; opening it widens the group so the
  // you/nori indicators shift slightly left.
  const [volumeOpen, setVolumeOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 text-[#14131a]">
      {!call.active ? (
        <Button size="sm" onClick={onJoin} disabled={!running || !connected}
          title="Capture your mic and join the two-way audio call">
          <Phone className="mr-2 h-4 w-4" /> Join call
        </Button>
      ) : (
        <>
          <Button size="sm" variant="destructive" onClick={onLeave}>
            <PhoneOff className="mr-2 h-4 w-4" /> Leave call
          </Button>
          <Button size="sm" variant={call.micMuted ? "secondary" : "default"} onClick={onToggleMute}>
            {call.micMuted
              ? <><MicOff className="mr-2 h-4 w-4" /> Unmute mic</>
              : <><Mic className="mr-2 h-4 w-4" /> Mute mic</>}
          </Button>
          {m6 && (
            <Button size="sm" variant={call.cameraOn ? "default" : "secondary"} onClick={onToggleCamera}>
              {call.cameraOn
                ? <><VideoOff className="mr-2 h-4 w-4" /> Camera off</>
                : <><Video className="mr-2 h-4 w-4" /> Camera on</>}
            </Button>
          )}
        </>
      )}
      <div className="ml-auto flex items-center gap-4">
        {/* "you" = your mic is hot (unmuted); the badge below says whether it reaches the robot.
            The mic glyph mirrors the outbound mic state at a glance. */}
        <span className="flex items-center gap-1.5">
          <OnAir live={call.active && !call.micMuted} label="you" />
          {call.active && !call.micMuted
            ? <Mic className="h-3.5 w-3.5 text-[#14131a]" />
            : <MicOff className="h-3.5 w-3.5 text-muted-foreground/60" />}
        </span>
        <span className="flex items-center gap-1.5">
          <OnAir live={call.robotMicLive || call.robotAudio} label="nori" />
          {/* Same two tones as the mic glyph beside "you": ink when audible, dim when muted. */}
          <button
            type="button"
            className={volume === 0 ? "text-muted-foreground/60 hover:text-[#14131a]" : "text-[#14131a]"}
            title="Robot audio volume"
            onClick={() => setVolumeOpen((v) => !v)}
          >
            {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
          {volumeOpen && (
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="h-1 w-20 cursor-pointer accent-[#14131a]"
              title="Robot audio volume"
            />
          )}
        </span>
        {call.active && !call.micMuted && !call.micSending && (
          <Badge variant="outline" className="text-[10px]">mic local-only (Pi M3 pending)</Badge>
        )}
      </div>
    </div>
  );
}

// A single key cap.
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 bg-muted px-1.5 py-0.5 font-mono text-xs leading-none">
      {children}
    </kbd>
  );
}

export function ControlLegend({ mode }: { mode: ControlMode }) {
  const legend = keybindLegend(mode);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Arm</span>
        <span className="whitespace-nowrap text-muted-foreground">press <Key>M</Key> to toggle mode</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-[#857b6b] hover:text-[#14131a]" aria-label="What the two modes mean">
              <HelpCircle className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 text-xs">
            Cylindrical maps to x/y/z; Motor allows per-motion control
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {legend.arm.map((r) => (
          <div key={r.dof} className="flex items-center gap-1.5 whitespace-nowrap">
            <Key>{r.posKey.toUpperCase()}</Key><Key>{r.negKey.toUpperCase()}</Key>
            <span className="text-muted-foreground">{r.dof}</span>
          </div>
        ))}
      </div>
      <BaseCommandLegend />
      <p className="text-muted-foreground">
        Click the video first so the page has keyboard focus. Keys are ignored while typing in a field.
      </p>
    </div>
  );
}

// One base drive cluster rendered as a physical keypad — forward on top, turn-left /
// reverse / turn-right below (the traditional WASD inverted-T).
function BaseKeypad({ cluster }: { cluster: BaseKeyCluster }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Key>{cluster.forward.toUpperCase()}</Key>
      <div className="flex gap-1">
        <Key>{cluster.left.toUpperCase()}</Key>
        <Key>{cluster.back.toUpperCase()}</Key>
        <Key>{cluster.right.toUpperCase()}</Key>
      </div>
    </div>
  );
}

// Base + lift + command keybinds only — shared between the keyboard legend above and the
// Leader card (where the arms follow the leader hardware but base/lift/commands stay on
// the keyboard). These bindings don't vary with the arm control mode.
// `wasd` also shows the WASD alias keypad — only pass it where WASD really reaches the
// base (the Leader card): with the keyboard driving the arms, WASD belongs to the arm.
export function BaseCommandLegend({ hint, wasd }: { hint?: string; wasd?: boolean }) {
  const legend = keybindLegend("cylindrical");
  const clusters = wasd ? baseKeyClusters() : baseKeyClusters().slice(0, 1);
  return (
    <div className="space-y-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="w-full font-medium">Base</span>
        {clusters.map((c, i) => (
          <div key={c.forward} className="flex items-center gap-3">
            {i > 0 && <span className="text-xs text-muted-foreground">or</span>}
            <BaseKeypad cluster={c} />
          </div>
        ))}
        <span className="text-muted-foreground">forward / reverse, turn left / right</span>
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <Key>{legend.lift.posKey.toUpperCase()}</Key><Key>{legend.lift.negKey.toUpperCase()}</Key>
          <span className="text-muted-foreground">{legend.lift.dof}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">Commands</span>
        {legend.commands.map((c) => (
          <div key={c.key} className="flex items-center gap-1.5 whitespace-nowrap">
            <Key>{c.key}</Key><span className="text-muted-foreground">{c.label}</span>
          </div>
        ))}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
