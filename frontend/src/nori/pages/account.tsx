// NORI: Additive file. Account page stub (Phase 2).
// Phase 2 builds: GET /nori/customers/me -> show profile, billing tier, compute
// allowance, paired robot serial (or "not paired"); link to /nori/pairing.

const Account = () => (
  <section className="space-y-2">
    <h1 className="text-2xl font-bold">Account</h1>
    <p className="text-muted-foreground text-sm">
      Profile, billing tier, compute allowance, and pairing status land in Phase 2
      (GET /api/v1/customers/me via the LeLab proxy).
    </p>
  </section>
);

export default Account;
