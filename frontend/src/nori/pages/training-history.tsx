// NORI: Additive file. Training history page stub (Phase 6).
// Phase 6 builds: GET /training/jobs + {id}; per-job detail with ~2s logs polling
// (GET /training/jobs/{id}/logs?since=).

const TrainingHistory = () => (
  <section className="space-y-2">
    <h1 className="text-2xl font-bold">Training history</h1>
    <p className="text-muted-foreground text-sm">
      Job list + per-job logs polling lands in Phase 6 (GET /api/v1/training/jobs).
    </p>
  </section>
);

export default TrainingHistory;
