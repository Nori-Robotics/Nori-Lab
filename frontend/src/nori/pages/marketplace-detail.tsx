// NORI: dedicated marketplace item page (replaces the old side drawer).
// Route: /nori/marketplace/:ref — renders a POLICY or a DATASET listing.
// A policy can be installed/renamed/uninstalled/published (own); a dataset is
// acquired and then trained on from the Training page. `kind` comes from the
// catalog list entry (the details endpoint doesn't carry it), so we fetch
// listPolicies to find the entry (for kind); details come from the real endpoint only.

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
  unpublishPolicy,
  type MyListing,
  type PolicyDetails,
  type PolicyListEntry,
} from "@/nori/api/client";
import {
  DetailRow,
  ListingStatusChip,
  SourceChip,
  fmtBytes,
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
      // Always the REAL details endpoint — no synthesized/preview data. A 404
      // means the artifact is genuinely unavailable (e.g. erased under
      // right-to-erasure, or taken down); surface that honestly rather than
      // fabricating stats.
      const details: PolicyDetails = await getPolicyDetails(baseUrl, fetchWithHeaders, ref).catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          throw new Error("This policy's data is no longer available (it may have been erased or taken down).");
        }
        throw e;
      });
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
    loaded?.details.kind === "dataset" ||
    (loaded?.entry as (PolicyListEntry & { kind?: string }) | null | undefined)?.kind ===
      "dataset";
  const installed = loaded ? installedRefs.has(loaded.details.ref) : false;
  const withdrawListing = useCallback(async () => {
    if (!ref) return;
    setBusy(true);
    setActionErr(null);
    try {
      await unpublishPolicy(baseUrl, fetchWithHeaders, ref);
      await refreshMyListings();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [ref, baseUrl, fetchWithHeaders, refreshMyListings]);

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
          {isDataset && details.dataset_stats && (
            <>
              {details.dataset_stats.task && (
                <DetailRow label="task" value={details.dataset_stats.task} />
              )}
              {details.dataset_stats.robot_type && (
                <DetailRow label="robot" value={details.dataset_stats.robot_type} />
              )}
              {details.dataset_stats.total_episodes != null && (
                <DetailRow label="episodes" value={String(details.dataset_stats.total_episodes)} />
              )}
              {details.dataset_stats.total_frames != null && (
                <DetailRow label="frames" value={details.dataset_stats.total_frames.toLocaleString()} />
              )}
              {details.dataset_stats.fps != null && (
                <DetailRow label="fps" value={String(details.dataset_stats.fps)} />
              )}
            </>
          )}
          {details.policy_class && <DetailRow label="class" value={details.policy_class} />}
          {!isDataset && details.training_steps != null && (
            <DetailRow label="trained steps" value={details.training_steps.toLocaleString()} />
          )}
          {!isDataset && details.batch_size != null && (
            <DetailRow label="batch size" value={String(details.batch_size)} />
          )}
          {!isDataset && details.dataset_episode_count != null && (
            <DetailRow label="dataset episodes" value={String(details.dataset_episode_count)} />
          )}
          {!isDataset && details.dataset_frame_count != null && (
            <DetailRow label="dataset frames" value={details.dataset_frame_count.toLocaleString()} />
          )}
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

      {/* Community status (publishing itself moved to the marketplace page's
          "Publish something to the community" card — the single publish
          surface). Owners keep status visibility + instant withdraw here. */}
      {details.editable && myListing && (myListing.in_review || myListing.is_public) ? (
        <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/60 px-3 py-2">
          <span className="flex items-center gap-2 text-[13px]">
            <ListingStatusChip status={myListing.status} />
            <span className="text-muted-foreground">
              {myListing.is_public ? "live in the community" : "being copied + scanned"}
            </span>
          </span>
          <button
            type="button"
            onClick={withdrawListing}
            disabled={busy}
            className="shrink-0 rounded-xl border border-destructive/40 bg-background px-3 py-1.5 font-mono text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {myListing.is_public ? "unpublish (instant)" : "withdraw submission"}
          </button>
        </div>
      ) : details.editable && !isDataset ? (
        // Own policy that is NOT publicly listed. State this plainly so it's
        // clear the policy is PRIVATE and there is nothing to "unpublish" —
        // publishing is a deliberate action from the marketplace page.
        <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/40 px-3 py-2">
          <span className="text-[13px] text-muted-foreground">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/70">🔒 not published</span>{" "}
            — only you can see this policy; it was never shared to the community. Nothing to unpublish.
          </span>
          <Link
            to="/nori/marketplace"
            className="shrink-0 rounded-xl border border-border bg-background px-3 py-1.5 font-mono text-[12px] hover:bg-accent"
          >
            publish →
          </Link>
        </div>
      ) : null}

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
