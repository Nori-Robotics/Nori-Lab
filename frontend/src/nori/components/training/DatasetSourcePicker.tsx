// NORI: Additive file. The training form's dataset-source picker — one panel,
// three sources the user toggles between (design: PROJECTS_DESIGN.md §3c):
//
//   · Nori cloud       — promoted uploads in the customer's Nori account (the
//                        backend's dataset_ref; default source, zero config)
//   · Import           — datasets LeLab can copy INTO the Nori account: ones
//                        recorded on this laptop's disk AND ones in the user's
//                        personal HF account (which Nori's servers can't reach)
//   · Open datasets    — Nori's published public catalog (open_dataset_id);
//                        works before the user has recorded/uploaded anything
//
// Selection writes config.dataset_ref / config.open_dataset_id (mutually
// exclusive — the setter clears the other). Importing (upload) is LeLab-only:
// the hosted app hides those controls with a desktop-app hint.

import { useCallback, useEffect, useState } from "react";
import { Loader2, UploadCloud } from "lucide-react";

import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Panel from "@/nori/components/Panel";
import {
  isDirectBackend,
  listMyDatasets,
  listPublicDatasets,
  uploadDataset,
  type MaybeDeduplicated,
  type PublicDataset,
} from "@/nori/api/client";
import { listDatasets } from "@/lib/replayApi";
import type { NoriTrainingFormState } from "./types";

const LABEL = "text-[#14131a]/70";
const FIELD = "border-[#14131a]/15 bg-white text-[#14131a] rounded-md";
const LATEST = "__latest__"; // sentinel for "use my latest promoted upload"

type SourceKind = "nori" | "hf" | "open";

const SOURCES: { kind: SourceKind; label: string }[] = [
  { kind: "nori", label: "Nori cloud" },
  { kind: "hf", label: "Import (laptop / HF)" },
  { kind: "open", label: "Open datasets" },
];

export interface DatasetSourcePickerProps {
  config: NoriTrainingFormState;
  updateConfig: <T extends keyof NoriTrainingFormState>(
    key: T,
    value: NoriTrainingFormState[T],
  ) => void;
}

const DatasetSourcePicker = ({ config, updateConfig }: DatasetSourcePickerProps) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const hosted = isDirectBackend();

  // Initial tab from config so a round-trip through the monitor keeps state.
  const [source, setSource] = useState<SourceKind>(
    config.open_dataset_id ? "open" : "nori",
  );

  // Mutually exclusive selection: setting one side always clears the other.
  const selectNori = (ref: string | undefined) => {
    updateConfig("open_dataset_id", undefined);
    updateConfig("dataset_ref", ref);
  };
  const selectOpen = (id: string) => {
    updateConfig("dataset_ref", undefined);
    updateConfig("open_dataset_id", id);
  };
  const switchSource = (kind: SourceKind) => {
    setSource(kind);
    // Leaving the open tab reverts to "latest Nori upload" so the dispatch
    // never silently trains on an open dataset the form no longer shows.
    if (kind !== "open" && config.open_dataset_id) selectNori(undefined);
  };

  // -- Nori cloud: the customer's promoted uploads -------------------------------
  type MyRow = {
    ref: string;
    label: string;
    source?: string;
    createdAt: string;
    episodeCount?: number | null;
    frameCount?: number | null;
  };
  const [myDatasets, setMyDatasets] = useState<MyRow[]>([]);
  const refreshMyDatasets = useCallback(() => {
    listMyDatasets(baseUrl, fetchWithHeaders)
      .then((rows) =>
        setMyDatasets(
          rows.map((d) => ({
            ref: d.dataset_ref,
            label: d.label,
            source: d.source,
            createdAt: d.created_at,
            episodeCount: d.episode_count,
            frameCount: d.frame_count,
          })),
        ),
      )
      .catch(() => {
        // No uploads yet / transient — the "Latest" default still dispatches.
      });
  }, [baseUrl, fetchWithHeaders]);
  useEffect(() => refreshMyDatasets(), [refreshMyDatasets]);

  // -- Import: local-disk + personal-HF datasets LeLab can copy into Nori --------
  const [uploadable, setUploadable] = useState<{ repo: string; source: string }[]>([]);
  const [selectedImport, setSelectedImport] = useState<string>("");
  const [hfRepoInput, setHfRepoInput] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (hosted) return; // LeLab-only listing; hosted app shows the hint instead
    let cancelled = false;
    listDatasets(baseUrl, fetchWithHeaders)
      .then((rows) => {
        if (!cancelled) setUploadable(rows.map((d) => ({ repo: d.repo_id, source: d.source })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, hosted]);

  const handleImport = async () => {
    const repo = hfRepoInput.trim() || selectedImport;
    if (!repo) return;
    setUploading(true);
    try {
      const session = await uploadDataset(baseUrl, fetchWithHeaders, repo);
      if (session.status === "PROMOTED") {
        const dup = !!(session as MaybeDeduplicated).deduplicated;
        toast({
          title: dup ? "Already in your Nori cloud" : "Dataset imported to Nori",
          description: dup ? `${repo} is unchanged since its last upload` : repo,
        });
        setHfRepoInput("");
        refreshMyDatasets();
        // Select the fresh upload and land the user on the tab that shows it.
        if (session.hf_path_prefix) selectNori(session.hf_path_prefix);
        setSource("nori");
      } else {
        toast({ title: "Import finished", description: `status: ${session.status}` });
      }
    } catch (e) {
      toast({
        title: "Import failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  // -- Open datasets: Nori's published catalog -----------------------------------
  const [openDatasets, setOpenDatasets] = useState<PublicDataset[]>([]);
  const [openLoaded, setOpenLoaded] = useState(false);
  useEffect(() => {
    if (source !== "open" || openLoaded) return;
    listPublicDatasets(baseUrl, fetchWithHeaders)
      .then((rows) => {
        setOpenDatasets(rows);
        setOpenLoaded(true);
      })
      .catch(() => setOpenLoaded(true));
  }, [source, openLoaded, baseUrl, fetchWithHeaders]);

  // The dataset whose summary to show under the Nori-cloud picker. An undefined
  // dataset_ref means "Latest upload (default)" → the newest row (backend orders
  // desc), so the card still reflects what will actually train.
  const selectedNori =
    config.dataset_ref === undefined
      ? myDatasets[0]
      : myDatasets.find((d) => d.ref === config.dataset_ref);
  const isLatest = config.dataset_ref === undefined;

  return (
    <Panel eyebrow="dataset" title="Choose training data">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {SOURCES.map((s) => (
            <Pill key={s.kind} size="sm" active={source === s.kind} onClick={() => switchSource(s.kind)}>
              {s.label}
            </Pill>
          ))}
        </div>

        {source === "nori" && (
          <div>
            <Label className={LABEL}>Dataset</Label>
            <Select
              value={config.dataset_ref ?? LATEST}
              onValueChange={(v) => selectNori(v === LATEST ? undefined : v)}
            >
              <SelectTrigger className={`mt-1 ${FIELD}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LATEST}>Latest upload (default)</SelectItem>
                {myDatasets.map((d) => (
                  <SelectItem key={d.ref} value={d.ref}>
                    {d.label}
                    {d.source === "community" ? " · acquired" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selectedNori && (
              <div className="mt-3 rounded-xl border border-[#14131a]/12 bg-[#14131a]/[0.02] px-3.5 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-[#14131a]">
                    {selectedNori.label}
                  </span>
                  {isLatest && (
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#b06a1c]">
                      latest
                    </span>
                  )}
                </div>
                {selectedNori.source === "community" ? (
                  <p className="mt-1 text-xs text-[#14131a]/55">
                    Acquired from the marketplace.
                  </p>
                ) : selectedNori.episodeCount != null || selectedNori.frameCount != null ? (
                  <p className="mt-1 text-xs tabular-nums text-[#14131a]/60">
                    {selectedNori.episodeCount != null && (
                      <>
                        <b className="font-semibold text-[#14131a]">
                          {selectedNori.episodeCount.toLocaleString()}
                        </b>{" "}
                        {selectedNori.episodeCount === 1 ? "episode" : "episodes"}
                      </>
                    )}
                    {selectedNori.episodeCount != null &&
                      selectedNori.frameCount != null &&
                      " · "}
                    {selectedNori.frameCount != null && (
                      <>
                        <b className="font-semibold text-[#14131a]">
                          {selectedNori.frameCount.toLocaleString()}
                        </b>{" "}
                        frames
                      </>
                    )}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-[#14131a]/45">
                    Episode counts weren't recorded for this upload.
                  </p>
                )}
                <p className="mt-0.5 text-[11px] text-[#14131a]/40">
                  Uploaded {new Date(selectedNori.createdAt).toLocaleDateString()}
                </p>
              </div>
            )}

            <p className="mt-2 text-xs text-[#14131a]/50">
              Datasets stored in your Nori account — uploaded from your robot,
              imported from this laptop or your HF account (Import tab), or acquired from the
              marketplace (shown as “Community · …”).
            </p>
          </div>
        )}

        {source === "hf" && (
          <div className="space-y-3">
            <p className="text-sm text-[#14131a]/70">
              Bring a dataset into your Nori account: one recorded on this laptop
              (marked <span className="font-mono text-xs">local</span>) or one from your
              personal Hugging Face account (marked <span className="font-mono text-xs">HF</span>).
              Nori's servers can't reach your personal HF or your disk, so importing
              copies it — it then appears under Nori cloud and trains from there.
            </p>
            {hosted ? (
              <p className="rounded-md border border-[#14131a]/10 bg-[#14131a]/[0.03] px-3 py-2 text-sm text-[#14131a]/60">
                Importing needs the desktop app — the datasets live on your laptop's
                disk or in your personal HF account, and only the desktop app can
                read them to copy into Nori.
              </p>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Label className={LABEL}>On this laptop / your HF</Label>
                  <Select
                    value={selectedImport}
                    onValueChange={(v) => {
                      setSelectedImport(v);
                      setHfRepoInput(""); // dropdown pick clears any pasted repo
                    }}
                  >
                    <SelectTrigger className={`mt-1 ${FIELD}`}>
                      <SelectValue placeholder={uploadable.length ? "Choose a dataset" : "No datasets found"} />
                    </SelectTrigger>
                    <SelectContent>
                      {uploadable.map((d) => (
                        <SelectItem key={d.repo} value={d.repo}>
                          {d.repo}
                          {d.source === "hub" ? " · HF" : d.source === "both" ? " · local + HF" : " · local"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1">
                  <Label className={LABEL}>or an HF dataset repo id</Label>
                  <Input
                    value={hfRepoInput}
                    onChange={(e) => setHfRepoInput(e.target.value)}
                    placeholder="username/dataset"
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={handleImport}
                  disabled={uploading || (!hfRepoInput.trim() && !selectedImport)}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing…
                    </>
                  ) : (
                    <>
                      <UploadCloud className="mr-2 h-4 w-4" /> Import to Nori
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}

        {source === "open" && (
          <div className="space-y-2">
            <p className="text-sm text-[#14131a]/70">
              Public datasets published by Nori — train a policy before you've
              recorded anything of your own.
            </p>
            {!openLoaded ? (
              <p className="text-sm text-[#14131a]/50">Loading…</p>
            ) : openDatasets.length === 0 ? (
              <p className="text-sm text-[#14131a]/50">No open datasets published yet.</p>
            ) : (
              <div className="space-y-2">
                {openDatasets.map((d) => {
                  const active = config.open_dataset_id === d.id;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => selectOpen(d.id)}
                      className={`block w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                        active
                          ? "border-[#14131a] bg-[#14131a]/[0.04]"
                          : "border-[#14131a]/15 bg-white hover:bg-[#14131a]/[0.02]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-[#14131a]">{d.title}</span>
                        {d.license && (
                          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#14131a]/50">
                            {d.license}
                          </span>
                        )}
                      </div>
                      {d.description && (
                        <p className="mt-0.5 text-xs text-[#14131a]/60">{d.description}</p>
                      )}
                      <p className="mt-0.5 font-mono text-[11px] text-[#14131a]/40">{d.hf_repo}</p>
                    </button>
                  );
                })}
              </div>
            )}
            {config.open_dataset_id === undefined && openDatasets.length > 0 && (
              <p className="text-xs text-[#14131a]/50">Pick a dataset to train on it.</p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
};

export default DatasetSourcePicker;
