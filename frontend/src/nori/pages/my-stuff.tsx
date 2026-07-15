// NORI: My Stuff — the customer's library. Everything captured, uploaded, and
// trained, with the dataset→policy lineage the backend joins in GET /library.
// Datasets column: local recordings ("on this laptop") + promoted uploads
// (each showing what it trained). Policies column: every trained policy with a
// chip back to its source dataset; hovering a policy highlights that dataset.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { useNori } from "@/nori/NoriContext";
import {
  getLibrary,
  uploadDataset,
  type Library,
  type LibraryDataset,
  type LibraryPolicy,
} from "@/nori/api/client";
import { DatasetCapture, type CaptureDatasetEntry } from "@/nori/remote/datasetCapture";

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

  const visualize = (datasetRef: string, repoId: string) => {
    // Reuse LeLab's LeRobot dataset viewer (the HF Space), same as Upload.tsx.
    const path = `/spaces/lerobot/visualize_dataset?path=${encodeURIComponent(`/${repoId}`)}`;
    window.open(`https://huggingface.co/login?next=${encodeURIComponent(path)}`, "_blank", "noopener,noreferrer");
  };

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
                  <p className="text-base font-bold text-[#14131a]">{d.repo_id}</p>
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
                  <div>
                    <p className="text-base font-bold text-[#14131a]">{d.label}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">Uploaded {shortDate(d.created_at)}</p>
                  </div>
                  <Pill tone="leaf">Uploaded</Pill>
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
                  <Button size="sm" variant="outline" onClick={() => visualize(d.dataset_ref, d.dataset_ref)}>
                    Visualize episodes
                  </Button>
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

          {allPolicies.map((p) => (
            <article
              key={p.job_id}
              className={cardCls}
              onMouseEnter={() => setActiveRef(p.sourceRef)}
              onMouseLeave={() => setActiveRef(null)}
              onFocus={() => setActiveRef(p.sourceRef)}
              onBlur={() => setActiveRef(null)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <p className="text-base font-bold text-[#14131a]">
                    {p.sourceLabel ?? "Policy"}
                  </p>
                  {p.policy_class && <Pill tone="accent">{p.policy_class.toUpperCase()}</Pill>}
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
                {p.state === "paused" && <Button size="sm" onClick={() => navigate("/nori/training")}>Resume training</Button>}
              </div>
            </article>
          ))}
        </div>
      </div>

      {!leLabAvailable && (
        <p className="font-mono text-xs text-muted-foreground">
          Local recordings aren't shown on the hosted app — open My Stuff in the desktop app to manage captures.
        </p>
      )}
    </section>
  );
};

export default MyStuff;
