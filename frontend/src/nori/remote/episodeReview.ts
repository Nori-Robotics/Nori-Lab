// NORI: client for dataset episode review — view (+ delete, local only) episodes.
// Two sources:
//   * LOCAL  — a dataset in the lerobot cache, served by lelab off /nori/capture/*
//              (unauthenticated, like the other capture endpoints). View + delete.
//   * CLOUD  — a promoted upload in the owner's Nori/HF repo, served by the
//              backend's Phase 2 viewer. The episodes LISTING is JWT-authorized
//              (noriRequest → direct backend on the hosted app, LeLab proxy on
//              desktop); each CLIP is fetched straight from the backend with a
//              signed token in the URL (a <video> media load needs no CORS).

import { noriRequest } from "@/nori/api/client";
import { type Fetcher } from "@/lib/apiClient";

export interface DatasetEpisode {
  index: number;
  length: number;
  task: string;
  duration_s: number;
}

const base = (u: string) => u.replace(/\/$/, "");

export interface EpisodeListing {
  cameras: string[];
  episodes: DatasetEpisode[];
}

export async function listEpisodes(baseUrl: string, repoId: string): Promise<EpisodeListing> {
  const r = await fetch(`${base(baseUrl)}/nori/capture/datasets/${encodeURIComponent(repoId)}/episodes`);
  if (!r.ok) throw new Error(`couldn't list episodes (HTTP ${r.status})`);
  const j = (await r.json()) as { cameras?: string[]; episodes: DatasetEpisode[] };
  return { cameras: j.cameras ?? [], episodes: j.episodes };
}

/** URL for one episode's clip (AV1→H.264, transcoded on demand + cached). */
export function episodeClipUrl(baseUrl: string, repoId: string, index: number, camera?: string): string {
  const q = camera ? `?camera=${encodeURIComponent(camera)}` : "";
  return `${base(baseUrl)}/nori/capture/datasets/${encodeURIComponent(repoId)}/episode/${index}/clip.mp4${q}`;
}

/** URL for one episode's first-frame thumbnail (JPEG). */
export function episodeThumbUrl(baseUrl: string, repoId: string, index: number, camera?: string): string {
  const q = camera ? `?camera=${encodeURIComponent(camera)}` : "";
  return `${base(baseUrl)}/nori/capture/datasets/${encodeURIComponent(repoId)}/episode/${index}/thumb.jpg${q}`;
}

export async function deleteEpisodes(
  baseUrl: string,
  repoId: string,
  indices: number[],
): Promise<{ deleted: number; remaining: number }> {
  const r = await fetch(`${base(baseUrl)}/nori/capture/datasets/${encodeURIComponent(repoId)}/delete-episodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ indices }),
  });
  if (!r.ok) {
    const d = ((await r.json().catch(() => null)) as { detail?: string } | null)?.detail;
    throw new Error(d ?? `delete failed (HTTP ${r.status})`);
  }
  return r.json();
}

// -- Cloud source (Phase 2: promoted uploads, viewable anywhere) ---------------

export interface CloudEpisodeListing extends EpisodeListing {
  session_id: string;
  /** Signed token appended to each clip URL (?t=). Valid until token_exp. */
  token: string;
  token_exp: number;
}

/** List a promoted dataset's episodes from the backend viewer (JWT-authorized). */
export async function listCloudEpisodes(
  baseUrl: string,
  fetcher: Fetcher,
  sessionId: string,
): Promise<CloudEpisodeListing> {
  return noriRequest<CloudEpisodeListing>(
    baseUrl,
    fetcher,
    `/nori/library/datasets/${encodeURIComponent(sessionId)}/episodes`,
    { action: "List dataset episodes" },
  );
}

/** Clip URL served straight from the backend, authorized by the signed token in
 * the query (no auth header, so a plain <video src> works cross-origin).
 * `backendBase` is config.noriBackendUrl. */
export function cloudEpisodeClipUrl(
  backendBase: string,
  sessionId: string,
  index: number,
  token: string,
  camera?: string,
): string {
  const cam = camera ? `&camera=${encodeURIComponent(camera)}` : "";
  return (
    `${base(backendBase)}/api/v1/library/datasets/${encodeURIComponent(sessionId)}` +
    `/episode/${index}/clip.mp4?t=${encodeURIComponent(token)}${cam}`
  );
}

/** First-frame thumbnail (JPEG) served from the backend, token-authorized. */
export function cloudEpisodeThumbUrl(
  backendBase: string,
  sessionId: string,
  index: number,
  token: string,
  camera?: string,
): string {
  const cam = camera ? `&camera=${encodeURIComponent(camera)}` : "";
  return (
    `${base(backendBase)}/api/v1/library/datasets/${encodeURIComponent(sessionId)}` +
    `/episode/${index}/thumb.jpg?t=${encodeURIComponent(token)}${cam}`
  );
}
