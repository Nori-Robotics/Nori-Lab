# Connection and video

## Stuck at `connecting`, never reaches `connected`

**This is the most common failure, and it is almost never your code.**

The connection is WebRTC. On a normal home or office network, both peers discover their public
addresses via STUN and connect **directly**. On a strict network they can't, and ICE never
completes — so the session sits at `connecting` forever.

Networks that do this: corporate and university firewalls, hotel and co-working Wi-Fi, CGNAT
mobile carriers, and VPNs.

**The fix is a TURN relay**, and in the Nori app you already have one: the backend **mints
short-lived relay credentials at every connect** for a signed-in operator, automatically. If
you're signed in and still stuck at `connecting`, check the session log for a
`TURN: mint failed…` line — that means the fetch didn't land and the session fell back to STUN
only.

Building your own client? Fetch the same credentials yourself
(`GET /api/v1/turn/credentials` with your account's JWT) and pass them into `RemoteTeleop`.

::: warning An old static TURN credential no longer works
The relay moved to a shared-secret scheme where credentials are time-bound. If you're still
passing a fixed username/password we sent you months ago, it will be **rejected** — and a
rejected relay looks exactly like no relay. Fetch fresh credentials instead.
:::

To confirm that's what you're looking at before asking:

- Does it connect when you're on the **same LAN** as the robot? If yes, it's the network path, not
  the robot.
- Does it connect from a **phone hotspot** instead of the office Wi-Fi? Same conclusion.

Details: [SDK: Connectivity](/sdk/connectivity).

## Connected, but no video

Work through these in order:

**Room mismatch.** The client and the robot must be in the same room. A typo here produces a
connection that looks healthy but carries no media, because you're not actually talking to the
robot.

**The encoder is paused.** `pauseVideo()` makes the robot stop encoding entirely — deliberately,
to save power. If something in your app paused it and never resumed, there is nothing on the wire.
Call `resumeVideo()`.

**No video element attached.** `setVideoEl(null)` detaches the sink. The robot is still sending;
nothing is rendering it.

**Black or freezing on a weak network (hotspots).** Check `TelemetryView.videoNet` (the **net**
chip in the app): `degraded`/`bad` means the link is dropping packets and the SDK's adaptive
bitrate loop is actively cutting the robot's encoder rate to keep frames flowing — expect a
softer picture, not a black one. If the feed is black *and* `videoNet` shows heavy loss that
never recovers, the link can't sustain even the ~150 kbps floor; move either end to a better
network or a TURN relay path.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- What the robot-side logs look like in each of these cases, and how an operator gets at them.
- The full `onConnState` sequence for a healthy connection, so people can tell *where* theirs
  stalls.
:::
-->

## Video quality {#video-quality}

**Low resolution and ~15 fps is expected, not a bug.**

The robot sends one H.264 track with all cameras tiled into a composite grid — typically 320×240
per tile at 15 fps. The Pi 5 has **no hardware H.264 encoder**, so every encoded pixel costs robot
power. Resolution and fps are tuned to measured hardware limits and will improve when the robot's
power hardware does.

Two things that are *not* the lever you want:

- `setVideoQuality("low" | "normal")` changes **bitrate only** — bandwidth, not robot CPU.
- Asking for a higher resolution isn't possible today; a live-switchable resolution API is designed
  and lands when there's power headroom for it.

Full expectations: [SDK: Video](/sdk/video).

## A camera disappears mid-session

That's usually **power**, not video. See [Power and brownouts](/troubleshooting/power).
