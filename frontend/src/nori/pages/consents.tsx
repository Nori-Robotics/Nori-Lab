// NORI: Additive file. Consent management page stub (Phase 6).
// Phase 6 builds: toggles for train_self / publish_public via POST /consents,
// /consents/{id}/revoke, GET /consents.

const Consents = () => (
  <section className="space-y-2">
    <h1 className="text-2xl font-bold">Consents</h1>
    <p className="text-muted-foreground text-sm">
      train_self / publish_public toggles land in Phase 6 (POST /api/v1/consents).
    </p>
  </section>
);

export default Consents;
