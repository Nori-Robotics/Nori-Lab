// NORI: Additive file. Account page (Phase 2).
// Renders the provisioned customer profile from NoriContext (provisioned on sign-in via
// POST /customers/me/provision). Shows billing tier, compute allowance, and pairing state.

import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import Panel from "@/nori/components/Panel";
import { useNori } from "@/nori/NoriContext";
import { signOut } from "@/nori/auth/session";
import ConsentsSection from "@/nori/components/ConsentsSection";

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
  const { session, provisioning, customer, customerError } = useNori();
  const navigate = useNavigate();

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

      <Panel eyebrow="account" title="Robot">
        {customer.is_paired ? (
          <Row label="Paired serial" value={customer.robot_serial_number} />
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
