// NORI: My Stuff — the customer's library. Everything captured, uploaded, and
// trained, with the dataset→policy lineage the backend joins in GET /library.
// One wide column with a Recordings / Datasets / Policies view switch (no
// side-by-side columns, so each card is full width). Policies keep the chip
// back to their source dataset; hovering a policy highlights that dataset.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Loader2, Lock, Trash2, Unlock } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApi } from "@/contexts/ApiContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { PolicyRunner, EXECUTION_PRESETS, type PolicyRunPhase } from "@/nori/remote/policyRun";
import {
  deleteDataset,
  deletePolicy,
  downloadPolicy,
  getActiveAssemblies,
  getLibrary,
  getRobotRecordings,
  getTrainingEstimateParams,
  listLocalPolicies,
  renameTrainingJob,
  renameUploadLabel,
  setDatasetLock,
  setPolicyLock,
  type ActiveAssembly,
  type Library,
  type LibraryDataset,
  type LibraryPolicy,
  type RawBundleEntry,
  type RobotRecordings,
} from "@/nori/api/client";
import { EpisodeReviewModal, type ReviewSource } from "@/nori/components/EpisodeReviewModal";
import { AssembleModal } from "@/nori/components/AssembleModal";
import { ExportModal } from "@/nori/components/ExportModal";

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
const shortDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
// Episode length -> "M:SS" (or "H:MM:SS" for long takes).
const formatDuration = (s: number) => {
  const total = Math.max(0, Math.round(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
};

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
        <p className="text-base font-bold text-nori-h14131a">{value}</p>
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

// ---- recording grouping ----------------------------------------------------
// The robot ships one raw bundle per EPISODE (episode-as-unit), so a recording
// session of N episodes arrives as N separate bundles. We regroup them for
// display ONLY — no id is minted on the robot or backend. Cluster key: shared
// label (the robot sets label = task) AND time-contiguity — episodes recorded
// back-to-back are one session; a gap longer than SESSION_GAP_MS starts a new
// one, so two sessions that reuse a task name on different days never merge.
const SESSION_GAP_MS = 20 * 60_000; // >20 min between episodes => a new session

type RecordingFlags = {
  assembling: boolean;
  promoted: boolean;
  localCleared: boolean;
  inCloud: boolean;
  finishing: boolean;
  failed: boolean;
  uploadActive: boolean;
};
// Per-bundle upload-activity evidence. The row EXISTS because the robot's
// shipper created it when the upload STARTED (chunk PUTs go straight to S3 and
// never touch the DB), so a fresh non-terminal row means bytes are moving
// right now. This must not key on the heartbeat's rec_episodes_pending alone:
// no current robot release ships that field, which left every in-flight
// recording labeled "On robot · waiting" mid-upload (live report 2026-08-10).
// FINALIZING is the server-side promotion step — active regardless of robot.
// A stale (>15 min) pre-terminal row really is stalled (robot went offline
// mid-upload; it resumes when idle) — "waiting" stays the honest label there.
const UPLOAD_FRESH_MS = 15 * 60_000;
function recordingFlags(b: RawBundleEntry): RecordingFlags {
  const assembling = b.assembling === true;
  const promoted = b.status === "PROMOTED";
  const localCleared = b.local_deleted_at != null;
  const createdMs = Date.parse(b.created_at);
  const uploadActive =
    b.status === "FINALIZING" ||
    (!Number.isNaN(createdMs) && Date.now() - createdMs < UPLOAD_FRESH_MS);
  return {
    assembling,
    promoted,
    localCleared,
    inCloud: promoted && localCleared && !assembling,
    finishing: promoted && !localCleared && !assembling,
    failed: b.status === "FAILED" || b.status === "PROMOTION_FAILED",
    uploadActive,
  };
}

type RecordingGroup = {
  key: string;
  label: string;
  newestMs: number;
  bundles: RawBundleEntry[];
};
function groupRecordings(bundles: RawBundleEntry[]): RecordingGroup[] {
  const ms = (b: RawBundleEntry) => {
    const t = Date.parse(b.created_at);
    return Number.isNaN(t) ? 0 : t;
  };
  const byLabel = new Map<string, RawBundleEntry[]>();
  for (const b of bundles) {
    const arr = byLabel.get(b.label) ?? [];
    arr.push(b);
    byLabel.set(b.label, arr);
  }
  const groups: RecordingGroup[] = [];
  for (const [label, arr] of byLabel) {
    const sorted = [...arr].sort((a, b) => ms(a) - ms(b)); // episode order
    let cluster: RawBundleEntry[] = [];
    const flush = () => {
      if (!cluster.length) return;
      groups.push({
        key: `${label}::${ms(cluster[0])}`,
        label,
        newestMs: ms(cluster[cluster.length - 1]),
        bundles: cluster,
      });
      cluster = [];
    };
    for (const b of sorted) {
      if (cluster.length && ms(b) - ms(cluster[cluster.length - 1]) > SESSION_GAP_MS) flush();
      cluster.push(b);
    }
    flush();
  }
  return groups.sort((a, b) => b.newestMs - a.newestMs); // newest session first
}

type GroupSummary = { tone: Tone; pill: string; detail: string };
function summarizeGroup(
  group: RecordingGroup,
  robotReporting: boolean,
): GroupSummary {
  let inCloud = 0;
  let uploading = 0;
  let waiting = 0;
  let assembling = 0;
  let failed = 0;
  for (const b of group.bundles) {
    const f = recordingFlags(b);
    if (f.failed) failed++;
    else if (f.assembling) assembling++;
    else if (f.inCloud) inCloud++;
    // per-bundle activity beats the coarse heartbeat proxy — a fresh row IS
    // an in-flight upload even when the heartbeat says nothing (see
    // recordingFlags.uploadActive); "finishing on robot" rolls up here too.
    else if (robotReporting || f.uploadActive) uploading++;
    else waiting++;
  }
  const parts: string[] = [];
  if (inCloud) parts.push(`${inCloud} in cloud`);
  if (uploading) parts.push(`${uploading} uploading`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (assembling) parts.push(`${assembling} assembling`);
  if (failed) parts.push(`${failed} need attention`);
  const allInCloud = inCloud === group.bundles.length;
  return {
    tone: failed ? "secondary" : allInCloud ? "leaf" : "sticker",
    pill: failed
      ? "Needs attention"
      : allInCloud
        ? "In cloud"
        : uploading
          ? "Uploading to cloud"
          : "On robot · waiting",
    detail: parts.join(" · "),
  };
}

// ---- page ------------------------------------------------------------------

const MyStuff = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const navigate = useNavigate();

  const [library, setLibrary] = useState<Library | null>(null);
  // W2.11 robot recordings (raw bundles) — replaces the legacy laptop-spool
  // "On this laptop" datasets, which are no longer produced.
  const [robot, setRobot] = useState<RobotRecordings | null>(null);
  const [assemblies, setAssemblies] = useState<ActiveAssembly[]>([]); // in-flight assembly jobs
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeRef, setActiveRef] = useState<string | null>(null); // hovered policy's source
  const [reviewing, setReviewing] = useState<ReviewSource | null>(null); // dataset under review
  const [view, setView] = useState<"recordings" | "datasets" | "policies">("recordings"); // column view picker
  const [policyFilter, setPolicyFilter] = useState<"all" | LibraryPolicy["state"]>("all");
  const [datasetFilter, setDatasetFilter] = useState<"all" | "own" | "community" | "published">("all");
  const [deletingRecording, setDeletingRecording] = useState<RawBundleEntry | null>(null); // pending delete
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false); // bulk delete of the picked set
  const [deleteRecBusy, setDeleteRecBusy] = useState(false);
  const [deleteRecErr, setDeleteRecErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set()); // recordings selected to assemble
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set()); // multi-episode sessions expanded
  const [assembleOpen, setAssembleOpen] = useState(false);
  const [exporting, setExporting] = useState<{ session_id: string; label: string } | null>(null); // dataset being downloaded
  const [deleting, setDeleting] = useState<LibraryDataset | null>(null); // pending delete confirmation
  const [alsoUnpublish, setAlsoUnpublish] = useState(false); // "also remove from marketplace" (published items)
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
    // robot recordings are best-effort — a backend without the raw-bundle
    // endpoint (or no robots yet) just shows an empty section, never an error.
    try {
      setRobot(await getRobotRecordings(baseUrl, fetchWithHeaders));
    } catch {
      setRobot(null);
    }
    try {
      setAssemblies((await getActiveAssemblies(baseUrl, fetchWithHeaders)).assemblies);
    } catch {
      setAssemblies([]);
    }
    setLoading(false);
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-refresh while any recording is in a transient state — uploading from the
  // robot to the cloud, or being assembled into a dataset — so its badge flips on
  // its own (uploading → in cloud, uploading-to-dataset → in cloud + new dataset).
  const anyTransient = useMemo(() => {
    const bundles = robot?.bundles ?? [];
    return (
      assemblies.length > 0 ||
      (robot?.on_robot_pending ?? 0) > 0 ||
      bundles.some(
        (b) =>
          b.assembling === true ||
          (b.status !== "PROMOTED" && b.status !== "FAILED" && b.status !== "PROMOTION_FAILED") ||
          // PROMOTED but the robot hasn't confirmed its local copy is deleted yet
          // ("Finishing on robot…") — keep polling so it flips to "In cloud" on its own.
          (b.status === "PROMOTED" && b.assembling !== true && b.local_deleted_at == null),
      )
    );
  }, [robot, assemblies]);

  // Datasets currently being assembled into (append/rebuild targets) — edits blocked.
  const assemblingDatasetIds = useMemo(
    () =>
      new Set(
        assemblies
          .filter((a) => a.target_dataset_session_id)
          .map((a) => a.target_dataset_session_id as string),
      ),
    [assemblies],
  );
  // Brand-new datasets still being assembled from scratch — shown as placeholders.
  const newAssembling = useMemo(() => assemblies.filter((a) => a.mode === "new"), [assemblies]);

  useEffect(() => {
    if (!anyTransient) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [anyTransient, load]);

  // Every policy, flattened, for the Policies column.
  const allPolicies = useMemo(() => {
    if (!library) return [];
    const linked = library.datasets.flatMap((d) =>
      d.policies.map((p) => ({ ...p, sourceRef: d.dataset_ref, sourceLabel: d.label })),
    );
    const unlinked = library.unlinked_policies.map((p) => ({ ...p, sourceRef: null, sourceLabel: null }));
    return [...linked, ...unlinked].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [library]);

  const togglePick = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Append targets = the caller's promoted datasets, minus any mid-assembly.
  const datasetOptions = useMemo(
    () =>
      (library?.datasets ?? [])
        .filter((d) => !assemblingDatasetIds.has(d.session_id))
        .map((d) => ({ session_id: d.session_id, label: d.label })),
    [library, assemblingDatasetIds],
  );

  const onDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteErr(null);
    try {
      await deleteDataset(baseUrl, fetchWithHeaders, deleting.session_id, deleting.published ? alsoUnpublish : false);
      setDeleting(null);
      await load();
    } catch (e) {
      // Keep the dialog open and show why (e.g. 409: published to the community).
      setDeleteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleting, alsoUnpublish, baseUrl, fetchWithHeaders, load]);

  const onDeleteRecording = useCallback(async () => {
    if (!deletingRecording) return;
    const id = deletingRecording.session_id;
    setDeleteRecBusy(true);
    setDeleteRecErr(null);
    try {
      // A recording is a dataset_upload_sessions row (kind=raw_bundle); the same
      // owner-scoped delete removes its raw_bundles/ files AND the row. Datasets
      // already assembled from it are independent copies and are untouched.
      await deleteDataset(baseUrl, fetchWithHeaders, id, false);
      setDeletingRecording(null);
      setPicked((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      await load();
    } catch (e) {
      setDeleteRecErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteRecBusy(false);
    }
  }, [deletingRecording, baseUrl, fetchWithHeaders, load]);

  const onBulkDeleteRecordings = useCallback(async () => {
    const targets = (robot?.bundles ?? []).filter((b) => {
      if (!picked.has(b.session_id)) return false;
      const f = recordingFlags(b);
      // Same deletability rule as the per-card Delete: a stable state and not
      // locked or mid-assembly (deleting an assembly source breaks the job).
      return !f.assembling && (f.promoted || f.failed) && !b.locked;
    });
    setDeleteRecBusy(true);
    setDeleteRecErr(null);
    const failed: string[] = [];
    for (const b of targets) {
      try {
        await deleteDataset(baseUrl, fetchWithHeaders, b.session_id, false);
      } catch {
        failed.push(b.label);
      }
    }
    setDeleteRecBusy(false);
    setPicked(new Set());
    await load();
    if (failed.length) {
      setDeleteRecErr(`Couldn't delete ${failed.length}: ${failed.join(", ")}`);
    } else {
      setBulkDeleteOpen(false);
    }
  }, [robot, picked, baseUrl, fetchWithHeaders, load]);

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

  // Recordings are dataset_upload_sessions rows too (kind=raw_bundle), so the
  // shared dataset lock endpoint covers them — a locked recording refuses
  // rename, whole-delete, AND per-episode delete server-side.
  const onToggleRecordingLock = useCallback(
    async (b: RawBundleEntry) => {
      setLockBusy(b.session_id);
      try {
        await setDatasetLock(baseUrl, fetchWithHeaders, b.session_id, !b.locked);
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
      await deletePolicy(baseUrl, fetchWithHeaders, deletingPolicy.job_id, deletingPolicy.published ? alsoUnpublish : false);
      setDeletingPolicy(null);
      await load();
    } catch (e) {
      setDeletePolicyErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletePolicyBusy(false);
    }
  }, [deletingPolicy, alsoUnpublish, baseUrl, fetchWithHeaders, load]);

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

  // Run-on-robot: policies run in the LOCAL lelab process; the robot only
  // receives {type:"control", action} frames. This moved here from the
  // marketplace (own policies no longer browse there) — My Stuff is where
  // your policies live, so it is where they run.
  const { teleop, running: sessionRunning, tel } = useTeleopSession();
  const telRef = useRef(tel);
  useEffect(() => { telRef.current = tel; }, [tel]);
  const runnerRef = useRef<PolicyRunner | null>(null);
  const [runPhase, setRunPhase] = useState<{ ref: string | null; phase: PolicyRunPhase }>({ ref: null, phase: { kind: "idle" } });
  const [localRefs, setLocalRefs] = useState<Set<string>>(new Set());
  const refreshLocalRefs = useCallback(() => {
    listLocalPolicies(baseUrl, fetchWithHeaders)
      .then((rows) => setLocalRefs(new Set(rows.filter((r) => r.runnable).map((r) => r.ref))))
      .catch(() => {});
  }, [baseUrl, fetchWithHeaders]);
  useEffect(() => refreshLocalRefs(), [refreshLocalRefs]);
  // Never leave the robot moving after this page unmounts.
  useEffect(() => () => { void runnerRef.current?.stop("left My Stuff"); }, []);

  const [installingRef, setInstallingRef] = useState<string | null>(null);
  const installForRun = useCallback(async (ref: string) => {
    setInstallingRef(ref);
    try {
      await downloadPolicy(baseUrl, fetchWithHeaders, ref);
      refreshLocalRefs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallingRef(null);
    }
  }, [baseUrl, fetchWithHeaders, refreshLocalRefs]);

  const runOnRobot = useCallback(async (ref: string) => {
    if (!teleop) return;
    if (!runnerRef.current) runnerRef.current = new PolicyRunner(baseUrl, () => telRef.current);
    const runner = runnerRef.current;
    runner.onPhase = (phase) => setRunPhase({ ref, phase });
    try {
      await runner.start(teleop, ref, EXECUTION_PRESETS.balanced);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, teleop]);
  const stopRun = useCallback(() => { void runnerRef.current?.stop(); }, []);

  /** Install + run controls for a live policy card. Installing is just a
   *  download to the local cache — it does NOT need a robot session, and once
   *  installed the policy is deployable from the Remote page too. Running does
   *  need a connected robot. */
  const runControlFor = (jobId: string) => {
    // Not installed yet → offer Install (no robot needed).
    if (!localRefs.has(jobId)) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => installForRun(jobId)} disabled={installingRef === jobId}>
            {installingRef === jobId ? "Installing…" : "Install"}
          </Button>
          <span className="text-xs text-muted-foreground">to deploy on the Remote page</span>
        </div>
      );
    }
    // Installed but no robot session → point to the Remote page to deploy.
    if (!sessionRunning || !teleop) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate("/nori/remote")}>
            Deploy on Remote →
          </Button>
          <span className="text-xs text-muted-foreground">installed ✓</span>
        </div>
      );
    }
    // Installed + connected → run it here.
    const mine = runPhase.ref === jobId ? runPhase.phase : null;
    if (mine?.kind === "loading") return <Button size="sm" disabled>loading…</Button>;
    if (mine?.kind === "running") return <Button size="sm" variant="destructive" onClick={stopRun}>Stop</Button>;
    if (runPhase.phase.kind === "running" || runPhase.phase.kind === "loading") {
      return <span className="text-xs text-muted-foreground">another policy is driving</span>;
    }
    const label = mine?.kind === "error" ? "Retry run" : mine?.kind === "stopped" ? "Run again" : "Run on robot";
    return <Button size="sm" onClick={() => runOnRobot(jobId)}>{label}</Button>;
  };

  /** % complete for a RUNNING policy. Prefers the REAL reported progress
   *  (steps_done/steps — the backend monitor writes the live step from the log
   *  stream) and only falls back to the clock estimate until the first step
   *  arrives. `real` drives whether the label shows "~…% (estimated)". */
  const trainingProgress = (p: {
    run_started_at: string | null;
    steps: number | null;
    steps_done: number | null;
    policy_type: string | null;
  }): { pct: number; real: boolean } | null => {
    // Real progress once a step count has been reported.
    if (p.steps != null && p.steps > 0 && p.steps_done != null && p.steps_done > 0) {
      return { pct: Math.max(2, Math.min(99, Math.round((p.steps_done / p.steps) * 100))), real: true };
    }
    // Fallback: elapsed-since-first-RUNNING minus setup, over steps/typical-rate.
    if (!estimate || !p.run_started_at || !p.steps) return null;
    const rate = estimate.rates[p.policy_type ?? ""]?.typical;
    if (!rate) return null;
    const elapsed = (Date.now() - new Date(p.run_started_at).getTime()) / 1000 - estimate.setup;
    if (elapsed <= 0) return { pct: 2, real: false }; // still in container setup
    return { pct: Math.max(2, Math.min(97, Math.round((elapsed / (p.steps / rate)) * 100))), real: false };
  };

  if (loading) {
    return (
      <section className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-3 h-6 w-6 animate-spin" /> Loading your library…
      </section>
    );
  }

  const datasets = library?.datasets ?? [];

  // Robot heartbeat proxy: on_robot_pending is null when the robot hasn't
  // reported recently. In-flight recordings then aren't actually being worked,
  // so we label them honestly ("waiting on robot") instead of claiming an
  // upload/finish is in progress. Coarse (heartbeat is global, not per-bundle);
  // a per-session last_upload_activity_at from the backend would be exact.
  const robotReporting = robot != null && robot.on_robot_pending != null;

  // How many of the picked recordings are actually deletable (stable state,
  // unlocked, not mid-assembly) — gates the bulk Delete action.
  const deletablePickedCount = (robot?.bundles ?? []).filter((b) => {
    if (!picked.has(b.session_id)) return false;
    const f = recordingFlags(b);
    return !f.assembling && (f.promoted || f.failed) && !b.locked;
  }).length;

  // Filtered views (top-of-column dropdowns). Recordings are unfiltered — too
  // few states/attributes to be worth it.
  const filteredPolicies = allPolicies.filter(
    (p) => policyFilter === "all" || p.state === policyFilter,
  );
  const filteredDatasets = datasets.filter((d) => {
    if (datasetFilter === "all") return true;
    if (datasetFilter === "community") return d.origin === "community";
    if (datasetFilter === "own") return d.origin !== "community";
    if (datasetFilter === "published") return d.published === true;
    return true;
  });

  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // One recording (raw bundle = one episode) card. Extracted so it renders
  // identically whether standalone or nested under a session group header.
  const renderRecordingCard = (b: RawBundleEntry) => {
    const { assembling, promoted, inCloud, finishing, failed, uploadActive } = recordingFlags(b);
    // "Actually happening right now": either the robot's heartbeat says so, or
    // this bundle's own row is fresh/finalizing (the robot creates the row at
    // upload start — see recordingFlags.uploadActive).
    const activeNow = robotReporting || uploadActive;
    // Assembly only needs the CLOUD copy, so a PROMOTED recording is selectable
    // even during the brief local-delete tail — don't block on cleanup.
    const selectable = promoted && !assembling;
    // Deletable once it's in a stable state (in cloud / failed) and not
    // mid-assembly — deleting a source mid-assembly would break the job.
    const deletable = !assembling && (promoted || failed);
    return (
      <article
        key={b.session_id}
        className={`${cardCls}${picked.has(b.session_id) ? " ring-2 ring-nori-h14131a" : ""}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {selectable && (
              <input
                type="checkbox"
                checked={picked.has(b.session_id)}
                onChange={() => togglePick(b.session_id)}
                className="mt-1 h-4 w-4 shrink-0 accent-nori-h14131a"
                aria-label={`Select ${b.label}`}
              />
            )}
            <div className="min-w-0">
              {/* Title line: name + "Episode" (singular; N episodes if a bundle
                  ever holds more) + the upload/record time, all on one line to
                  keep the card compact. Rename hits the same owner-scoped
                  upload-label endpoint as datasets (raw bundles are sessions). */}
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <EditableName
                  value={b.label}
                  onRename={(next) => onRenameUpload(b.session_id, next)}
                />
                <span className="shrink-0 text-xs text-muted-foreground [font-variant-numeric:tabular-nums]">
                  {b.episode_count != null && b.episode_count !== 1
                    ? `${fmt(b.episode_count)} episodes`
                    : "Episode"}
                  {" · "}
                  {b.status === "PROMOTED" && b.finalized_at
                    ? `Uploaded ${shortDateTime(b.finalized_at)}`
                    : `Recorded ${shortDateTime(b.created_at)}`}
                </span>
              </div>
            </div>
          </div>
          <Pill
            tone={
              assembling
                ? "sticker"
                : inCloud || (finishing && !activeNow)
                  ? "leaf"
                  : failed
                    ? "secondary"
                    : "sticker"
            }
          >
            {assembling
              ? "Uploading to dataset"
              : inCloud
                ? "In cloud"
                : failed
                  ? "Needs attention"
                  : !activeNow
                    ? // Nothing is demonstrably happening (no heartbeat signal AND
                      // the row is stale). A promoted take is already cloud-safe;
                      // an unpromoted one waits until the robot idles/reconnects.
                      finishing
                      ? "In cloud · clearing pending"
                      : "On robot · waiting for upload"
                    : finishing
                      ? "Finishing on robot…"
                      : "Uploading to cloud"}
          </Pill>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-nori-h14131a/80 [font-variant-numeric:tabular-nums]">
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {b.duration_s != null && <span><b className="font-semibold text-nori-h14131a">{formatDuration(b.duration_s)}</b></span>}
            {b.frame_count != null && <span><b className="font-semibold text-nori-h14131a">{fmt(b.frame_count)}</b> frames</span>}
            {b.action_count != null && <span><b className="font-semibold text-nori-h14131a">{fmt(b.action_count)}</b> motion samples</span>}
          </span>
          <div className="flex items-center gap-1.5">
            {/* Preview the ORIGINAL recorded video (raw_bundle viewer) — the
                robot's own H.264 at full quality, viewable before assembly. */}
            {selectable && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReviewing({ kind: "raw", sessionId: b.session_id, title: b.label })}
              >
                Preview
              </Button>
            )}
            {(promoted || failed) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={lockBusy === b.session_id}
                onClick={() => onToggleRecordingLock(b)}
              >
                {b.locked ? (
                  <><Unlock className="mr-1 h-3.5 w-3.5" /> Unlock</>
                ) : (
                  <><Lock className="mr-1 h-3.5 w-3.5" /> Lock</>
                )}
              </Button>
            )}
            {deletable && !b.locked && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  setDeleteRecErr(null);
                  setDeletingRecording(b);
                }}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
              </Button>
            )}
          </div>
        </div>
        <p className="mt-3 border-t border-dashed border-border pt-2.5 text-[12px] italic text-muted-foreground">
          {assembling
            ? "Being assembled into a dataset — this runs in your cloud and can take a few minutes."
            : failed
              ? `Upload problem: ${b.failure_reason ?? "unknown"}`
              : inCloud
                ? "Full-quality copy is in your cloud. Select it to assemble a trainable dataset."
                : !activeNow
                  ? finishing
                    ? "Full-quality copy is safe in your cloud. The copy on your robot will be cleared."
                    : "Recorded and held on the robot. It uploads automatically once the robot is powered on and idle."
                  : finishing
                    ? "Safe in your cloud — the robot is clearing its local copy. Keep Nori powered on until it finishes."
                    : "Uploading from the robot — this finishes while the robot is idle."}
        </p>
        {/* The latest assembly attempt with this recording FAILED — show
            which episode and why (e.g. a camera gap), so the user knows to
            re-record rather than retry. Hidden while a new attempt runs;
            the backend clears it once a later attempt succeeds. */}
        {b.last_assembly_error && !assembling && (
          <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
            Couldn't assemble into a dataset: {b.last_assembly_error}
          </p>
        )}
      </article>
    );
  };

  return (
    <section className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-3xl md:text-4xl">My Stuff</h1>
        <p className="max-w-[56ch] text-muted-foreground">
          Everything you've captured, uploaded, and trained.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Couldn't load everything: {error}
        </div>
      )}

      {/* One wide column: Recordings / Datasets / Policies are a single view
          switch (below) rather than side-by-side columns, so each card gets the
          full width. min-w-0 keeps a long name/repo id from overflowing. */}
      <div className="min-w-0">
        <div className="min-w-0 space-y-3.5">
          {/* View picker: Recordings ↔ Datasets, one at a time. Robot recordings
              (W2.11) are full-quality episodes captured on the robot and auto-
              uploaded; they become trainable once assembled into a dataset. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-full bg-secondary p-1 text-sm font-medium">
              {([
                ["recordings", "Recordings", robot?.bundles?.length ?? 0],
                ["datasets", "Datasets", datasets.length],
                ["policies", "Policies", allPolicies.length],
              ] as const).map(([key, label, count]) => (
                <button
                  key={key}
                  onClick={() => setView(key)}
                  className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 transition-colors ${
                    view === key
                      ? "bg-card text-nori-h14131a shadow-soft"
                      : "text-muted-foreground hover:text-nori-h14131a"
                  }`}
                >
                  {label}
                  <span className="rounded-full bg-nori-h14131a/10 px-1.5 text-xs [font-variant-numeric:tabular-nums]">
                    {count}
                  </span>
                </button>
              ))}
            </div>
            {/* Contextual status: recordings show the on-robot/uploading note; datasets show the total. */}
            {view === "recordings"
              ? (() => {
                  // on_robot_pending is >0 as soon as you RECORD (while still connected), long
                  // before any upload — so only say "uploading" when a bundle is actually in
                  // flight (an upload row exists); otherwise report it as still on the robot.
                  const pending = robot?.on_robot_pending ?? 0;
                  const uploading = (robot?.bundles ?? []).some(
                    (b) =>
                      b.assembling !== true &&
                      b.status !== "PROMOTED" &&
                      b.status !== "FAILED" &&
                      b.status !== "PROMOTION_FAILED",
                  );
                  if (uploading)
                    return <span className="font-mono text-xs text-muted-foreground">uploading to cloud…</span>;
                  if (pending > 0)
                    return (
                      <span className="font-mono text-xs text-muted-foreground">
                        {pending} on robot · uploads when idle
                      </span>
                    );
                  return null;
                })()
              : view === "datasets" ? (
                <Select
                  value={datasetFilter}
                  onValueChange={(v) => setDatasetFilter(v as typeof datasetFilter)}
                >
                  <SelectTrigger
                    aria-label="Filter datasets"
                    className="h-8 w-auto gap-1.5 rounded-md border-nori-h14131a/15 bg-white px-2.5 text-xs text-nori-h14131a dark:bg-background"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All datasets</SelectItem>
                    <SelectItem value="own">Own</SelectItem>
                    <SelectItem value="community">Community</SelectItem>
                    <SelectItem value="published">Published</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Select
                  value={policyFilter}
                  onValueChange={(v) => setPolicyFilter(v as typeof policyFilter)}
                >
                  <SelectTrigger
                    aria-label="Filter policies"
                    className="h-8 w-auto gap-1.5 rounded-md border-nori-h14131a/15 bg-white px-2.5 text-xs text-nori-h14131a dark:bg-background"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All policies</SelectItem>
                    <SelectItem value="live">Live</SelectItem>
                    <SelectItem value="training">Training</SelectItem>
                    <SelectItem value="paused">Paused</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
              )}
          </div>

          {view === "recordings" && (
            <>
          {groupRecordings(robot?.bundles ?? []).map((group) => {
            // A single-episode session needs no grouping chrome — render flat.
            if (group.bundles.length === 1) return renderRecordingCard(group.bundles[0]);
            const expanded = expandedGroups.has(group.key);
            const summary = summarizeGroup(group, robotReporting);
            // Whole-group selection: the assemble flow keys on session_ids, so a
            // header checkbox toggles every SELECTABLE (promoted, not assembling)
            // episode in the session at once — no per-episode checking needed.
            const selectableIds = group.bundles
              .filter((b) => {
                const f = recordingFlags(b);
                return f.promoted && !f.assembling;
              })
              .map((b) => b.session_id);
            const allPicked =
              selectableIds.length > 0 && selectableIds.every((id) => picked.has(id));
            const somePicked = selectableIds.some((id) => picked.has(id));
            const toggleGroupPick = () =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (allPicked) selectableIds.forEach((id) => next.delete(id));
                else selectableIds.forEach((id) => next.add(id));
                return next;
              });
            return (
              <div key={group.key} className="rounded-[20px] border border-border bg-card/60 shadow-soft">
                {/* Session header — the N episodes below share a task + were
                    recorded back-to-back, so they belong to one dataset. */}
                <div className="flex w-full items-center gap-2 px-4 py-3">
                  {selectableIds.length > 0 && (
                    <input
                      type="checkbox"
                      checked={allPicked}
                      ref={(el) => {
                        if (el) el.indeterminate = somePicked && !allPicked;
                      }}
                      onChange={toggleGroupPick}
                      className="h-4 w-4 shrink-0 accent-nori-h14131a"
                      aria-label={`Select all ${group.bundles.length} episodes in ${group.label}`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="text-muted-foreground">{expanded ? "▾" : "▸"}</span>
                      <span className="truncate text-base font-bold text-nori-h14131a">{group.label}</span>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {group.bundles.length} episodes{summary.detail ? ` · ${summary.detail}` : ""}
                      </span>
                    </span>
                    <Pill tone={summary.tone}>{summary.pill}</Pill>
                  </button>
                </div>
                {expanded && (
                  <div className="space-y-3 px-3 pb-3">
                    {group.bundles.map((b) => renderRecordingCard(b))}
                  </div>
                )}
              </div>
            );
          })}

          {picked.size > 0 && (
            <div className="sticky bottom-3 z-10 flex items-center justify-between gap-3 rounded-2xl border border-nori-h14131a bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
              <span className="text-sm font-medium text-nori-h14131a">
                {picked.size} recording{picked.size === 1 ? "" : "s"} selected
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>
                  Clear
                </Button>
                {deletablePickedCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      setDeleteRecErr(null);
                      setBulkDeleteOpen(true);
                    }}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    Delete{deletablePickedCount > 1 ? ` ${deletablePickedCount}` : ""}
                  </Button>
                )}
                <Button size="sm" onClick={() => setAssembleOpen(true)}>
                  Assemble into dataset
                </Button>
              </div>
            </div>
          )}

          {(robot?.bundles?.length ?? 0) === 0 && (
            <p className="rounded-[20px] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No robot recordings yet. Record a session on the Remote page. Episodes upload here automatically when the robot is idle (disconnected) and powered on.
            </p>
          )}

            </>
          )}

          {view === "datasets" && (
            <>
          {/* new datasets still assembling from scratch (no row yet) — placeholders */}
          {newAssembling.map((a) => (
            <article key={a.id} className={`${cardCls} opacity-90`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-bold text-nori-h14131a">
                    {a.new_dataset_name || "New dataset"}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">Just now</p>
                </div>
                <Pill tone="sticker">Assembling</Pill>
              </div>
              <p className="mt-3 flex items-center gap-2 border-t border-dashed border-border pt-2.5 text-[13px] italic text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Assembling your recordings into a trainable dataset — this can take a few minutes.
              </p>
            </article>
          ))}

          {/* uploaded, with lineage */}
          {filteredDatasets.map((d) => {
            const live = d.policies.filter((p) => p.state === "live").length;
            const highlighted = activeRef === d.dataset_ref;
            const assembling = assemblingDatasetIds.has(d.session_id); // append/rebuild in flight
            return (
              <article
                key={d.session_id}
                className={`${cardCls} ${highlighted ? "ring-2 ring-accent border-accent" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {d.locked || assembling ? (
                      <p className="text-base font-bold text-nori-h14131a">{d.label}</p>
                    ) : (
                      <EditableName value={d.label} onRename={(next) => onRenameUpload(d.session_id, next)} />
                    )}
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {d.origin === "community" ? "Added" : "Uploaded"} {shortDate(d.created_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {d.origin === "community" && <Pill tone="sticker-2">Community</Pill>}
                    {assembling ? (
                      <Pill tone="sticker">Assembling</Pill>
                    ) : d.locked ? (
                      <Pill tone="accent">
                        <Lock className="mr-1 inline h-3 w-3" />Locked
                      </Pill>
                    ) : (
                      <Pill tone="leaf">{d.origin === "community" ? "In cloud" : "Uploaded"}</Pill>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-nori-h14131a/80 [font-variant-numeric:tabular-nums]">
                  {d.episode_count != null && <span><b className="font-semibold text-nori-h14131a">{fmt(d.episode_count)}</b> episodes</span>}
                  {d.frame_count != null && <span><b className="font-semibold text-nori-h14131a">{fmt(d.frame_count)}</b> frames</span>}
                </div>
                <div className="mt-3 border-t border-dashed border-border pt-2.5 text-[13px] text-nori-h14131a/70">
                  {d.policies.length === 0 ? (
                    <span className="italic text-muted-foreground">No policies trained yet.</span>
                  ) : (
                    <span>
                      <span className="font-semibold text-nori-hb06a1c">→</span>{" "}
                      Trained <b className="font-semibold text-nori-h14131a">{live} live {live === 1 ? "policy" : "policies"}</b>
                      {d.policies.length > live ? ` · ${d.policies.length} runs` : ""}
                    </span>
                  )}
                </div>
                {assembling ? (
                  <p className="mt-3 flex items-center gap-2 text-[13px] italic text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Assembling in your cloud — editing is paused until it finishes.
                  </p>
                ) : (
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
                      onClick={() => setExporting({ session_id: d.session_id, label: d.label })}
                    >
                      <Download className="mr-1 h-3.5 w-3.5" /> Download
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
                          setAlsoUnpublish(false);
                          setDeleting(d);
                        }}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                      </Button>
                    )}
                  </div>
                )}
              </article>
            );
          })}

          {filteredDatasets.length === 0 && newAssembling.length === 0 && (
            <p className="rounded-[20px] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {datasetFilter !== "all" && datasets.length > 0
                ? "No datasets match this filter."
                : "No trainable datasets yet. Robot recordings become trainable datasets once assembled."}
            </p>
          )}
            </>
          )}

          {/* -------- Policies (third view) -------- */}
          {view === "policies" && (
            <>
          {filteredPolicies.length === 0 && (
            <p className="rounded-[20px] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {policyFilter !== "all" && allPolicies.length > 0
                ? "No policies match this filter."
                : "No policies yet — train one from a dataset."}
            </p>
          )}

          {filteredPolicies.map((p) => {
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
                    <p className="text-base font-bold text-nori-h14131a">
                      {p.title ?? p.sourceLabel ?? "Policy"}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.policy_class && <Pill tone="accent">{p.policy_class.toUpperCase()}</Pill>}
                    {p.origin === "community" && <Pill tone="sticker-2">Community</Pill>}
                    {p.locked && (
                      <Pill tone="accent">
                        <Lock className="mr-1 inline h-3 w-3" />Locked
                      </Pill>
                    )}
                  </div>
                </div>
                <Pill tone={STATE_TONE[p.state]}>{STATE_LABEL[p.state]}</Pill>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-nori-h14131a/80 [font-variant-numeric:tabular-nums]">
                {p.state === "paused" && p.steps_done != null && p.steps != null ? (
                  <span><b className="font-semibold text-nori-h14131a">{fmt(p.steps_done)}</b> / {fmt(p.steps)} steps</span>
                ) : p.steps != null ? (
                  <span><b className="font-semibold text-nori-h14131a">{fmt(p.steps)}</b> steps</span>
                ) : null}
                {p.promoted_at && <span>Promoted {shortDate(p.promoted_at)}</span>}
                {p.final_cost_usd != null && <span>${p.final_cost_usd.toFixed(2)}</span>}
              </div>
              {inFlight && (() => {
                const prog = trainingProgress(p);
                return (
                  <div className="mt-2.5">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                        training
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {prog === null
                          ? "starting…"
                          : prog.pct <= 2
                            ? "setting up…"
                            : prog.real
                              ? `${prog.pct}%`
                              : `~${prog.pct}% (estimated)`}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-nori-h14131a/10">
                      <div
                        className="h-full rounded-full bg-nori-hb06a1c transition-[width] duration-1000"
                        style={{ width: `${prog?.pct ?? 2}%` }}
                      />
                    </div>
                  </div>
                );
              })()}
              <div className="mt-3 border-t border-dashed border-border pt-2.5 text-[13px] text-nori-h14131a/70">
                {p.sourceLabel ? (
                  <span>
                    <span className="font-mono text-xs text-muted-foreground">Trained from</span>{" "}
                    <span className="font-mono text-[13px] text-nori-h14131a">◆ {p.sourceLabel}</span>
                  </span>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">Source dataset not recorded</span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {p.state === "live" && runControlFor(p.job_id)}
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
                      setAlsoUnpublish(false);
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
            </>
          )}
        </div>
      </div>

      {reviewing && (
        <EpisodeReviewModal source={reviewing} onClose={() => setReviewing(null)} onChanged={load} />
      )}

      {exporting && (
        <ExportModal dataset={exporting} onClose={() => setExporting(null)} />
      )}

      {assembleOpen && (
        <AssembleModal
          sources={[...picked]}
          datasets={datasetOptions}
          onClose={() => {
            setAssembleOpen(false);
            void load(); // pick up the "uploading to dataset" badge if backgrounded
          }}
          onDone={() => {
            setPicked(new Set());
            void load();
          }}
        />
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
          {deleting?.published && (
            <label className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={alsoUnpublish}
                onChange={(e) => setAlsoUnpublish(e.target.checked)}
              />
              <span>
                Also remove it from the community marketplace.
                <span className="block text-xs text-muted-foreground">
                  Leave unchecked to keep the public listing live — only your personal copy is deleted.
                </span>
              </span>
            </label>
          )}
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
        open={!!deletingRecording}
        onOpenChange={(o) => {
          if (!o && !deleteRecBusy) {
            setDeletingRecording(null);
            setDeleteRecErr(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deletingRecording?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the recording and its original video files from your Nori
              cloud. This can’t be undone. Any datasets you already assembled from it are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteRecErr && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteRecErr}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteRecBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void onDeleteRecording();
              }}
              disabled={deleteRecBusy}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              {deleteRecBusy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={bulkDeleteOpen}
        onOpenChange={(o) => {
          if (!o && !deleteRecBusy) {
            setBulkDeleteOpen(false);
            setDeleteRecErr(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deletablePickedCount} recording{deletablePickedCount === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected recordings and their original video
              files from your Nori cloud. This can’t be undone. Any datasets you already
              assembled from them are kept, and locked recordings are skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteRecErr && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteRecErr}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteRecBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void onBulkDeleteRecordings();
              }}
              disabled={deleteRecBusy}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              {deleteRecBusy ? "Deleting…" : `Delete ${deletablePickedCount}`}
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
              This permanently deletes the trained policy and its checkpoint. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deletingPolicy?.published && (
            <label className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={alsoUnpublish}
                onChange={(e) => setAlsoUnpublish(e.target.checked)}
              />
              <span>
                Also remove it from the community marketplace.
                <span className="block text-xs text-muted-foreground">
                  Leave unchecked to keep the public listing live — only your personal copy is deleted.
                </span>
              </span>
            </label>
          )}
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

    </section>
  );
};

export default MyStuff;
