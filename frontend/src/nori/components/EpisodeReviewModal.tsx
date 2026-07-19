// NORI: Episode review + curation modal. Play each episode of a dataset in the
// browser and delete the bad takes before training.
//
// Two sources:
//   * LOCAL — a dataset in this laptop's lerobot cache. lelab transcodes AV1→H.264
//             on demand (no HuggingFace login). Delete is synchronous.
//   * CLOUD — a promoted/assembled upload in your Nori account, viewable from
//             anywhere. Shows the recording-session provenance; deleting a session
//             or individual episodes enqueues a reindex-safe cloud REBUILD job
//             (polled to completion here), so indices stay consistent afterwards.
//
// Clips load lazily (only the ones you play are fetched/transcoded).

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X, Play, Trash2 } from "lucide-react";
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
import {
  getDatasetSessions,
  deleteDatasetSession,
  deleteDatasetEpisodes,
  getAssemblyJob,
  type DatasetProvenanceSession,
} from "@/nori/api/client";

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
  // Curation (episode/session delete) needs the provenance sidecar, which only
  // ASSEMBLED datasets have. Local datasets curate directly; a cloud dataset does
  // only once it has recording-session provenance (else the rebuild would error).

  const [episodes, setEpisodes] = useState<DatasetEpisode[] | null>(null);
  const [cameras, setCameras] = useState<string[]>([]);
  const [camera, setCamera] = useState<string | null>(null);
  const [clipToken, setClipToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [playing, setPlaying] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sessions, setSessions] = useState<DatasetProvenanceSession[] | null>(null);
  const [rebuilding, setRebuilding] = useState(false); // a delete rebuild is running
  const cancelled = useRef(false);
  useEffect(() => () => {
    cancelled.current = true;
  }, []);

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
      if (isCloud && source.kind === "cloud") {
        try {
          const s = await getDatasetSessions(baseUrl, fetchWithHeaders, source.sessionId);
          setSessions(s.sessions);
        } catch {
          setSessions([]); // provenance is best-effort (pre-assembly datasets have none)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // source is a stable object per open; deps cover the fields we read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, fetchWithHeaders, isCloud, source]);

  // A cloud delete (session or episodes) enqueues a reindex-safe REBUILD job.
  // Poll it to terminal, then reload the listing (indices/episodes changed).
  const runRebuild = useCallback(
    async (enqueue: () => Promise<{ assembly_job_id: string }>) => {
      setError(null);
      setRebuilding(true);
      try {
        const { assembly_job_id } = await enqueue();
        for (;;) {
          await new Promise((r) => setTimeout(r, 2500));
          if (cancelled.current) return;
          const job = await getAssemblyJob(baseUrl, fetchWithHeaders, assembly_job_id);
          if (job.status === "DONE") break;
          if (job.status === "FAILED") throw new Error(job.failure_reason || "Rebuild failed.");
        }
        setMarked(new Set());
        setConfirm(false);
        onChanged();
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRebuilding(false);
      }
    },
    [baseUrl, fetchWithHeaders, onChanged, load],
  );

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
    if (source.kind === "cloud") {
      const ids = [...marked];
      await runRebuild(() => deleteDatasetEpisodes(baseUrl, fetchWithHeaders, source.sessionId, ids));
      return;
    }
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
  }, [baseUrl, fetchWithHeaders, source, marked, onChanged, onClose, load, runRebuild]);

  const deleteSession = useCallback(
    (sessionKey: string) => {
      if (source.kind !== "cloud") return;
      void runRebuild(() => deleteDatasetSession(baseUrl, fetchWithHeaders, source.sessionId, sessionKey));
    },
    [baseUrl, fetchWithHeaders, source, runRebuild],
  );

  const canCurate = !isCloud || (sessions != null && sessions.length > 0);

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
          {isCloud && sessions && sessions.length > 0 && (
            <div className="mb-4 rounded-2xl border border-border bg-background p-3">
              <p className="eyebrow mb-2">Recording sessions</p>
              <div className="space-y-1">
                {sessions.map((s) => (
                  <div
                    key={s.session_key}
                    className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-1.5 hover:bg-secondary"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-nori-h14131a">{s.task || "Untitled session"}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {s.recorded_at ? new Date(s.recorded_at).toLocaleDateString() : "—"} ·{" "}
                        {s.episode_count} episode{s.episode_count === 1 ? "" : "s"}
                      </p>
                    </div>
                    <button
                      onClick={() => deleteSession(s.session_key)}
                      disabled={rebuilding || sessions.length <= 1}
                      title={
                        sessions.length <= 1
                          ? "Can't delete the only session (a dataset can't be empty)"
                          : "Delete this session's episodes"
                      }
                      className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </div>
                ))}
              </div>
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
                      {canCurate && (
                        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={isMarked}
                            onChange={() => toggleMark(ep.index)}
                            disabled={rebuilding}
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
            {rebuilding ? (
              <span className="inline-flex items-center gap-2 text-nori-h14131a">
                <Loader2 className="h-4 w-4 animate-spin" /> Rebuilding dataset…
              </span>
            ) : (
              <>
                {episodes ? `${episodes.length} episodes` : ""}
                {marked.size > 0 ? ` · ${marked.size} marked to cut` : ""}
              </>
            )}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy || rebuilding}>Close</Button>
            {canCurate &&
              (confirm ? (
                <Button className="bg-red-500 text-white hover:bg-red-600" onClick={doDelete} disabled={busy || rebuilding}>
                  {busy || rebuilding ? "Deleting…" : `Yes, delete ${marked.size}`}
                </Button>
              ) : (
                <Button
                  className="bg-red-500 text-white hover:bg-red-600"
                  onClick={() => setConfirm(true)}
                  disabled={marked.size === 0 || busy || rebuilding}
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
