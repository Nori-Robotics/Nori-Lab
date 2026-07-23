// NORI: Additive file. Browser-catcher — the operator-side half of remote-session
// dataset capture.
//
// DEPRECATED for RECORDING (2026-07-22, STREAM_INTEGRATION_PLAN §5b): the
// robot's raw-bundle recorder replaces this path (full-quality frames, true
// action labels). No UI constructs a recording DatasetCapture anymore — the
// Remote card records on the ROBOT (DatasetCaptureCard). What remains live
// here is the static dataset LISTING helper (listDatasets), used by publish
// flows over already-assembled captures. lelab warns on /nori/capture/start
// and NORI_BROWSER_CAPTURE=0 refuses it outright. The robot persists nothing (R5) and its LAN taps are loopback-bound
// on customer units, so during a remote session THIS page is the only place the data
// exists: the composite video (teleop.videoStream()), joint telemetry (onTelemetry),
// and the outbound control frames (onControlSent — we are the sender).
//
// This class catches all three and streams them to the local lelab spool
// (/nori/capture/*, lelab/browser_capture.py), which exports a LeRobotDataset and
// hands it to the existing backend-mediated upload. Nothing here talks to
// Nori-Backend or HF directly; the browser holds no HF token by design.
//
// Clocking: every row is stamped with Date.now() — the SAME clock stamps episode
// start at the instant MediaRecorder actually starts (its PTS zero), so export
// alignment is pure subtraction. Telemetry arrives ~15 Hz (the throttled operator
// copy); the exporter's default 15 fps grid matches.
//
// Availability: hosted (LeLab-free) deployments have no spool — call
// DatasetCapture.available() and hide the UI when false.

import type { RemoteTeleop, TelemetryView } from "@nori/sdk";
import { lelabFetch } from "@/lib/localAuth";

export interface CaptureEpisode {
  index: number;
  task: string;
}

export interface CaptureExportResult {
  repoId: string;
}

/** One local lerobot-cache dataset (GET /nori/capture/datasets). */
export interface CaptureDatasetEntry {
  repo_id: string;
  episodes: number;
  frames: number;
  fps: number | null;
  robot_type: string | null;
  modified_at: string;
  /** Capture-shaped (has the remote view) — offerable as an append target. */
  appendable: boolean;
}

type Row = Record<string, unknown>;

// Chunk cadence for MediaRecorder. 1 s keeps POST bodies small (~100-300 KB at the
// default encoder bitrate) and bounds data loss on a mid-episode crash.
const TIMESLICE_MS = 1000;
// Sidecar flush cadence. Telemetry at ~15 Hz + control at ~50 Hz stay well under
// a few KB per flush.
const FLUSH_MS = 1000;

function pickMimeType(): string {
  // Prefer H.264-in-mp4 style codecs when the browser offers them (cheaper for the
  // exporter), fall back through the VP8/9 webm ladder. Empty string = browser default.
  const candidates = [
    "video/webm;codecs=h264",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export class DatasetCapture {
  private baseUrl: string;
  private captureId: string | null = null;
  private recorder: MediaRecorder | null = null;
  private telBuf: Row[] = [];
  private ctlBuf: Row[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  // Video chunks must land in order; queue POSTs behind one promise chain.
  private chunkChain: Promise<void> = Promise.resolve();
  private epIndex = -1;
  private mime = "";
  // The current episode's video chunks, kept in-memory so the at-capture review
  // can play back what was just recorded (in addition to streaming to the spool).
  private episodeChunks: BlobPart[] = [];

  episodeActive = false;
  episodes: CaptureEpisode[] = [];
  // Surfaced to the UI; set when any spool POST fails (capture keeps going —
  // losing a flush is better than killing the session's recording outright).
  lastError: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  static async available(baseUrl: string): Promise<boolean> {
    try {
      const r = await lelabFetch(`${baseUrl.replace(/\/$/, "")}/nori/capture/ping`);
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Local cache datasets, newest first (for the append picker + the list). */
  static async listDatasets(baseUrl: string): Promise<CaptureDatasetEntry[]> {
    const r = await lelabFetch(`${baseUrl.replace(/\/$/, "")}/nori/capture/datasets`);
    if (!r.ok) throw new Error(`list datasets: HTTP ${r.status}`);
    return ((await r.json()) as { datasets: CaptureDatasetEntry[] }).datasets;
  }

  /** Rename a local cache dataset (409 on collision, 422 on a bad name). */
  static async renameDataset(baseUrl: string, repoId: string, newRepoId: string): Promise<string> {
    const r = await lelabFetch(`${baseUrl.replace(/\/$/, "")}/nori/capture/datasets/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_id: repoId, new_repo_id: newRepoId }),
    });
    if (!r.ok) {
      const detail = (await r.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(detail?.detail || `rename: HTTP ${r.status}`);
    }
    return ((await r.json()) as { repo_id: string }).repo_id;
  }

  get active(): boolean {
    return this.captureId !== null;
  }

  // ---- session lifecycle -------------------------------------------------

  async begin(teleop: RemoteTeleop, room: string): Promise<void> {
    if (this.captureId) return;
    this.mime = pickMimeType();
    // Full grid ({cols,rows,tiles}) so the exporter can crop the composite into
    // per-camera views; null on single-camera / layout-unknown sessions.
    const info = teleop.cameraLayoutInfo();
    const layout = info ? { cols: info.cols, rows: info.rows, tiles: info.tiles } : null;
    const res = await this.post("/nori/capture/start", {
      room,
      layout,
      video_mime: this.mime,
    });
    this.captureId = (res as { capture_id: string }).capture_id;
    this.episodes = [];
    this.epIndex = -1;
    this.lastError = null;
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  /** Wire into TeleopSessionContext's telemetry fan-out. Rows without joint
   *  state (link-chip updates etc.) are skipped. */
  onTelemetry = (t: TelemetryView): void => {
    if (!this.captureId) return;
    if (!t.state || Object.keys(t.state).length === 0) return;
    this.telBuf.push({ t_ms: Date.now(), state: t.state });
  };

  /** Wire into the SDK's onControlSent observer. */
  onControlSent = (frame: Record<string, unknown>, tWallMs: number): void => {
    if (!this.captureId) return;
    this.ctlBuf.push({ t_ms: tWallMs, frame });
  };

  // ---- episodes ------------------------------------------------------------

  async episodeStart(teleop: RemoteTeleop, task: string): Promise<void> {
    if (!this.captureId) throw new Error("capture not started");
    if (this.episodeActive) return;
    const stream = teleop.videoStream();
    if (!stream) throw new Error("no video stream — is video enabled?");
    // A stale stream (e.g. the pre-reconnect session's ended track) makes
    // MediaRecorder never fire onstart — which used to hang the await below
    // FOREVER with a dead-looking Start button. Fail fast and loud instead.
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== "live") {
      throw new Error("video track is not live (stale session stream?) — reconnect and retry");
    }

    const index = ++this.epIndex;
    const recorder = new MediaRecorder(stream, this.mime ? { mimeType: this.mime } : undefined);
    this.recorder = recorder;
    this.episodeChunks = []; // fresh buffer for this episode's review playback

    recorder.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data || ev.data.size === 0) return;
      const blob = ev.data;
      this.episodeChunks.push(blob); // keep for the at-capture review preview
      this.chunkChain = this.chunkChain.then(async () => {
        try {
          await lelabFetch(`${this.baseUrl}/nori/capture/${this.captureId}/video/${index}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: blob,
          });
        } catch (e) {
          this.lastError = `video chunk: ${e instanceof Error ? e.message : String(e)}`;
        }
      });
    };
    // Episode start t_ms is stamped when the recorder ACTUALLY starts — this is
    // the video's PTS zero, the anchor the exporter subtracts against. Bounded
    // wait: onstart not firing (recorder wedged on a bad stream) must surface as
    // an error the card can show, never an unresponsive button.
    const started = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("video recorder did not start within 4 s (stale/paused stream?)")),
        4000
      );
      recorder.onstart = () => {
        clearTimeout(deadline);
        void this.post(`/nori/capture/${this.captureId}/episode`, {
          index,
          event: "start",
          t_ms: Date.now(),
          task,
        });
        resolve();
      };
    });
    recorder.start(TIMESLICE_MS);
    try {
      await started;
    } catch (e) {
      try { recorder.stop(); } catch { /* never started — nothing to stop */ }
      this.recorder = null;
      this.epIndex = index - 1; // roll the index back: this episode never existed
      throw e;
    }
    this.episodes.push({ index, task });
    this.episodeActive = true;
  }

  /** Stop the current episode. Returns the recorded video (assembled from the
   *  streamed chunks) + its index, so the UI can play it back for the at-capture
   *  Accept/Reject review. The episode's start/stop events and video are already
   *  in the spool; Accept keeps it, Reject calls discardEpisode(index). */
  async episodeStop(): Promise<{ index: number; blob: Blob } | null> {
    const recorder = this.recorder;
    if (!recorder || !this.episodeActive) return null;
    const index = this.epIndex;
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop(); // flushes a final ondataavailable before onstop
    await stopped;
    await this.post(`/nori/capture/${this.captureId}/episode`, {
      index,
      event: "stop",
      t_ms: Date.now(),
    });
    this.recorder = null;
    this.episodeActive = false;
    const blob = new Blob(this.episodeChunks, { type: this.mime || "video/webm" });
    return { index, blob };
  }

  /** Reject an episode from the at-capture review: mark it discarded so the
   *  exporter skips it (the spooled files stay on disk but never reach the
   *  dataset). Safe to call for the just-stopped episode's index. */
  async discardEpisode(index: number): Promise<void> {
    if (!this.captureId) return;
    await this.post(`/nori/capture/${this.captureId}/episode`, {
      index,
      event: "discard",
      t_ms: Date.now(),
    });
    this.episodes = this.episodes.filter((e) => e.index !== index);
  }

  // ---- finish --------------------------------------------------------------

  /** Stop capturing, run the export, resolve with the dataset repo_id. Pass
   *  `appendTo` to add this session's episodes to an existing dataset, or
   *  `name` to create a new one with that exact name (default: timestamped).
   *  Poll cadence 2 s; export is CPU-bound on the laptop (video decode + encode). */
  async finish(fps = 15, name = "", appendTo = ""): Promise<CaptureExportResult> {
    if (!this.captureId) throw new Error("capture not started");
    if (this.episodeActive) await this.episodeStop();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await this.chunkChain; // every video byte on disk before export starts
    const id = this.captureId;

    await this.post(`/nori/capture/${id}/finish`, { fps, name, append_to: appendTo });
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = (await (await lelabFetch(`${this.baseUrl}/nori/capture/${id}`)).json()) as {
        export: { status: string; repo_id: string | null; error: string | null };
      };
      if (st.export.status === "done" && st.export.repo_id) {
        this.captureId = null;
        return { repoId: st.export.repo_id };
      }
      if (st.export.status === "error") {
        this.captureId = null;
        throw new Error(st.export.error || "export failed");
      }
    }
  }

  /** Drop the session without exporting (spool remains on disk for manual rescue). */
  async abort(): Promise<void> {
    if (this.episodeActive) await this.episodeStop().catch(() => undefined);
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.captureId = null;
    this.telBuf = [];
    this.ctlBuf = [];
  }

  // ---- internals -----------------------------------------------------------

  private async flush(): Promise<void> {
    if (!this.captureId) return;
    const tel = this.telBuf.splice(0);
    const ctl = this.ctlBuf.splice(0);
    try {
      if (tel.length) await this.post(`/nori/capture/${this.captureId}/telemetry`, { rows: tel });
      if (ctl.length) await this.post(`/nori/capture/${this.captureId}/controls`, { rows: ctl });
    } catch (e) {
      this.lastError = `flush: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const r = await lelabFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
}
