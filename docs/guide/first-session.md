# Your first session

Getting from a powered-on robot to an arm that moves when you press a key.

::: info 🚧 To write
The happy path, start to finish. Rough shape — fill in from the real app flow
(`frontend/src/nori/pages/`):

1. **Power on the robot.** What the LEDs / boot sound should do. How long until it's on the
   network.
2. **Sign in** to the Nori app.
3. **Pair the robot** (`/nori/pairing`), using the **pair code printed on the box**. This is the
   one-time step that makes the robot yours; after it, the app fills in the room (the robot's
   serial) automatically. There is no room token to copy anywhere.
4. **Connect** (`/nori/remote`). The connection chip goes `not connected` → `connecting…` →
   `connected`. Video should appear within a couple of seconds.
5. **Check telemetry** — `safety: ok`, loop running at ~50 Hz.
6. **Drive it.** The keyboard legend on the Remote page is the live key map.
7. **Stop.** Tearing down cleanly vs. just closing the tab.
:::

## The one thing to know before you move an arm

The robot has two different kinds of E-stop:

- The **physical E-stop** cuts electrical power to the motors only. The robot's computer and other
  non-motor systems stay powered. A raised arm can go limp and fall when motor power is removed.
- The **software E-stop**, available in the app or through `teleop.command("estop")`, blocks motion
  and latches while leaving motor torque engaged.

The **master switch** is different again: it controls power to the entire robot.

Clearing a software E-stop is deliberate and nothing else does it for you: `reset_latch`. That's
the design — a latch you can clear by accident isn't a latch. Releasing the physical E-stop is
required to restore motor power; a software command cannot restore power that the physical E-stop
has cut.

**The robot can also latch itself.** A servo that gets too hot, or a joint that pulls too much
current for too long, has its torque cut and latched off to save the motor — no human involved.
That joint goes **limp**, so a raised arm can drop. Read `latch_reason` to tell the cases apart
before you reset.

Full behavior in [the safety contract](/sdk/safety) and [safety states](/troubleshooting/safety-states).

## If it doesn't connect

The single most common failure is a session that sits at `connecting` and never reaches
`connected`. That's almost always the network, not you — see
[Connection troubleshooting](/troubleshooting/connection).
