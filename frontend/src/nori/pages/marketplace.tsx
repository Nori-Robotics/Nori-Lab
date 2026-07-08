// NORI: Additive file. Marketplace browse + install (Phase 3).
// Lists policies (GET /nori/marketplace/policies), filters by source client-side, and
// installs = acquire (first-party) + download bytes to the local Nori cache. Running a
// downloaded policy against the robot (rollout) is blocked on the Pi.
// Visual language ported from NoriSkillHub: paper/ink outlines, sticker tints,
// display headlines, pill chips, bounce-hover cards.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { Pill } from "@/components/ui/pill";
import {
  acquirePolicy,
  downloadPolicy,
  listPolicies,
  type PolicyListEntry,
} from "@/nori/api/client";

type SourceFilter = "all" | "own" | "first_party" | "community";
const SOURCES: { key: SourceFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "own", label: "Own" },
  { key: "first_party", label: "First-party" },
  { key: "community", label: "Community" },
];

// Tint map mirrors the Skill Hub's CATEGORY_TINT — light sticker tokens with
// ink text/borders so the chips read the same in both app themes.
const SOURCE_TINT: Record<string, string> = {
  own: "bg-sticker",
  first_party: "bg-leaf",
  community: "bg-sticker-2",
};
const SOURCE_LABEL: Record<string, string> = {
  own: "own",
  first_party: "first-party",
  community: "community",
};

type InstallState = { status: "idle" | "working" | "done" | "error"; message?: string };

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
  onInstall,
}: {
  policy: PolicyListEntry;
  state: InstallState;
  onInstall: () => void;
}) => (
  <div className="group flex h-full flex-col rounded-[24px] border border-border bg-background p-5 shadow-soft transition-[transform,box-shadow] duration-200 ease-bounce hover:-translate-y-1 hover:shadow-pop md:p-6">
    <div className="flex items-center justify-between gap-2">
      <SourceChip source={policy.source} />
      {policy.policy_class && <span className="eyebrow">{policy.policy_class}</span>}
    </div>

    <h3 className="mt-4 font-display text-[1.6rem] font-normal leading-[1] tracking-tight">
      {policy.title}
    </h3>

    {policy.description && (
      <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground line-clamp-3">
        {policy.description}
      </p>
    )}

    <div className="mt-auto flex items-center justify-between gap-3 pt-5">
      <span className="font-mono text-[12px] text-muted-foreground">
        {new Date(policy.created_at).toLocaleDateString()}
      </span>
      <span className="font-mono text-[12px]">
        {policy.price_usd != null ? `$${policy.price_usd}` : "free"}
      </span>
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
          (state.status === "working" ? "installing…" : `nori install ${policy.title}`)}
      </code>
      <span className="eyebrow shrink-0 text-foreground">
        {state.status === "working"
          ? "…"
          : state.status === "done"
            ? "reinstall →"
            : "install →"}
      </span>
    </button>
  </div>
);

const Marketplace = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [policies, setPolicies] = useState<PolicyListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});

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
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders]);

  const install = useCallback(
    async (policy: PolicyListEntry) => {
      setInstalls((s) => ({ ...s, [policy.ref]: { status: "working" } }));
      try {
        // First-party listings need an acquire step before download; own-trained don't.
        if (policy.source === "first_party") {
          await acquirePolicy(baseUrl, fetchWithHeaders, policy.ref);
        }
        const res = await downloadPolicy(baseUrl, fetchWithHeaders, policy.ref);
        const kb = Math.max(1, Math.round(res.size_bytes / 1024));
        setInstalls((s) => ({
          ...s,
          [policy.ref]: { status: "done", message: `cached ${kb} KB locally` },
        }));
      } catch (e) {
        setInstalls((s) => ({
          ...s,
          [policy.ref]: {
            status: "error",
            message: e instanceof Error ? e.message : String(e),
          },
        }));
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
        p.title.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [policies, source, query]);

  return (
    <section>
      {/* HERO — dot-grid wash, blob tints, display headline, sticker badge */}
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
            Every policy you train, you can publish. Every policy someone else trains, you
            can install and run on your own robot.
          </p>
        </div>
      </div>

      {/* SEARCH — pill input with custard focus ring */}
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

      {/* SOURCE STRIP — pill filters, active = ink-filled */}
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
          <p className="mt-2 font-display text-[1.8rem] font-normal leading-tight">
            Fetching skills…
          </p>
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
                onInstall={() => install(p)}
              />
            </div>
          ))}
        </div>
      )}

      <p className="eyebrow mt-10">
        {"// installed policies are cached locally — running one on the robot ships with robot connectivity"}
      </p>
    </section>
  );
};

export default Marketplace;
