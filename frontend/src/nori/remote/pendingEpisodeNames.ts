// NORI: record-time episode names, applied once the recording reaches the cloud.
//
// The robot's recorder (rpi5/media/recorder.py) owns the bundle's per-episode
// metadata and has no name field on the wire today, so names typed during a
// recording session can't ship inside the bundle. Instead the capture card
// stores them here (localStorage — they survive reloads) and this module
// applies them AFTER the bundle uploads + promotes, via the raw-recording
// naming route (PATCH …/episode/{idx}/name). From there the normal annotation
// flow takes over (the name travels into any dataset assembled from the take).
//
// Matching a pending set to its uploaded bundle is deliberately conservative —
// ALL of these must hold before any name is written:
//   * the bundle PROMOTED after the session started (upload begins at idle,
//     always after session_start; 5 min of clock skew tolerated),
//   * its episode count equals the session's kept-episode count,
//   * its episodes carry the session's exact task string (the card sends the
//     task on every episode_start, and the robot stamps it into meta.json).
// No match → the set stays pending (retried while the Remote page is open,
// expired after 48 h); the fallback is always manual naming in Review episodes.

import { type Fetcher } from "@/lib/apiClient";
import { getRobotRecordings } from "@/nori/api/client";
import { listRecordingEpisodes, nameRecordingEpisode } from "@/nori/remote/episodeReview";

export interface PendingNameSet {
  /** Laptop-clock ISO time of session_start. */
  startedAt: string;
  /** The session task — every episode's meta.json task, used to verify a match. */
  task: string;
  /** Per KEPT episode, in recording order ("" = left unnamed). */
  names: string[];
}

const KEY = "nori.pendingEpisodeNames.v1";
const EXPIRE_MS = 48 * 3600 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function load(): PendingNameSet[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as PendingNameSet[]) : [];
    if (!Array.isArray(arr)) return [];
    // Expire stale sets and drop degenerate ones (nothing to apply).
    return arr.filter(
      (s) =>
        s &&
        Array.isArray(s.names) &&
        s.names.some((n) => n) &&
        Date.now() - Date.parse(s.startedAt) < EXPIRE_MS,
    );
  } catch {
    return [];
  }
}

function save(sets: PendingNameSet[]) {
  try {
    if (sets.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(sets));
  } catch {
    // localStorage unavailable (private mode) — names just won't survive reload.
  }
}

/** Queue a session's names for application. No-op if none are non-empty. */
export function addPendingNames(set: PendingNameSet): void {
  if (!set.names.some((n) => n)) return;
  save([...load(), set]);
}

/** How many sessions still have names waiting to be applied. */
export function pendingNameCount(): number {
  return load().length;
}

/** Try to apply every pending set. Returns how many sessions were applied and
 * how many remain (their bundles haven't uploaded/promoted yet, or no bundle
 * matched safely). Safe to call repeatedly — a set is removed only after every
 * one of its non-empty names is written. */
export async function applyPendingNames(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<{ applied: number; pending: number }> {
  let sets = load();
  if (sets.length === 0) return { applied: 0, pending: 0 };

  const { bundles } = await getRobotRecordings(baseUrl, fetcher);
  const used = new Set<string>();
  const remaining: PendingNameSet[] = [];
  let applied = 0;

  // Oldest session first, matched to its oldest eligible bundle, so two
  // same-task same-count sessions pair up chronologically instead of both
  // grabbing the newest upload.
  sets = [...sets].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const set of sets) {
    const t0 = Date.parse(set.startedAt) - CLOCK_SKEW_MS;
    const candidates = bundles
      .filter(
        (b) =>
          b.status === "PROMOTED" &&
          !used.has(b.session_id) &&
          b.episode_count === set.names.length &&
          Date.parse(b.created_at) >= t0,
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

    let done = false;
    for (const cand of candidates) {
      try {
        const listing = await listRecordingEpisodes(baseUrl, fetcher, cand.session_id);
        const eps = listing.episodes;
        if (eps.length !== set.names.length) continue;
        if (!eps.every((e) => e.task === set.task)) continue;
        for (let i = 0; i < set.names.length; i++) {
          const name = set.names[i].trim();
          if (!name || eps[i].name === name) continue;
          await nameRecordingEpisode(baseUrl, fetcher, cand.session_id, eps[i].index, name);
        }
        used.add(cand.session_id);
        applied += 1;
        done = true;
        break;
      } catch {
        // Listing/PATCH failed (still finalizing, transient network) — keep the
        // set pending; already-written names re-verify as equal next round.
        break;
      }
    }
    if (!done) remaining.push(set);
  }
  save(remaining);
  return { applied, pending: remaining.length };
}
