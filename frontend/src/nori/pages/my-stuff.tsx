// NORI: My Stuff — the customer's library. Everything captured, uploaded, and
// trained, with the dataset→policy lineage the backend joins in GET /library.
// Datasets column: local recordings ("on this laptop") + promoted uploads
// (each showing what it trained). Policies column: every trained policy with a
// chip back to its source dataset; hovering a policy highlights that dataset.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Lock, Trash2, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useApi } from "@/contexts/ApiContext";
import { useNori } from "@/nori/NoriContext";
import {
  deleteDataset,
  deletePolicy,
  getLibrary,
  renamePolicy,
  renameUploadLabel,
  setDatasetLock,
  setPolicyLock,
  uploadDataset,
  type Library,
  type LibraryDataset,
  type LibraryPolicy,
} from "@/nori/api/client";
import { DatasetCapture, type CaptureDatasetEntry } from "@/nori/remote/datasetCapture";
import { EpisodeReviewModal, type ReviewSource } from "@/nori/components/EpisodeReviewModal";

// ---- small presentational bits -------------------------------------------

type Tone = "leaf" | "sticker" | "sticker-2" | "accent" | "secondary";
const TONE: Record<Tone, string> = {
  leaf: "bg-leaf",
  sticker: "bg-sticker",
  "sticker-2": "bg-sticker-2",
  accent: "bg-accent",
  secondary: "bg-secondary",
};
const Pill = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full ${TONE[tone]} px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink`}
  >
    {children}
  </span>
);

const STATE_TONE: Record<LibraryPolicy["state"], Tone> = {
  live: "leaf",
  training: "sticker",
  paused: "sticker",
  failed: "sticker-2",
};
const STATE_LABEL: Record<LibraryPolicy["state"], string> = {
  live: "Live",
  training: "Training",
  paused: "Paused",
  failed: "Failed",
};

const fmt = (n: number) => n.toLocaleString();
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const cardCls =
  "rounded-[20px] border border-border bg-card p-4 shadow-soft transition-shadow hover:shadow-pop";

// Inline-editable name: the card title with a pencil. Commit on Enter/blur-save,
// Escape cancels; errors (name rules, PII scan on policies) surface inline.
const EditableName = ({
  value,
  onRename,
}: {
  value: string;
  onRename: (next: string) => Promise<void>;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === value) {
      setEditing(false);
      setErr(null);
      return;
    }
    setBusy(true);
    try {
      await onRename(next);
      setEditing(false);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <span className="group/name inline-flex items-center gap-1.5">
        <p className="text-base font-bold text-[#14131a]">{value}</p>
        <button
          type="button"
          aria-label="Rename"
          title="Rename"
          onClick={(e) => {
            e.stopPropagation();
            setDraft(value);
            setEditing(true);
          }}
          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/name:opacity-100 focus:opacity-100"
        >
          ✎
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex w-full max-w-72 flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <span className="flex items-center gap-1.5">
        <input
          className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm font-bold"
          value={draft}
          disabled={busy}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(value);
              setErr(null);
            }
          }}
        />
        <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={busy} onClick={() => void commit()}>
          {busy ? "…" : "Save"}
        </Button>
      </span>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
};

// ---- page ------------------------------------------------------------------

const MyStuff = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { leLabAvailable } = useNori();
  const navigate = useNavigate();

  const [library, setLibrary] = useState<Library | null>(null);
  const [local, setLocal] = useState<CaptureDatasetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeRef, setActiveRef] = useState<string | null>(null); // hovered policy's source
  const [uploading, setUploading] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ReviewSource | null>(null); // dataset under review
  const [deleting, setDeleting] = useState<LibraryDataset | null>(null); // pending delete confirmation
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deletingPolicy, setDeletingPolicy] = useState<LibraryPolicy | null>(null);
  const [deletePolicyBusy, setDeletePolicyBusy] = useState(false);
  const [deletePolicyErr, setDeletePolicyErr] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState<string | null>(null); // id being locked/unlocked

  const load = useCallback(async () => {
    setError(null);
    try {
      const lib = await getLibrary(baseUrl, fetchWithHeaders);
      setLibrary(lib);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // local captures are best-effort (only when a LeLab spool is reachable)
    try {
      setLocal(await DatasetCapture.listDatasets(baseUrl));
    } catch {
      setLocal([]);
    }
    setLoading(false);
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every policy, flattened, for the Policies column.
  const allPolicies = useMemo(() => {
    if (!library) return [];
    const linked = library.datasets.flatMap((d) =>
      d.policies.map((p) => ({ ...p, sourceRef: d.dataset_ref, sourceLabel: d.label })),
    );
    const unlinked = library.unlinked_policies.map((p) => ({ ...p, sourceRef: null, sourceLabel: null }));
    return [...linked, ...unlinked].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [library]);

  const onRenameLocal = useCallback(
    async (oldId: string, next: string) => {
      await DatasetCapture.renameDataset(baseUrl, oldId, next);
      await load();
    },
    [baseUrl, load],
  );

  const onDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteErr(null);
    try {
      await deleteDataset(baseUrl, fetchWithHeaders, deleting.session_id);
      setDeleting(null);
      await load();
    } catch (e) {
      // Keep the dialog open and show why (e.g. 409: published to the community).
      setDeleteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleting, baseUrl, fetchWithHeaders, load]);

  const onToggleDatasetLock = useCallback(
    async (d: LibraryDataset) => {
      setLockBusy(d.session_id);
      try {
        await setDatasetLock(baseUrl, fetchWithHeaders, d.session_id, !d.locked);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLockBusy(null);
      }
    },
    [baseUrl, fetchWithHeaders, load],
  );

  const onTogglePolicyLock = useCallback(
    async (jobId: string, locked: boolean) => {
      setLockBusy(jobId);
      try {
        await setPolicyLock(baseUrl, fetchWithHeaders, jobId, !locked);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLockBusy(null);
      }
    },
    [baseUrl, fetchWithHeaders, load],
  );

  const onDeletePolicy = useCallback(async () => {
    if (!deletingPolicy) return;
    setDeletePolicyBusy(true);
    setDeletePolicyErr(null);
    try {
      await deletePolicy(baseUrl, fetchWithHeaders, deletingPolicy.job_id);
      setDeletingPolicy(null);
      await load();
    } catch (e) {
      setDeletePolicyErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletePolicyBusy(false);
    }
  }, [deletingPolicy, baseUrl, fetchWithHeaders, load]);

  const onRenameUpload = useCallback(
    async (sessionId: string, next: string) => {
      await renameUploadLabel(baseUrl, fetchWithHeaders, sessionId, next);
      await load();
    },
    [baseUrl, fetchWithHeaders, load],
  );

  const onRenamePolicy = useCallback(
    async (jobId: string, next: string) => {
      // Jobs-side rename: works at ANY stage (queued/training/paused/failed/
      // live), unlike the promotion-gated marketplace rename.
      await renameTrainingJob(baseUrl, fetchWithHeaders, jobId, next);
      await load();
    },
    [baseUrl, fetchWithHeaders, load],
  );

  // Live-progress estimate inputs: per-policy step rates + setup seconds
  // (fetched once) and a slow tick so training bars advance without polling —
  // the estimate is pure clock math against run_started_at.
  const [estimate, setEstimate] = useState<{ rates: Record<string, { typical: number }>; setup: number } | null>(null);
  useEffect(() => {
    getTrainingEstimateParams(baseUrl, fetchWithHeaders)
      .then((e) => setEstimate({ rates: e.step_rates, setup: e.setup_seconds }))
      .catch(() => {});
  }, [baseUrl, fetchWithHeaders]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  /** Estimated % complete for a RUNNING policy: elapsed-since-first-RUNNING
   *  minus container setup, over steps/typical-rate. Clamped, labeled ~. */
  const trainingProgress = (p: { run_started_at: string | null; steps: number | null; policy_type: string | null }): number | null => {
    if (!estimate || !p.run_started_at || !p.steps) return null;
    const rate = estimate.rates[p.policy_type ?? ""]?.typical;
    if (!rate) return null;
    const elapsed = (Date.now() - new Date(p.run_started_at).getTime()) / 1000 - estimate.setup;
    if (elapsed <= 0) return 2; // still in container setup
    return Math.max(2, Math.min(97, Math.round((elapsed / (p.steps / rate)) * 100)));
  };

  const onUpload = useCallback(
    async (repoId: string) => {
      setUploading(repoId);
      try {
        await uploadDataset(baseUrl, fetchWithHeaders, repoId, `${repoId} — from My Stuff`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(null);
      }
    },
    [baseUrl, fetchWithHeaders, load],
  );


  if (loading) {
    return (
      <section className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-3 h-6 w-6 animate-spin" /> Loading your library…
      </section>
    );
  }

  const datasets = library?.datasets ?? [];

  return (
    <section className="space-y-6">
      <header className="space-y-1.5">
        <p className="eyebrow">Your library</p>
        <h1 className="text-3xl md:text-4xl">My Stuff</h1>
        <p className="max-w-[56ch] text-muted-foreground">
          Everything you've captured, uploaded, and trained — and which policies came from which data.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Couldn't load everything: {error}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[1.35fr_1fr]">
        {/* -------- Datasets -------- */}
        <div className="space-y-3.5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-bold tracking-tight text-[#14131a]">Datasets</h2>
            <span className="font-mono text-xs text-muted-foreground">
              {local.length + datasets.length} total
            </span>
          </div>

          {/* local, not-yet-uploaded */}
          {local.map((d) => (
            <article key={`local-${d.repo_id}`} className={cardCls}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <EditableName value={d.repo_id} onRename={(next) => onRenameLocal(d.repo_id, next)} />
                  {d.robot_type && <p className="mt-0.5 text-sm text-muted-foreground">{d.robot_type}</p>}
                </div>
                <Pill tone="secondary">On this laptop</Pill>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[#14131a]/80 [font-variant-numeric:tabular-nums]">
                <span><b className="font-semibold text-[#14131a]">{fmt(d.episodes)}</b> episodes</span>
                <span><b className="font-semibold text-[#14131a]">{fmt(d.frames)}</b> frames</span>
                {d.fps && <span><b className="font-semibold text-[#14131a]">{d.fps}</b> fps</span>}
              </div>
              <p className="mt-3 border-t border-dashed border-border pt-2.5 text-[13px] italic text-muted-foreground">
                Not uploaded yet — upload to train a policy on it.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setReviewing({ kind: "local", repoId: d.repo_id })}>
                  Review episodes
                </Button>
                <Button size="sm" onClick={() => onUpload(d.repo_id)} disabled={uploading === d.repo_id}>
                  {uploading === d.repo_id ? "Uploading…" : "Upload to cloud"}
                </Button>
              </div>
            </article>
          ))}

          {/* uploaded, with lineage */}
          {datasets.map((d) => {
            const live = d.policies.filter((p) => p.state === "live").length;
            const highlighted = activeRef === d.dataset_ref;
            return (
              <article
                key={d.session_id}
                className={`${cardCls} ${highlighted ? "ring-2 ring-accent border-accent" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {d.locked ? (
                      <p className="text-base font-bold text-[#14131a]">{d.label}</p>
                    ) : (
                      <EditableName value={d.label} onRename={(next) => onRenameUpload(d.session_id, next)} />
                    )}
                    <p className="mt-0.5 text-sm text-muted-foreground">Uploaded {shortDate(d.created_at)}</p>
                  </div>
                  {d.locked ? (
                    <Pill tone="accent">
                      <Lock className="mr-1 inline h-3 w-3" />Locked
                    </Pill>
                  ) : (
                    <Pill tone="leaf">Uploaded</Pill>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[#14131a]/80 [font-variant-numeric:tabular-nums]">
                  {d.episode_count != null && <span><b className="font-semibold text-[#14131a]">{fmt(d.episode_count)}</b> episodes</span>}
                  {d.frame_count != null && <span><b className="font-semibold text-[#14131a]">{fmt(d.frame_count)}</b> frames</span>}
                </div>
                <div className="mt-3 border-t border-dashed border-border pt-2.5 text-[13px] text-[#14131a]/70">
                  {d.policies.length === 0 ? (
                    <span className="italic text-muted-foreground">No policies trained yet.</span>
                  ) : (
                    <span>
                      <span className="font-semibold text-[#b06a1c]">→</span>{" "}
                      Trained <b className="font-semibold text-[#14131a]">{live} live {live === 1 ? "policy" : "policies"}</b>
                      {d.policies.length > live ? ` · ${d.policies.length} runs` : ""}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => navigate("/nori/training")}>Train a policy</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReviewing({ kind: "cloud", sessionId: d.session_id, title: d.label })}
                  >
                    Review episodes
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={lockBusy === d.session_id}
                    onClick={() => onToggleDatasetLock(d)}
                  >
                    {d.locked ? (
                      <><Unlock className="mr-1 h-3.5 w-3.5" /> Unlock</>
                    ) : (
                      <><Lock className="mr-1 h-3.5 w-3.5" /> Lock</>
                    )}
                  </Button>
                  {!d.locked && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        setDeleteErr(null);
                        setDeleting(d);
                      }}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                    </Button>
                  )}
                </div>
              </article>
            );
          })}

          {local.length === 0 && datasets.length === 0 && (
            <p className="rounded-[20px] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing here yet. Record a session on the Remote page to get started.
            </p>
          )}
        </div>

        {/* -------- Policies -------- */}
        <div className="space-y-3.5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-bold tracking-tight text-[#14131a]">Policies</h2>
            <span className="font-mono text-xs text-muted-foreground">{allPolicies.length} total</span>
          </div>

          {allPolicies.length === 0 && (
            <p className="rounded-[20px] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No policies yet — train one from a dataset.
            </p>
          )}

          {allPolicies.map((p) => {
            const inFlight = p.state === "training";
            const openProgress = () => navigate(`/nori/training-history?open=${encodeURIComponent(p.job_id)}`);
            return (
            <article
              key={p.job_id}
              className={`${cardCls} ${inFlight ? "cursor-pointer" : ""}`}
              onClick={inFlight ? openProgress : undefined}
              onMouseEnter={() => setActiveRef(p.sourceRef)}
              onMouseLeave={() => setActiveRef(null)}
              onFocus={() => setActiveRef(p.sourceRef)}
              onBlur={() => setActiveRef(null)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  {/* Renameable at EVERY stage (jobs-side rename) — a policy can
                      be named before its training finishes. Locked policies show
                      plain text. */}
                  {!p.locked ? (
                    <EditableName
                      value={p.title ?? p.sourceLabel ?? "Policy"}
                      onRename={(next) => onRenamePolicy(p.job_id, next)}
                    />
                  ) : (
                    <p className="text-base font-bold text-[#14131a]">
                      {p.title ?? p.sourceLabel ?? "Policy"}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.policy_class && <Pill tone="accent">{p.policy_class.toUpperCase()}</Pill>}
                    {p.locked && (
                      <Pill tone="accent">
                        <Lock className="mr-1 inline h-3 w-3" />Locked
                      </Pill>
                    )}
                  </div>
                </div>
                <Pill tone={STATE_TONE[p.state]}>{STATE_LABEL[p.state]}</Pill>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[#14131a]/80 [font-variant-numeric:tabular-nums]">
                {p.state === "paused" && p.steps_done != null && p.steps != null ? (
                  <span><b className="font-semibold text-[#14131a]">{fmt(p.steps_done)}</b> / {fmt(p.steps)} steps</span>
                ) : p.steps != null ? (
                  <span><b className="font-semibold text-[#14131a]">{fmt(p.steps)}</b> steps</span>
                ) : null}
                {p.promoted_at && <span>Promoted {shortDate(p.promoted_at)}</span>}
                {p.final_cost_usd != null && <span>${p.final_cost_usd.toFixed(2)}</span>}
              </div>
              {inFlight && (() => {
                const pct = trainingProgress(p);
                return (
                  <div className="mt-2.5">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                        training
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {pct === null
                          ? "starting…"
                          : pct <= 2
                            ? "setting up…"
                            : `~${pct}% (estimated)`}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#14131a]/10">
                      <div
                        className="h-full rounded-full bg-[#b06a1c] transition-[width] duration-1000"
                        style={{ width: `${pct ?? 2}%` }}
                      />
                    </div>
                  </div>
                );
              })()}
              <div className="mt-3 border-t border-dashed border-border pt-2.5 text-[13px] text-[#14131a]/70">
                {p.sourceLabel ? (
                  <span>
                    <span className="font-mono text-xs text-muted-foreground">Trained from</span>{" "}
                    <span className="font-mono text-[13px] text-[#14131a]">◆ {p.sourceLabel}</span>
                  </span>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">Source dataset not recorded</span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {p.state === "live" && <Button size="sm" onClick={() => navigate("/nori/marketplace")}>Run on robot</Button>}
                {p.state === "training" && (
                  <Button size="sm" onClick={(e) => { e.stopPropagation(); openProgress(); }}>
                    View progress →
                  </Button>
                )}
                {p.state === "paused" && <Button size="sm" onClick={openProgress}>Resume training</Button>}
                {!inFlight && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={lockBusy === p.job_id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePolicyLock(p.job_id, !!p.locked);
                    }}
                  >
                    {p.locked ? (
                      <><Unlock className="mr-1 h-3.5 w-3.5" /> Unlock</>
                    ) : (
                      <><Lock className="mr-1 h-3.5 w-3.5" /> Lock</>
                    )}
                  </Button>
                )}
                {!inFlight && !p.locked && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletePolicyErr(null);
                      setDeletingPolicy(p);
                    }}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                  </Button>
                )}
              </div>
            </article>
            );
          })}
        </div>
      </div>

      {reviewing && (
        <EpisodeReviewModal source={reviewing} onClose={() => setReviewing(null)} onChanged={load} />
      )}

      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o && !deleteBusy) {
            setDeleting(null);
            setDeleteErr(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the dataset and its files from your Nori cloud. This can’t be undone.
              {deleting && deleting.policies.length > 0 ? (
                <>
                  {" "}
                  Policies already trained from it are kept, but will show “source not recorded.”
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteErr && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteErr}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault(); // stay open while deleting / on error
                void onDelete();
              }}
              disabled={deleteBusy}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!deletingPolicy}
        onOpenChange={(o) => {
          if (!o && !deletePolicyBusy) {
            setDeletingPolicy(null);
            setDeletePolicyErr(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deletingPolicy?.title ?? "this policy"}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the trained policy and its checkpoint. This can’t be
              undone. Published policies must be unpublished first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deletePolicyErr && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deletePolicyErr}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePolicyBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void onDeletePolicy();
              }}
              disabled={deletePolicyBusy}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              {deletePolicyBusy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {!leLabAvailable && (
        <p className="font-mono text-xs text-muted-foreground">
          Local recordings aren't shown on the hosted app — open My Stuff in the desktop app to manage captures.
        </p>
      )}
    </section>
  );
};

export default MyStuff;
