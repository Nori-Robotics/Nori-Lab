// NORI: Additive file. Presentational status surface for remote teleop (Phase 7 C1–C3).
// Pure/dumb components driven by props from pages/remote.tsx — no session logic lives here.
//   * TelemetryPanel — connection + link mode + loop_hz + safety/watchdog + temp + staleness.
//   * GripForce      — per-motor Present_Current bars (the "virtual tactile" signal), grippers first.
//   * ControlLegend  — mode-aware keybind legend, derived from teleop.ts's exported maps.

import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { HelpCircle, Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Volume2, VolumeX } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  baseKeyClusters,
  keybindLegend,
  type BaseKeyCluster,
  type CallState,
  type ConnectFailure,
  type ConnectPhase,
  type ConnectStatus,
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
  // Tinted chips in the leader-setup palette: neutral tan, green/amber/red badges.
  // The neutral fill is the darker #e5e1d2 (same tan as the rail-gauge track), NOT the card's own
  // #f3f1e8 — chips in the default tone are the ones with no data yet (path / watchdog / temp
  // before a connect), and cream-on-cream made them vanish exactly when the operator is looking
  // for them. link + control never use this tone; they're always good/warn/bad.
  const toneClass = {
    default: "border-[#14131a]/12 bg-[#e5e1d2] text-[#14131a]",
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

// Map the robot's free-text safety string to a tone. Anything that isn't a plain
// "ok"/"normal"/"-" reads as a warning so a latch/hold stands out.
function safetyTone(safety: string): "good" | "warn" | "default" {
  const s = safety.toLowerCase();
  if (s === "-" || s === "") return "default";
  if (s === "ok" || s === "normal" || s === "nominal" || s === "clear") return "good";
  return "warn";
}

// Operator-facing remedy per motor-control offline reason (nori_protocol_schema §5b). The wire
// still carries a machine `reason`/`detail`; neither is shown — this is the what-do-I-do line
// that replaces them, in plain language for a non-technical operator.
const CONTROL_REMEDIES: Record<string, string> = {
  startup_positions:
    "An arm isn't responding — it has likely lost power. Power-cycle (unplug/replug) the arm; the robot reconnects automatically.",
  bus_lost:
    "A motor cable disconnected. The robot is restarting motor control — it should return in about 15 seconds. If it keeps happening, check the cable.",
  unauthorized:
    "The robot rejected the control token (provisioning problem). Contact support — this won't fix itself.",
  unreachable:
    "The robot's motor control is down or restarting. It should return shortly; video keeps working.",
  connection_lost:
    "The robot's motor control restarted. It should return shortly; video keeps working.",
};
export function controlRemedy(reason?: string): string {
  return (reason && CONTROL_REMEDIES[reason]) || CONTROL_REMEDIES.unreachable;
}

// Full-width alert shown while motor control is offline. Fixed headline + the plain-English
// remedy, so a dead-arm refusal loop reads as "power-cycle the arm" instead of random downtime
// with a connected video feed. The raw reason code and the robot's `detail` string are
// deliberately NOT rendered — the remedy above is the operator-facing version of both.
export function ControlOfflineBanner({ status }: { status: DaemonStatus | null }) {
  if (!status || status.state === "online") return null;
  return (
    <div className="rounded-md border border-[#d24a3d]/35 bg-[#fde7e4] px-4 py-3 text-[#a3271c]">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em]">
        Robot motor control offline, reconnecting
      </p>
      <p className="mt-1 text-sm">{controlRemedy(status.reason)}</p>
    </div>
  );
}

// What the operator is told for each connect failure. Same contract as CONTROL_REMEDIES above:
// headline = what's wrong in their words, body = what to DO about it.
//
// A NOTE ON HONESTY: `robot_not_responding` still mentions the access code even though
// `bad_access_code` now exists. A robot only reports a bad code if its software is new enough to
// send a rejection; an older one in the fleet still refuses SILENTLY, and that is indistinguishable
// from being switched off. So the "isn't answering" copy names both causes rather than asserting
// the robot is off and sending the operator to hunt a power cable that's already plugged in.
// `settingsLink: true` marks failures whose remedy lives in the call settings; ConnectionBanner
// renders a link to them when given `settingsTo` (pages that aren't Home, where the settings
// actually are — see ConnectionPanel.ConnectionStatus for the dead-end this fixes).
const CONNECT_TROUBLE: Record<ConnectFailure, { headline: string; body: string; settingsLink?: boolean }> = {
  signaling_unreachable: {
    headline: "Can't reach Nori",
    body: "Your device can't reach Nori's servers. Check your internet connection — the robot is probably fine.",
  },
  bad_access_code: {
    headline: "Wrong access code",
    body: "Your robot is online but rejected this access code. Open your call settings and re-enter the code shown on the robot.",
    settingsLink: true,
  },
  robot_not_responding: {
    headline: "Your robot isn't answering",
    body: "Check that the robot is powered on and connected to Wi-Fi. If it's on and online, the access code in your call settings may not match the one on the robot. It will connect on its own once it's reachable.",
    settingsLink: true,
  },
  ice_failed: {
    headline: "Couldn't open a video connection",
    body: "Your robot answered, but no network path could be opened between you — usually a restrictive firewall or office network. Try a different network, or a phone hotspot, to confirm.",
  },
  negotiation_failed: {
    headline: "The connection failed to start",
    body: "Something went wrong setting up the video link. Disconnect and try again; if it keeps happening, contact support.",
  },
  session_rejected: {
    headline: "The robot refused this session",
    body: "The robot is reachable but wouldn't accept control. This usually means a provisioning problem — contact support.",
  },
};

// What we're doing, while it's still going fine. Only used pre-connection.
const CONNECT_PROGRESS: Partial<Record<ConnectPhase, string>> = {
  joining: "Connecting to Nori…",
  waiting: "Waiting for your robot…",
  negotiating: "Your robot answered — opening the video link…",
};

// The connection surface: a calm progress line while a connect is in flight, a red banner with a
// remedy when it fails. Renders nothing once connected (the chips take over) or when idle.
// `settingsTo`: route to the page that owns the call settings (Home). Pass it from pages WITHOUT
// the settings (Remote) so a settings-shaped failure links the operator there instead of dead-
// ending; omit it on Home itself, where the settings are directly below the banner.
export function ConnectionBanner({ status, settingsTo }: { status: ConnectStatus; settingsTo?: string }) {
  if (status.phase === "idle" || status.phase === "connected") return null;

  if (status.phase === "failed") {
    const t = status.reason ? CONNECT_TROUBLE[status.reason] : undefined;
    // An unknown reason must still render as a failure rather than vanish.
    const headline = t?.headline ?? "Couldn't connect";
    const body = t?.body ?? "Disconnect and try again; if it keeps happening, contact support.";
    return (
      <div className="rounded-md border border-[#d24a3d]/35 bg-[#fde7e4] px-4 py-3 text-[#a3271c]">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em]">{headline}</p>
        <p className="mt-1 text-sm">{body}</p>
        {settingsTo && t?.settingsLink && (
          <p className="mt-1.5 text-sm">
            <Link to={settingsTo} className="font-medium underline hover:opacity-80">
              Open settings on the Home page →
            </Link>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 rounded-md border border-[#14131a]/12 bg-[#f3f1e8] px-4 py-3 text-[#14131a]">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#857b6b]" />
      <p className="text-sm">{CONNECT_PROGRESS[status.phase] ?? "Connecting…"}</p>
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
  daemonStatus?: DaemonStatus | null; // robot-reported motor-control health (null = none received yet)
}) {
  const connected = connState === "connected";
  // loop_hz should sit near 50; flag a sag so a struggling control loop is visible.
  const hzTone = !controlActive || stale ? "default" : tel.loopHz >= 45 ? "good" : tel.loopHz >= 30 ? "warn" : "bad";
  // One honest control readout, gated on all three independent signals — they can disagree:
  //   * controlActive : the command channel is open (transport).
  //   * !stale        : telemetry is still arriving (the robot is actually running the loop).
  //   * motorsOk      : the robot's own motor-control health push.
  // The media bridge can be fully connected while motor control behind it is dead, which used to
  // read as a green "active" chip; requiring all three keeps the chip from lying. A null
  // daemonStatus means the robot never sent one (older bridge) — don't punish that, the
  // staleness timer still catches a genuinely dead controller.
  const motorsOk = !daemonStatus || daemonStatus.state === "online";
  const controlOk = controlActive && !stale && motorsOk;

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
      {/* "offline", not "disconnected": this chip is false when ANY of the three signals above
          fails (channel closed, telemetry stale, motors unhealthy), and only the first of those
          is really a disconnection. The vaguer word is the more honest one here. */}
      <Stat label="control" value={controlOk ? "online" : "offline"}
        tone={controlOk ? "good" : "bad"} />
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
// real millimeters (~115.6 mm per encoder rev, Pi-side multi-turn tracker, m3_m5 §5.5). Zero
// is the pose at DAEMON START (startup-relative until stall-homing lands). The Pi OMITS the
// key whenever its tracker isn't valid (pre-first-read / desynced / that rail's direction
// never calibrated) — render as "unknown".
//
// SETUP ASSUMPTION (2026-07-03): the arms are ALWAYS parked at the TOP of the rails at
// daemon start, so boot pose (h≈0) IS the top and the carriage can only ever travel DOWN.
// That makes the old center-zero bar wrong (it reserved half the bar for "up", which never
// happens). We render a TOP-ANCHORED descent gauge: empty at the top (home), filling as the
// rail dives.
//
// This used to take |h| because the Pi's lift direction was unverified. It no longer is —
// direction is calibrated per unit (lift.hpp) and the Pi publishes depth-below-top directly —
// so railReading() clamps instead of mirroring, and a backwards rail now shows up as an
// obviously-pinned gauge rather than a plausible wrong number. See rail.ts.
//
// railReading() + RAIL_TRAVEL_MM moved to the SDK (packages/nori-sdk/src/rail.ts) when the 3D
// robot became shared with the headset: this gauge, the desktop 3D card and the in-VR model all
// derive the carriage height from that one function, so they can't drift. Re-exported here
// because existing callers import it from this module.
import { railReading, RAIL_TRAVEL_MM } from "@nori/sdk";
export { railReading, RAIL_TRAVEL_MM };

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
  // In-call the three buttons + the you/nori indicators have to share a 400px rail, so once the
  // call is up the labels shorten ("Leave call" -> "Leave") and the icon gap tightens. The
  // pre-call state has only one button and keeps its full label. Titles carry the long form.
  return (
    <div className="flex flex-wrap items-center gap-2 text-[#14131a]">
      {/* Status on the left, actions on the right — same hand as the // controls strip, where the
          mode pills sit right-aligned. */}
      <div className="flex flex-wrap items-center gap-3">
        {/* "you" = your mic is hot (unmuted); the badge below says whether it reaches the robot.
            The mic glyph mirrors the outbound mic state at a glance. */}
        <span className="flex items-center gap-1.5">
          <OnAir live={call.active && !call.micMuted} label="you" />
          {call.active && !call.micMuted
            ? <Mic className="h-3.5 w-3.5 text-[#14131a]" />
            : <MicOff className="h-3.5 w-3.5 text-muted-foreground/60" />}
        </span>
        <span className="flex items-center gap-1.5">
          {/* robotAudio only says a track is ATTACHED — a robot-side mute (W2.5: robots
              boot muted) still drops the audio, so don't glow "on air" while muted. */}
          <OnAir live={(call.robotMicLive || call.robotAudio) && !call.robotMicMuted} label="nori" />
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
        {/* W2.5 consent UX: robots ship muted-by-default; only someone physically at the
            robot can unmute (kiosk / mute button). Tell the operator that instead of
            leaving a silently dead robot mic. */}
        {call.robotMicMuted && (
          <Badge
            variant="outline"
            // whitespace-nowrap so the long copy can't wrap INSIDE the badge — that's what made it
            // balloon to two/three lines once a call filled the row. The short label fits on one
            // line; the full explanation moved to the tooltip.
            className="whitespace-nowrap text-[10px]"
            title="The robot's microphone is muted on the robot itself. Only a person at the robot can unmute it — from the robot's screen or its mute button."
          >
            <MicOff className="mr-1 h-3 w-3" /> Robot muted: unmute on the robot
          </Badge>
        )}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {!call.active ? (
          // Same Pill as the Keyboard / Leader arm / VR mode strip below — this is the audio
          // card's one action, and it sits in the same right-hand column, so it should read as
          // the same kind of control rather than a differently-shaped button.
          <Pill
            onClick={onJoin}
            disabled={!running || !connected}
            title="Capture your mic and join the two-way audio call"
            className="inline-flex items-center"
          >
            <Phone className="mr-2 h-4 w-4" /> Join call
          </Pill>
        ) : (
          <>
            <Button size="sm" variant="destructive" onClick={onLeave} title="Leave the audio call">
              <PhoneOff className="mr-1.5 h-4 w-4" /> Leave
            </Button>
            <Button size="sm" variant={call.micMuted ? "secondary" : "default"} onClick={onToggleMute}
              title={call.micMuted ? "Unmute your mic" : "Mute your mic"}>
              {call.micMuted
                ? <><MicOff className="mr-1.5 h-4 w-4" /> Unmute</>
                : <><Mic className="mr-1.5 h-4 w-4" /> Mute</>}
            </Button>
            {m6 && (
              <Button size="sm" variant={call.cameraOn ? "default" : "secondary"} onClick={onToggleCamera}
                title={call.cameraOn ? "Turn your camera off" : "Turn your camera on"}>
                {call.cameraOn
                  ? <><VideoOff className="mr-1.5 h-4 w-4" /> Camera</>
                  : <><Video className="mr-1.5 h-4 w-4" /> Camera</>}
              </Button>
            )}
          </>
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

// DOF names arrive straight from the SDK's axis maps, which are code identifiers
// ("shoulder_pan"). Underscores are for the wire, not the operator.
const dofLabel = (dof: string) => dof.replace(/_/g, " ");

export function ControlLegend({ mode }: { mode: ControlMode }) {
  const legend = keybindLegend(mode);
  return (
    <div className="space-y-3 text-xs">
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
      {/* No whitespace-nowrap here: the DOF names come from the SDK's axis maps and the long ones
          ("shoulder_pan") overflowed their grid cell and ran under the next cell's keycaps.
          Letting the label wrap inside its own cell keeps it legible instead of hidden. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {legend.arm.map((r) => (
          <div key={r.dof} className="flex min-w-0 items-center gap-1.5">
            <Key>{r.posKey.toUpperCase()}</Key><Key>{r.negKey.toUpperCase()}</Key>
            <span className="text-muted-foreground">{dofLabel(r.dof)}</span>
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
    <div className="space-y-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="w-full font-medium">Base</span>
        {clusters.map((c, i) => (
          <div key={c.forward} className="flex items-center gap-3">
            {i > 0 && <span className="text-xs text-muted-foreground">or</span>}
            <BaseKeypad cluster={c} />
          </div>
        ))}
        <span className="text-muted-foreground">forward / reverse, turn left / right</span>
        <div className="flex items-center gap-1.5">
          <Key>{legend.lift.posKey.toUpperCase()}</Key><Key>{legend.lift.negKey.toUpperCase()}</Key>
          <span className="text-muted-foreground">{dofLabel(legend.lift.dof)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">Commands</span>
        {legend.commands.map((c) => (
          <div key={c.key} className="flex items-center gap-1.5 whitespace-nowrap">
            <Key>{c.key}</Key><span className="text-muted-foreground">{c.label}</span>
          </div>
        ))}
        {/* ENTER switches the active follower arm. It's a UI selection, not a robot command, so
            it isn't in the SDK's keybind legend — but the operator doesn't care about that
            distinction, and it belongs with the other keys they can press. */}
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <Key>ENTER</Key><span className="text-muted-foreground">switch arm</span>
        </div>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
