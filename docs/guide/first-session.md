# Your first session

Getting from a powered-on robot to an arm that moves when you press a key.

::: info 🚧 To write
The happy path, start to finish. Rough shape — fill in from the real app flow
(`frontend/src/nori/pages/`):

1. **Power on the robot.** What the LEDs / boot sound should do. How long until it's on the
   network.
2. **Sign in** to the Nori app.
3. **Pair the robot** (`/nori/pairing`). Where the room name and token come from.
4. **Connect** (`/nori/remote`). The connection chip goes `not connected` → `connecting…` →
   `connected`. Video should appear within a couple of seconds.
5. **Check telemetry** — `safety: ok`, loop running at ~50 Hz.
6. **Drive it.** The keyboard legend on the Remote page is the live key map.
7. **Stop.** Tearing down cleanly vs. just closing the tab.
:::

## The one thing to know before you move an arm

The robot has an **E-STOP**, and it latches. Trip it any time — from the app, from your code
(`teleop.command("estop")`), or with the physical button on the robot. Motion stops and the
motors go torque-limited.

Clearing it is deliberate and nothing else does it for you: `reset_latch`. That's the design —
a latch you can clear by accident isn't a latch.

Full behavior in [the safety contract](/sdk/safety) and [safety states](/troubleshooting/safety-states).

## If it doesn't connect

The single most common failure is a session that sits at `connecting` and never reaches
`connected`. That's almost always the network, not you — see
[Connection troubleshooting](/troubleshooting/connection).
