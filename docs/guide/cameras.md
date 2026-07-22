# Cameras

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- Which cameras a robot ships with and what **role** each has (`overhead`, `left_wrist`,
  `right_wrist`, …). Roles are the vocabulary everything else uses — the composite video tiles,
  `cameraView(role)` in the SDK, and per-camera stills all key off them.
- Mounting and aiming.
- How to verify each camera is alive before a session.
:::
-->

## What the video feed actually is {#video-quality}

Important for setting expectations, and worth reading before filing a video bug:
**low resolution and ~15 fps is expected, not a bug.**

The robot sends **one H.264 track** containing **all cameras tiled into a composite grid** —
typically 320×240 per tile at 15 fps. There are no per-camera tracks on the wire. This is
deliberate: the Pi 5 has no hardware H.264 encoder, so every encoded pixel costs robot power, and
one encode is far cheaper than N.

That also means resolution and frame rate are capped by the robot's **power budget**, not by the
protocol or your network. They'll improve when the robot's supply hardware does.

Two things that are *not* the lever you want:

- `setVideoQuality("low" | "normal")` changes **bitrate only** — bandwidth, not robot CPU.
- Asking for a higher resolution isn't possible today; a live-switchable resolution API is designed
  and lands when there's power headroom for it.

In the SDK, `cameraView(role)` crops a tile out of the composite into its own `MediaStream`, so
you never do quadrant math yourself. Full expectations: [SDK: Video](/sdk/video).

## If the frame rate drops over a long session

The reflex is to blame power. On the cameras specifically, **check temperature first.**

A Pi that has been streaming several cameras for a while can hit its soft thermal limit and cap
its own clocks — which shows up as steadily falling delivered fps, not as a device disappearing.
`vcgencmd get_throttled` tells the two apart: the thermal bits (`0x8`, `0x80000`) with **no**
undervoltage bit means the fix is **cooling**, not a bigger supply.
[The bit decode](/guide/power#confirming).

Cameras now hand their JPEG frames straight through by default, skipping a decode/re-encode round
trip on the Pi — that's what bought the headroom back. The robot falls back to the old
decode-and-re-encode path automatically for a camera whose hardware won't do it, or one configured
with a rotation, and those cameras cost noticeably more CPU per frame.

## Phone as a camera

Streaming a phone camera into the app requires **HTTPS** — browsers won't hand out camera access
over plain HTTP from a non-localhost origin.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
Port the operator-facing parts of `frontend/HTTPS_SETUP.md` (mkcert, self-signed certs in
`certs/`, running uvicorn with `--ssl-keyfile`/`--ssl-certfile`). Skip the dev-only detail.
:::
-->
