// NORI: upload a dataset or recording from your machine into your Nori cloud
// (browser-native). Pick the dataset/bundle FOLDER; the browser builds the file
// manifest, opens an upload session, PUTs each file straight to S3 via its presigned
// URL, then finalizes (the backend validates + promotes). Uploaded data is
// provenance='uploaded' — trainable + downloadable but NEVER publishable.
//
// The per-file PUTs go browser -> S3 directly; that needs a bucket CORS rule allowing
// PUT + the SSE header from the app origin (see backend storage/verify_aws_setup.py).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Loader2, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi } from "@/contexts/ApiContext";
import {
  finalizeDatasetUpload,
  getUploadSession,
  putPolicyBundle,
  startDatasetUpload,
  type DatasetUploadEntry,
} from "@/nori/api/client";

type Kind = "lerobot" | "raw_bundle";
type Phase = "form" | "uploading" | "processing" | "done" | "error";

// Mirrors the backend per-kind extension allowlist + sentinel (junk is filtered out
// client-side so we never send a manifest the backend would reject wholesale).
const ALLOWED: Record<Kind, string[]> = {
  lerobot: [".parquet", ".json", ".mp4", ".mkv", ".txt", ".md", ".png", ".jpg"],
  raw_bundle: [".mp4", ".mjpeg", ".ndjson", ".json"],
};
const SENTINEL: Record<Kind, string> = { lerobot: "info.json", raw_bundle: "meta.json" };

function relPath(f: File): string {
  const wk = (f as unknown as { webkitRelativePath?: string }).webkitRelativePath;
  if (wk && wk.includes("/")) return wk.split("/").slice(1).join("/"); // strip the top folder
  return f.name;
}
function allowed(kind: Kind, path: string): boolean {
  const low = path.toLowerCase();
  return ALLOWED[kind].some((ext) => low.endsWith(ext));
}

export function UploadDatasetModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded?: () => void;
}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [kind, setKind] = useState<Kind>("lerobot");
  const [files, setFiles] = useState<File[]>([]);
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  // path -> File, filtered to the selected kind's allowlist.
  const selected = useMemo(() => {
    const m = new Map<string, File>();
    for (const f of files) {
      const p = relPath(f);
      if (allowed(kind, p)) m.set(p, f);
    }
    return m;
  }, [files, kind]);

  const hasSentinel = useMemo(
    () => [...selected.keys()].some((p) => p.toLowerCase().endsWith(SENTINEL[kind])),
    [selected, kind]
  );

  const submit = useCallback(async () => {
    setError(null);
    if (selected.size === 0) {
      setError("Pick your dataset/recording folder first.");
      return;
    }
    if (!hasSentinel) {
      setError(kind === "lerobot"
        ? "That folder doesn't look like a LeRobot dataset (no meta/info.json)."
        : "That folder doesn't look like a recording bundle (no meta.json).");
      return;
    }
    setPhase("uploading");
    try {
      const manifest: DatasetUploadEntry[] = [...selected].map(([path, f]) => ({ path, size: f.size }));
      const start = await startDatasetUpload(baseUrl, fetchWithHeaders, {
        manifest,
        kind,
        label: label.trim() || null,
      });
      if (cancelled.current) return;
      setProgress({ done: 0, total: start.uploads.length });
      let done = 0;
      for (const up of start.uploads) {
        if (cancelled.current) return;
        const f = selected.get(up.path);
        if (!f) throw new Error(`No local file for ${up.path}`);
        await putPolicyBundle(up.put_url, f); // generic presigned-PUT (SSE header)
        done += 1;
        setProgress({ done, total: start.uploads.length });
      }
      setPhase("processing");
      await finalizeDatasetUpload(baseUrl, fetchWithHeaders, start.session_id);
      for (;;) {
        if (cancelled.current) return;
        await new Promise((r) => setTimeout(r, 2500));
        if (cancelled.current) return;
        const s = await getUploadSession(baseUrl, fetchWithHeaders, start.session_id);
        if (s.status === "PROMOTED") {
          setPhase("done");
          onUploaded?.();
          return;
        }
        if (s.status === "FAILED") {
          setError(s.failure_reason || "Upload was rejected by validation.");
          setPhase("error");
          return;
        }
      }
    } catch (e) {
      if (cancelled.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [selected, hasSentinel, kind, label, baseUrl, fetchWithHeaders, onUploaded]);

  const kindBtn = (k: Kind, text: string) => (
    <button
      type="button"
      onClick={() => setKind(k)}
      className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
        kind === k ? "border-nori-h14131a bg-secondary font-medium text-nori-h14131a"
                   : "border-border text-muted-foreground"
      }`}
    >
      {text}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-[20px] bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-nori-h14131a">Upload from your machine</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-nori-h14131a" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          A LeRobot <span className="font-medium text-nori-h14131a">dataset</span> or a raw{" "}
          <span className="font-medium text-nori-h14131a">recording</span> folder. Stays private to
          you — trainable and downloadable, but not publishable.
        </p>

        {phase === "form" && (
          <div className="mt-5 flex flex-col gap-3">
            <div className="flex gap-2">
              {kindBtn("lerobot", "Dataset (LeRobot)")}
              {kindBtn("raw_bundle", "Recording (raw)")}
            </div>
            <div>
              <Label htmlFor="ds-folder">Folder</Label>
              <Input
                id="ds-folder"
                type="file"
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {selected.size > 0
                  ? `${selected.size} file(s) selected${hasSentinel ? "" : " · missing " + SENTINEL[kind]}`
                  : "Pick the dataset/bundle root folder."}
              </p>
            </div>
            <div>
              <Label htmlFor="ds-label">Name</Label>
              <Input id="ds-label" value={label} onChange={(e) => setLabel(e.target.value)}
                placeholder={kind === "lerobot" ? "My dataset" : "My recording"} />
            </div>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button onClick={submit} disabled={selected.size === 0} className="mt-1 w-full gap-2">
              <UploadCloud className="h-4 w-4" /> Upload
            </Button>
          </div>
        )}

        {phase === "uploading" && (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-nori-h14131a" />
            <p className="text-sm text-muted-foreground">
              Uploading {progress.done}/{progress.total} files…
            </p>
          </div>
        )}

        {phase === "processing" && (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-nori-h14131a" />
            <p className="text-sm text-muted-foreground">Validating + promoting in your cloud…</p>
          </div>
        )}

        {phase === "done" && (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="h-7 w-7 text-green-600" />
            <p className="text-sm text-nori-h14131a">
              {kind === "lerobot" ? "Dataset" : "Recording"} uploaded — it's in My Stuff now.
            </p>
            <Button onClick={onClose} className="w-full">Done</Button>
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPhase("form")}>Back</Button>
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
