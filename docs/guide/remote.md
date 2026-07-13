# Remote teleoperation

Driving the robot from the app's Remote page — video on screen, keyboard in your hands, robot
anywhere with a network.

::: info 🚧 To write
- **The connection panel.** Room, token, STUN/TURN fields — what each is and when you touch it
  (mostly: never; they're provisioned for you).
- **The keyboard legend.** It's rendered live on the page and changes with the control mode, so
  document the *modes*, not a frozen key table.
- **Control modes:** cylindrical vs. per-joint, and why you'd switch.
- **Switching arms.**
- **The connection chip** in the nav: `not connected` → `connecting…` → `connected`, and what
  each stall means.
- Screenshots.
:::

## Modes and commands

Two control modes — **cylindrical** (move the gripper through space) and **per-joint** (drive
each joint directly). Toggle between them; the key map changes with the mode, which is why the
legend on the page is the source of truth rather than anything written here.

Three commands, always available:

| Command | Effect |
|---|---|
| **E-STOP** | Trips the latch immediately. Motion blocked, motors torque-limited. Never rate-limited. |
| **Reset latch** | Clears the E-STOP and any stall latches. The only thing that clears a latch. |
| **Reset** | Returns the arms to their neutral pose. It's a motion command, so it's refused while latched. |

## When a joint stops but everything else keeps working

That's a **stall**, and it's working as designed. When a joint is pushed against something, the
robot cuts torque **on that joint only** — everything else keeps running. Jog the stalled joint
*away* from the obstruction and it self-clears.

A stall is deliberately not a global safety stop. See [safety states](/troubleshooting/safety-states).
