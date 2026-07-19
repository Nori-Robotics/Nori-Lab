// W2.11: a purely EPHEMERAL in-browser episode preview recorder.
//
// The full-quality training copy is recorded ON THE ROBOT (rpi5/media/recorder.py)
// and ships itself to the cloud — the laptop no longer spools anything. This class
// exists ONLY to give the operator a quick "does the demo look OK?" playback so
// they can Reject a fumbled take (record("episode_discard")). It records the
// inbound WebRTC stream into memory, hands back a Blob for a <video> preview, and
// forgets it. No fetch, no spool, no upload. The preview is the DEGRADED live view.
//
// Mechanism deliberately matches the proven legacy browser catcher
// (datasetCapture.ts): a MediaRecorder on the raw inbound stream, 1 s timeslice.
// `.diagnostic` explains an empty take if one ever happens (kept for support).

const MIME_CANDIDATES = [
  "video/webm;codecs=h264",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMimeType(): string {
  for (const c of MIME_CANDIDATES) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export class EphemeralEpisodeRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private mime = "";
  private lastError = "";
  /** Human-readable reason a preview came back empty (shown in the card). */
  diagnostic = "";

  get active(): boolean {
    return this.recorder !== null;
  }

  /** Begin recording the inbound stream into memory. Throws synchronously if the
   *  stream has no live video track (a stale post-reconnect stream). */
  start(stream: MediaStream): void {
    if (this.recorder) return;
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== "live") {
      throw new Error("video track is not live (stale session stream?) — reconnect and retry");
    }
    this.mime = pickMimeType();
    this.chunks = [];
    this.lastError = "";
    this.diagnostic = "";
    const recorder = new MediaRecorder(stream, this.mime ? { mimeType: this.mime } : undefined);
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    recorder.onerror = (ev: Event) => {
      this.lastError = String((ev as unknown as { error?: { name?: string } }).error?.name ?? "error");
      console.warn("[episodePreview] MediaRecorder error", ev);
    };
    this.recorder = recorder;
    recorder.start(1000); // periodic chunks; stop() forces the final flush
  }

  /** Stop and return the recorded preview Blob (null + a set `.diagnostic` if no
   *  data). The caller owns the Blob's object URL and must revoke it. */
  stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(this._finish());
    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => resolve(this._finish());
      try { recorder.requestData(); } catch { /* not all browsers, harmless */ }
      try {
        recorder.stop();
      } catch {
        resolve(this._finish());
      }
    });
  }

  private _finish(): Blob | null {
    if (this.chunks.length > 0) {
      return new Blob(this.chunks, { type: this.mime || "video/webm" });
    }
    const supported = MIME_CANDIDATES.filter(
      (c) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c),
    );
    this.diagnostic =
      `no video captured — mime="${this.mime || "browser-default"}", ` +
      `supported=[${supported.join(", ") || "none"}]` +
      (this.lastError ? `, recorderError=${this.lastError}` : "");
    console.warn("[episodePreview] " + this.diagnostic + " — the robot copy is unaffected.");
    return null;
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
