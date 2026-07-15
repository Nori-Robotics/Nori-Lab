// NORI: Episode review + curation modal. Play each episode of a LOCAL dataset
// in the browser (lelab transcodes AV1→H.264 on demand — no HuggingFace login)
// and delete the bad takes before training. Clips load lazily (only the ones
// you play get transcoded).

import { useCallback, useEffect, useState } from "react";
import { Loader2, X, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import {
  listEpisodes,
  deleteEpisodes,
  episodeClipUrl,
  type DatasetEpisode,
} from "@/nori/remote/episodeReview";

export function EpisodeReviewModal({
  repoId,
  onClose,
  onChanged,
}: {
  repoId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { baseUrl } = useApi();
  const [episodes, setEpisodes] = useState<DatasetEpisode[] | null>(null);
  const [cameras, setCameras] = useState<string[]>([]);
  const [camera, setCamera] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [playing, setPlaying] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const listing = await listEpisodes(baseUrl, repoId);
      setEpisodes(listing.episodes);
      setCameras(listing.cameras);
      setCamera((c) => c ?? listing.cameras[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, repoId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleMark = (i: number) =>
    setMarked((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  const doDelete = useCallback(async () => {
    setBusy(true);
    try {
      const res = await deleteEpisodes(baseUrl, repoId, [...marked]);
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
  }, [baseUrl, repoId, marked, onChanged, onClose, load]);

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
            <p className="eyebrow">Review episodes</p>
            <h2 className="text-xl font-bold text-[#14131a]">{repoId}</h2>
          </div>
          {cameras.length > 1 && (
            <div className="flex items-center gap-1 rounded-full bg-secondary p-1">
              {cameras.map((c) => (
                <button
                  key={c}
                  onClick={() => setCamera(c)}
                  className={`rounded-full px-3 py-1 font-mono text-[11px] transition-colors ${
                    camera === c ? "bg-card text-[#14131a] shadow-soft" : "text-muted-foreground hover:text-[#14131a]"
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
                          src={episodeClipUrl(baseUrl, repoId, ep.index, camera ?? undefined)}
                          controls
                          autoPlay
                          muted
                        />
                      ) : (
                        <button
                          className="flex h-full w-full items-center justify-center text-[#14131a]/60 hover:text-[#14131a]"
                          onClick={() => setPlaying((s) => new Set(s).add(ep.index))}
                          aria-label={`Play episode ${ep.index}`}
                        >
                          <Play className="h-8 w-8" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-[#14131a]">ep {ep.index}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {ep.duration_s}s · {ep.length}fr
                        </p>
                      </div>
                      <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={isMarked}
                          onChange={() => toggleMark(ep.index)}
                          className="accent-[#b03a29]"
                        />
                        cut
                      </label>
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
            {marked.size > 0 ? ` · ${marked.size} marked to cut` : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
            {confirm ? (
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
