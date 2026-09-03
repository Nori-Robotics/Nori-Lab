// NORI: the Sounds view of My Stuff — the customer's private clip library.
//
// Phase 1 of the soundboard: upload, organise, and hear a clip in the browser.
// PLAYING ON THE ROBOT IS NOT HERE YET: the A3's gateway has no audio path, so a
// "play on robot" button would do nothing on the current fleet. It arrives with the
// robot-side work in phase 2, and the copy below promises only what works today.
//
// Preview uses a plain <audio> element pointed at a presigned URL. That is a media
// load, not a fetch(), so it needs no bucket CORS — deliberately, because the
// Web Audio route (what audioClip.ts uses to stream to a robot) would.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Music, Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import {
  deleteSound, getSoundUrl, renameSound, uploadSound, type SoundClip,
} from "@/nori/api/client";

const cardCls =
  "rounded-[20px] border border-border bg-card p-4 shadow-soft transition-shadow hover:shadow-pop";

/** Clip length as "0:04". Sounds are seconds long, so minutes:seconds is enough. */
const clipLength = (ms: number | null) => {
  if (ms == null) return "—";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const sizeLabel = (bytes: number | null) =>
  bytes == null ? "—" : bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export interface SoundsPanelProps {
  sounds: SoundClip[];
  /** Re-fetch the library after any change, so counts elsewhere stay honest. */
  onChanged: () => void;
  /** True while the parent's first load is still in flight. */
  loading?: boolean;
}

export const SoundsPanel = ({ sounds, onChanged, loading }: SoundsPanelProps) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // One <audio> for the whole panel: a second preview replaces the first rather
  // than layering, which is what people expect from a list of clips.
  useEffect(() => {
    const el = new Audio();
    el.addEventListener("ended", () => setPlayingId(null));
    el.addEventListener("error", () => setPlayingId(null));
    audioRef.current = el;
    return () => { el.pause(); el.src = ""; audioRef.current = null; };
  }, []);

  const preview = useCallback(async (sound: SoundClip) => {
    const el = audioRef.current;
    if (!el) return;
    if (playingId === sound.id) { el.pause(); setPlayingId(null); return; }
    setError(null);
    try {
      const { url } = await getSoundUrl(baseUrl, fetchWithHeaders, sound.id);
      el.pause();
      el.src = url;
      await el.play();
      setPlayingId(sound.id);
    } catch (e) {
      setPlayingId(null);
      setError(e instanceof Error ? e.message : "That clip would not play.");
    }
  }, [baseUrl, fetchWithHeaders, playingId]);

  const upload = useCallback(async (files: FileList | File[]) => {
    const picked = Array.from(files).filter((f) => f.size > 0);
    if (!picked.length) return;
    setError(null);
    setBusy(true);
    setPendingNames(picked.map((f) => f.name));
    const failures: string[] = [];
    // Sequential on purpose: finalize transcodes, and a parallel burst would just
    // queue on the server while making the failure attribution murkier.
    for (const file of picked) {
      try {
        await uploadSound(baseUrl, fetchWithHeaders, file);
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
      }
      setPendingNames((names) => names.filter((n) => n !== file.name));
    }
    setBusy(false);
    setPendingNames([]);
    if (failures.length) setError(failures.join(" · "));
    onChanged();
  }, [baseUrl, fetchWithHeaders, onChanged]);

  const rename = useCallback(async (sound: SoundClip, next: string) => {
    const name = next.trim();
    if (!name || name === sound.name) return;
    try {
      await renameSound(baseUrl, fetchWithHeaders, sound.id, name);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That rename did not stick.");
    }
  }, [baseUrl, fetchWithHeaders, onChanged]);

  const remove = useCallback(async (sound: SoundClip) => {
    if (!window.confirm(`Delete "${sound.name}"? This cannot be undone.`)) return;
    try {
      if (playingId === sound.id) { audioRef.current?.pause(); setPlayingId(null); }
      await deleteSound(baseUrl, fetchWithHeaders, sound.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That sound could not be deleted.");
    }
  }, [baseUrl, fetchWithHeaders, onChanged, playingId]);

  return (
    <>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer?.files?.length) void upload(e.dataTransfer.files);
        }}
        className={`rounded-[20px] border-2 border-dashed p-5 text-center transition-colors ${
          dragging ? "border-nori-h8ab135 bg-nori-h8ab135/5" : "border-border bg-card/60"
        }`}
      >
        <Music className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
        <p className="mt-2 text-sm font-medium text-nori-h14131a">
          Drop audio files here, or
          <button
            type="button"
            className="ml-1 underline underline-offset-2 hover:text-nori-h4d6a1e disabled:opacity-50"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            choose files
          </button>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Up to 30 seconds each. MP3, WAV, M4A, OGG and FLAC all work.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            e.target.value = "";
            if (files?.length) void upload(files);
          }}
        />
      </div>

      {error && (
        <p className="rounded-[14px] border border-nori-hd24a3d/30 bg-nori-hd24a3d/5 px-3 py-2 text-[13px] text-nori-h8f2318">
          {error}
        </p>
      )}

      {pendingNames.map((name) => (
        <article key={`pending-${name}`} className={`${cardCls} opacity-90`}>
          <p className="flex items-center gap-2 text-[13px] italic text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Converting “{name}” — this takes a moment.
          </p>
        </article>
      ))}

      {!loading && !sounds.length && !pendingNames.length && (
        <article className={cardCls}>
          <p className="text-base font-bold text-nori-h14131a">No sounds yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a clip and it lands here, ready to play from your robot once
            speaker playback ships.
          </p>
        </article>
      )}

      {sounds.map((sound) => {
        const failed = sound.status === "FAILED";
        const ready = sound.status === "READY";
        return (
          <article key={sound.id} className={cardCls}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Button
                  size="icon"
                  variant="secondary"
                  className="h-9 w-9 shrink-0 rounded-full"
                  disabled={!ready}
                  title={ready ? "Hear it in your browser" : "Not ready yet"}
                  aria-label={playingId === sound.id ? `Stop ${sound.name}` : `Play ${sound.name}`}
                  onClick={() => void preview(sound)}
                >
                  {playingId === sound.id
                    ? <Pause className="h-4 w-4" />
                    : <Play className="h-4 w-4" />}
                </Button>
                <div className="min-w-0">
                  <input
                    defaultValue={sound.name}
                    aria-label="Sound name"
                    className="w-full truncate border-0 bg-transparent p-0 text-base font-bold text-nori-h14131a outline-none focus:underline focus:underline-offset-4"
                    onBlur={(e) => void rename(sound, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        e.currentTarget.value = sound.name;
                        e.currentTarget.blur();
                      }
                    }}
                  />
                  <p className="mt-0.5 text-sm text-muted-foreground [font-variant-numeric:tabular-nums]">
                    {failed
                      ? "Could not be converted"
                      : `${clipLength(sound.duration_ms)} · ${sizeLabel(sound.bytes)}`}
                  </p>
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-nori-h8f2318"
                title="Delete"
                aria-label={`Delete ${sound.name}`}
                onClick={() => void remove(sound)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {failed && sound.failure_reason && (
              <p className="mt-3 border-t border-dashed border-border pt-2.5 text-[13px] text-muted-foreground">
                {sound.failure_reason}
              </p>
            )}
          </article>
        );
      })}

      {busy && !pendingNames.length && (
        <p className="flex items-center gap-2 text-[13px] italic text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
        </p>
      )}
    </>
  );
};

export default SoundsPanel;
