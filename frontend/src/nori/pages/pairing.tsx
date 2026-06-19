// NORI: Additive file. Pairing page stub (Phase 6, manual serial entry).
// Phase 6 builds: manual serial text input -> POST /customers/me/pair. The mDNS/QR
// discovery path is blocked on the Pi daemon's presence advertisement.

const Pairing = () => (
  <section className="space-y-2">
    <h1 className="text-2xl font-bold">Pair your robot</h1>
    <p className="text-muted-foreground text-sm">
      Manual serial entry lands in Phase 6 (POST /api/v1/customers/me/pair). mDNS/QR
      discovery is blocked on the Pi.
    </p>
  </section>
);

export default Pairing;
