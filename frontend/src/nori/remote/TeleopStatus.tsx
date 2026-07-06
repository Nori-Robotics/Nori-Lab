// NORI: Additive file. Presentational status surface for remote teleop (Phase 7 C1–C3).
// Pure/dumb components driven by props from pages/remote.tsx — no session logic lives here.
//   * TelemetryPanel — connection + link mode + loop_hz + safety/watchdog + temp + staleness.
//   * GripForce      — per-motor Present_Current bars (the "virtual tactile" signal), grippers first.
//   * ControlLegend  — mode-aware keybind legend, derived from teleop.ts's exported maps.

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  keybindLegend,
  type CallState,
  type ControlMode,
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

export function TelemetryPanel({
  connState,
  tel,
  controlActive,
  stale,
  inVr,
}: {
  connState: string;
  tel: TelemetryView;
  controlActive: boolean;
  stale: boolean; // no telemetry frame for a while -> the readouts below are not live
  inVr: boolean;
}) {
  const connected = connState === "connected";
  // loop_hz should sit near 50; flag a sag so a struggling control loop is visible.
  const hzTone = !controlActive || stale ? "default" : tel.loopHz >= 45 ? "good" : tel.loopHz >= 30 ? "warn" : "bad";

  return (
    <div className="rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// telemetry</p>
      <div className="mt-3 flex flex-wrap gap-2">
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
      <Stat label="loop" value={`${tel.loopHz.toFixed(1)} Hz`} tone={hzTone} />
      <Stat label="safety" value={tel.safety} tone={safetyTone(tel.safety)} />
      <Stat label="watchdog" value={tel.watchdog} tone={tel.watchdog === "-" ? "default" : "warn"} />
      <Stat label="temp" value={tel.tempC > 0 ? `${tel.tempC.toFixed(0)}°C` : "—"}
        tone={tel.tempC >= 80 ? "bad" : tel.tempC >= 70 ? "warn" : "default"} />
      {inVr && <Stat label="mode" value="VR" tone="good" />}
      </div>
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
// yet, so it's a tunable constant here; default to the short variant. Bump to 950 for a tall
// unit. (When the Pi starts publishing travel_mm, consume that instead of this constant.)
const RAIL_TRAVEL_MM = 650;

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
      <p className="font-mono text-[10px] text-[#857b6b]">
        0 = top of rail (start pose); bar fills as the carriage descends. Full scale ={" "}
        {RAIL_TRAVEL_MM} mm travel. “unknown” = tracker not valid.
      </p>
    </div>
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
  onJoin,
  onLeave,
  onToggleMute,
  onToggleCamera,
}: {
  call: CallState;
  running: boolean;
  connected: boolean;
  m6: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-background px-3 py-2">
      {!call.active ? (
        <Button size="sm" onClick={onJoin} disabled={!running || !connected}
          className="bg-[#8ab135] text-foreground hover:bg-[#7a9d2f]"
          title="Capture your mic and join the two-way audio call">
          Join call
        </Button>
      ) : (
        <>
          <Button size="sm" variant="destructive" onClick={onLeave}>Leave call</Button>
          <Button size="sm" variant={call.micMuted ? "secondary" : "default"} onClick={onToggleMute}>
            {call.micMuted ? "Unmute mic" : "Mute mic"}
          </Button>
          {m6 && (
            <Button size="sm" variant={call.cameraOn ? "default" : "secondary"} onClick={onToggleCamera}>
              {call.cameraOn ? "Camera off" : "Camera on"}
            </Button>
          )}
        </>
      )}
      <div className="ml-auto flex items-center gap-4">
        {/* "you" = your mic is hot (unmuted); the badge below says whether it reaches the robot. */}
        <OnAir live={call.active && !call.micMuted} label="you" />
        <OnAir live={call.robotMicLive || call.robotAudio} label="robot" />
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
    <kbd className="rounded border border-b-2 bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none">
      {children}
    </kbd>
  );
}

export function ControlLegend({ mode }: { mode: ControlMode }) {
  const legend = keybindLegend(mode);
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">Arm</span>
        <Badge variant="secondary" className="text-[10px]">
          {mode === "joint" ? "per-motor" : "cylindrical"}
        </Badge>
        <span className="text-muted-foreground">press <Key>M</Key> to toggle</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {legend.arm.map((r) => (
          <div key={r.dof} className="flex items-center gap-1.5">
            <Key>{r.posKey.toUpperCase()}</Key><Key>{r.negKey.toUpperCase()}</Key>
            <span className="text-muted-foreground">{r.dof}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">Base</span>
        {legend.base.map((r) => (
          <div key={r.dof} className="flex items-center gap-1.5">
            <Key>{r.posKey.toUpperCase()}</Key><Key>{r.negKey.toUpperCase()}</Key>
            <span className="text-muted-foreground">{r.dof}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <Key>{legend.lift.posKey.toUpperCase()}</Key><Key>{legend.lift.negKey.toUpperCase()}</Key>
          <span className="text-muted-foreground">{legend.lift.dof}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">Commands</span>
        {legend.commands.map((c) => (
          <div key={c.key} className="flex items-center gap-1.5">
            <Key>{c.key}</Key><span className="text-muted-foreground">{c.label}</span>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground">
        Click the video first so the page has keyboard focus. Keys are ignored while typing in a field.
      </p>
    </div>
  );
}
