// NORI: Additive file. Consent management + data deletion (Phase 6), rendered as a
// section at the bottom of the Account page (formerly its own /nori/consents page).
// Toggles for train_self / publish_public (POST /consents, /consents/{id}/revoke,
// GET /consents) plus a data-deletion request (POST /deletion-requests). The backend
// starts the erasure immediately (in-process kick + durable worker backstop); a
// `full` request deletes the account, so on success we sign the user out.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "@/contexts/ApiContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Panel from "@/nori/components/Panel";
import { signOut } from "@/nori/auth/session";
import {
  createDeletionRequest,
  grantConsent,
  listConsents,
  revokeConsent,
  type Consent,
  type ConsentType,
  type DeletionScope,
} from "@/nori/api/client";

// Full-account deletion is irreversible + immediate, so require the user to
// type this exact word to arm the confirm button.
const CONFIRM_WORD = "DELETE";

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

const ConsentsSection = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const navigate = useNavigate();
  const [consents, setConsents] = useState<Consent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ConsentType | null>(null);
  const [delScope, setDelScope] = useState<DeletionScope>("data_only");
  // Deletion flow: idle → confirming (armed panel) → submitting → done/error.
  const [delConfirming, setDelConfirming] = useState(false);
  const [delTyped, setDelTyped] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const [delDone, setDelDone] = useState<string | null>(null);

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

  // Switching scope resets the confirm flow (a full-delete confirmation must
  // not carry over to a data-only submission, or vice versa).
  const selectScope = (s: DeletionScope) => {
    setDelScope(s);
    setDelConfirming(false);
    setDelTyped("");
    setDelError(null);
    setDelDone(null);
  };

  const isFull = delScope === "full";
  // For a full-account delete the confirm button is armed only once the user
  // types the confirm word exactly; data-only needs no typed confirmation.
  const confirmArmed = !isFull || delTyped.trim() === CONFIRM_WORD;

  const submitDeletion = async () => {
    if (!confirmArmed) return;
    setDelBusy(true);
    setDelError(null);
    setDelDone(null);
    try {
      await createDeletionRequest(baseUrl, fetchWithHeaders, delScope);
      if (isFull) {
        // Immediate: the account is being erased. Sign out locally right away
        // (the backend also kills the auth user within seconds) and send them
        // to sign-in so no stale authed UI lingers.
        setDelDone("Account deletion started. Signing you out…");
        await signOut();
        navigate("/nori/sign-in", { replace: true });
        return;
      }
      // data_only: the account stays; just report it.
      setDelDone("Data-deletion request submitted. Your uploaded data and checkpoints are being erased.");
      setDelConfirming(false);
    } catch (e) {
      setDelError(e instanceof Error ? e.message : String(e));
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Consents</h2>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Panel eyebrow="consents" title="Data usage" bodyClassName="divide-y divide-nori-h14131a/10">
          {CONSENT_DEFS.map((def) => {
            const active = activeOf(def.type);
            return (
              <div key={def.type} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium text-nori-h14131a">{def.label}</p>
                  <p className="text-xs text-nori-h5c564b">{def.desc}</p>
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
      </Panel>

      <Panel eyebrow="consents" title="Delete my data" bodyClassName="space-y-3">
          <div className="flex gap-2">
            {(["data_only", "full"] as DeletionScope[]).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={delScope === s ? "default" : "outline"}
                onClick={() => selectScope(s)}
              >
                {s === "data_only" ? "Data only" : "Full account"}
              </Button>
            ))}
          </div>
          <p className="text-xs text-nori-h5c564b">
            {isFull
              ? "Permanently deletes your account, sign-in, robots, uploaded datasets, and trained checkpoints. This is immediate and cannot be undone."
              : "Permanently erases your uploaded datasets and trained checkpoints. Your account stays active. This cannot be undone."}
          </p>

          {!delConfirming ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={delBusy}
              onClick={() => {
                setDelConfirming(true);
                setDelTyped("");
                setDelError(null);
                setDelDone(null);
              }}
            >
              {isFull ? "Delete my account…" : "Delete my data…"}
            </Button>
          ) : (
            <div className="space-y-2 rounded-md border border-destructive/40 p-3">
              <p className="text-xs font-medium text-destructive">
                {isFull
                  ? `Type ${CONFIRM_WORD} to confirm permanent deletion of your account.`
                  : "Confirm you want to permanently erase your uploaded data."}
              </p>
              {isFull && (
                <Input
                  value={delTyped}
                  onChange={(e) => setDelTyped(e.target.value)}
                  placeholder={CONFIRM_WORD}
                  autoComplete="off"
                  aria-label="Type DELETE to confirm"
                  className="h-8 max-w-[12rem]"
                />
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={delBusy || !confirmArmed}
                  onClick={submitDeletion}
                >
                  {delBusy ? "Deleting…" : isFull ? "Permanently delete" : "Erase my data"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={delBusy}
                  onClick={() => {
                    setDelConfirming(false);
                    setDelTyped("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {delError && <p className="text-xs text-destructive">{delError}</p>}
          {delDone && <p className="text-xs text-nori-h857b6b">{delDone}</p>}
      </Panel>
    </div>
  );
};

export default ConsentsSection;
