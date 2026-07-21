// NORI: "Publish something to the community" — the ONE place anything gets
// published (per-policy publish forms are removed; cards/detail keep status
// chips + withdraw only). Flow: choose WHAT (policy | dataset) → choose the
// item (datasets from the same sources as the training page: Nori cloud, or
// import from this laptop / your HF — open datasets are excluded, they're
// already public and not yours) → a summary of the selection appears as
// confirmation → title/description/consent → publish. Server-side each kind
// runs its own safety pipeline: policies are sanitized + class-validated +
// safetensors-gated; datasets are re-homed + media/tabular format-gated.
// Both auto-publish (no manual review).

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import {
  getPolicyDetails,
  grantConsent,
  isDirectBackend,
  listMyDatasets,
  listMyListings,
  listPolicies,
  publishDataset,
  publishPolicy,
  uploadDataset,
  type MyDataset,
  type PolicyDetails,
  type PolicyListEntry,
} from "@/nori/api/client";
import { listDatasets } from "@/lib/replayApi";
import { DatasetCapture, type CaptureDatasetEntry } from "@/nori/remote/datasetCapture";
import { Pill } from "@/components/ui/pill";
import { fmtBytes } from "@/nori/pages/marketplace";

type Kind = "policy" | "dataset";
type DatasetSource = "nori" | "import";

const FIELD =
  "w-full rounded-xl border border-input bg-background px-3 py-2 text-[14px] focus:outline-none focus:shadow-[0_0_0_3px_hsl(var(--nori-hffe9a8))]";

const SummaryRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4 py-0.5">
    <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
      {label}
    </span>
    <span className="text-right font-mono text-[12px] text-foreground">{value}</span>
  </div>
);

/** The confirmation block shown under the picker once something is selected. */
const SelectionSummary = ({ rows }: { rows: [string, string][] }) => (
  <div className="rounded-xl border border-border bg-secondary/60 px-3 py-2">
    {rows.map(([l, v]) => (
      <SummaryRow key={l} label={l} value={v} />
    ))}
  </div>
);

const CommunityPublishCard = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const hosted = isDirectBackend();

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null); // must be chosen first

  // -- policy source: own policies + their listing states ---------------------
  const [ownPolicies, setOwnPolicies] = useState<PolicyListEntry[]>([]);
  const [listingByJob, setListingByJob] = useState<Record<string, string>>({});
  const [selPolicy, setSelPolicy] = useState("");
  const [policyDetails, setPolicyDetails] = useState<PolicyDetails | null>(null);

  // -- dataset sources (mirrors the training page, minus open datasets) -------
  const [dsSource, setDsSource] = useState<DatasetSource>("nori");
  const [uploads, setUploads] = useState<MyDataset[]>([]);
  const [selUpload, setSelUpload] = useState("");
  const [importable, setImportable] = useState<{ repo: string; source: string }[]>([]);
  const [localStats, setLocalStats] = useState<Record<string, CaptureDatasetEntry>>({});
  const [selImport, setSelImport] = useState("");

  // -- shared publish form -----------------------------------------------------
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [needsConsent, setNeedsConsent] = useState(false);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // progress line while working
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false); // public-publish confirmation gate

  useEffect(() => {
    if (!open) return;
    listPolicies(baseUrl, fetchWithHeaders)
      .then((rows) =>
        setOwnPolicies(
          rows.filter(
            (p) =>
              p.source === "own" &&
              (p as PolicyListEntry & { kind?: string }).kind !== "dataset"
          )
        )
      )
      .catch(() => setOwnPolicies([]));
    listMyListings(baseUrl, fetchWithHeaders)
      .then((rows) => {
        const m: Record<string, string> = {};
        for (const l of rows) {
          if (l.source_job_id && (l.in_review || l.is_public)) m[l.source_job_id] = l.status;
        }
        setListingByJob(m);
      })
      .catch(() => setListingByJob({}));
    listMyDatasets(baseUrl, fetchWithHeaders)
      // Own uploads only — acquired community datasets are someone else's to publish.
      .then((rows) => setUploads(rows.filter((d) => d.source !== "community")))
      .catch(() => setUploads([]));
    if (!hosted) {
      listDatasets(baseUrl, fetchWithHeaders)
        .then((rows) => setImportable(rows.map((d) => ({ repo: d.repo_id, source: d.source }))))
        .catch(() => {});
      DatasetCapture.listDatasets(baseUrl)
        .then((rows) => {
          const m: Record<string, CaptureDatasetEntry> = {};
          for (const r of rows) m[r.repo_id] = r;
          setLocalStats(m);
        })
        .catch(() => {});
    }
  }, [open, baseUrl, fetchWithHeaders, hosted]);

  // Policy summary loads on selection (details = class/date/files/training set).
  useEffect(() => {
    setPolicyDetails(null);
    if (!selPolicy) return;
    let cancelled = false;
    getPolicyDetails(baseUrl, fetchWithHeaders, selPolicy)
      .then((d) => !cancelled && setPolicyDetails(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selPolicy, baseUrl, fetchWithHeaders]);

  const pickKind = (k: Kind) => {
    setKind(k);
    setErr(null);
    setDone(null);
  };

  const seedTitle = (raw: string) => {
    if (!title.trim()) setTitle(raw.replace(/^Upload\s+/, "Dataset ").replace(/[_-]+/g, " "));
  };

  const summaryRows = (): [string, string][] | null => {
    if (kind === "policy" && selPolicy) {
      const p = ownPolicies.find((x) => x.ref === selPolicy);
      if (!p) return null;
      const rows: [string, string][] = [["policy", p.title]];
      if (policyDetails) {
        if (policyDetails.policy_class) rows.push(["class", policyDetails.policy_class]);
        rows.push(["trained", policyDetails.created_at.slice(0, 10)]);
        if (policyDetails.dataset_repo) rows.push(["trained on", policyDetails.dataset_repo]);
        if (policyDetails.files?.length) {
          const total = policyDetails.files.reduce((n, f) => n + (f.size_bytes ?? 0), 0);
          rows.push(["bundle", `${policyDetails.files.length} files · ${fmtBytes(total)}`]);
        }
      }
      return rows;
    }
    if (kind === "dataset" && dsSource === "nori" && selUpload) {
      const u = uploads.find((x) => x.session_id === selUpload);
      if (!u) return null;
      return [
        ["dataset", u.label],
        ["where", "your Nori cloud"],
        ["uploaded", u.created_at.slice(0, 10)],
      ];
    }
    if (kind === "dataset" && dsSource === "import" && selImport) {
      const entry = importable.find((x) => x.repo === selImport);
      if (!entry) return null;
      const rows: [string, string][] = [
        ["dataset", entry.repo],
        ["where", entry.source === "hub" ? "your Hugging Face" : "this laptop"],
      ];
      const stats = localStats[entry.repo];
      if (stats) {
        rows.push(["contents", `${stats.episodes} episodes · ${stats.frames} frames`]);
        if (stats.fps) rows.push(["fps", String(stats.fps)]);
      }
      rows.push(["note", "will be imported to your Nori cloud first"]);
      return rows;
    }
    return null;
  };

  const canSubmit =
    !busy &&
    title.trim().length >= 3 &&
    (!needsConsent || consented) &&
    ((kind === "policy" && !!selPolicy) ||
      (kind === "dataset" && dsSource === "nori" && !!selUpload) ||
      (kind === "dataset" && dsSource === "import" && !!selImport));

  const submit = async () => {
    setErr(null);
    try {
      if (needsConsent && consented) {
        setBusy("granting consent…");
        await grantConsent(baseUrl, fetchWithHeaders, "publish_public");
        setNeedsConsent(false);
      }
      if (kind === "policy") {
        setBusy("publishing policy…");
        const l = await publishPolicy(baseUrl, fetchWithHeaders, selPolicy, title.trim(), desc.trim() || null);
        setDone(l.title);
        setSelPolicy("");
      } else if (dsSource === "nori") {
        setBusy("publishing dataset…");
        const l = await publishDataset(baseUrl, fetchWithHeaders, selUpload, title.trim(), desc.trim() || null);
        setDone(l.title);
        setSelUpload("");
      } else {
        // Import-first path: copy the local/HF dataset into Nori cloud (the
        // existing blocking upload), then publish the promoted session.
        setBusy("importing to your Nori cloud… (this can take a while)");
        const session = await uploadDataset(baseUrl, fetchWithHeaders, selImport);
        if (session.status !== "PROMOTED") {
          throw new Error(`import did not promote (status: ${session.status})`);
        }
        setBusy("publishing dataset…");
        const l = await publishDataset(baseUrl, fetchWithHeaders, session.id, title.trim(), desc.trim() || null);
        setDone(l.title);
        setSelImport("");
      }
      setTitle("");
      setDesc("");
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) {
        setNeedsConsent(true);
        setErr("Publishing needs the ‘share publicly’ consent — tick the box below and retry.");
      } else if (status === 409) {
        setErr("This item already has an active listing (or an account deletion is in flight).");
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(null);
    }
  };

  const rows = summaryRows();

  return (
    <div className="mt-6 rounded-[24px] border border-border bg-background p-5 shadow-soft md:p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div>
          <div className="eyebrow">{"// share your work"}</div>
          <h3 className="mt-1 font-display text-[1.5rem] font-normal leading-tight tracking-tight">
            Publish something to the community
          </h3>
        </div>
        <span className="eyebrow shrink-0 text-foreground">{open ? "close ✕" : "share →"}</span>
      </button>

      {open && (
        <div className="mt-5 space-y-3">
          {/* Step 1: WHAT is being published — nothing else renders until chosen. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-1">{"// publish a"}</span>
            <Pill size="sm" active={kind === "policy"} onClick={() => pickKind("policy")}>
              Policy
            </Pill>
            <Pill size="sm" active={kind === "dataset"} onClick={() => pickKind("dataset")}>
              Dataset
            </Pill>
          </div>

          {kind === "policy" && (
            <div>
              <label className="eyebrow" htmlFor="pub-policy">
                {"// your trained policies"}
              </label>
              <select
                id="pub-policy"
                value={selPolicy}
                onChange={(e) => {
                  setSelPolicy(e.target.value);
                  setDone(null);
                  const p = ownPolicies.find((x) => x.ref === e.target.value);
                  if (p) seedTitle(p.title);
                }}
                className={`mt-1 ${FIELD}`}
              >
                <option value="">Choose one of your policies…</option>
                {ownPolicies.map((p) => (
                  <option key={p.ref} value={p.ref} disabled={!!listingByJob[p.ref]}>
                    {p.title}
                    {listingByJob[p.ref] ? ` — already ${listingByJob[p.ref]}` : ""}
                  </option>
                ))}
              </select>
              {ownPolicies.length === 0 && (
                <p className="mt-1 text-[12.5px] text-muted-foreground">
                  No trained policies yet — train one from the Training page first.
                </p>
              )}
            </div>
          )}

          {kind === "dataset" && (
            <>
              {/* Same sources as the training page (minus Open datasets — those
                  are already public and not yours to publish). */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="eyebrow mr-1">{"// from"}</span>
                <Pill size="sm" active={dsSource === "nori"} onClick={() => setDsSource("nori")}>
                  Nori cloud
                </Pill>
                {!hosted && (
                  <Pill size="sm" active={dsSource === "import"} onClick={() => setDsSource("import")}>
                    Import (laptop / HF)
                  </Pill>
                )}
              </div>

              {dsSource === "nori" ? (
                <select
                  value={selUpload}
                  onChange={(e) => {
                    setSelUpload(e.target.value);
                    setDone(null);
                    const u = uploads.find((x) => x.session_id === e.target.value);
                    if (u) seedTitle(u.label);
                  }}
                  className={FIELD}
                >
                  <option value="">Choose one of your Nori cloud datasets…</option>
                  {uploads.map((u) => (
                    <option key={u.session_id} value={u.session_id}>
                      {u.label}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={selImport}
                  onChange={(e) => {
                    setSelImport(e.target.value);
                    setDone(null);
                    if (e.target.value) seedTitle(e.target.value);
                  }}
                  className={FIELD}
                >
                  <option value="">Choose a dataset to import + publish…</option>
                  {importable.map((d) => (
                    <option key={d.repo} value={d.repo}>
                      {d.repo}
                      {d.source === "hub" ? " · HF" : d.source === "both" ? " · local + HF" : " · local"}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}

          {/* Step 2: the confirmation summary of what was selected. */}
          {rows && <SelectionSummary rows={rows} />}

          {rows && (
            <>
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
                placeholder={
                  kind === "policy"
                    ? "What does this policy do? Task, robot, tips… (shown to others)"
                    : "What's in this dataset? Task, robot, camera setup… (shown to others)"
                }
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
                  I have the rights to this content and consent to publishing it publicly
                  (grants the ‘publish_public’ consent; revocable — revoking takes my
                  shared items down).
                </label>
              )}

              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!canSubmit}
                className="w-full rounded-xl border border-border bg-secondary px-3 py-2 font-mono text-[12px] hover:bg-accent disabled:opacity-50"
              >
                {busy ??
                  (kind === "dataset" && dsSource === "import"
                    ? "import to Nori, then publish →"
                    : "publish to community →")}
              </button>

              {confirming && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                  onClick={() => setConfirming(false)}
                >
                  <div
                    className="w-full max-w-md rounded-[20px] bg-card p-6 shadow-xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <h2 className="text-lg font-bold text-foreground">Publish to the community?</h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                      This makes your {kind === "policy" ? "policy" : "dataset"} — <span className="font-medium text-foreground">including all of its data</span> — public
                      to everyone on the community marketplace: anyone can view, add it to their
                      cloud, and {kind === "policy" ? "deploy" : "train on"} it.
                    </p>
                    <p className="mt-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
                      You can <span className="font-medium text-foreground">unpublish it at any time</span> — that takes the listing down
                      and revokes access. (Copies others already added to their own cloud stay with them.)
                    </p>
                    <div className="mt-5 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        className="rounded-xl border border-border px-3 py-2 font-mono text-[12px] hover:bg-accent"
                      >
                        cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirming(false);
                          void submit();
                        }}
                        className="rounded-xl border border-border bg-foreground px-3 py-2 font-mono text-[12px] text-background hover:opacity-90"
                      >
                        make it public →
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Each kind runs its own server-side safety pipeline. */}
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                {kind === "policy"
                  ? "Your policy bundle is privacy-sanitized (training configs stripped, metadata scrubbed), class-validated, weights-format-gated (safetensors only), copied to a neutral repo, and becomes public — no manual review. This is immediate and public."
                  : "Your dataset is copied to a neutral repo, automatically safety-scanned (media/tabular files only), and becomes public — no manual review. This is immediate and public."}
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

export default CommunityPublishCard;
