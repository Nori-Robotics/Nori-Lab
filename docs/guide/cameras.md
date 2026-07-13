# Cameras

::: info 🚧 To write
- Which cameras a robot ships with and what **role** each has (`overhead`, `left_wrist`,
  `right_wrist`, …). Roles are the vocabulary everything else uses — the composite video tiles,
  `cameraView(role)` in the SDK, and per-camera stills all key off them.
- Mounting and aiming.
- How to verify each camera is alive before a session.
:::

## What the video feed actually is

Important for setting expectations, and worth reading before filing a video bug:

The robot sends **one H.264 track** containing **all cameras tiled into a composite grid** —
typically 320×240 per tile at 15 fps. There are no per-camera tracks on the wire. This is
deliberate: the Pi 5 has no hardware H.264 encoder, so every encoded pixel costs robot power, and
one encode is far cheaper than N.

That also means resolution and frame rate are capped by the robot's **power budget**, not by the
protocol or your network. They'll improve when the robot's supply hardware does.

In the SDK, `cameraView(role)` crops a tile out of the composite into its own `MediaStream`, so
you never do quadrant math yourself. See [SDK: Video](/sdk/video).

## Phone as a camera

Streaming a phone camera into the app requires **HTTPS** — browsers won't hand out camera access
over plain HTTP from a non-localhost origin.

::: info 🚧 To write
Port the operator-facing parts of `frontend/HTTPS_SETUP.md` (mkcert, self-signed certs in
`certs/`, running uvicorn with `--ssl-keyfile`/`--ssl-certfile`). Skip the dev-only detail.
:::
