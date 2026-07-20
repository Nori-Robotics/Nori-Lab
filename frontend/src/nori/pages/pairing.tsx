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
import { useNori } from "@/nori/NoriContext";
import {
  listRobots,
  pairRobot,
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

const Pairing = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { customer, setCustomer, activeRobotSerial, setActiveRobotSerial } = useNori();

  const [robots, setRobots] = useState<PairedRobot[] | null>(null);
  const [serial, setSerial] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySerial, setBusySerial] = useState<string | null>(null);
  const [confirmSerial, setConfirmSerial] = useState<string | null>(null);

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
    try {
      const updated = await pairRobot(baseUrl, fetchWithHeaders, next, code || undefined);
      setCustomer(updated);
      setSerial("");
      setPairCode("");
      // First robot paired becomes active automatically.
      if (!robots || robots.length === 0) setActiveRobotSerial(next);
      await loadRobots();
    } catch (err) {
      // 403 = the pairing code is missing or wrong (proof-of-possession gate, backend
      // migration 029). Keep this distinct from the serial cases so we point the user
      // at the CODE, not the serial.
      if (err instanceof ApiError && err.status === 403) {
        setError(
          "That pairing code is missing or incorrect. Enter the code printed on your " +
            "robot's box to confirm it's yours."
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

  const paired = robots ?? [];
  const hasRobots = paired.length > 0;

  return (
    <section className="max-w-md space-y-4">
      <h1 className="text-3xl font-bold">{hasRobots ? "Your robots" : "Pair your robot"}</h1>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {hasRobots && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Paired robots{paired.length > 1 ? " — select which to connect" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {paired.map((r) => {
              const s = r.robot_serial_number;
              const active = s === activeRobotSerial;
              const confirming = confirmSerial === s;
              const busy = busySerial === s;
              return (
                <div
                  key={s}
                  className={`flex items-center gap-3 rounded-md border p-3 ${
                    active ? "border-primary" : "border-border"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm">{s}</div>
                    {r.nickname && (
                      <div className="truncate text-xs text-muted-foreground">{r.nickname}</div>
                    )}
                  </div>
                  {active ? (
                    <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      Connected
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onSelect(s)}
                      disabled={busy}
                    >
                      Connect
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
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmSerial(s)}
                    >
                      Unpair
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {hasRobots ? "Pair another robot" : "Enter serial number"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onPair} className="space-y-4">
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
            <Button type="submit" disabled={submitting || !serial.trim()}>
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
