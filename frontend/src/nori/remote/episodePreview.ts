// W2.11: a purely EPHEMERAL in-browser episode preview recorder.
//
// The full-quality training copy is recorded ON THE ROBOT (see rpi5/media/
// recorder.py) and ships itself to the cloud — the laptop no longer spools
// anything. This class exists ONLY to give the operator a quick "does the demo
// look OK?" playback so they can Reject a fumbled take (which deletes the
// robot's copy via teleop.record("discard_last")).
//
// It records the inbound WebRTC stream into memory, hands back a Blob for a
// <video> preview, and forgets it. No fetch, no spool, no export, no upload —
// contrast DatasetCapture (datasetCapture.ts), the legacy laptop-spool pipeline
// this replaces. The preview is the DEGRADED live stream (that's all the laptop
// has); it mirrors what you saw while driving, not the robot's full-quality copy.

function pickMimeType(): string {
  // VP8/VP9-in-webm first: MediaRecorder muxes those reliably from a remote
  // WebRTC track. "video/webm;codecs=h264" is often reported as supported but
  // can silently produce zero data when the inbound track is H.264 — that was
  // the empty-preview bug. mp4 is a last resort for Safari.
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export class EphemeralEpisodeRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private mime = "";

  get active(): boolean {
    return this.recorder !== null;
  }

  /** Begin recording the given inbound stream into memory. Throws (synchronously)
   *  if the stream has no live video track — a stale post-reconnect stream would
   *  otherwise make MediaRecorder never fire, which is the "dead button" trap. */
  start(stream: MediaStream): void {
    if (this.recorder) return;
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== "live") {
      throw new Error("video track is not live (stale session stream?) — reconnect and retry");
    }
    this.mime = pickMimeType();
    this.chunks = [];
    const recorder = new MediaRecorder(stream, this.mime ? { mimeType: this.mime } : undefined);
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    recorder.onerror = (ev) => console.warn("[episodePreview] MediaRecorder error", ev);
    this.recorder = recorder;
    // Periodic 1 s chunks so data accrues during the take; stop() also forces a
    // final flush. (Chosen mime = whatever the browser will actually mux — see
    // pickMimeType.)
    recorder.start(1000);
  }

  /** Stop and return the recorded preview Blob (null if never started / no data).
   *  The caller owns the Blob's object URL and must revoke it. */
  stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(this._blob());
    // Build the blob INSIDE onstop (guaranteed to fire after the final
    // dataavailable), never by racing an awaited promise against the data event.
    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => resolve(this._blob());
      try { recorder.requestData(); } catch { /* not all browsers, harmless */ }
      try {
        recorder.stop();
      } catch {
        resolve(this._blob());
      }
    });
  }

  private _blob(): Blob | null {
    if (this.chunks.length === 0) {
      console.warn(`[episodePreview] no data captured (mime=${this.mime || "default"}) — `
        + "the inbound stream may not be muxable by this browser; robot copy is unaffected");
      return null;
    }
    return new Blob(this.chunks, { type: this.mime || "video/webm" });
  }

  /** Drop the in-flight recording without producing a Blob (unmount cleanup). */
  cancel(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* ignore */ }
    }
  }
}
