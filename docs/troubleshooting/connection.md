# Connection and video

## Stuck at `connecting`, never reaches `connected`

**This is the most common failure, and it is almost never your code.**

The connection is WebRTC. On a normal home or office network, both peers discover their public
addresses via STUN and connect **directly**. On a strict network they can't, and ICE never
completes — so the session sits at `connecting` forever.

Networks that do this: corporate and university firewalls, hotel and co-working Wi-Fi, CGNAT
mobile carriers, and VPNs.

**The fix is a TURN relay.** We don't issue TURN credentials by default yet. If you're hitting
this, [tell us](/troubleshooting/getting-help) and we'll provision relay credentials for you; they
slot into the options you already pass, with no other change.

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

::: info 🚧 To write
- What the robot-side logs look like in each of these cases, and how an operator gets at them.
- The full `onConnState` sequence for a healthy connection, so people can tell *where* theirs
  stalls.
:::

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
