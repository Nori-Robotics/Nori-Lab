// NORI: Additive file. Browser-catcher — the operator-side half of remote-session
// dataset capture. The robot persists nothing (R5) and its LAN taps are loopback-bound
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

export interface CaptureEpisode {
  index: number;
  task: string;
}

export interface CaptureExportResult {
  repoId: string;
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
      const r = await fetch(`${baseUrl.replace(/\/$/, "")}/nori/capture/ping`);
      return r.ok;
    } catch {
      return false;
    }
  }

  get active(): boolean {
    return this.captureId !== null;
  }

  // ---- session lifecycle -------------------------------------------------

  async begin(teleop: RemoteTeleop, room: string): Promise<void> {
    if (this.captureId) return;
    this.mime = pickMimeType();
    const layout = teleop.cameraLayoutInfo()?.tiles ?? [];
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

    const index = ++this.epIndex;
    const recorder = new MediaRecorder(stream, this.mime ? { mimeType: this.mime } : undefined);
    this.recorder = recorder;

    recorder.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data || ev.data.size === 0) return;
      const blob = ev.data;
      this.chunkChain = this.chunkChain.then(async () => {
        try {
          await fetch(`${this.baseUrl}/nori/capture/${this.captureId}/video/${index}`, {
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
    // the video's PTS zero, the anchor the exporter subtracts against.
    const started = new Promise<void>((resolve) => {
      recorder.onstart = () => {
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
    await started;
    this.episodes.push({ index, task });
    this.episodeActive = true;
  }

  async episodeStop(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || !this.episodeActive) return;
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
  }

  // ---- finish --------------------------------------------------------------

  /** Stop capturing, run the export, resolve with the created dataset repo_id.
   *  Poll cadence 2 s; export is CPU-bound on the laptop (video decode + encode). */
  async finish(fps = 15, name = ""): Promise<CaptureExportResult> {
    if (!this.captureId) throw new Error("capture not started");
    if (this.episodeActive) await this.episodeStop();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await this.chunkChain; // every video byte on disk before export starts
    const id = this.captureId;

    await this.post(`/nori/capture/${id}/finish`, { fps, name });
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = (await (await fetch(`${this.baseUrl}/nori/capture/${id}`)).json()) as {
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
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
}
