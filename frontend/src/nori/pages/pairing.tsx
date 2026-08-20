// NORI: Additive file. Pairing page (Phase 6, manual serial entry).
// Manual serial → POST /nori/customers/me/pair. mDNS/QR discovery is blocked on the Pi
// daemon's presence advertisement.
//
// Multi-robot: the customer can pair several robots and choose which one teleop/remote
// connects to (the "active" robot — see NoriContext.activeRobotSerial). The backend
// multi-robot endpoints (list / per-robot unpair / server-side active selection) are
// live (Nori-Backend, 2026-07-06); this page calls them directly. A profile-derived
// single-robot fallback remains only for resilience if listRobots fails.

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { ApiError } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import RobotUrdfViewer, { type HoveredJoint } from "@/nori/components/RobotUrdfViewer";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { railReading } from "@nori/sdk";
import { Robot3D } from "@/nori/remote/Robot3D";
import { useNori } from "@/nori/NoriContext";
import { hasUrdfModel, isRobotModelBlocked } from "@/nori/robotModels";
import {
  listRobots,
  pairRobot,
  renameRobot,
  selectRobot,
  unpairRobot,
  type CustomerProfile,
  type PairedRobot,
} from "@/nori/api/client";

/** Single-robot list derived from the profile — resilience fallback if the backend's
 * multi-robot GET /customers/me/robots call fails (the endpoint is live). */
function robotsFromCustomer(customer: CustomerProfile | null): PairedRobot[] {
  if (!customer?.is_paired || !customer.robot_serial_number) return [];
  return [{ robot_serial_number: customer.robot_serial_number, is_active: true }];
}

/** Lift endpoint height when fully retracted, from the description. */
const LIFT_RETRACTED_MM = 515;

/**
 * Height of the model panel. Shared by the viewport and the telemetry column so
 * the two cannot drift apart — they sit side by side, and a mismatch leaves one
 * short with a ragged bottom edge.
 */
const PANEL_HEIGHT = "h-[640px]";

/**
 * Format a joint's range in its own units. Revolute limits are radians and read
 * as degrees; PRISMATIC limits are metres and must not be run through a radian
 * conversion — the lift would otherwise report "0 to 41 degrees" of travel.
 */
const jointRange = (type: string, lower?: number, upper?: number): string => {
  if (lower === undefined || upper === undefined) return "";
  if (type === "prismatic") return `${Math.round(lower * 1000)} to ${Math.round(upper * 1000)} mm`;
  if (type === "continuous") return "continuous";
  const d = (rad: number) => Math.round((rad * 180) / Math.PI);
  return `${d(lower)}\u00b0 to ${d(upper)}\u00b0`;
};

/**
 * Small readout under the model: what the cursor is over, and whatever live
 * telemetry happens to be flowing.
 *
 * The pairing page has no session of its own — it reads whatever the shared
 * TeleopSessionContext has. Usually that is nothing, so every live field degrades
 * to a dash rather than being hidden; a row that appears and disappears as a
 * session comes and goes is more confusing than one that is simply empty.
 */
const ModelReadout: React.FC<{
  hovered: HoveredJoint | null;
  pose: Record<string, number>;
  joints: HoveredJoint[];
}> = ({ hovered, pose, joints }) => {
  const { running, connState, tel } = useTeleopSession();
  const live = running && connState === "connected";

  // The lift key differs per robot generation, so find it rather than hardcode:
  // any *_lift.pos in the telemetry dict is the one we want.
  const liftKey = Object.keys(tel.state ?? {}).find((k) => k.endsWith("_lift.pos"));
  const liveLift = liftKey ? railReading(tel.state, liftKey) : null;

  // With nothing connected the MODEL is the only pose that exists — and it is a
  // real one, since dragging a joint in the viewer actually moves it.
  const extension = pose["lift_extension_joint"];
  const estLiftMm =
    typeof extension === "number" ? LIFT_RETRACTED_MM + extension * 1000 : null;

  const liftValue = liveLift?.known
    ? `${Math.round(liveLift.depthMm)} mm`
    : estLiftMm !== null
      ? `~${Math.round(estLiftMm)} mm`
      : "\u2014";

  const valueOf = (j: HoveredJoint): string => {
    const v = pose[j.name];
    if (typeof v !== "number") return "\u2014";
    if (j.type === "prismatic") return `${Math.round(v * 1000)} mm`;
    return `${Math.round((v * 180) / Math.PI)}\u00b0`;
  };

  /** Where the joint sits in its range, for the little fill bar. 0..1. */
  const fractionOf = (j: HoveredJoint): number | null => {
    const v = pose[j.name];
    if (typeof v !== "number" || j.lower === undefined || j.upper === undefined)
      return null;
    const span = j.upper - j.lower;
    return span > 0 ? Math.min(1, Math.max(0, (v - j.lower) / span)) : null;
  };

  return (
    <div
      className={`flex ${PANEL_HEIGHT} min-h-0 flex-col gap-3 rounded-md border bg-muted/30 p-3`}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {live ? "Lift height" : "Lift height (est.)"}
          </p>
          <p className="truncate text-sm font-medium tabular-nums">{liftValue}</p>
          {/* Named explicitly because it is NOT the lift_extension_joint value
              below: extension is travel from stowed (0-720 mm), this is the
              endpoint's height above the base (515-1235 mm). */}
          <p className="text-[11px] text-muted-foreground">above base</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Battery</p>
          <p className="truncate text-sm font-medium tabular-nums">
            {typeof tel.batteryPercent === "number"
              ? `${tel.batteryPercent}%`
              : "\u2014"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {live ? "live" : "needs a session"}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="sticky top-0 bg-muted/30 pb-1 text-xs font-medium text-muted-foreground">
          Joints {joints.length > 0 && `(${joints.length})`}
        </p>
        {joints.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <ul className="space-y-1">
            {joints.map((j) => {
              const frac = fractionOf(j);
              const isHovered = hovered?.name === j.name;
              return (
                <li
                  key={j.name}
                  className={`rounded px-1.5 py-1 ${
                    isHovered ? "bg-nori-h8ab135/20" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[11px]">
                      {j.name.replace(/_joint$/, "")}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums">
                      {valueOf(j)}
                    </span>
                  </div>
                  {frac !== null && (
                    <div className="mt-1 h-1 w-full rounded-full bg-border">
                      <div
                        className="h-1 rounded-full bg-nori-h8ab135"
                        style={{ width: `${frac * 100}%` }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground">
        {live
          ? "Live values from the connected robot."
          : "No session connected — poses are estimated from the model. Drag a joint to move it."}
      </p>
    </div>
  );
};

const Pairing = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { customer, setCustomer, activeRobotSerial, setActiveRobotSerial } = useNori();

  const [robots, setRobots] = useState<PairedRobot[] | null>(null);
  const [serial, setSerial] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [nickname, setNickname] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySerial, setBusySerial] = useState<string | null>(null);
  // Not persisted: showing the model is a look-at-it action, not a preference.
  const [showUrdf, setShowUrdf] = useState(false);
  const [hovered, setHovered] = useState<HoveredJoint | null>(null);
  const [pose, setPose] = useState<Record<string, number>>({});
  const [joints, setJoints] = useState<HoveredJoint[]>([]);
  const [confirmSerial, setConfirmSerial] = useState<string | null>(null);
  const [renameSerial, setRenameSerial] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const loadRobots = useCallback(async () => {
    try {
      setRobots(await listRobots(baseUrl, fetchWithHeaders));
    } catch {
      // listRobots failed (network/backend) — fall back to the profile-derived list.
      setRobots(robotsFromCustomer(customer));
    }
  }, [baseUrl, fetchWithHeaders, customer]);

  useEffect(() => {
    loadRobots();
  }, [loadRobots]);

  // Keep the active selection pointing at a robot that still exists. Runs when the list
  // changes (e.g. after unpair) or when a stale localStorage serial doesn't match.
  useEffect(() => {
    if (!robots || robots.length === 0) return;
    if (robots.some((r) => r.robot_serial_number === activeRobotSerial)) return;
    const preferred = robots.find((r) => r.is_active) ?? robots[0];
    setActiveRobotSerial(preferred.robot_serial_number);
  }, [robots, activeRobotSerial, setActiveRobotSerial]);

  const onPair = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const next = serial.trim();
    const code = pairCode.trim();
    const name = nickname.trim();
    // Client-side model gate (robotModels.ts): this build only offers L2. Block a known
    // disallowed model (L3) before the API call. UX-only — not enforced server-side.
    if (isRobotModelBlocked(next)) {
      setError(
        "This app supports Nori L2 robots only — that serial is a different model " +
          "and can't be paired here."
      );
      setSubmitting(false);
      return;
    }
    try {
      const updated = await pairRobot(
        baseUrl,
        fetchWithHeaders,
        next,
        code || undefined,
        name || undefined
      );
      setCustomer(updated);
      setSerial("");
      setPairCode("");
      setNickname("");
      // First robot paired becomes active automatically.
      if (!robots || robots.length === 0) setActiveRobotSerial(next);
      await loadRobots();
    } catch (err) {
      // 403 covers TWO different refusals with different fixes: the pair-code gate
      // (proof of possession, mig 029) AND the tier robot-limit cap (get_tier_limits,
      // which runs BEFORE the code check). Both backend `detail` strings are already
      // user-facing, so surface the actual one — otherwise someone over their robot
      // limit is wrongly told "wrong pairing code" and chases the code forever.
      if (err instanceof ApiError && err.status === 403) {
        setError(
          err.detail ??
            "Pairing was refused — check the code printed on your robot's box, and that " +
              "you're not over your robot limit."
        );
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        // 409 = serial owned by another account; 404 = no such registered robot (the
        // provisioned-only cutover refuses made-up serials). Both mean "this serial isn't
        // available to you," and the far likelier cause is a typo — so lead with that and
        // show the same friendly copy instead of the raw backend detail (which leaked a
        // "No robot with serial ... is registered" string for the 404 case).
        setError(
          `Pairing failed: '${next}' is not available. Please check you typed your ` +
            `serial number correctly. Each robot can only be paired to one account.`
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Selection feeds remote.tsx's session room. We apply it locally immediately for
  // snappy UX, then persist server-side (selectRobot). If the sync fails the local
  // choice still stands, so a transient backend error doesn't block connecting.
  const onSelect = async (s: string) => {
    setActiveRobotSerial(s);
    try {
      setCustomer(await selectRobot(baseUrl, fetchWithHeaders, s));
    } catch {
      // Persisting the active robot failed; the local choice stands for this session.
    }
  };

  const onUnpair = async (s: string) => {
    setError(null);
    setBusySerial(s);
    try {
      const updated = await unpairRobot(baseUrl, fetchWithHeaders, s);
      setCustomer(updated);
      if (activeRobotSerial === s) setActiveRobotSerial(null); // reconcile effect re-points
      setConfirmSerial(null);
      await loadRobots();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySerial(null);
    }
  };

  // Open the inline rename editor for a robot, seeded with its current name. Clears any
  // pending unpair confirm on the same row so the two edit modes can't overlap.
  const startRename = (s: string, current: string | null | undefined) => {
    setError(null);
    setConfirmSerial(null);
    setRenameValue(current ?? "");
    setRenameSerial(s);
  };

  const onRename = async (s: string) => {
    setError(null);
    setBusySerial(s);
    try {
      // Empty string clears the nickname (backend stores NULL). Last-write-wins against a
      // rename made on the robot's own kiosk — both write the one robots.nickname column.
      await renameRobot(baseUrl, fetchWithHeaders, s, renameValue.trim());
      setRenameSerial(null);
      await loadRobots();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySerial(null);
    }
  };

  const paired = robots ?? [];
  const hasRobots = paired.length > 0;

  const activeRobot = paired.find((r) => r.robot_serial_number === activeRobotSerial);
  // Only the A-series ships a URDF (see nori_ws/urdf_release). Everything else falls
  // back to the stylised model the remote page uses, so every robot shows something.
  //
  // `?urdf=1` forces the URDF regardless of model. This exists because iterating on
  // the A3 description otherwise requires an A3 paired to the signed-in account,
  // which nobody tuning mesh dimensions has. Read once per render from the live URL
  // so it needs no state and no rebuild to toggle.
  const forceUrdf =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("urdf");
  const showsUrdf = forceUrdf || hasUrdfModel(activeRobot?.robot_serial_number);

  return (
    // Wider than the rest of the Nori pages: once a robot is paired this becomes a
    // two-column layout, and the paired list needs room for a nickname plus four
    // actions on one row.
    <section className="max-w-5xl space-y-4">
      <h1 className="text-3xl font-bold">{hasRobots ? "Your robots" : "Pair your robot"}</h1>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {hasRobots && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Paired robots{paired.length > 1 ? " — select which to use" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {paired.map((r) => {
              const s = r.robot_serial_number;
              const active = s === activeRobotSerial;
              const confirming = confirmSerial === s;
              const renaming = renameSerial === s;
              const busy = busySerial === s;

              // Rename mode: the whole row becomes an edit form so the input has room
              // (nicknames run up to 128 chars — no space for it inline with the buttons).
              if (renaming) {
                return (
                  <div
                    key={s}
                    className={`space-y-2 rounded-md border p-3 ${
                      active ? "border-primary" : "border-border"
                    }`}
                  >
                    <div className="truncate font-mono text-xs text-muted-foreground">{s}</div>
                    <Label htmlFor={`rename-${s}`} className="sr-only">
                      Nickname
                    </Label>
                    <Input
                      id={`rename-${s}`}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      placeholder="Nickname (leave blank to clear)"
                      maxLength={128}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => onRename(s)} disabled={busy}>
                        {busy ? "Saving…" : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenameSerial(null)}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={s}
                  className={`flex items-center gap-3 rounded-md border p-3 ${
                    active ? "border-primary" : "border-border"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    {/* Lead with the nickname when set — it's what the customer named the
                        robot — and drop the serial to a secondary line. Serial-only when unnamed. */}
                    {r.nickname ? (
                      <>
                        <div className="truncate text-sm font-medium">{r.nickname}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">{s}</div>
                      </>
                    ) : (
                      <div className="truncate font-mono text-sm">{s}</div>
                    )}
                  </div>
                  {active ? (
                    <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      Selected
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onSelect(s)}
                      disabled={busy}
                    >
                      Select
                    </Button>
                  )}
                  {confirming ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => onUnpair(s)}
                        disabled={busy}
                      >
                        {busy ? "Unpairing…" : "Confirm"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmSerial(null)}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startRename(s, r.nickname)}
                        disabled={busy}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setConfirmSerial(s)}
                      >
                        Unpair
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Only meaningful once a robot is selected — the model shown is the one that
          robot is, and there is nothing to show before then. Collapsed by default:
          the meshes are ~10 MB, so they are fetched on first expand, not on page
          load. */}
      {activeRobot && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="text-base">Robot model</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {showUrdf
                  ? "Drag to rotate, scroll to zoom."
                  : `A 3D model of ${activeRobot.nickname || activeRobot.robot_serial_number}.`}
              </p>
            </div>
            <Button
              variant={showUrdf ? "outline" : "default"}
              onClick={() => setShowUrdf((v) => !v)}
            >
              {showUrdf ? "Hide model" : showsUrdf ? "Show URDF" : "Show model"}
            </Button>
          </CardHeader>
          {showUrdf && (
            <CardContent>
              {showsUrdf ? (
                <>
                  {/* Viewer and telemetry side by side: the joint list is long
                      enough that stacking it pushed the model off screen. Collapses
                      to stacked below lg. */}
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <RobotUrdfViewer
                      className={`${PANEL_HEIGHT} w-full`}
                      onHoverJoint={setHovered}
                      onPoseChange={setPose}
                      onJointsLoaded={setJoints}
                    />
                    <ModelReadout
                      hovered={hovered}
                      pose={pose}
                      joints={joints}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Dimensions and joint limits are measured from hardware. Mass and
                    inertia are approximate.
                  </p>
                </>
              ) : (
                <>
                  {/* No telemetry on this page, so the model renders in its default
                      pose — this is "what your robot looks like", not a live view. */}
                  <Robot3D state={{}} activeArm="right" />
                  <p className="mt-2 text-xs text-muted-foreground">
                    A stylised model. The full robot description is published for the
                    Nori A3.
                  </p>
                </>
              )}
            </CardContent>
          )}
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {hasRobots ? "Pair another robot" : "Enter serial number"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* One row across the full width: three short fields and the button read
              as a single action, and a stacked form at full page width left a lot of
              dead space to the right of each input. Falls back to stacked below md. */}
          <form
            onSubmit={onPair}
            className="grid grid-cols-1 items-start gap-4 md:grid-cols-[1fr_1fr_1fr_auto]"
          >
            <div className="space-y-1.5">
              <Label htmlFor="serial">Robot serial number</Label>
              {/* Serials are canonically UPPERCASE, and the serial becomes the room name — an
                  exact-match Supabase realtime channel. A lowercase entry pairs fine and then
                  fails to connect with "your robot isn't answering", which is a miserable trail
                  to follow. Normalize as typed so the field can't hold a serial that won't work. */}
              <Input
                id="serial"
                value={serial}
                onChange={(e) => setSerial(e.target.value.toUpperCase())}
                placeholder="e.g. NORI-L0-1234"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pairCode">Pairing code</Label>
              {/* Proof of possession (backend migration 029): the code printed on the
                  robot's box. Required to claim a provisioned robot so knowing the
                  on-the-box serial alone can't grab someone else's robot. Normalized
                  server-side (case / separators don't matter), so we uppercase as typed
                  purely for legibility. Optional field for legacy un-provisioned units. */}
              <Input
                id="pairCode"
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                placeholder="e.g. ABC3-DEF4-XYZ5-MNTW"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Printed on your robot's box, next to the serial number.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nickname">Nickname (optional)</Label>
              {/* Friendly name for the robot, shown on the home card and editable later on
                  the robot's own kiosk. Backend caps it at 128 chars (PairRequest.nickname);
                  match that here so the field can't hold a value the server would reject. */}
              <Input
                id="nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="e.g. Kitchen bot"
                maxLength={128}
              />
              <p className="text-xs text-muted-foreground">
                What you'll call this robot around the app. You can change it later.
              </p>
            </div>
            {/* Nudged down so it lines up with the inputs rather than their labels;
                two of the fields carry helper text below, so aligning to the row's
                top or bottom both look wrong. */}
            <Button
              type="submit"
              disabled={submitting || !serial.trim()}
              className="md:mt-[1.65rem]"
            >
              {submitting ? "Pairing…" : "Pair robot"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Automatic discovery is coming soon. For now, find the serial on the sticker under
        your robot.
      </p>
    </section>
  );
};

export default Pairing;
