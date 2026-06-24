// NORI: Additive file. Consent management + data deletion (Phase 6).
// Toggles for train_self / publish_public (POST /consents, /consents/{id}/revoke,
// GET /consents) plus a data-deletion request (POST /deletion-requests; backend purge
// sweeper not yet wired — records a status row only).

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createDeletionRequest,
  grantConsent,
  listConsents,
  revokeConsent,
  type Consent,
  type ConsentType,
  type DeletionScope,
} from "@/nori/api/client";

const CONSENT_DEFS: { type: ConsentType; label: string; desc: string }[] = [
  {
    type: "train_self",
    label: "Train on my data",
    desc: "Allow Nori to train policies from datasets you record.",
  },
  {
    type: "publish_public",
    label: "Publish publicly",
    desc: "Allow your contributed data to be shared in the public marketplace.",
  },
];

const Consents = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [consents, setConsents] = useState<Consent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ConsentType | null>(null);
  const [delScope, setDelScope] = useState<DeletionScope>("data_only");
  const [delStatus, setDelStatus] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setConsents(await listConsents(baseUrl, fetchWithHeaders));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Active (un-revoked) consent of a given type, if any.
  const activeOf = (type: ConsentType) =>
    consents?.find((c) => c.consent_type === type && !c.revoked_at);

  const toggle = async (type: ConsentType) => {
    setBusy(type);
    setError(null);
    try {
      const active = activeOf(type);
      if (active) {
        await revokeConsent(baseUrl, fetchWithHeaders, active.id);
      } else {
        await grantConsent(baseUrl, fetchWithHeaders, type);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const requestDeletion = async () => {
    setDelStatus(null);
    try {
      const res = await createDeletionRequest(baseUrl, fetchWithHeaders, delScope);
      setDelStatus(`Deletion request submitted (status: ${res.status}).`);
    } catch (e) {
      setDelStatus(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">Consents</h1>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data usage</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {CONSENT_DEFS.map((def) => {
            const active = activeOf(def.type);
            return (
              <div key={def.type} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium">{def.label}</p>
                  <p className="text-xs text-muted-foreground">{def.desc}</p>
                </div>
                <Button
                  size="sm"
                  variant={active ? "outline" : "default"}
                  disabled={busy === def.type || consents === null}
                  onClick={() => toggle(def.type)}
                >
                  {busy === def.type ? "…" : active ? "Revoke" : "Grant"}
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delete my data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            {(["data_only", "full"] as DeletionScope[]).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={delScope === s ? "default" : "outline"}
                onClick={() => setDelScope(s)}
              >
                {s === "data_only" ? "Data only" : "Full account"}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="destructive" onClick={requestDeletion}>
            Request deletion
          </Button>
          {delStatus && <p className="text-xs text-muted-foreground">{delStatus}</p>}
        </CardContent>
      </Card>
    </section>
  );
};

export default Consents;
