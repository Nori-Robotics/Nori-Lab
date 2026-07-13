// NORI: Additive file. Marketplace browse + install + details + rename (Phase 3+).
// Lists policies (GET /nori/marketplace/policies), filters by source client-side,
// installs = acquire (first-party) + download the runnable bundle to the local Nori
// cache. Install state now comes from the LOCAL cache (GET /nori/policies/local) so it
// survives refresh; a card opens a detail drawer (GET .../details) that shows provenance
// + file manifest and lets you rename (PATCH) or uninstall (DELETE) own policies.
// Visual language ported from NoriSkillHub: paper/ink outlines, sticker tints,
// display headlines, pill chips, bounce-hover cards.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { Pill } from "@/components/ui/pill";
import {
  acquirePolicy,
  deleteLocalPolicy,
  downloadPolicy,
  getPolicyDetails,
  listLocalPolicies,
  listPolicies,
  renamePolicy,
  type LocalPolicy,
  type PolicyDetails,
  type PolicyListEntry,
} from "@/nori/api/client";

type SourceFilter = "all" | "own" | "first_party" | "community";
const SOURCES: { key: SourceFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "own", label: "Own" },
  { key: "first_party", label: "First-party" },
  { key: "community", label: "Community" },
];

const SOURCE_TINT: Record<string, string> = {
  own: "bg-sticker",
  first_party: "bg-leaf",
  community: "bg-sticker-2",
  acquired: "bg-sticker-2",
};
const SOURCE_LABEL: Record<string, string> = {
  own: "own",
  first_party: "first-party",
  community: "community",
  acquired: "acquired",
};

type InstallState = { status: "idle" | "working" | "done" | "error"; message?: string };

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const SourceChip = ({ source }: { source: string }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink ${
      SOURCE_TINT[source] ?? "bg-paper-3"
    }`}
  >
    <span className="h-1.5 w-1.5 rounded-full bg-ink" aria-hidden />
    {SOURCE_LABEL[source] ?? source}
  </span>
);

const PolicyCard = ({
  policy,
  state,
  installed,
  onInstall,
  onOpen,
}: {
  policy: PolicyListEntry;
  state: InstallState;
  installed: boolean;
  onInstall: () => void;
  onOpen: () => void;
}) => (
  <div className="group flex h-full flex-col rounded-[24px] border border-border bg-background p-5 shadow-soft transition-[transform,box-shadow] duration-200 ease-bounce hover:-translate-y-1 hover:shadow-pop md:p-6">
    <div className="flex items-center justify-between gap-2">
      <SourceChip source={policy.source} />
      <div className="flex items-center gap-2">
        {installed && (
          <span className="inline-flex items-center rounded-full bg-leaf px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink">
            installed
          </span>
        )}
        {policy.policy_class && <span className="eyebrow">{policy.policy_class}</span>}
      </div>
    </div>

    <button type="button" onClick={onOpen} className="mt-4 text-left">
      <h3 className="font-display text-[1.6rem] font-normal leading-[1] tracking-tight underline-offset-4 group-hover:underline">
        {policy.title}
      </h3>
    </button>

    {policy.description && (
      <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground line-clamp-3">
        {policy.description}
      </p>
    )}

    <div className="mt-auto flex items-center justify-between gap-3 pt-5">
      <span className="font-mono text-[12px] text-muted-foreground">
        {new Date(policy.created_at).toLocaleDateString()}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="font-mono text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        details →
      </button>
    </div>

    <button
      type="button"
      onClick={onInstall}
      disabled={state.status === "working"}
      className="mt-4 flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-secondary px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-70"
    >
      <code
        className={`truncate font-mono text-[12px] ${
          state.status === "error" ? "text-destructive" : "text-foreground"
        }`}
      >
        {state.message ??
          (state.status === "working"
            ? "installing…"
            : installed
              ? `reinstall ${policy.title}`
              : `nori install ${policy.title}`)}
      </code>
      <span className="eyebrow shrink-0 text-foreground">
        {state.status === "working" ? "…" : installed ? "reinstall →" : "install →"}
      </span>
    </button>
  </div>
);

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2">
    <span className="eyebrow">{label}</span>
    <span className="text-right font-mono text-[12.5px] text-foreground">{value}</span>
  </div>
);

const DetailDrawer = ({
  details,
  onClose,
  onRenamed,
  onUninstalled,
  installed,
  baseUrl,
  fetcher,
}: {
  details: PolicyDetails;
  onClose: () => void;
  onRenamed: (d: PolicyDetails) => void;
  onUninstalled: () => void;
  installed: boolean;
  baseUrl: string;
  fetcher: ReturnType<typeof useApi>["fetchWithHeaders"];
}) => {
  const [title, setTitle] = useState(details.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const t = title.trim();
      const updated = await renamePolicy(baseUrl, fetcher, details.ref, t || null);
      onRenamed(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    setBusy(true);
    setErr(null);
    try {
      await deleteLocalPolicy(baseUrl, fetcher, details.ref);
      onUninstalled();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-background p-6 shadow-pop">
        <div className="flex items-center justify-between">
          <SourceChip source={details.source} />
          <button type="button" onClick={onClose} className="eyebrow hover:text-foreground">
            close ✕
          </button>
        </div>

        {details.editable ? (
          <div className="mt-5">
            <label className="eyebrow" htmlFor="policy-title">
              {"// name"}
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="policy-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                className="min-w-0 flex-1 rounded-xl border border-input bg-background px-3 py-2 font-display text-[1.3rem] leading-tight focus:outline-none focus:shadow-[0_0_0_3px_#ffe9a8]"
              />
              <button
                type="button"
                onClick={save}
                disabled={busy || title.trim() === details.title}
                className="shrink-0 rounded-xl border border-border bg-secondary px-3 py-2 font-mono text-[12px] hover:bg-accent disabled:opacity-50"
              >
                save
              </button>
            </div>
          </div>
        ) : (
          <h2 className="mt-5 font-display text-[1.9rem] font-normal leading-tight tracking-tight">
            {details.title}
          </h2>
        )}

        {details.description && (
          <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
            {details.description}
          </p>
        )}

        <div className="mt-6">
          <div className="eyebrow mb-1">{"// about"}</div>
          {details.policy_class && <DetailRow label="class" value={details.policy_class} />}
          {details.dataset_repo && <DetailRow label="dataset" value={details.dataset_repo} />}
          {details.final_cost_usd != null && (
            <DetailRow label="train cost" value={`$${details.final_cost_usd}`} />
          )}
          {details.timeout_seconds != null && (
            <DetailRow label="timeout" value={`${details.timeout_seconds}s`} />
          )}
          <DetailRow label="created" value={new Date(details.created_at).toLocaleString()} />
          <DetailRow label="price" value={details.price_usd != null ? `$${details.price_usd}` : "free"} />
        </div>

        <div className="mt-6">
          <div className="eyebrow mb-1">{"// files"}</div>
          {details.files.map((f) => (
            <div
              key={f.name}
              className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2"
            >
              <span className="font-mono text-[12.5px]">{f.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {f.size_bytes != null ? fmtBytes(f.size_bytes) : "—"}
              </span>
            </div>
          ))}
        </div>

        {err && <p className="mt-4 text-[13px] text-destructive">{err}</p>}

        {installed && (
          <button
            type="button"
            onClick={uninstall}
            disabled={busy}
            className="mt-6 w-full rounded-xl border border-destructive/40 bg-background px-3 py-2 font-mono text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            uninstall from this machine
          </button>
        )}
      </div>
    </div>
  );
};

const Marketplace = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [policies, setPolicies] = useState<PolicyListEntry[] | null>(null);
  const [local, setLocal] = useState<LocalPolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});
  const [openDetails, setOpenDetails] = useState<PolicyDetails | null>(null);

  const installedRefs = useMemo(() => new Set(local.map((p) => p.ref)), [local]);

  const refreshLocal = useCallback(async () => {
    try {
      setLocal(await listLocalPolicies(baseUrl, fetchWithHeaders));
    } catch {
      // Local cache listing is best-effort; a failure just hides the badges.
    }
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listPolicies(baseUrl, fetchWithHeaders);
        if (!cancelled) setPolicies(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    refreshLocal();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, refreshLocal]);

  const install = useCallback(
    async (policy: PolicyListEntry) => {
      setInstalls((s) => ({ ...s, [policy.ref]: { status: "working" } }));
      try {
        if (policy.source === "first_party" || policy.source === "community") {
          await acquirePolicy(baseUrl, fetchWithHeaders, policy.ref);
        }
        const res = await downloadPolicy(baseUrl, fetchWithHeaders, policy.ref);
        setInstalls((s) => ({
          ...s,
          [policy.ref]: { status: "done", message: `cached ${fmtBytes(res.size_bytes)} locally` },
        }));
        refreshLocal();
      } catch (e) {
        setInstalls((s) => ({
          ...s,
          [policy.ref]: { status: "error", message: e instanceof Error ? e.message : String(e) },
        }));
      }
    },
    [baseUrl, fetchWithHeaders, refreshLocal]
  );

  const openDrawer = useCallback(
    async (ref: string) => {
      try {
        setOpenDetails(await getPolicyDetails(baseUrl, fetchWithHeaders, ref));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [baseUrl, fetchWithHeaders]
  );

  const filtered = useMemo(() => {
    if (!policies) return [];
    const q = query.trim().toLowerCase();
    return policies.filter((p) => {
      if (source !== "all" && p.source !== source) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [policies, source, query]);

  return (
    <section>
      {/* HERO */}
      <div className="relative overflow-hidden rounded-[24px] border border-border bg-background px-5 py-8 md:px-8 md:py-10">
        <div className="dot-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div
          className="pointer-events-none absolute -left-16 -top-16 h-40 w-40 rounded-full bg-leaf opacity-70 blur-3xl"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -right-12 top-8 h-32 w-32 rounded-full bg-sticker opacity-60 blur-3xl"
          aria-hidden
        />
        <div className="relative">
          <div className="flex items-center justify-between">
            <span className="eyebrow">{"// skills community"}</span>
            <span className="inline-flex -rotate-3 animate-floaty items-center rounded-full bg-sticker px-3 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink shadow-soft">
              {"// beta"}
            </span>
          </div>
          <h1 className="mt-4 font-display text-balance text-[clamp(2rem,4.5vw,3rem)] leading-[0.95] tracking-tight">
            Teach once. Share forever.
          </h1>
          <p className="mt-3 max-w-2xl text-pretty text-[15px] leading-relaxed text-muted-foreground">
            Every policy you train, you can publish. Every policy someone else trains, you can
            install and run on your own robot.
          </p>
        </div>
      </div>

      {/* SEARCH */}
      <div className="relative mt-8">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search policies — pick, pour, fold…"
          aria-label="Search policies"
          className="block w-full rounded-full border border-input bg-background px-6 py-3 pl-12 font-mono text-[14px] text-foreground placeholder:text-muted-foreground transition-shadow focus:outline-none focus:shadow-[0_0_0_3px_#ffe9a8]"
        />
        <svg
          aria-hidden
          className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <circle cx={7} cy={7} r={4.5} />
          <path d="M10.5 10.5 L14 14" />
        </svg>
      </div>

      {/* SOURCE STRIP */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {SOURCES.map((s) => (
          <Pill key={s.key} active={source === s.key} onClick={() => setSource(s.key)}>
            {s.label}
          </Pill>
        ))}
      </div>

      {/* GRID / STATES */}
      {error ? (
        <div className="mt-10 rounded-[24px] border border-dashed border-border bg-secondary p-10 text-center">
          <div className="eyebrow">{"// error"}</div>
          <p className="mt-2 font-display text-[1.8rem] font-normal leading-tight">
            Couldn't reach the marketplace.
          </p>
          <p className="mt-2 text-[14px] text-destructive">{error}</p>
        </div>
      ) : policies === null ? (
        <div className="mt-10 rounded-[24px] border border-dashed border-border bg-secondary p-10 text-center">
          <div className="eyebrow">{"// loading"}</div>
          <p className="mt-2 font-display text-[1.8rem] font-normal leading-tight">Fetching skills…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-10 rounded-[24px] border border-dashed border-border bg-secondary p-10 text-center">
          <div className="eyebrow">{"// no match"}</div>
          <p className="mt-2 font-display text-[1.8rem] font-normal leading-tight">
            No policies matched. Teach us one?
          </p>
          <p className="mt-2 text-[14px] text-muted-foreground">
            Try a different word, or train and publish one yourself.
          </p>
        </div>
      ) : (
        <div key={`${source}-${query}`} className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p, i) => (
            <div
              key={p.ref}
              className="h-full animate-fade-in-up"
              style={{ animationDelay: `${Math.min(i * 60, 300)}ms` }}
            >
              <PolicyCard
                policy={p}
                state={installs[p.ref] ?? { status: "idle" }}
                installed={installedRefs.has(p.ref)}
                onInstall={() => install(p)}
                onOpen={() => openDrawer(p.ref)}
              />
            </div>
          ))}
        </div>
      )}

      <p className="eyebrow mt-10">
        {"// installed policies are cached locally and load into rollout on the robot"}
      </p>

      {openDetails && (
        <DetailDrawer
          details={openDetails}
          installed={installedRefs.has(openDetails.ref)}
          baseUrl={baseUrl}
          fetcher={fetchWithHeaders}
          onClose={() => setOpenDetails(null)}
          onRenamed={(d) => {
            setOpenDetails(d);
            // Reflect the new title in the catalog list without a full refetch.
            setPolicies((ps) =>
              ps ? ps.map((p) => (p.ref === d.ref ? { ...p, title: d.title } : p)) : ps
            );
          }}
          onUninstalled={() => {
            refreshLocal();
            setOpenDetails(null);
          }}
        />
      )}
    </section>
  );
};

export default Marketplace;
