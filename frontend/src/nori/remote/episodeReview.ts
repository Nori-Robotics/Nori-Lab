// NORI: client for local dataset episode review — view + delete episodes on a
// dataset in the lerobot cache, served by lelab (no HuggingFace, no login).
// These hit the local /nori/capture/* surface directly (unauthenticated, like
// the other capture endpoints), not the JWT-forwarding backend proxy.

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
