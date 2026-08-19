# Video

What the robot sends, what to expect from it, and what to do when it degrades.

## What the video feed actually is {#video-quality}

**Low resolution and ~15 fps is expected, not a bug.**

The robot sends **one H.264 track** containing **all cameras tiled into a composite grid** —
typically 320×240 per tile at 15 fps. There are no per-camera tracks on the wire. This is
deliberate: the Pi 5 has no hardware H.264 encoder, so every encoded pixel costs robot power, and
one encode is far cheaper than N.

That also means resolution and frame rate are capped by the robot's **power budget**, not by the
protocol or your network.

Two things that are *not* the lever you want:

- `setVideoQuality("low" | "normal")` changes **bitrate only** — bandwidth, not robot CPU.
- There is no way to request a higher resolution today.

In the SDK, `cameraView(role)` crops a tile out of the composite into its own `MediaStream`, so
you never do quadrant math yourself. Full expectations: [SDK: Video](/sdk/video).

## If the frame rate drops over a long session

The reflex is to blame power. On the cameras specifically, **check temperature first.**

A robot that has been streaming several cameras for a while can hit its soft thermal limit and cap
its own clocks — which shows up as steadily falling delivered fps, not as a device disappearing.
`vcgencmd get_throttled` tells the two apart: the thermal bits (`0x8`, `0x80000`) with **no**
undervoltage bit means the fix is **cooling**, not a bigger supply.
[The bit decode](/guide/l2#confirming).

Cameras hand their JPEG frames straight through where they can, skipping a decode/re-encode round
trip on the robot. A camera whose hardware won't do it — or one configured with a rotation — falls
back to decoding and re-encoding, which costs noticeably more CPU per frame.

## If a camera vanishes mid-session

That is a power symptom, not a video one — the USB rail is running out of current and the device
is re-enumerating. See [Brownouts and throttling](/guide/l2#brownouts).

## Phone as a camera

Streaming a phone camera into the app requires **HTTPS** — browsers won't hand out camera access
over plain HTTP from a non-localhost origin.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
Port the operator-facing parts of `frontend/HTTPS_SETUP.md` (mkcert, self-signed certs in
`certs/`, running uvicorn with `--ssl-keyfile`/`--ssl-certfile`). Skip the dev-only detail.

Also: the throttling and brownout links above point into `/guide/l2`, because the diagnostics
are Pi-specific and we have not yet confirmed the A3's compute. Once the A3 hardware is known,
either confirm they apply and move those sections out of the L2 page, or write A3 equivalents.
:::
-->
