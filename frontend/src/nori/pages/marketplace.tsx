// NORI: Additive file. Marketplace page stub (Phase 3).
// Phase 3 builds: GET /marketplace/policies (?source=) -> policy cards; acquire +
// download to local cache. Robot push (rollout) is blocked on the Pi.

const Marketplace = () => (
  <section className="space-y-2">
    <h1 className="text-2xl font-bold">Marketplace</h1>
    <p className="text-muted-foreground text-sm">
      Browse + install policies lands in Phase 3 (GET /api/v1/marketplace/policies).
    </p>
  </section>
);

export default Marketplace;
