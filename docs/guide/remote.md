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
| **E-STOP** | Trips the latch immediately. Motion blocked; torque **stays engaged**, because dropping a raised arm is worse than holding it. Never rate-limited. |
| **Reset latch** | Clears every latch — E-STOP, stall, and the over-temp / over-current motor cuts — and re-engages torque on any joint that was cut. The only thing that clears a latch. |
| **Reset** | Returns the arms to their neutral pose. It's a motion command, so it's refused while latched. |

## When a joint stops but everything else keeps working

That's a **stall**, and it's working as designed. When a joint is pushed against something, the
robot cuts torque **on that joint only** — everything else keeps running. Jog the stalled joint
*away* from the obstruction and it self-clears.

A stall is deliberately not a global safety stop. See [safety states](/troubleshooting/safety-states).
