// NORI: dedicated marketplace item page (replaces the old side drawer).
// Route: /nori/marketplace/:ref — renders a POLICY or a DATASET listing.
// A policy can be installed/renamed/uninstalled/published (own); a dataset is
// acquired and then trained on from the Training page. `kind` comes from the
// catalog list entry (the details endpoint doesn't carry it), so we fetch
// listPolicies to find the entry and fall back to mockDetailsFor on a 404.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi } from "@/contexts/ApiContext";
import { ApiError } from "@/lib/apiClient";
import {
  acquirePolicy,
  deleteLocalPolicy,
  downloadPolicy,
  getPolicyDetails,
  listLocalPolicies,
  listMyListings,
  listPolicies,
  renamePolicy,
  type MyListing,
  type PolicyDetails,
  type PolicyListEntry,
} from "@/nori/api/client";
import {
  DetailRow,
  PublishSection,
  SourceChip,
  fmtBytes,
  mockDetailsFor,
} from "./marketplace";

type Loaded = {
  details: PolicyDetails;
  entry: PolicyListEntry | null; // catalog entry (carries `kind`); null if not in catalog
};

const MarketplaceDetail = () => {
  const { ref: rawRef } = useParams<{ ref?: string }>();
  const ref = rawRef ? decodeURIComponent(rawRef) : "";
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installedRefs, setInstalledRefs] = useState<Set<string>>(new Set());
  const [myListings, setMyListings] = useState<MyListing[]>([]);

  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [acquired, setAcquired] = useState(false);

  const refreshLocal = useCallback(async () => {
    try {
      const local = await listLocalPolicies(baseUrl, fetchWithHeaders);
      setInstalledRefs(new Set(local.map((p) => p.ref)));
    } catch {
      /* best-effort */
    }
  }, [baseUrl, fetchWithHeaders]);

  const refreshMyListings = useCallback(async () => {
    try {
      setMyListings(await listMyListings(baseUrl, fetchWithHeaders));
    } catch {
      setMyListings([]);
    }
  }, [baseUrl, fetchWithHeaders]);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Catalog entry first — it's the only source of `kind` and the mock fallback.
      let entry: PolicyListEntry | null = null;
      try {
        const list = await listPolicies(baseUrl, fetchWithHeaders);
        entry = list.find((p) => p.ref === ref) ?? null;
      } catch {
        /* catalog fetch best-effort */
      }
      let details: PolicyDetails;
      try {
        details = await getPolicyDetails(baseUrl, fetchWithHeaders, ref);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && entry) {
          details = mockDetailsFor(entry); // preview until the details endpoint ships
        } else {
          throw e;
        }
      }
      setLoaded({ details, entry });
      setTitle(details.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, fetchWithHeaders, ref]);

  useEffect(() => {
    setLoaded(null);
    load();
    refreshLocal();
    refreshMyListings();
  }, [load, refreshLocal, refreshMyListings]);

  const isDataset =
    (loaded?.entry as (PolicyListEntry & { kind?: string }) | null | undefined)?.kind ===
    "dataset";
  const installed = loaded ? installedRefs.has(loaded.details.ref) : false;
  const myListing = useMemo(
    () => myListings.find((l) => l.source_job_id === ref) ?? null,
    [myListings, ref]
  );

  const back = (
    <button
      type="button"
      onClick={() => navigate("/nori/marketplace")}
      className="eyebrow hover:text-foreground"
    >
      ← marketplace
    </button>
  );

  if (error) {
    return (
      <section className="mx-auto max-w-3xl">
        {back}
        <div className="mt-6 rounded-[24px] border border-dashed border-border bg-secondary p-10 text-center">
          <div className="eyebrow">{"// not found"}</div>
          <p className="mt-2 font-display text-[1.8rem] font-normal leading-tight">
            Couldn't load this item.
          </p>
          <p className="mt-2 text-[14px] text-destructive">{error}</p>
        </div>
      </section>
    );
  }
  if (!loaded) {
    return (
      <section className="mx-auto max-w-3xl">
        {back}
        <div className="mt-6 rounded-[24px] border border-dashed border-border bg-secondary p-10 text-center">
          <div className="eyebrow">{"// loading"}</div>
          <p className="mt-2 font-display text-[1.8rem] font-normal leading-tight">Fetching…</p>
        </div>
      </section>
    );
  }

  const { details } = loaded;

  const rename = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      const updated = await renamePolicy(baseUrl, fetchWithHeaders, details.ref, title.trim() || null);
      setLoaded((prev) => (prev ? { ...prev, details: updated } : prev));
      setTitle(updated.title);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setBusy(true);
    setActionErr(null);
    setInstallMsg("installing…");
    try {
      if (details.source === "first_party" || details.source === "community") {
        await acquirePolicy(baseUrl, fetchWithHeaders, details.ref);
      }
      const res = await downloadPolicy(baseUrl, fetchWithHeaders, details.ref);
      setInstallMsg(`cached ${fmtBytes(res.size_bytes)} locally`);
      refreshLocal();
    } catch (e) {
      setInstallMsg(null);
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const acquireDataset = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      await acquirePolicy(baseUrl, fetchWithHeaders, details.ref); // kind-agnostic acquire
      setAcquired(true);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      await deleteLocalPolicy(baseUrl, fetchWithHeaders, details.ref);
      refreshLocal();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto max-w-3xl">
      {back}

      <div className="mt-4 flex items-center gap-2">
        <SourceChip source={details.source} />
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink ${
            isDataset ? "bg-leaf" : "bg-sticker"
          }`}
        >
          {isDataset ? "dataset" : "policy"}
        </span>
        {installed && (
          <span className="inline-flex items-center rounded-full bg-leaf px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink">
            installed
          </span>
        )}
      </div>

      {details.editable ? (
        <div className="mt-4">
          <label className="eyebrow" htmlFor="item-title">
            {"// name"}
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="item-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              className="min-w-0 flex-1 rounded-xl border border-input bg-background px-3 py-2 font-display text-[1.6rem] leading-tight focus:outline-none focus:shadow-[0_0_0_3px_#ffe9a8]"
            />
            <button
              type="button"
              onClick={rename}
              disabled={busy || title.trim() === details.title}
              className="shrink-0 rounded-xl border border-border bg-secondary px-3 py-2 font-mono text-[12px] hover:bg-accent disabled:opacity-50"
            >
              save
            </button>
          </div>
        </div>
      ) : (
        <h1 className="mt-4 font-display text-[clamp(2rem,4vw,2.8rem)] font-normal leading-[1] tracking-tight">
          {details.title}
        </h1>
      )}

      {details.description && (
        <p className="mt-4 whitespace-pre-line text-[15px] leading-relaxed text-muted-foreground">
          {details.description}
        </p>
      )}

      <div className="mt-8 grid gap-8 md:grid-cols-[1fr_1fr]">
        <div>
          <div className="eyebrow mb-1">{"// about"}</div>
          {details.policy_class && <DetailRow label="class" value={details.policy_class} />}
          {details.dataset_repo && (
            <DetailRow label={isDataset ? "repo" : "dataset"} value={details.dataset_repo} />
          )}
          {details.final_cost_usd != null && (
            <DetailRow label="train cost" value={`$${details.final_cost_usd}`} />
          )}
          {details.timeout_seconds != null && (
            <DetailRow label="timeout" value={`${details.timeout_seconds}s`} />
          )}
          <DetailRow label="created" value={new Date(details.created_at).toLocaleString()} />
          <DetailRow
            label="price"
            value={details.price_usd != null ? `$${details.price_usd}` : "free"}
          />
        </div>

        <div>
          <div className="eyebrow mb-1">{"// files"}</div>
          {details.files.map((f) => (
            <div
              key={f.name}
              className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2"
            >
              <span className="break-all font-mono text-[12.5px]">{f.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {f.size_bytes != null ? fmtBytes(f.size_bytes) : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ACTIONS */}
      <div className="mt-8">
        {isDataset ? (
          acquired ? (
            <div className="rounded-xl border border-border bg-secondary px-4 py-4">
              <p className="text-[14px] text-foreground">
                Added to your training datasets.
              </p>
              <Link
                to="/nori/training"
                className="mt-2 inline-flex rounded-xl border border-border bg-background px-3 py-2 font-mono text-[12px] hover:bg-accent"
              >
                train on this dataset →
              </Link>
            </div>
          ) : (
            <button
              type="button"
              onClick={acquireDataset}
              disabled={busy}
              className="w-full rounded-xl border border-border bg-secondary px-3 py-3 font-mono text-[13px] hover:bg-accent disabled:opacity-50"
            >
              {busy ? "acquiring…" : "acquire dataset — add to my training datasets →"}
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={install}
            disabled={busy}
            className="w-full rounded-xl border border-border bg-secondary px-3 py-3 font-mono text-[13px] hover:bg-accent disabled:opacity-50"
          >
            {installMsg ?? (installed ? `reinstall ${details.title}` : `nori install ${details.title}`)}
          </button>
        )}
      </div>

      {details.editable && (
        <PublishSection
          details={details}
          myListing={myListing}
          baseUrl={baseUrl}
          fetcher={fetchWithHeaders}
          onChanged={refreshMyListings}
        />
      )}

      {actionErr && <p className="mt-4 text-[13px] text-destructive">{actionErr}</p>}

      {installed && !isDataset && (
        <button
          type="button"
          onClick={uninstall}
          disabled={busy}
          className="mt-6 w-full rounded-xl border border-destructive/40 bg-background px-3 py-2 font-mono text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          uninstall from this machine
        </button>
      )}
    </section>
  );
};

export default MarketplaceDetail;
