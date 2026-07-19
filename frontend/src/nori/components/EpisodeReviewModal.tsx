// NORI: Episode review + curation modal. Play each episode of a dataset in the
// browser and (LOCAL datasets only) delete the bad takes before training.
//
// Two sources:
//   * LOCAL — a dataset in this laptop's lerobot cache. lelab transcodes AV1→H.264
//             on demand (no HuggingFace login). Supports view + delete.
//   * CLOUD — a promoted upload in your Nori account, viewable from anywhere
//             (hosted app included). The backend serves a preview clip if one
//             exists, else transcodes on demand. View-only for now.
//
// Clips load lazily (only the ones you play are fetched/transcoded).

import { useCallback, useEffect, useState } from "react";
import { Loader2, X, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { useNori } from "@/nori/NoriContext";
import {
  listEpisodes,
  listCloudEpisodes,
  deleteEpisodes,
  episodeClipUrl,
  cloudEpisodeClipUrl,
  episodeThumbUrl,
  cloudEpisodeThumbUrl,
  type DatasetEpisode,
} from "@/nori/remote/episodeReview";

/** What the modal is reviewing: a local lerobot-cache dataset, or a promoted
 * cloud upload (keyed by its upload session id). */
export type ReviewSource =
  | { kind: "local"; repoId: string }
  | { kind: "cloud"; sessionId: string; title: string };

export function EpisodeReviewModal({
  source,
  onClose,
  onChanged,
}: {
  source: ReviewSource;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { config } = useNori();
  const backendBase = config?.noriBackendUrl ?? "";

  const isCloud = source.kind === "cloud";
  const title = source.kind === "local" ? source.repoId : source.title;

  const [episodes, setEpisodes] = useState<DatasetEpisode[] | null>(null);
  const [cameras, setCameras] = useState<string[]>([]);
  const [camera, setCamera] = useState<string | null>(null);
  const [clipToken, setClipToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [playing, setPlaying] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const listing = isCloud
        ? await listCloudEpisodes(baseUrl, fetchWithHeaders, source.sessionId)
        : await listEpisodes(baseUrl, source.repoId);
      setEpisodes(listing.episodes);
      setCameras(listing.cameras);
      setCamera((c) => c ?? listing.cameras[0] ?? null);
      if ("token" in listing) setClipToken(listing.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // source is a stable object per open; deps cover the fields we read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, fetchWithHeaders, isCloud, source]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const clipSrc = (index: number): string | undefined => {
    if (isCloud) {
      if (!clipToken || !backendBase) return undefined;
      return cloudEpisodeClipUrl(backendBase, source.sessionId, index, clipToken, camera ?? undefined);
    }
    return episodeClipUrl(baseUrl, source.repoId, index, camera ?? undefined);
  };

  const thumbSrc = (index: number): string | undefined => {
    if (isCloud) {
      if (!clipToken || !backendBase) return undefined;
      return cloudEpisodeThumbUrl(backendBase, source.sessionId, index, clipToken, camera ?? undefined);
    }
    return episodeThumbUrl(baseUrl, source.repoId, index, camera ?? undefined);
  };

  const toggleMark = (i: number) =>
    setMarked((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  const doDelete = useCallback(async () => {
    if (source.kind !== "local") return;
    setBusy(true);
    try {
      const res = await deleteEpisodes(baseUrl, source.repoId, [...marked]);
      setMarked(new Set());
      setConfirm(false);
      onChanged();
      if (res.remaining === 0) {
        onClose();
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, source, marked, onChanged, onClose, load]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-4xl rounded-[24px] border border-border bg-card shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <p className="eyebrow">Review episodes{isCloud ? " · cloud" : ""}</p>
            <h2 className="text-xl font-bold text-nori-h14131a">{title}</h2>
          </div>
          {cameras.length > 1 && (
            <div className="flex items-center gap-1 rounded-full bg-secondary p-1">
              {cameras.map((c) => (
                <button
                  key={c}
                  onClick={() => setCamera(c)}
                  className={`rounded-full px-3 py-1 font-mono text-[11px] transition-colors ${
                    camera === c ? "bg-card text-nori-h14131a shadow-soft" : "text-muted-foreground hover:text-nori-h14131a"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <button aria-label="Close" className="rounded-lg p-1.5 hover:bg-secondary" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto p-5">
          {error && (
            <p className="mb-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {!episodes && !error && (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="mr-3 h-5 w-5 animate-spin" /> Loading episodes…
            </div>
          )}
          {episodes && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {episodes.map((ep) => {
                const isMarked = marked.has(ep.index);
                return (
                  <div
                    key={ep.index}
                    className={`overflow-hidden rounded-2xl border bg-background transition-colors ${
                      isMarked ? "border-destructive ring-2 ring-destructive/40" : "border-border"
                    }`}
                  >
                    <div className="relative aspect-video bg-secondary">
                      {playing.has(ep.index) ? (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video
                          key={`${ep.index}-${camera}`}
                          className="h-full w-full object-cover"
                          src={clipSrc(ep.index)}
                          controls
                          autoPlay
                          muted
                        />
                      ) : (
                        <button
                          className="group flex h-full w-full items-center justify-center text-nori-h14131a/60 hover:text-nori-h14131a"
                          onClick={() => setPlaying((s) => new Set(s).add(ep.index))}
                          aria-label={`Play episode ${ep.index}`}
                        >
                          {thumbSrc(ep.index) && (
                            <img
                              key={`${ep.index}-${camera}`}
                              src={thumbSrc(ep.index)}
                              alt=""
                              loading="lazy"
                              className="absolute inset-0 h-full w-full object-cover"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                              }}
                            />
                          )}
                          <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition-transform group-hover:scale-110">
                            <Play className="h-5 w-5" />
                          </span>
                        </button>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-nori-h14131a">ep {ep.index}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {ep.duration_s}s · {ep.length}fr
                        </p>
                      </div>
                      {!isCloud && (
                        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={isMarked}
                            onChange={() => toggleMark(ep.index)}
                            className="accent-nori-hb03a29"
                          />
                          cut
                        </label>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <span className="text-sm text-muted-foreground">
            {episodes ? `${episodes.length} episodes` : ""}
            {!isCloud && marked.size > 0 ? ` · ${marked.size} marked to cut` : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
            {!isCloud &&
              (confirm ? (
                <Button className="bg-red-500 text-white hover:bg-red-600" onClick={doDelete} disabled={busy}>
                  {busy ? "Deleting…" : `Yes, delete ${marked.size}`}
                </Button>
              ) : (
                <Button
                  className="bg-red-500 text-white hover:bg-red-600"
                  onClick={() => setConfirm(true)}
                  disabled={marked.size === 0 || busy}
                >
                  Delete {marked.size || ""} episode{marked.size === 1 ? "" : "s"}
                </Button>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
