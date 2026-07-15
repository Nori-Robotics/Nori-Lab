// NORI: "Share a dataset" — publish one of your PROMOTED uploads to the
// community so others can train on it. Backend: POST
// /nori/marketplace/datasets/{session_id}/publish (auto-publishes after
// re-homing + the format gate; no manual review). Collapsible so it never
// competes with the browse grid.

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import {
  grantConsent,
  listMyDatasets,
  publishDataset,
} from "@/nori/api/client";

type Upload = { session_id: string; label: string };

const FIELD =
  "w-full rounded-xl border border-input bg-background px-3 py-2 text-[14px] focus:outline-none focus:shadow-[0_0_0_3px_#ffe9a8]";

const DatasetPublishCard = () => {
  const { baseUrl, fetchWithHeaders } = useApi();

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [needsConsent, setNeedsConsent] = useState(false);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listMyDatasets(baseUrl, fetchWithHeaders)
      .then((rows) =>
        setUploads(
          // Only the caller's OWN uploads are publishable — acquired community
          // datasets (source=community) are someone else's to publish.
          rows
            .filter((d) => d.source !== "community")
            .map((d) => ({ session_id: d.session_id, label: d.label }))
        )
      )
      .catch(() => setUploads([]));
  }, [baseUrl, fetchWithHeaders]);
  useEffect(() => refresh(), [refresh]);

  const pick = (sessionId: string) => {
    setSel(sessionId);
    setDone(null);
    setErr(null);
    const u = uploads.find((x) => x.session_id === sessionId);
    // Seed a public title from the upload label (drop the "Upload " prefix).
    if (u && !title.trim()) setTitle(u.label.replace(/^Upload\s+/, "Dataset "));
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (needsConsent && consented) {
        await grantConsent(baseUrl, fetchWithHeaders, "publish_public");
        setNeedsConsent(false);
      }
      const listing = await publishDataset(
        baseUrl,
        fetchWithHeaders,
        sel,
        title.trim(),
        desc.trim() || null
      );
      setDone(listing.title);
      setSel("");
      setTitle("");
      setDesc("");
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) {
        setNeedsConsent(true);
        setErr("Publishing needs the ‘share publicly’ consent — tick the box below and retry.");
      } else if (status === 409) {
        setErr("This dataset already has an active listing (or an account deletion is in flight).");
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 rounded-[24px] border border-border bg-background p-5 shadow-soft md:p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div>
          <div className="eyebrow">{"// share your data"}</div>
          <h3 className="mt-1 font-display text-[1.5rem] font-normal leading-tight tracking-tight">
            Publish a dataset to the community
          </h3>
        </div>
        <span className="eyebrow shrink-0 text-foreground">{open ? "close ✕" : "share →"}</span>
      </button>

      {open && (
        <div className="mt-5 space-y-3">
          {uploads.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">
              You have no promoted datasets yet. Record or upload a dataset first — it'll
              appear here to publish.
            </p>
          ) : (
            <>
              <div>
                <label className="eyebrow" htmlFor="ds-pick">
                  {"// dataset"}
                </label>
                <select
                  id="ds-pick"
                  value={sel}
                  onChange={(e) => pick(e.target.value)}
                  className={`mt-1 ${FIELD}`}
                >
                  <option value="">Choose one of your datasets…</option>
                  {uploads.map((u) => (
                    <option key={u.session_id} value={u.session_id}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>

              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                placeholder="Public title"
                className={FIELD}
              />
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="What's in this dataset? Task, robot, camera setup… (shown to others)"
                className={FIELD}
              />

              {needsConsent && (
                <label className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={consented}
                    onChange={(e) => setConsented(e.target.checked)}
                    className="mt-0.5"
                  />
                  I have the rights to this data and consent to publishing it publicly
                  (grants the ‘publish_public’ consent; revocable — revoking takes my
                  shared datasets down).
                </label>
              )}

              <button
                type="button"
                onClick={submit}
                disabled={busy || !sel || title.trim().length < 3 || (needsConsent && !consented)}
                className="w-full rounded-xl border border-border bg-secondary px-3 py-2 font-mono text-[12px] hover:bg-accent disabled:opacity-50"
              >
                {busy ? "publishing…" : "publish to community →"}
              </button>

              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                Your dataset is copied to a neutral repo, automatically safety-scanned
                (media/tabular only), and becomes public — no manual review. This is
                immediate and public.
              </p>
            </>
          )}

          {err && <p className="text-[12.5px] text-destructive">{err}</p>}
          {done && (
            <p className="text-[12.5px] text-foreground">
              Published “{done}” — it's being copied + scanned and will appear in Community
              shortly.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DatasetPublishCard;
