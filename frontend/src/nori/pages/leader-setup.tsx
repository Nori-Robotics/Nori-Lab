// NORI: local-hardware setup page for Nori L2 dual leaders.
// Both leader arms are expected on one shared USB serial bus.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Crosshair,
  Gauge,
  Loader2,
  Save,
  Search,
  StopCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApi } from "@/contexts/ApiContext";
import { useNori } from "@/nori/NoriContext";
import { useToast } from "@/hooks/use-toast";
import {
  autoSaveLeaderPorts,
  autoStart,
  autoStop,
  getAutoStatus,
  getManualStatus,
  manualCancel,
  manualFinish,
  manualStart,
  readLeaderLive,
  saveLeaderPorts,
  stopLeaderLive,
  type AutoStatus,
  type LeaderLiveResponse,
  type LeaderPortsResponse,
  type LeaderSide,
  type ManualStatus,
} from "@/nori/api/leaderSetup";

const SIDES: LeaderSide[] = ["left", "right"];
const JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
const CALIBRATION_MODES = ["manual", "auto"] as const;
type CalibrationMode = (typeof CALIBRATION_MODES)[number];
const DEFAULT_CALIBRATION_ID = "nori_l2_dual_leader_dev";
const LIVE_POLL_MS = 50;
// Minimum swept range (unwrapped ticks) before a joint counts as calibrated. These are
// deliberately forgiving — an under-swept joint just clamps at its recorded bounds, so
// demanding near-full sweeps (the old 2200-3800 values) made Finish practically
// unreachable. ~800 ticks ≈ 70° of real motion; gripper full stroke is ~1000 ticks.
const MANUAL_READY_SPAN_TICKS: Record<string, number> = {
  shoulder_pan: 800,
  shoulder_lift: 800,
  elbow_flex: 800,
  wrist_flex: 800,
  wrist_roll: 800,
  gripper: 300,
};
const FIELD_CLASS =
  "h-10 rounded-md border-[#14131a]/12 bg-[#fffdf7] text-[#14131a] placeholder:text-[#a39887] focus-visible:ring-[#d98b3d]";
const OUTLINE_BUTTON_CLASS =
  "rounded-md border-[#14131a]/12 bg-[#fffdf7] text-[#14131a] hover:bg-[#ebe8db] hover:text-[#14131a]";
const SELECT_CONTENT_CLASS = "border-[#14131a]/12 bg-[#fffdf7] text-[#14131a]";
const SELECT_ITEM_CLASS = "focus:bg-[#ebe8db] focus:text-[#14131a]";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function portFromResponse(response: LeaderPortsResponse): string {
  const left = asRecord(response.ports?.left);
  const stable = left?.stable_path;
  const device = left?.device;
  if (typeof stable === "string" && stable) return stable;
  if (typeof device === "string" && device) return device;

  // Prefer a full dual bus, but accept a bus with a single complete arm (can_left OR
  // can_right) so one-arm setups auto-detect instead of reporting "not found".
  const sharedProbe =
    response.probes?.find((probe) => probe.can_left && probe.can_right) ??
    response.probes?.find((probe) => probe.can_left || probe.can_right);
  return sharedProbe?.open_path ?? "";
}

function formatAge(timestamp: number | null): string {
  if (!timestamp) return "waiting";
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 1000) return "now";
  return `${Math.round(ageMs / 1000)}s`;
}

function jointId(side: LeaderSide, joint: string): number {
  return JOINTS.indexOf(joint) + 1 + (side === "right" ? 6 : 0);
}

function recordValue(record: Record<string, number> | undefined, id: number): number | null {
  if (!record) return null;
  const value = record[String(id)];
  return typeof value === "number" ? value : null;
}

function manualJointReady(status: ManualStatus | null, side: LeaderSide, joint: string): boolean {
  const session = status?.session;
  if (!status?.active || !session || session.side !== side) return false;
  const id = jointId(side, joint);
  const center = recordValue(session.center, id);
  if (center == null) return false;
  // Prefer the unwrapped delta span: raw min/max explode to ~4096 the moment a joint
  // crosses the 0/4096 encoder boundary, which would mark it "ready" after barely moving.
  const minDelta = recordValue(session.min_deltas ?? {}, id);
  const maxDelta = recordValue(session.max_deltas ?? {}, id);
  const threshold = MANUAL_READY_SPAN_TICKS[joint] ?? 2400;
  if (minDelta != null && maxDelta != null) return maxDelta - minDelta >= threshold;
  const min = recordValue(session.mins, id);
  const max = recordValue(session.maxes, id);
  if (min == null || max == null) return false;
  return max - min >= threshold;
}

function manualSideReady(status: ManualStatus | null, side: LeaderSide): boolean {
  return JOINTS.every((joint) => manualJointReady(status, side, joint));
}

function autoJointComplete(status: AutoStatus | null, side: LeaderSide): boolean {
  return status?.status === "completed" && status.side === side;
}

function StatusPill({
  tone,
  children,
}: {
  tone: "green" | "amber" | "red" | "neutral";
  children: React.ReactNode;
}) {
  const colors = {
    green: "border-[#4e9d55]/35 bg-[#e4f3e2] text-[#2a6b33]",
    amber: "border-[#db9346]/35 bg-[#fdf1de] text-[#8a5a12]",
    red: "border-[#d24a3d]/35 bg-[#fde7e4] text-[#a3271c]",
    neutral: "border-[#14131a]/12 bg-[#f3f1e8] text-[#5c564b]",
  };
  return (
    <span className={`inline-flex h-7 items-center gap-2 rounded-md border px-2.5 text-xs font-medium ${colors[tone]}`}>
      {children}
    </span>
  );
}

function LeaderPane({
  side,
  frame,
  manualStatus,
  autoStatus,
  completedManualSide,
}: {
  side: LeaderSide;
  frame: LeaderLiveResponse | null;
  manualStatus: ManualStatus | null;
  autoStatus: AutoStatus | null;
  completedManualSide: LeaderSide | null;
}) {
  const data = frame?.leaders?.[side];
  const visible = data?.visible ?? 0;
  const activeManualOnThisSide = manualStatus?.active && manualStatus.session?.side === side;
  const rows = JOINTS.map((joint) => ({
    joint,
    motor: data?.motors?.[joint],
  }));

  return (
    <div className="rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-normal">{side} leader</h2>
        <StatusPill tone={visible === 6 ? "green" : visible > 0 ? "amber" : "red"}>
          <span className={`h-2 w-2 rounded-full ${visible === 6 ? "bg-[#3f9a4c]" : visible > 0 ? "bg-[#db9346]" : "bg-[#d24a3d]"}`} />
          {visible}/6
        </StatusPill>
      </div>

      <div className="space-y-2">
        {rows.map(({ joint, motor }) => {
          const raw = motor?.raw ?? null;
          const target = motor?.target ?? null;
          const pct = raw == null ? 0 : Math.max(0, Math.min(100, (raw / 4095) * 100));
          const calibrationComplete = activeManualOnThisSide
            ? manualJointReady(manualStatus, side, joint)
            : completedManualSide === side || autoJointComplete(autoStatus, side);
          return (
            <div key={joint} className="grid min-h-11 grid-cols-[minmax(0,1fr)_2.75rem_2.75rem] items-center gap-1.5 rounded-md border border-[#14131a]/10 bg-[#f3f1e8] px-2 py-2">
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-xs text-[#14131a]">{joint}</span>
                    {calibrationComplete && (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[#4e9d55]/50 bg-[#e4f3e2] text-[#2a6b33]">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </div>
                  <span className={`h-2 w-2 rounded-full ${motor?.ok ? "bg-[#43a04e]" : "bg-[#d24a3d]"}`} />
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e5e1d2]">
                  <div className="h-full rounded-full bg-[#d98b3d]" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="text-right font-mono text-xs">
                <div className="text-[10px] uppercase text-[#857b6b]">raw</div>
                <div>{raw == null ? "--" : Math.round(raw)}</div>
              </div>
              <div className="text-right font-mono text-xs">
                <div className="text-[10px] uppercase text-[#857b6b]">deg</div>
                <div>{target == null ? "--" : target.toFixed(1)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// `embedded` renders the same setup surface as a compact block (no full-page chrome,
// smaller header, single-column stacking so it fits a narrow sidebar) for inlining
// inside another page — e.g. the Remote page's leader card. `headerExtra` slots extra
// controls (like the arm selector) into the header row next to the status pills.
// `collapsed`/`onToggleCollapse` make the embedded header a show/hide toggle (the
// component stays mounted while collapsed so live polling and the status pill keep
// running).
const LeaderSetup = ({
  embedded = false,
  titleExtra,
  headerExtra,
  headerBelow,
  collapsed = false,
  onToggleCollapse,
}: {
  embedded?: boolean;
  // Rendered inline next to the "Leader setup" title (embedded only) — the Remote page
  // puts the Engage button here. Clicks inside it don't toggle the collapse.
  titleExtra?: React.ReactNode;
  headerExtra?: React.ReactNode;
  // Rendered directly under the header row (embedded, expanded only) — the Remote page
  // slots the base/commands keyboard legend here since base + lift stay on the keyboard
  // while the leaders drive the arms.
  headerBelow?: React.ReactNode;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { leLabAvailable } = useNori();
  const { toast } = useToast();

  const [calibrationId, setCalibrationId] = useState(DEFAULT_CALIBRATION_ID);
  const [sharedPort, setSharedPort] = useState("");
  // True once an auto-detect has run and found no USB leader bus (arm unplugged, a
  // charge-only cable, or a hub swallowing it) — drives a plain-language hint instead
  // of leaving a consumer staring at an empty field.
  const [noArmFound, setNoArmFound] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [liveFrame, setLiveFrame] = useState<LeaderLiveResponse | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [lastLiveAt, setLastLiveAt] = useState<number | null>(null);

  const [calibrationSide, setCalibrationSide] = useState<LeaderSide>("left");
  const [calibrationMode, setCalibrationMode] = useState<CalibrationMode>("manual");
  const [completedManualSide, setCompletedManualSide] = useState<LeaderSide | null>(null);
  const [manualStatus, setManualStatus] = useState<ManualStatus | null>(null);

  const [autoConfirmed, setAutoConfirmed] = useState(false);
  const [autoStatus, setAutoStatus] = useState<AutoStatus | null>(null);

  const run = async <T,>(
    label: string,
    task: () => Promise<T>,
    onSuccess?: (value: T) => void,
    successDescription = "Done",
  ) => {
    setBusy(label);
    setError(null);
    try {
      const value = await task();
      // The leader endpoints report soft failures as HTTP 200 + {success:false, message}
      // (e.g. "left leader missing IDs", "calibration already active"). Treat those as
      // errors — otherwise a failed "start calibration" instantly toasts success.
      const record = asRecord(value);
      if (record && record.success === false) {
        throw new Error(String(record.message || `${label} failed`));
      }
      onSuccess?.(value);
      toast({ title: label, description: successDescription });
      return value;
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      toast({ title: label, description: message, variant: "destructive" });
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const saveSharedPort = useCallback(
    async (port: string) => {
      const trimmed = port.trim();
      if (!trimmed) throw new Error("Leader USB port is required");
      const response = await saveLeaderPorts(baseUrl, fetchWithHeaders, trimmed, trimmed);
      setSharedPort(trimmed);
      return response;
    },
    [baseUrl, fetchWithHeaders]
  );

  const autoDetectPort = useCallback(async () => {
    const response = await autoSaveLeaderPorts(baseUrl, fetchWithHeaders);
    const detected = portFromResponse(response);
    if (!detected) {
      setNoArmFound(true);
      throw new Error(response.message || "Could not find a leader arm on any USB bus");
    }
    setNoArmFound(false);
    setSharedPort(detected);
    return response;
  }, [baseUrl, fetchWithHeaders]);

  const refreshManualStatus = useCallback(async () => {
    const status = await getManualStatus(baseUrl, fetchWithHeaders);
    setManualStatus(status);
    return status;
  }, [baseUrl, fetchWithHeaders]);

  const refreshAutoStatus = useCallback(async () => {
    const status = await getAutoStatus(baseUrl, fetchWithHeaders);
    setAutoStatus(status);
    return status;
  }, [baseUrl, fetchWithHeaders]);

  const readLiveOnce = useCallback(async () => {
    const frame = await readLeaderLive(
      baseUrl,
      fetchWithHeaders,
      calibrationId.trim() || DEFAULT_CALIBRATION_ID,
      sharedPort.trim() || undefined
    );
    setLiveFrame(frame);
    setLiveError(null);
    setLastLiveAt(Date.now());
    if (!sharedPort.trim() && frame.port) setSharedPort(frame.port);
    return frame;
  }, [baseUrl, calibrationId, fetchWithHeaders, sharedPort]);

  useEffect(() => {
    // No local LeLab (hosted build) -> the unavailable-guard renders below, but hooks
    // still run before that early return. Don't probe a dead localhost.
    if (!leLabAvailable) return;
    void refreshManualStatus().catch(() => undefined);
    void refreshAutoStatus().catch(() => undefined);
  }, [leLabAvailable, refreshAutoStatus, refreshManualStatus]);

  useEffect(() => {
    if (!leLabAvailable) return;
    void autoDetectPort().catch(() => undefined);
  }, [leLabAvailable, autoDetectPort]);

  useEffect(() => {
    // Don't poll live telemetry until a leader USB port is known (auto-detected or
    // manually saved). Before setup there's no hardware to read, so polling would just
    // spam the backend with requests that resolve to a "not connected" frame.
    if (!sharedPort.trim()) {
      setLiveFrame(null);
      setLiveError(null);
      return undefined;
    }

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        await readLiveOnce();
      } catch (err) {
        setLiveError(errorMessage(err));
        setLastLiveAt(Date.now());
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, LIVE_POLL_MS);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [readLiveOnce, sharedPort]);

  useEffect(() => {
    return () => {
      void stopLeaderLive(baseUrl, fetchWithHeaders).catch(() => undefined);
    };
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    if (!manualStatus?.active) return undefined;
    if (manualStatus.session?.side) {
      setCalibrationMode("manual");
      setCalibrationSide(manualStatus.session.side);
    }
    const id = window.setInterval(() => {
      void refreshManualStatus().catch((err) => setError(errorMessage(err)));
    }, 250);
    return () => window.clearInterval(id);
  }, [manualStatus?.active, manualStatus?.session?.side, refreshManualStatus]);

  useEffect(() => {
    if (!autoStatus?.active) return undefined;
    if (autoStatus.side === "left" || autoStatus.side === "right") {
      setCalibrationMode("auto");
      setCalibrationSide(autoStatus.side);
    }
    const id = window.setInterval(() => {
      void refreshAutoStatus().catch((err) => setError(errorMessage(err)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [autoStatus?.active, autoStatus?.side, refreshAutoStatus]);

  const portReady = Boolean(sharedPort.trim());
  const bothVisible = useMemo(() => {
    const left = liveFrame?.leaders?.left?.visible ?? 0;
    const right = liveFrame?.leaders?.right?.visible ?? 0;
    return left === 6 && right === 6;
  }, [liveFrame]);
  // Honest link pill: reflects the actual /nori/leader/live polling state instead of a
  // hardcoded "live". No port -> not polling; port but no frame yet -> connecting; frames
  // flowing -> live (green once both arms show all 6 motors); read error -> paused.
  const liveStatus: { tone: "green" | "amber" | "red" | "neutral"; dot: string; label: string } = liveError
    ? { tone: "red", dot: "bg-[#d24a3d]", label: "paused" }
    : !portReady
      ? { tone: "neutral", dot: "bg-[#a39887]", label: "no leader bus" }
      : liveFrame
        ? {
            tone: bothVisible ? "green" : "amber",
            dot: bothVisible ? "bg-[#3f9a4c]" : "bg-[#db9346]",
            label: `live · ${formatAge(lastLiveAt)}`,
          }
        : { tone: "amber", dot: "bg-[#db9346]", label: "connecting…" };
  const calibrationBusy = Boolean(manualStatus?.active || autoStatus?.active);
  const manualActiveSide = manualStatus?.session?.side ?? calibrationSide;
  const manualReady = manualSideReady(manualStatus, manualActiveSide);
  const calibrationMessage =
    autoStatus?.error ||
    (manualStatus?.active
      ? `${manualActiveSide} manual${manualReady ? " ready" : ""}`
      : autoStatus?.active || autoStatus?.status === "completed"
        ? autoStatus.message || "auto calibration"
        : "ready");

  // Leader driving depends on the LeLab server enumerating the USB serial bus (pyserial
  // behind `/nori/leader/*`). On the hosted, LeLab-free deploy there is no such server —
  // a headset browser can't reach any local hardware — so the whole flow is impossible.
  // Show an honest notice instead of a Search button that can only ever fail. All hooks
  // above still run, so this early return is rules-of-hooks safe.
  if (!leLabAvailable) {
    return (
      <section
        className={
          embedded
            ? "text-[#14131a]"
            : "min-h-[calc(100vh-2rem)] rounded-md bg-[#fbfaf5] px-4 py-5 text-[#14131a] sm:px-5"
        }
      >
        <Alert className="border-[#14131a]/12 bg-[#fffdf7] text-[#14131a]">
          <AlertTitle>Leader driving isn’t available on the web app</AlertTitle>
          <AlertDescription className="text-[#5c5344]">
            Leader arm connection and calibration are only available in the desktop
            app over USB connection. Use a VR headset for remote driving over web, or open Nori Lab on
            the computer the arms are plugged into.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section
      className={
        embedded
          ? "space-y-4 text-[#14131a]"
          : "min-h-[calc(100vh-2rem)] space-y-5 rounded-md bg-[#fbfaf5] px-4 py-5 text-[#14131a] sm:px-5"
      }
    >
      {embedded ? (
        <>
          {/* Header row: just the title + toggle (matches the other control cards).
              The arm pills + live status get their own row below, revealed on expand. */}
          <div
            className={`flex min-h-9 items-center justify-between gap-3 ${onToggleCollapse ? "cursor-pointer" : ""}`}
            onClick={onToggleCollapse}
          >
            <div className="flex items-center gap-3">
              {/* The global h1 rule applies the display font — embedded must render the same
                  element as CardTitle (h3, font-sans) to match the Keyboard controls title. */}
              <h3 className="text-base font-semibold leading-none tracking-tight">Leader setup</h3>
            </div>
            {onToggleCollapse && (
              <span className="text-sm text-muted-foreground">
                {collapsed ? "▼ show" : "▲ hide"}
              </span>
            )}
          </div>
          {!collapsed && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {headerExtra ?? <span />}
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={liveStatus.tone}>
                  <span className={`h-2 w-2 rounded-full ${liveStatus.dot}`} />
                  {liveStatus.label}
                </StatusPill>
                {titleExtra && <span onClick={(e) => e.stopPropagation()}>{titleExtra}</span>}
                {busy && (
                  <StatusPill tone="neutral">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {busy}
                  </StatusPill>
                )}
              </div>
            </div>
          )}
          {!collapsed && headerBelow}
        </>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#7a7060]">// Teleoperation</p>
            <h1 className="text-4xl font-semibold tracking-normal sm:text-5xl">Leader setup</h1>
            <p className="max-w-2xl text-sm text-[#6f6858]">nori l2 dual leader calibration</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={liveStatus.tone}>
              <span className={`h-2 w-2 rounded-full ${liveStatus.dot}`} />
              {liveStatus.label}
            </StatusPill>
            {busy && (
              <StatusPill tone="neutral">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {busy}
              </StatusPill>
            )}
          </div>
        </div>
      )}

      {embedded && collapsed ? null : (
      <>

      {(error || liveError) && (
        <Alert className="border-[#d24a3d]/35 bg-[#fde7e4] text-[#8f2318]">
          <AlertTitle>{error ? "setup needs attention" : "live read paused"}</AlertTitle>
          <AlertDescription>{error || liveError}</AlertDescription>
        </Alert>
      )}

      {(liveFrame?.warnings?.length ?? 0) > 0 && (
        <Alert className="border-[#db9346]/35 bg-[#fdf1de] text-[#8a5a12]">
          <AlertTitle>calibration needs attention</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {liveFrame?.warnings?.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-3 shadow-sm">
        <div className={embedded ? "grid gap-3" : "grid gap-3 lg:grid-cols-2 lg:items-end"}>
          <div className="space-y-1.5">
            <Label htmlFor="leader-port" className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#7a7060]">
              shared usb
            </Label>
            <div className="flex gap-2">
              <Input
                id="leader-port"
                value={sharedPort}
                onChange={(event) => setSharedPort(event.target.value)}
                placeholder="/dev/serial/by-id/..."
                className={FIELD_CLASS}
              />
              <Button
                variant="outline"
                onClick={() => run("Auto-detect USB", autoDetectPort)}
                disabled={busy != null}
                className={`h-10 shrink-0 ${OUTLINE_BUTTON_CLASS}`}
              >
                <Search className="mr-2 h-4 w-4" />
                auto
              </Button>
            </div>
            {noArmFound && !portReady && busy == null && (
              <p className="text-xs leading-relaxed text-[#8a5a12]">
                No leader arm found. Check that it’s plugged in with a{" "}
                <span className="font-medium">data</span> USB cable (some cables only charge)
                and connected <span className="font-medium">directly</span> to the computer,
                not through a hub or dock — then tap <span className="font-medium">auto</span> again.
              </p>
            )}
          </div>
          {/* Calibration id + save share a line, mirroring the usb + auto pattern above. */}
          <div className="space-y-1.5">
            <Label htmlFor="calibration-id" className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#7a7060]">
              calibration
            </Label>
            <div className="flex gap-2">
              <Input
                id="calibration-id"
                value={calibrationId}
                onChange={(event) => setCalibrationId(event.target.value)}
                className={FIELD_CLASS}
              />
              <Button
                variant="outline"
                onClick={() => run("Save USB port", () => saveSharedPort(sharedPort))}
                disabled={busy != null || !portReady}
                className={`h-10 shrink-0 ${OUTLINE_BUTTON_CLASS}`}
                title="Save the shared USB port for both leader arms"
              >
                <Save className="mr-2 h-4 w-4" />
                save
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Card className="rounded-md border-[#14131a]/10 bg-[#f6f4eb] text-[#14131a] shadow-sm">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">calibrate leader</h2>
            <StatusPill tone={manualStatus?.active || autoStatus?.active ? "amber" : "neutral"}>
              {calibrationMessage}
            </StatusPill>
          </div>

          {/* Manual calibration captures the zero reference from the arm's pose at the
              moment start is pressed; the robot interprets leader targets as absolute
              offsets from that pose, so it must match the follower's zero/ready pose —
              and the SAME pose on every recalibration. */}
          {calibrationMode === "manual" && (
            <p className="rounded bg-[#ebe8db] px-2 py-1 text-xs text-[#5c564b]">
              Hold the leader in its <strong>zero pose</strong> (matching the follower arm&apos;s
              zero/ready pose) when you press <strong>start</strong> — that pose is captured as the
              zero reference for every joint. Use the same pose each time you recalibrate, or the
              robot arms will track offset or pin at their limits.
            </p>
          )}

          {/* Only one calibration session can exist server-side, and it survives page
              reloads — say so explicitly, since a running session is why the start
              button is disabled ("why won't it let me start?"). */}
          {manualStatus?.active && (
            <p className="rounded bg-[#db9346]/15 px-2 py-1 text-xs text-[#8a5a12]">
              A manual calibration session for the <strong>{manualActiveSide}</strong> leader is
              already running (it persists across page reloads). Sweep each joint until every
              row shows a checkmark, then press <strong>finish</strong> — or{" "}
              <strong>cancel</strong> to start over.
            </p>
          )}
          {autoStatus?.active && (
            <p className="rounded bg-[#db9346]/15 px-2 py-1 text-xs text-[#8a5a12]">
              Auto calibration is running — wait for it to complete or press stop before
              starting a new session.
            </p>
          )}

          {/* Row 1: side + mode side by side. Row 2: all the actions on one line. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#7a7060]">side</Label>
              <Select value={calibrationSide} onValueChange={(value) => setCalibrationSide(value as LeaderSide)} disabled={calibrationBusy}>
                <SelectTrigger className={FIELD_CLASS}><SelectValue /></SelectTrigger>
                <SelectContent className={SELECT_CONTENT_CLASS}>
                  {SIDES.map((side) => (
                    <SelectItem key={side} value={side} className={SELECT_ITEM_CLASS}>
                      {side}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#7a7060]">mode</Label>
              <div className="grid h-10 grid-cols-2 rounded-md border border-[#14131a]/12 bg-[#fffdf7] p-1">
                {CALIBRATION_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setCalibrationMode(mode)}
                    disabled={calibrationBusy}
                    className={`rounded px-2 text-sm ${
                      calibrationMode === mode
                        ? "bg-[#d98b3d] text-foreground"
                        : "text-[#5c564b] hover:bg-[#ebe8db] hover:text-[#14131a]"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                setCompletedManualSide(null);
                if (calibrationMode === "manual") {
                  void run(
                    "Start manual calibration",
                    () => manualStart(baseUrl, fetchWithHeaders, calibrationSide, calibrationId.trim(), sharedPort.trim() || undefined),
                    () => void refreshManualStatus(),
                    "Session started — zero pose captured from the arm's current position. Sweep every joint through its full range, then press finish."
                  );
                  return;
                }
                void run(
                  "Start auto calibration",
                  () => autoStart(baseUrl, fetchWithHeaders, calibrationSide, calibrationId.trim(), autoConfirmed, sharedPort.trim() || undefined),
                  () => void refreshAutoStatus(),
                  "Auto calibration running — keep clear of the arm."
                );
              }}
              disabled={busy != null || calibrationBusy || !portReady || (calibrationMode === "auto" && !autoConfirmed)}
              className="rounded-md bg-[#d98b3d] text-foreground hover:bg-[#c97929]"
            >
              {calibrationMode === "manual" ? <Crosshair className="mr-2 h-4 w-4" /> : <Gauge className="mr-2 h-4 w-4" />}
              start
            </Button>
            {calibrationMode === "manual" ? (
              <>
                <Button
                  onClick={() =>
                    run("Finish manual calibration", () => manualFinish(baseUrl, fetchWithHeaders), () => {
                      setCompletedManualSide(manualActiveSide);
                      void refreshManualStatus();
                      void readLiveOnce();
                    })
                  }
                  disabled={busy != null || !manualStatus?.active || !manualReady}
                  className="rounded-md bg-[#8ab135] text-foreground hover:bg-[#799c2a]"
                >
                  <Save className="mr-2 h-4 w-4" />
                  finish
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    run("Cancel manual calibration", () => manualCancel(baseUrl, fetchWithHeaders), () => {
                      void refreshManualStatus();
                    })
                  }
                  disabled={busy != null || !manualStatus?.active}
                  className={OUTLINE_BUTTON_CLASS}
                >
                  cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => run("Stop auto calibration", () => autoStop(baseUrl, fetchWithHeaders), () => void refreshAutoStatus())}
                  disabled={busy != null || !autoStatus?.active}
                  className={OUTLINE_BUTTON_CLASS}
                >
                  <StopCircle className="mr-2 h-4 w-4" />
                  stop
                </Button>
                <label className="flex min-h-10 items-center gap-2 rounded-md border border-[#14131a]/10 bg-[#f6f4eb] px-3 text-sm text-[#5c564b]">
                  <Checkbox
                    checked={autoConfirmed}
                    onCheckedChange={(value) => setAutoConfirmed(value === true)}
                    disabled={calibrationBusy}
                  />
                  <span>arms clear</span>
                </label>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Embedded lives in a ~400px sidebar: stack the panes (right below left) instead
          of squeezing two columns — the viewport-based md: breakpoint lies about the
          actual card width. */}
      <div className={embedded ? "grid gap-4" : "grid gap-4 xl:grid-cols-2"}>
        <LeaderPane
          side="left"
          frame={liveFrame}
          manualStatus={manualStatus}
          autoStatus={autoStatus}
          completedManualSide={completedManualSide}
        />
        <LeaderPane
          side="right"
          frame={liveFrame}
          manualStatus={manualStatus}
          autoStatus={autoStatus}
          completedManualSide={completedManualSide}
        />
      </div>
      </>
      )}
    </section>
  );
};

export default LeaderSetup;
