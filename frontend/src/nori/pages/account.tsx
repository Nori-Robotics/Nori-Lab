// NORI: Additive file. Account page (Phase 2).
// Renders the provisioned customer profile from NoriContext (provisioned on sign-in via
// POST /customers/me/provision). Shows billing tier, compute allowance, and pairing state.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import Panel from "@/nori/components/Panel";
import { useNori } from "@/nori/NoriContext";
import { useApi } from "@/contexts/ApiContext";
import { signOut } from "@/nori/auth/session";
import ConsentsSection from "@/nori/components/ConsentsSection";
import { listRobots, type PairedRobot } from "@/nori/api/client";

function fmtSeconds(s: number): string {
  if (s <= 0) return "0m";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex justify-between gap-4 py-1.5 text-sm">
    <span className="text-[#5c564b]">{label}</span>
    <span className="text-right font-medium text-[#14131a]">{value}</span>
  </div>
);

const Account = () => {
  const { session, provisioning, customer, customerError, activeRobotSerial } = useNori();
  const { baseUrl, fetchWithHeaders } = useApi();
  const navigate = useNavigate();

  // Multi-robot: the profile's robot_serial_number only carries the ACTIVE robot, so ask
  // GET /customers/me/robots for the full list (same source as the Pairing page). Falls
  // back to the profile-derived single robot if the call fails.
  const [robots, setRobots] = useState<PairedRobot[] | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    listRobots(baseUrl, fetchWithHeaders)
      .then((list) => {
        if (!cancelled) setRobots(list);
      })
      .catch(() => {
        if (!cancelled) setRobots(null); // profile fallback below
      });
    return () => {
      cancelled = true;
    };
  }, [session, baseUrl, fetchWithHeaders]);

  if (!session) {
    return (
      <section className="space-y-3">
        <p className="text-sm text-muted-foreground">You are signed out.</p>
        <Button onClick={() => navigate("/nori/sign-in")}>Sign in</Button>
      </section>
    );
  }

  if (provisioning && !customer) {
    return <p className="text-sm text-muted-foreground">Loading your account…</p>;
  }

  if (customerError && !customer) {
    return <p className="text-sm text-destructive">{customerError}</p>;
  }

  if (!customer) return null;

  // Robots to render: the multi-robot list when it loaded, else the single active robot
  // from the profile (old behavior) so the panel still works if the list call fails.
  const paired: PairedRobot[] =
    robots ??
    (customer.is_paired && customer.robot_serial_number
      ? [{ robot_serial_number: customer.robot_serial_number, is_active: true }]
      : []);

  const handleSignOut = async () => {
    await signOut();
    navigate("/nori/sign-in", { replace: true });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Account</h1>
        <Button variant="outline" size="sm" onClick={handleSignOut}>
          Sign out
        </Button>
      </div>

      <Panel eyebrow="account" title="Profile" bodyClassName="divide-y divide-[#14131a]/10">
        <Row label="Email" value={customer.email ?? "—"} />
        <Row label="Billing tier" value={customer.billing_tier} />
        <Row label="Dataset repo" value={customer.hf_dataset_repo} />
      </Panel>

      <Panel eyebrow="account" title="Compute allowance" bodyClassName="divide-y divide-[#14131a]/10">
        <Row label="Allowed" value={fmtSeconds(customer.allowed_seconds)} />
        <Row label="Consumed" value={fmtSeconds(customer.consumed_seconds)} />
        <Row label="Remaining" value={fmtSeconds(customer.remaining_seconds)} />
      </Panel>

      <Panel eyebrow="account" title={paired.length > 1 ? "Robots" : "Robot"}>
        {paired.length > 0 ? (
          <div className="divide-y divide-[#14131a]/10">
            {paired.map((r) => {
              const s = r.robot_serial_number;
              const active = activeRobotSerial ? s === activeRobotSerial : r.is_active;
              return (
                <div key={s} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <span className="min-w-0 truncate font-mono text-[#14131a]">
                    {s}
                    {r.nickname ? (
                      <span className="ml-2 font-sans text-xs text-[#5c564b]">{r.nickname}</span>
                    ) : null}
                  </span>
                  {active && (
                    <span className="shrink-0 rounded bg-[#8ab135]/25 px-2 py-0.5 text-xs font-medium text-[#4d6a1e]">
                      Connected
                    </span>
                  )}
                </div>
              );
            })}
            <div className="flex justify-end pt-2">
              <Button size="sm" variant="outline" onClick={() => navigate("/nori/pairing")}>
                Manage robots
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-[#5c564b]">No robot paired yet</span>
            <Button size="sm" onClick={() => navigate("/nori/pairing")}
              className="rounded-md bg-[#d98b3d] text-foreground hover:bg-[#c97929]">
              Pair a robot
            </Button>
          </div>
        )}
      </Panel>

      <ConsentsSection />
    </section>
  );
};

export default Account;
