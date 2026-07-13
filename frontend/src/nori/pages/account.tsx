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
import {
  getBillingSummary,
  listRobots,
  type BillingSummary,
  type PairedRobot,
} from "@/nori/api/client";

function fmtSeconds(s: number): string {
  if (s <= 0) return "0m";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const TIER_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro — $20/mo",
  developer: "Developer (contract)",
};

/** Thin usage bar: green under the soft line, amber near it, red at the cap. */
const UsageBar = ({ used, allowed }: { used: number; allowed: number }) => {
  const frac = allowed > 0 ? Math.min(1, used / allowed) : 0;
  const color = frac >= 1 ? "#c0392b" : frac >= 0.66 ? "#d98b3d" : "#8ab135";
  return (
    <div className="mt-1 h-1.5 w-full rounded bg-[#14131a]/10">
      <div
        className="h-1.5 rounded"
        style={{ width: `${Math.round(frac * 100)}%`, backgroundColor: color }}
      />
    </div>
  );
};

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

  // Billing summary (tier + monthly compute + agent tokens). Optional: when the
  // backend predates /billing/summary, fall back to the profile-derived
  // compute panel so the page keeps working against older deployments.
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    getBillingSummary(baseUrl, fetchWithHeaders)
      .then((b) => {
        if (!cancelled) setBilling(b);
      })
      .catch(() => {
        if (!cancelled) setBilling(null); // profile fallback below
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
        <Row
          label="Plan"
          value={TIER_LABELS[billing?.billing_tier ?? customer.billing_tier] ??
            (billing?.billing_tier ?? customer.billing_tier)}
        />
        <Row label="Dataset repo" value={customer.hf_dataset_repo} />
      </Panel>

      {billing ? (
        <Panel eyebrow="billing" title="Usage this month" bodyClassName="space-y-3">
          <div>
            <div className="flex justify-between gap-4 text-sm">
              <span className="text-[#5c564b]">Training compute</span>
              <span className="font-medium text-[#14131a]">
                {fmtSeconds(
                  billing.compute.consumed_seconds_this_month +
                    billing.compute.reserved_seconds_this_month
                )}{" "}
                / {fmtSeconds(billing.compute.allowed_seconds_per_month)}
              </span>
            </div>
            <UsageBar
              used={
                billing.compute.consumed_seconds_this_month +
                billing.compute.reserved_seconds_this_month
              }
              allowed={billing.compute.allowed_seconds_per_month}
            />
          </div>

          <div>
            <div className="flex justify-between gap-4 text-sm">
              <span className="text-[#5c564b]">Assistant tokens (today)</span>
              <span className="font-medium text-[#14131a]">
                {fmtTokens(billing.agent_tokens.used_today)} /{" "}
                {fmtTokens(billing.agent_tokens.allowed_today)}
              </span>
            </div>
            <UsageBar
              used={billing.agent_tokens.used_today}
              allowed={billing.agent_tokens.allowed_today}
            />
          </div>

          {billing.agent_tokens.used_this_month != null &&
            billing.agent_tokens.allowed_per_month != null && (
              <div>
                <div className="flex justify-between gap-4 text-sm">
                  <span className="text-[#5c564b]">Assistant tokens (this month)</span>
                  <span className="font-medium text-[#14131a]">
                    {fmtTokens(billing.agent_tokens.used_this_month)} /{" "}
                    {fmtTokens(billing.agent_tokens.allowed_per_month)}
                  </span>
                </div>
                <UsageBar
                  used={billing.agent_tokens.used_this_month}
                  allowed={billing.agent_tokens.allowed_per_month}
                />
              </div>
            )}

          {billing.agent_tokens.hard_capped && (
            <p className="text-xs font-medium text-[#c0392b]">
              Assistant budget exhausted — resets {billing.agent_tokens.used_this_month != null
                ? "daily and monthly (UTC)"
                : "at midnight UTC"}.
            </p>
          )}

          {billing.billing_tier === "free" && (
            <p className="pt-1 text-xs text-[#5c564b]">
              Free plan{billing.limits
                ? ` — training jobs up to ${Math.round(
                    billing.limits.max_job_timeout_seconds / 60
                  )} min, ${billing.limits.max_robots} robots`
                : ""}. Pro ($20/mo) with higher limits is coming soon.
            </p>
          )}
        </Panel>
      ) : (
        <Panel
          eyebrow="account"
          title="Compute allowance"
          bodyClassName="divide-y divide-[#14131a]/10"
        >
          <Row label="Allowed" value={fmtSeconds(customer.allowed_seconds)} />
          <Row label="Consumed" value={fmtSeconds(customer.consumed_seconds)} />
          <Row label="Remaining" value={fmtSeconds(customer.remaining_seconds)} />
        </Panel>
      )}

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
