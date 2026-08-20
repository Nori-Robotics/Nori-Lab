# What is Nori?

::: info Hardware setup on this site covers the Nori L2
[Nori A3](/guide/a3) hardware documentation is coming soon. Everything else here — the app,
video, teleoperation, safety, and the SDK — applies to either robot.
:::

A Nori robot is a dual mobile manipulator you can drive from a browser, a VR headset, and/or your own code. Three pieces make that work:

| Piece | What it is | Where it runs |
|---|---|---|
| **The daemon** | The control loop and the entire safety stack: clamping, software E-STOP, stall handling, motor torque lifecycle. | On the robot. |
| **The Nori app** | Setup, pairing, calibration, teleoperation, recording, training, marketplace. | Your laptop — as the [desktop app](/guide/install). |
| **`@nori/sdk`** | A TypeScript client. Connect over WebRTC, get video + telemetry, send jog commands. | Your code, in a browser. → [SDK docs](/sdk/) |

One design decision shapes everything else: **all safety mechanisms live on-board the robot, and
no client can disable them.** The app and the SDK are both just clients — which is what makes the
SDK safe to experiment with. See [the safety contract](/sdk/safety).

## Pick your path

**I want to drive my Nori asap:** 
[ Install the desktop app](/guide/install) → [set up leader arms](/guide/l2#leader-arms) →
[first session](/guide/first-session). The leader-arm step is L2-only; on an A3, see
[Nori A3](/guide/a3).

**I want to build software for my robot:** 
[ SDK quick start](/sdk/quickstart). You don't need the desktop app for this.

**I want to drive using my headset:** 
[ VR](/guide/vr). The VR page is hosted — no install needed, but the robot must already be paired.

**Something is broken right now:** 
[ Something's broken](/guide/broken) — find your symptom, jump to the fix.

## What's in the box (Nori L2)

Early batches of the Nori L2 will come with:
- Nori robot
- One leader arm, which can be used in conjunction with keyboard teleoperation to control both arms. 
- Clamps for the leader arm.
- A charger for Nori.

A3 box contents land with the [A3 hardware pages](/guide/a3).
