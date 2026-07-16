// NORI: Additive file. Marketplace browse + install + details + rename (Phase 3+).
// Lists policies (GET /nori/marketplace/policies), filters by source client-side,
// installs = acquire (first-party) + download the runnable bundle to the local Nori
// cache. Install state now comes from the LOCAL cache (GET /nori/policies/local) so it
// survives refresh; a card navigates to a dedicated detail page
// (/nori/marketplace/:ref, marketplace-detail.tsx) that shows provenance + file
// manifest and lets you rename (PATCH) or uninstall (DELETE) own policies, or
// acquire a dataset to train on.
// Visual language ported from NoriSkillHub: paper/ink outlines, sticker tints,
// display headlines, pill chips, bounce-hover cards.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { Pill } from "@/components/ui/pill";
import {
  acquirePolicy,
  downloadPolicy,
  listLocalPolicies,
  listMyListings,
  listPolicies,
  type LocalPolicy,
  type MyListing,
  type PolicyDetails,
  type PolicyListEntry,
} from "@/nori/api/client";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import {
  PolicyRunner,
  EXECUTION_PRESETS,
  EXECUTION_MODE_LABELS,
  type PolicyRunPhase,
  type ExecutionMode,
} from "@/nori/remote/policyRun";
import CommunityPublishCard from "@/nori/components/marketplace/CommunityPublishCard";

/**
 * PREVIEW-ONLY stand-in for GET .../details while the backend endpoint is
 * unreleased (it lands with the marketplace-details branch + migration 014).
 * Values are plausible placeholders modeled on a real promoted bundle; the
 * description carries an explicit preview-data banner so nobody mistakes
 * them for real stats. Delete once the endpoint is deployed everywhere.
 */
export function mockDetailsFor(p: PolicyListEntry): PolicyDetails {
  const withRepo = p as PolicyListEntry & { dataset_repo?: string | null; kind?: string };
  const isDataset = withRepo.kind === "dataset";
  return {
    ref: p.ref,
    source: p.source,
    title: p.title,
    is_renamed: false,
    description:
      `${p.description ?? ""}\n\n` +
      (isDataset
        ? "⚠ preview data — the dataset-details endpoint isn't deployed yet; the " +
          "file list below is a placeholder for the LeRobot layout (meta/data/videos)."
        : "⚠ preview data — the policy-details endpoint isn't deployed yet; " +
          "the file list and stats below are placeholders."),
    policy_class: isDataset ? null : (p.policy_class ?? "act"),
    price_usd: p.price_usd ?? null,
    created_at: p.created_at,
    dataset_repo: isDataset
      ? "NoriRobotics/community-datasets"
      : withRepo.dataset_repo ?? (p.source === "own" ? "NoriRobotics/customer-preview" : null),
    promoted_at: p.created_at,
    final_cost_usd: !isDataset && p.source === "own" ? 0.0751 : null,
    timeout_seconds: !isDataset && p.source === "own" ? 900 : null,
    editable: !isDataset && p.source === "own",
    files: isDataset
      ? [
          { name: "meta/info.json", size_bytes: 1024, sha256: null },
          { name: "meta/episodes.jsonl", size_bytes: 4096, sha256: null },
          { name: "data/chunk-000/episode_000000.parquet", size_bytes: 5242880, sha256: null },
          { name: "videos/chunk-000/observation.images.cam/episode_000000.mp4", size_bytes: 12582912, sha256: null },
        ]
      : [
          {
            name: "model.safetensors",
            size_bytes: 206766560,
            sha256: "42772891cb6eba1e7bc36ad8e12c0fa0723c61f036fa235c725ce6026e6e81df",
          },
          {
            name: "config.json",
            size_bytes: 198,
            sha256: "d2ef3c412258b5daf89205d2a651e53c2631ce3adea78cd2d08df698cc58334c",
          },
          { name: "policy_preprocessor.safetensors", size_bytes: 1184, sha256: null },
          { name: "policy_postprocessor.safetensors", size_bytes: 1088, sha256: null },
        ],
  };
}

type SourceFilter = "all" | "own" | "first_party" | "community";
// Own policies do NOT browse in the marketplace — they live in My Stuff
// (a private policy is never public, so the marketplace, which is the
// get-things-from-others surface, must not list it). Own policies stay
// reachable by direct ref (detail page) and via the publish card below.
const SOURCES: { key: SourceFilter; label: string }[] = [
  { key: "all", label: "All" },
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

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export const SourceChip = ({ source }: { source: string }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink ${
      SOURCE_TINT[source] ?? "bg-paper-3"
    }`}
  >
    <span className="h-1.5 w-1.5 rounded-full bg-ink" aria-hidden />
    {SOURCE_LABEL[source] ?? source}
  </span>
);

/** The "run on the connected robot" affordance. The policy executes in the
 * LOCAL lelab process (lelab/nori_rollout.py); only {type:"control", action}
 * frames reach the robot. null = no live robot session; row not rendered. */
type RobotAction = {
  label: string;
  busy: boolean;
  error: boolean;
  onClick: () => void;
};

const PolicyCard = ({
  policy,
  state,
  installed,
  listingStatus,
  robotAction,
  onInstall,
  onOpen,
}: {
  policy: PolicyListEntry;
  state: InstallState;
  installed: boolean;
  /** Latest community-submission state for OWN policies (in review / public /
   * rejected / taken down) — at-a-glance sharing status on the card. A
   * "public" chip means the policy is live in other customers' Community tab
   * (own listings are deliberately not shown in the owner's own catalog). */
  listingStatus?: string | null;
  robotAction?: RobotAction | null;
  onInstall: () => void;
  onOpen: () => void;
}) => {
  // Datasets and policies share the grid but render differently: a dataset is
  // acquired + trained on, not installed onto a robot.
  const isDataset = (policy as PolicyListEntry & { kind?: string }).kind === "dataset";
  return (
  <div className="group flex h-full flex-col rounded-[24px] border border-border bg-background p-5 shadow-soft transition-[transform,box-shadow] duration-200 ease-bounce hover:-translate-y-1 hover:shadow-pop md:p-6">
    <div className="flex items-center justify-between gap-2">
      <SourceChip source={policy.source} />
      <div className="flex items-center gap-2">
        {policy.source === "own" && !isDataset && (
          listingStatus === "public" || listingStatus === "pending_review" ? (
            <ListingStatusChip status={listingStatus} />
          ) : (
            // Own policy that is NOT publicly listed → private to you.
            // Says plainly it's not shared, so no one hunts for an
            // "unpublish" on something that was never published.
            <span
              className="inline-flex items-center rounded-full bg-paper-3 px-2.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink/70"
              title="Only you can see this. Publish it from “Publish something to the community.”"
            >
              private
            </span>
          )
        )}
        {policy.source !== "own" && listingStatus && listingStatus !== "taken_down" && (
          <ListingStatusChip status={listingStatus} />
        )}
        {installed && (
          <span className="inline-flex items-center rounded-full bg-leaf px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink">
            installed
          </span>
        )}
        {isDataset ? (
          <span className="inline-flex items-center rounded-full bg-leaf px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink">
            dataset
          </span>
        ) : (
          policy.policy_class && <span className="eyebrow">{policy.policy_class}</span>
        )}
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

    {isDataset ? (
    <button
      type="button"
      onClick={onOpen}
      className="mt-4 flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-secondary px-3 py-2 text-left transition-colors hover:bg-accent"
    >
      <code className="truncate font-mono text-[12px] text-foreground">
        view dataset · {policy.title}
      </code>
      <span className="eyebrow shrink-0 text-foreground">open →</span>
    </button>
    ) : (
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
    )}

    {!isDataset && robotAction && (
      <button
        type="button"
        onClick={robotAction.onClick}
        disabled={robotAction.busy}
        className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-70"
      >
        <code
          className={`truncate font-mono text-[12px] ${
            robotAction.error ? "text-destructive" : "text-foreground"
          }`}
        >
          {robotAction.label}
        </code>
        <span className="eyebrow shrink-0 text-foreground" aria-hidden>
          {robotAction.busy ? "…" : "▶ robot"}
        </span>
      </button>
    )}
  </div>
  );
};

export const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2">
    <span className="eyebrow">{label}</span>
    <span className="text-right font-mono text-[12.5px] text-foreground">{value}</span>
  </div>
);

const LISTING_STATUS_TINT: Record<string, string> = {
  pending_review: "bg-[#d98b3d]/25 text-[#8a5620]",
  public: "bg-leaf text-ink",
  rejected: "bg-destructive/15 text-destructive",
  taken_down: "bg-paper-3 text-muted-foreground",
};
const LISTING_STATUS_LABEL: Record<string, string> = {
  pending_review: "in review",
  public: "public",
  rejected: "rejected",
  taken_down: "taken down",
};

export const ListingStatusChip = ({ status }: { status: string }) => (
  <span
    className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] ${
      LISTING_STATUS_TINT[status] ?? "bg-paper-3"
    }`}
  >
    {LISTING_STATUS_LABEL[status] ?? status}
  </span>
);


/** Robot execution mode — shown only while a live robot session is active
 * (same gate as the run-on-robot buttons). Sets how a policy drives the arm
 * (temporal ensembling vs open-loop chunk horizon); applies to the next run.
 * Inference-only — no effect on training. */
const ExecutionModeBar = ({
  mode,
  onMode,
}: {
  mode: ExecutionMode;
  onMode: (m: ExecutionMode) => void;
}) => (
  <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[20px] border border-border bg-background px-4 py-3 shadow-soft">
    <span className="eyebrow shrink-0">{"// robot execution"}</span>
    <div className="flex flex-wrap items-center gap-1.5">
      {(Object.keys(EXECUTION_PRESETS) as ExecutionMode[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onMode(m)}
          title={EXECUTION_MODE_LABELS[m].hint}
          className={`rounded-full px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${
            mode === m ? "bg-sticker text-ink" : "bg-paper-3 text-muted-foreground hover:text-foreground"
          }`}
        >
          {EXECUTION_MODE_LABELS[m].label}
        </button>
      ))}
    </div>
    <span className="min-w-0 flex-1 text-[12px] leading-snug text-muted-foreground">
      {EXECUTION_MODE_LABELS[mode].hint}
    </span>
  </div>
);

const Marketplace = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [policies, setPolicies] = useState<PolicyListEntry[] | null>(null);
  const [local, setLocal] = useState<LocalPolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});
  const [myListings, setMyListings] = useState<MyListing[]>([]);
  // How a policy drives the robot (inference-only; never affects training).
  // Read through a ref in runOnRobot so changing it doesn't churn the callback.
  const [execMode, setExecMode] = useState<ExecutionMode>("smooth");
  const execModeRef = useRef(execMode);
  useEffect(() => {
    execModeRef.current = execMode;
  }, [execMode]);

  const installedRefs = useMemo(() => new Set(local.map((p) => p.ref)), [local]);

  // Newest submission per source job — what the drawer's share section shows.
  // Best-effort (older backends without the endpoint just hide the feature).
  const myListingByJob = useMemo(() => {
    const m: Record<string, MyListing> = {};
    for (const l of [...myListings].reverse()) {
      if (l.source_job_id) m[l.source_job_id] = l;
    }
    return m;
  }, [myListings]);

  const refreshMyListings = useCallback(async () => {
    try {
      setMyListings(await listMyListings(baseUrl, fetchWithHeaders));
    } catch {
      setMyListings([]);
    }
  }, [baseUrl, fetchWithHeaders]);

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
    refreshMyListings();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, refreshLocal, refreshMyListings]);

  // Live robot session (survives navigation): drives the "run on robot" row
  // on every card. ARCHITECTURE (full_nori_plan §Robot push): the policy runs
  // in the LOCAL lelab process; the robot only ever receives standard
  // {type:"control", action} frames. Nothing is sent to or executed on the
  // Pi — the previous delivery-grant install-onto-the-robot flow is removed.
  const { teleop, running, tel } = useTeleopSession();
  const telRef = useRef(tel);
  useEffect(() => {
    telRef.current = tel;
  }, [tel]);

  const runnerRef = useRef<PolicyRunner | null>(null);
  const [runState, setRunState] = useState<{ ref: string | null; phase: PolicyRunPhase }>({
    ref: null,
    phase: { kind: "idle" },
  });

  // Leaving the page stops the policy: the robot must never keep moving
  // under a controller whose UI (and stop button) is no longer on screen.
  useEffect(
    () => () => {
      void runnerRef.current?.stop("left the marketplace page");
    },
    []
  );

  const runOnRobot = useCallback(
    async (policy: PolicyListEntry) => {
      if (!teleop) return;
      if (!runnerRef.current) {
        runnerRef.current = new PolicyRunner(baseUrl, () => telRef.current);
      }
      const runner = runnerRef.current;
      runner.onPhase = (phase) => setRunState({ ref: policy.ref, phase });
      try {
        await runner.start(teleop, policy.ref, EXECUTION_PRESETS[execModeRef.current]);
      } catch (e) {
        // The run-button label truncates the message; surface the FULL rollout
        // error in a toast (wraps + persists until dismissed) so long details
        // like the joint/camera-mismatch text are fully readable and copyable.
        toast({
          title: "Couldn't run on robot",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
      }
    },
    [baseUrl, teleop, toast]
  );

  const stopRun = useCallback(() => {
    void runnerRef.current?.stop();
  }, []);

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

  const robotActionFor = useCallback(
    (policy: PolicyListEntry): RobotAction | null => {
      if (!running || !teleop) return null;
      const mine = runState.ref === policy.ref ? runState.phase : null;
      if (mine?.kind === "loading") {
        return { label: "loading policy…", busy: true, error: false, onClick: () => {} };
      }
      if (mine?.kind === "running") {
        return { label: `driving the robot — stop`, busy: false, error: false, onClick: stopRun };
      }
      if (mine?.kind === "error") {
        return { label: `${mine.message} — retry`, busy: false, error: true, onClick: () => runOnRobot(policy) };
      }
      if (mine?.kind === "stopped") {
        return { label: `stopped (${mine.reason}) — run again`, busy: false, error: false, onClick: () => runOnRobot(policy) };
      }
      if (runState.phase.kind === "running" || runState.phase.kind === "loading") {
        return { label: "another policy is driving", busy: true, error: false, onClick: () => {} };
      }
      const installedLocally = local.some((l) => l.ref === policy.ref && l.runnable);
      if (!installedLocally) {
        return { label: "install first, then run from here", busy: false, error: false, onClick: () => install(policy) };
      }
      return { label: "run on robot (policy runs here)", busy: false, error: false, onClick: () => runOnRobot(policy) };
    },
    [running, teleop, runState, stopRun, runOnRobot, local, install]
  );


  // NOTE: the backend catalog intentionally excludes the caller's OWN
  // community listings from their public view — owners track theirs via
  // /my-listings and the status chip on their Own card (a "public" chip means
  // it's live in everyone else's Community tab). Decision 2026-07-13: keep
  // that exclusion in the UI too, rather than double-listing own policies.
  const filtered = useMemo(() => {
    if (!policies) return [];
    const q = query.trim().toLowerCase();
    return policies.filter((p) => {
      // Own policies never appear in the marketplace grid — private ones
      // would leak a "published" impression, and all own policies are
      // managed + run from My Stuff instead.
      if (p.source === "own") return false;
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

      {/* PUBLISH (policy or dataset — the single publish surface) */}
      <CommunityPublishCard />

      {/* ROBOT EXECUTION MODE — only while a live session can run policies */}
      {running && teleop && <ExecutionModeBar mode={execMode} onMode={setExecMode} />}

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
                listingStatus={p.source === "own" ? myListingByJob[p.ref]?.status : null}
                robotAction={robotActionFor(p)}
                onInstall={() => install(p)}
                onOpen={() => navigate(`/nori/marketplace/${encodeURIComponent(p.ref)}`)}
              />
            </div>
          ))}
        </div>
      )}

      <p className="eyebrow mt-10">
        {"// installed policies are cached locally and load into rollout on the robot"}
      </p>

    </section>
  );
};

export default Marketplace;
