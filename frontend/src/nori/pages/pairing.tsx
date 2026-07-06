// NORI: Additive file. Pairing page (Phase 6, manual serial entry).
// Manual serial → POST /nori/customers/me/pair. mDNS/QR discovery is blocked on the Pi
// daemon's presence advertisement.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "@/contexts/ApiContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNori } from "@/nori/NoriContext";
import { pairRobot } from "@/nori/api/client";

const Pairing = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { customer, setCustomer } = useNori();
  const navigate = useNavigate();
  const [serial, setSerial] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (customer?.is_paired) {
    return (
      <section className="space-y-3">
        <h1 className="text-3xl font-bold">Robot paired</h1>
        <p className="text-sm text-muted-foreground">
          Paired to <span className="font-mono">{customer.robot_serial_number}</span>.
        </p>
      </section>
    );
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const updated = await pairRobot(baseUrl, fetchWithHeaders, serial.trim());
      setCustomer(updated);
      navigate("/nori/account");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="max-w-md space-y-4">
      <h1 className="text-3xl font-bold">Pair your robot</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enter serial number</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="serial">Robot serial number</Label>
              <Input
                id="serial"
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                placeholder="e.g. XLR-2W-000123"
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting || !serial.trim()}>
              {submitting ? "Pairing…" : "Pair robot"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Automatic discovery (mDNS / QR) arrives once the robot daemon ships. For now, find
        the serial on the sticker under your robot.
      </p>
    </section>
  );
};

export default Pairing;
