# Video

The robot's inbound video is one media track on the peer connection.

## Attach a sink

Attach it to a `<video>` element at construction (`videoEl`) **or** re-point it at any time —
useful when one long-lived session renders on different pages:

```ts
teleop.setVideoEl(myVideoEl);   // point the live stream at this element (null to detach)
teleop.setAudioEl(myAudioEl);   // same for the robot's inbound audio sink
```

## Pause the encoder to save robot power

Detaching with `null` stops *rendering*, but the robot keeps encoding and sending. On a Pi 5 —
no hardware H.264 encoder, so video is software x264 and often the biggest power draw — that's
wasteful when nothing is watching.

Pause the **encoder itself**, not just the sink:

```ts
teleop.pauseVideo();    // robot drops frames BEFORE the encoder -> it goes idle (power saved)
teleop.resumeVideo();   // re-enable; the robot forces a keyframe so video reappears at once
```

Pause/resume ride the control data channel (no renegotiation, so resume is fast) and are safe to
call **before the channel is open** — the desired state is applied on open. So "pause on connect,
resume only while a viewer is mounted" works.

Control and telemetry are a separate transport, so pausing video **never** affects jog or
telemetry. A fresh session starts flowing at the defaults.

::: tip
`setVideoQuality("low" | "normal")` changes **bitrate only** — bandwidth, not robot CPU.
`pauseVideo()` is the control that actually saves robot power. Note that while connected, the
SDK's adaptive-bitrate loop re-asserts its own measured target every second, so a manual
`setVideoQuality` value is transient by design.
:::

## Grab a still frame

Without a `<video>` element — reads the live track directly:

```ts
const blob = await teleop.captureFrame();   // JPEG Blob, or null if no video is arriving
// If the encoder may be paused, use snapshot(): it resumes, waits for a frame, grabs, re-pauses:
const still = await teleop.snapshot();      // JPEG Blob, or null
```

### Per-camera stills

Both take an optional camera `role` (from the layout — see below) to crop one tile out of the
composite. This is what a per-camera LLM `look` maps to:

```ts
const wrist = await teleop.snapshot(500, "left_wrist");     // one tile, or null
const over  = await teleop.captureFrame("image/jpeg", 0.7, "overhead");
```

::: warning Unknown role → `null`, never the full composite
Deliberate. If your caller labeled the frame — e.g. told a vision model "this is left_wrist" — a
silent fallback would hand it a **mislabeled image**.

On `null` with a role set, report the valid roles (`cameraLayoutInfo()?.tiles`) instead.
Single-camera robots send no layout, so any `role` returns `null` there — use the bare calls.
:::

The role→rect mapping is exported as `cameraTileRect(layout, role, w, h)` (pure, unit-tested) if
you need the same math elsewhere.

## The raw stream, no DOM required

For canvas pipelines, ML/CV consumers, or `MediaRecorder`:

```ts
const stream = teleop.videoStream();        // MediaStream | null (null until the track arrives)
const rec = new MediaRecorder(stream!);
// Do NOT stop() its tracks — they belong to the peer connection. Just drop your reference.
```

## Per-camera views

The robot sends **one composite track** — all cameras tiled into a grid. The bridge announces
which camera is in which tile (`cameraLayoutInfo()` / `onCameraLayout`), and `cameraView(role)`
crops a tile into its own `MediaStream`, so you never do quadrant math:

```ts
teleop.cameraLayoutInfo();                       // {cols, rows, tiles} | null (also: onCameraLayout)
const view = teleop.cameraView("left_wrist");    // CameraViewHandle | null
if (view) {
  myVideoEl.srcObject = view.stream;             // or feed it to CV / MediaRecorder
  // later:
  view.stop();                                   // ends the crop loop (composite unaffected)
}
```

`cameraView` returns `null` until **both** the video track and the layout frame have arrived, or
if the role isn't in the layout. Single-camera robots send no layout — use `videoStream()`.

Each live view runs a canvas draw loop (per decoded frame where the browser supports
`requestVideoFrameCallback`), so **`stop()` views you're not showing.**

## What to expect from the feed

Read this before filing a video issue:

- **One H.264 track, composite grid** of all robot cameras — typically 320×240 per tile at 15 fps.
  There are no per-camera tracks on the wire; `cameraView()` is the supported per-camera access.
  This is deliberate: one encode on the robot.
- **The ceiling is robot power, not the protocol.** The Pi 5 has no hardware H.264 encoder, so
  encode pixels×fps directly hits the robot's power budget. Resolution and fps are tuned to
  measured hardware limits and will improve when the robot's supply hardware does. A
  live-switchable resolution API is designed and lands when that headroom exists.
- **Bitrate adapts to your link automatically.** The SDK measures loss/RTT/delivered-fps once a
  second and streams a bitrate target to the robot's encoder (sessions start ~600 kbps and ramp
  to the robot's ceiling on a clean link; on a congested one — hotspots especially — the picture
  softens instead of freezing or going black). The current link verdict is
  `TelemetryView.videoNet` (`quality: good | degraded | bad`, plus loss/fps/RTT/target numbers).
  Frame rate is never the degradation axis — 15 fps is held; quality-per-frame gives first.

::: warning Verification status (v0)
`setVideoEl`/`setAudioEl`, `pauseVideo`/`resumeVideo`, `captureFrame`/`snapshot`, and the
`videoStream` / `cameraView` additions are implemented and typecheck/build-clean, but **pending
on-robot verification** — encoder power drop, clean keyframe resume, frame grab, and tile-crop
against a real composite.

The inbound video feed itself is hardware-verified and stable.
:::
