# Audio

## Streaming a clip to the robot speaker

`sendClipAudio` streams an arbitrary audio **track** to the robot's speaker over the same reserved
uplink the two-way call uses (renegotiation-free `replaceTrack`).

It's **transport-only** — you supply the `MediaStreamTrack`. The SDK does not fetch, decode, or
set levels.

```ts
// Build a track from an audio file WITHOUT playing it on the laptop (route through a
// MediaStream sink only, never ctx.destination), and CAP THE LEVEL (see the caveats):
const ctx = new AudioContext();
const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
const src = ctx.createBufferSource(); src.buffer = buf;
const gain = ctx.createGain(); gain.gain.value = 0.7;     // ← cap output level
const dest = ctx.createMediaStreamDestination();
src.connect(gain); gain.connect(dest);

await teleop.sendClipAudio(dest.stream.getAudioTracks()[0]); // reserve uplink + start
src.start();
src.onended = () => { void teleop.sendClipAudio(null); ctx.close(); }; // hand uplink back / detach
```

## Requirements and caveats

Read before you ship audio.

**The robot's voice downlink must be ON** (`webrtc_robot.py --voice` / `NORI_VOICE`, plus a
speaker). Only then is the audio m-line `sendrecv` and does the robot play what you send.
Otherwise `sendClipAudio` returns `false` and nothing transmits.

**There is one audio m-line** — a clip and the mic share it. A clip takes the uplink;
`sendClipAudio(null)` hands it back to the mic (if a call is active) or detaches.

**It's real-time Opus, not a file transfer.** Audio plays as it streams; a network drop drops it.
The caller owns the track's lifetime — stop it when the source ends.

**Clips don't ring the robot.** Robots gate their room microphone behind a local accept prompt: a
person *at* the robot must consent before an operator can hear the room. A clip is speaker-only —
nobody is asking to listen — so `sendClipAudio` announces itself as a clip and plays immediately.
No accept prompt, and the robot's mic stays shut.

`joinCall()` is the one that rings: on a consent-gated robot, expect **silence** (no room audio)
until someone at the robot accepts. Older robot builds ignore the clip marker and may ring anyway
— harmless.

::: danger Output level is capped ON THE ROBOT
The robot clamps downlink playback to `NORI_SPEAKER_GAIN` (default **0.7**) with a `volume`
element before the sink, so no track you send can overdrive the speaker. You don't have to trust
the client — the guarantee lives on the robot.

This exists for a concrete reason: a near-full-scale clip drives the speaker amp and the
hardware-AEC reference far harder than call speech. On a full-speed USB DSP speakerphone
(MV-SILICON P10S) that **browned the device out into a mid-stream USB re-enumeration**
(`alsasink … device has been disconnected` spam). Quiet call voice never triggered it.

You *may* still attenuate client-side (defense in depth). For loud playback, also prefer a powered
USB hub and a robust speaker.
:::

**The speaker device must be name-stable.** Set `NORI_SPEAKER` to a dmix alias (`nori_out`) or
`hw:CARD=<name>` — **never `hw:<number>`**. A device that re-enumerates comes back as a *new* card
number, so a numbered device is unrecoverable after any reset.

## Reference implementation

The fork ships a reference implementation of all of the above — fetch, decode, gain-cap, and
lifecycle — in `frontend/src/nori/remote/audioClip.ts` (`playAudioUrl` / `playAudioFile`, default
gain `0.7`).

## Two-way call

`joinCall()` / `leaveCall()` and the mic/camera surface on `RemoteTeleop` are **experimental** and
may change.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
Document the call API properly once it stabilizes: joining, the robot-side consent prompt, mic
and camera control, and what the operator hears while waiting for someone at the robot to accept.
:::
-->

Audio problems: [Audio troubleshooting](/guide/audio).
