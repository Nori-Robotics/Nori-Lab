# Remote teleoperation

Driving the robot from the app's Remote page — video on screen, keyboard in your hands, robot
anywhere with a network.

## The connection panel

There is almost nothing in it, on purpose.

**The robot is chosen by pairing, not typed.** The room is the active robot's serial and fills
itself in from the Pairing page. There is no room field to get wrong, and **no room token** — that
scheme is retired. An operator can only join a robot their account owns, enforced by the backend,
so there is nothing here to configure or leak.

**TURN fields are gone.** Relay credentials are minted per session at connect. A hand-typed static
credential would now be *rejected* by the relay, so the field could only turn a working session
into a broken one. See [Connectivity](/sdk/connectivity).

**STUN is still editable**, and you should still never need to touch it.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- **The keyboard legend.** It's rendered live on the page and changes with the control mode, so
  document the *modes*, not a frozen key table.
- **Control modes:** cylindrical vs. per-joint, and why you'd switch.
- **Switching arms.**
- **The connection chip** in the nav: `not connected` → `connecting…` → `connected`, and what
  each stall means.
- Screenshots.
:::
-->

## Modes and commands

Two control modes — **cylindrical** (move the gripper through space) and **per-joint** (drive
each joint directly). Toggle between them; the key map changes with the mode, which is why the
legend on the page is the source of truth rather than anything written here.

Three commands, always available:

| Command | Effect |
|---|---|
| **Software E-STOP** | Trips the software latch immediately. Motion blocked; torque **stays engaged**, because dropping a raised arm is worse than holding it. Never rate-limited. This is separate from the physical E-stop, which cuts motor power. |
| **Reset latch** | Clears every latch — E-STOP, stall, and the over-temp / over-current motor cuts — and re-engages torque on any joint that was cut. The only thing that clears a latch. |
| **Reset** | Returns the arms to their neutral pose. It's a motion command, so it's refused while latched. |

## When a joint stops but everything else keeps working

That's a **stall**, and it's working as designed. When a joint is pushed against something, the
robot cuts torque **on that joint only** — everything else keeps running. Jog the stalled joint
*away* from the obstruction and it self-clears.

A stall is deliberately not a global safety stop. See [safety states](/guide/safety-states).

## When it won't connect {#connection-trouble}

### Stuck at `connecting`, never reaches `connected`

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

### Connected, but no video

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

### The picture is low-res and choppy

That's expected, not a fault — it's the robot's power budget, and the reasons are on the
[Cameras](/guide/cameras#video-quality) page.

### A camera disappears mid-session

That's usually **power**, not video. See [Brownouts and throttling](/guide/power#brownouts).
