// NORI: Additive file. App-side helper for laptop -> robot-speaker CLIP audio (M3b downlink
// with a non-mic source). Turns a URL/File into a MediaStreamTrack and streams it through a
// live RemoteTeleop via sendClipAudio(). This is the concrete `nori.playAudio(url)` the
// script API (docs/llm_integration_plan.md) calls into — it lives in the app, not the SDK,
// because loading a URL is a network/DOM concern (the SDK core stays dep-free + transport-only).
//
// WHAT URLS WORK (this is the real constraint, not the transport):
//   - blob:  URLs from a user-picked File (URL.createObjectURL(file)) — BEST, no CORS at all.
//   - same-origin / app-bundled asset URLs (import a .mp3, or /public/*).
//   - data:  URLs (tiny embedded clips).
//   - cross-origin URLs ONLY if the server sends CORS headers (your Supabase bucket / CDN).
//     A bare third-party link without CORS -> decodeAudioData / captureStream fails or yields
//     a silent (tainted) track. There is no way around same-origin policy from the browser.
//   - a backend TTS/synthesis endpoint that returns audio bytes (route via the Nori proxy) is
//     just "a same-origin/CORS URL" from here — nothing special needed.
// Live radio/HLS streams are out of scope (need MSE); a progressive http mp3/ogg with CORS is fine.
//
// We decode via Web Audio (not an <audio> element) so there is NO local playback on the
// laptop — the operator's own speakers stay quiet while the robot plays the clip — and so we
// get a precise 'ended' signal. decodeAudioData needs the whole buffer, so this is for clips,
// not endless streams.

import type { RemoteTeleop } from "@nori/sdk";

// A running clip. stop() is idempotent: it stops playback, releases the audio uplink back to
// the mic (SDK-side), and closes the AudioContext. `done` resolves when the clip finishes or
// is stopped, so callers can `await` a clip (the script API awaits this).
export interface ClipHandle {
  stop: () => void;
  done: Promise<void>;
}

// Client-side output level for a clip, in [0,1]. The HARD safety cap now lives on the ROBOT
// (webrtc_robot.py `volume volume=NORI_SPEAKER_GAIN`, default 0.7) so NO client can overdrive the
// speaker into the P10S brownout/USB-re-enumeration we hit — that's the self-defending layer.
// This client value is therefore defense-in-depth / an optional attenuation, and defaults to
// unity so a well-behaved client isn't double-attenuated (1.0 x 0.7 = the verified-safe level).
// NOTE: unity here assumes the robot has the backstop; against an OLD robot without it, pass a
// lower gain (e.g. 0.7) explicitly.
const DEFAULT_CLIP_GAIN = 1.0;

// Fetch + decode + stream `url` to the robot speaker. Rejects if the URL can't be
// fetched/decoded (CORS, 404, unsupported codec) BEFORE anything is sent to the robot.
// Requires the robot's voice downlink to be on (see sendClipAudio); if it's off the clip
// still "plays" locally-silently and simply isn't transmitted (SDK logs it).
// `gain` caps the output level (default DEFAULT_CLIP_GAIN); pass 1 for unity.
export async function playAudioUrl(
  teleop: RemoteTeleop, url: string, gain: number = DEFAULT_CLIP_GAIN,
): Promise<ClipHandle> {
  // Pull the bytes first so a bad URL fails loudly here, not mid-stream.
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`clip fetch ${resp.status} for ${url}`);
  const bytes = await resp.arrayBuffer();

  const ctx = new AudioContext();
  const buffer = await ctx.decodeAudioData(bytes); // throws on an unsupported/again-tainted codec

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  // src -> gain (level cap) -> MediaStream sink ONLY (not ctx.destination) so the robot hears
  // it and the laptop doesn't (teleop already plays the robot's own mic back to the operator).
  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0, Math.min(1, gain));
  const dest = ctx.createMediaStreamDestination();
  src.connect(gainNode);
  gainNode.connect(dest);
  const track = dest.stream.getAudioTracks()[0];

  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });

  const stop = () => {
    if (settled) return;
    settled = true;
    try { src.stop(); } catch { /* already stopped */ }
    track.stop();
    void teleop.sendClipAudio(null); // hand the uplink back to the mic / detach
    void ctx.close();
    resolveDone();
  };

  src.onended = stop; // natural end of the clip
  // After the awaits above the context can be "suspended" (autoplay policy); resume so
  // src.start() actually produces audio. The picker onChange is a user gesture, so this is allowed.
  if (ctx.state === "suspended") await ctx.resume();
  await teleop.sendClipAudio(track); // reserve the uplink with our track, then start
  src.start();
  return { stop, done };
}

// Convenience for a user-picked File (drag/drop or <input type=file>): no CORS, no network.
export function playAudioFile(
  teleop: RemoteTeleop, file: File, gain: number = DEFAULT_CLIP_GAIN,
): Promise<ClipHandle> {
  const url = URL.createObjectURL(file);
  return playAudioUrl(teleop, url, gain).then((h) => ({
    ...h,
    stop: () => { h.stop(); URL.revokeObjectURL(url); },
  }));
}
