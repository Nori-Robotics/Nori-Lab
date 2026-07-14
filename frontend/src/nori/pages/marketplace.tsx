// NORI: Additive file. Marketplace browse + install + details + rename (Phase 3+).
// Lists policies (GET /nori/marketplace/policies), filters by source client-side,
// installs = acquire (first-party) + download the runnable bundle to the local Nori
// cache. Install state now comes from the LOCAL cache (GET /nori/policies/local) so it
// survives refresh; a card opens a detail drawer (GET .../details) that shows provenance
// + file manifest and lets you rename (PATCH) or uninstall (DELETE) own policies.
// Visual language ported from NoriSkillHub: paper/ink outlines, sticker tints,
// display headlines, pill chips, bounce-hover cards.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { ApiError } from "@/lib/apiClient";
import { Pill } from "@/components/ui/pill";
import {
  acquirePolicy,
  deleteLocalPolicy,
  downloadPolicy,
  getPolicyDetails,
  grantConsent,
  listLocalPolicies,
  listMyListings,
  listPolicies,
  publishPolicy,
  renamePolicy,
  unpublishPolicy,
  type LocalPolicy,
  type MyListing,
  type PolicyDetails,
  type PolicyListEntry,
} from "@/nori/api/client";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { PolicyRunner, type PolicyRunPhase } from "@/nori/remote/policyRun";

/**
 * PREVIEW-ONLY stand-in for GET .../details while the backend endpoint is
 * unreleased (it lands with the marketplace-details branch + migration 014).
 * Values are plausible placeholders modeled on a real promoted bundle; the
 * description carries an explicit preview-data banner so nobody mistakes
 * them for real stats. Delete once the endpoint is deployed everywhere.
 */
function mockDetailsFor(p: PolicyListEntry): PolicyDetails {
  const withRepo = p as PolicyListEntry & { dataset_repo?: string | null };
  return {
    ref: p.ref,
    source: p.source,
    title: p.title,
    is_renamed: false,
    description:
      `${p.description ?? ""}\n\n` +
      "⚠ preview data — the policy-details endpoint isn't deployed yet; " +
      "the file list and stats below are placeholders.",
    policy_class: p.policy_class ?? "act",
    price_usd: p.price_usd ?? null,
    created_at: p.created_at,
    dataset_repo: withRepo.dataset_repo ?? (p.source === "own" ? "NoriRobotics/customer-preview" : null),
    promoted_at: p.created_at,
    final_cost_usd: p.source === "own" ? 0.0751 : null,
    timeout_seconds: p.source === "own" ? 900 : null,
    editable: p.source === "own",
    files: [
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
}) => (
  <div className="group flex h-full flex-col rounded-[24px] border border-border bg-background p-5 shadow-soft transition-[transform,box-shadow] duration-200 ease-bounce hover:-translate-y-1 hover:shadow-pop md:p-6">
    <div className="flex items-center justify-between gap-2">
      <SourceChip source={policy.source} />
      <div className="flex items-center gap-2">
        {listingStatus && listingStatus !== "taken_down" && (
          <ListingStatusChip status={listingStatus} />
        )}
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

    {robotAction && (
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

const DetailRow = ({ label, value }: { label: string; value: string }) => (
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

const ListingStatusChip = ({ status }: { status: string }) => (
  <span
    className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] ${
      LISTING_STATUS_TINT[status] ?? "bg-paper-3"
    }`}
  >
    {LISTING_STATUS_LABEL[status] ?? status}
  </span>
);

/**
 * The "// share" section of the drawer for OWN policies. Publishing is
 * consent-gated (403 → inline consent grant + retry) and review-gated
 * server-side: a submission goes "in review" and only a human approval makes
 * it public. Unpublish is instant.
 */
const PublishSection = ({
  details,
  myListing,
  baseUrl,
  fetcher,
  onChanged,
}: {
  details: PolicyDetails;
  myListing: MyListing | null;
  baseUrl: string;
  fetcher: ReturnType<typeof useApi>["fetchWithHeaders"];
  onChanged: () => void;
}) => {
  const [form, setForm] = useState(false);
  const [pubTitle, setPubTitle] = useState(details.title);
  const [pubDesc, setPubDesc] = useState("");
  const [needsConsent, setNeedsConsent] = useState(false);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const active = myListing && (myListing.in_review || myListing.is_public);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (needsConsent && consented) {
        await grantConsent(baseUrl, fetcher, "publish_public");
        setNeedsConsent(false);
      }
      await publishPolicy(baseUrl, fetcher, details.ref, pubTitle.trim(), pubDesc.trim() || null);
      setForm(false);
      onChanged();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) {
        setNeedsConsent(true);
        setErr("Publishing needs the 'share publicly' consent — tick the box to grant it and retry.");
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const retract = async () => {
    setBusy(true);
    setErr(null);
    try {
      await unpublishPolicy(baseUrl, fetcher, details.ref);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6">
      <div className="eyebrow mb-1">{"// share"}</div>

      {active ? (
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13.5px] text-muted-foreground">
              {myListing!.in_review
                ? "Submitted — a human reviews every policy before it goes public."
                : "Live on the community marketplace."}
            </span>
            <ListingStatusChip status={myListing!.status} />
          </div>
          <button
            type="button"
            onClick={retract}
            disabled={busy}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-[12px] hover:bg-accent disabled:opacity-50"
          >
            {myListing!.is_public ? "unpublish (instant)" : "withdraw submission"}
          </button>
        </div>
      ) : form ? (
        <div className="space-y-3 py-2">
          {myListing?.status === "rejected" && myListing.review_reason && (
            <p className="text-[12.5px] text-destructive">
              Last submission rejected: {myListing.review_reason}
            </p>
          )}
          <input
            value={pubTitle}
            onChange={(e) => setPubTitle(e.target.value)}
            maxLength={120}
            placeholder="Public title"
            className="w-full rounded-xl border border-input bg-background px-3 py-2 text-[14px] focus:outline-none focus:shadow-[0_0_0_3px_#ffe9a8]"
          />
          <textarea
            value={pubDesc}
            onChange={(e) => setPubDesc(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="What does this policy do? (shown to other customers)"
            className="w-full rounded-xl border border-input bg-background px-3 py-2 text-[13.5px] focus:outline-none focus:shadow-[0_0_0_3px_#ffe9a8]"
          />
          {needsConsent && (
            <label className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                className="mt-0.5"
              />
              I consent to publishing this policy publicly (grants the
              &lsquo;publish_public&rsquo; consent; revocable — revoking takes all my
              shared policies down).
            </label>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={busy || pubTitle.trim().length < 3 || (needsConsent && !consented)}
              className="flex-1 rounded-xl border border-border bg-secondary px-3 py-2 font-mono text-[12px] hover:bg-accent disabled:opacity-50"
            >
              {busy ? "submitting…" : "submit for review"}
            </button>
            <button
              type="button"
              onClick={() => setForm(false)}
              disabled={busy}
              className="rounded-xl border border-border px-3 py-2 font-mono text-[12px] hover:bg-accent"
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 py-2">
          {myListing?.status === "rejected" && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-destructive">
                {myListing.review_reason
                  ? `Rejected: ${myListing.review_reason}`
                  : "Last submission was rejected."}
              </span>
              <ListingStatusChip status="rejected" />
            </div>
          )}
          <button
            type="button"
            onClick={() => setForm(true)}
            className="w-full rounded-xl border border-border bg-secondary px-3 py-2 font-mono text-[12px] hover:bg-accent"
          >
            {myListing?.status === "rejected" ? "revise & resubmit →" : "publish to community →"}
          </button>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Shared policies are privacy-scrubbed, copied to a neutral location, and
            human-reviewed before anyone can install them.
          </p>
        </div>
      )}

      {err && <p className="mt-2 text-[12.5px] text-destructive">{err}</p>}
    </div>
  );
};

const DetailDrawer = ({
  details,
  onClose,
  onRenamed,
  onUninstalled,
  installed,
  baseUrl,
  fetcher,
  myListing,
  onListingChanged,
}: {
  details: PolicyDetails;
  onClose: () => void;
  onRenamed: (d: PolicyDetails) => void;
  onUninstalled: () => void;
  installed: boolean;
  baseUrl: string;
  fetcher: ReturnType<typeof useApi>["fetchWithHeaders"];
  myListing: MyListing | null;
  onListingChanged: () => void;
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

        {details.editable && (
          <PublishSection
            details={details}
            myListing={myListing}
            baseUrl={baseUrl}
            fetcher={fetcher}
            onChanged={onListingChanged}
          />
        )}

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
  const [myListings, setMyListings] = useState<MyListing[]>([]);

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
        await runner.start(teleop, policy.ref);
      } catch {
        // phase already reflects the error via onPhase
      }
    },
    [baseUrl, teleop]
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

  const openDrawer = useCallback(
    async (policy: PolicyListEntry) => {
      try {
        setOpenDetails(await getPolicyDetails(baseUrl, fetchWithHeaders, policy.ref));
      } catch (e) {
        // The details endpoint ships with the backend's marketplace-details
        // branch (gated on migration 014). Until that deploys, a 404 here
        // would dead-end the drawer — synthesize CLEARLY-MARKED preview
        // details from the catalog entry instead so the drawer stays
        // testable. Real responses take over automatically once the
        // endpoint exists; every other error still surfaces.
        if (e instanceof ApiError && e.status === 404) {
          setOpenDetails(mockDetailsFor(policy));
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [baseUrl, fetchWithHeaders]
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
                listingStatus={p.source === "own" ? myListingByJob[p.ref]?.status : null}
                robotAction={robotActionFor(p)}
                onInstall={() => install(p)}
                onOpen={() => openDrawer(p)}
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
          myListing={myListingByJob[openDetails.ref] ?? null}
          onListingChanged={refreshMyListings}
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
