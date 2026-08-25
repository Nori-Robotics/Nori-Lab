# Video and recording

Two different video paths share this page on purpose: the **live feed** you watch (degraded to fit
the robot's power budget) and the **full-quality copy the robot records** for training. Knowing
which one you're looking at answers most video questions.

## What the video feed actually is {#video-quality}

**Low resolution and ~15 fps is expected, not a bug.**

The robot sends **one H.264 track** containing **all cameras tiled into a composite grid** —
typically 320×240 per tile at 15 fps. The tiles are the robot's four cameras, identified by
**role**: `left_wrist`, `right_wrist`, `overhead`, and `front` — the same four roles on both the
L2 and the A3 ([where each one sits](/guide/l2#cameras)). There are no per-camera tracks on the
wire. This is
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

A camera that is **missing from the start of a session** (or two views swapped) is different: the
saved port→role mapping is stale and the camera needs re-identifying. See
[If some cameras aren't found](/guide/l2#camera-identification).



<!-- TODO-DOCS (hidden from the live site; uncomment to restore)

## Phone as a camera

Streaming a phone camera into the app requires **HTTPS** — browsers won't hand out camera access
over plain HTTP from a non-localhost origin.

Port the operator-facing parts of `frontend/HTTPS_SETUP.md` (mkcert, self-signed certs in
`certs/`, running uvicorn with `--ssl-keyfile`/`--ssl-certfile`). Skip the dev-only detail.

Also: the throttling and brownout links above point into `/guide/l2`. The A3's compute is
confirmed as a Raspberry Pi 5 (see the A3 hardware paper), so the Pi-specific diagnostics apply
to both robots — move those sections out of the L2 page into a shared location.
:::
-->

## How recording works {#how-recording-works}

Record demonstrations from the **Remote Operation** page while connected. The flow is two-tier:
**start a session** with a task label, then record **episodes** one at a time — start, drive,
stop, then keep or reject.

The copy you train on is made **on the robot**: full-resolution frames from `left_wrist`,
`right_wrist`, and `overhead`, plus joint state and actions at 50 Hz. The `front` camera is
primarily your driving view and stays out of the standard training copy — the stereo capture
option below is the exception. The preview you watch while recording is just the live feed described above — it
often drops bitrate to spare the robot's compute, and that never affects the training copy.
Rejecting an episode deletes the robot's copy too, before it can upload.

### Stereo capture (front + overhead)

The front and overhead cameras can record as a **stereo pair**. Flip **Enforce stereo view** on
the recording card before starting a session — it's session-scoped, fixed once the session opens.
The robot then holds both cameras to one matched frame rate so frames pair 1:1, and the card shows
**"stereo enforced"**, reported by the robot itself — a robot that doesn't support it shows
nothing rather than a false promise.

There is no hardware shutter sync: both streams carry per-frame timestamps, and pairing happens at
assembly with a worst-case misalignment of half a frame period. Each episode stores the measured
extrinsics between the two cameras, and the published
[robot description](/guide/a3#try-it-in-simulation) carries their precise mounting orientation —
together, everything needed to reconstruct the stereo geometry.

### Upload

Upload begins after you **finish the session and disconnect**: the robot ships the session as one
bundle the next time it's powered and idle, showing an indicator on its kiosk for the duration.
The recording then appears under **Robot recordings** in My Stuff; once it's safely in your cloud,
the robot deletes its local copy to reclaim space.

From there: [assemble recordings into a dataset and train a policy](/guide/training).
