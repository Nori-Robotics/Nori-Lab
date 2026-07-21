# What is Nori?

A Nori robot is a dual mobile manipulator you can drive from a browser, a VR headset, and/or your own code. Three pieces make that work:

| Piece | What it is | Where it runs |
|---|---|---|
| **The daemon** | The control loop and the entire safety stack: clamping, software E-STOP, stall handling, motor torque lifecycle. | On the robot (a Raspberry Pi 5). |
| **The Nori app** | Setup, pairing, calibration, teleoperation, recording, training, marketplace. | Your laptop — as the [desktop app](/guide/install). |
| **`@nori/sdk`** | A TypeScript client. Connect over WebRTC, get video + telemetry, send jog commands. | Your code, in a browser. → [SDK docs](/sdk/) |

The load-bearing design decision, stated once: **all safety mechanisms live on-board the robot, and
no client may disable it.** The app and the SDK are both just clients. That's what makes the SDK to mess around with. See [the safety contract](/sdk/safety).

## Pick your path

**I want to drive my Nori asap.**
[Install the desktop app](/guide/install) → [set up leader arms](/guide/leader-arms) →
[first session](/guide/first-session).

**I want to build software for my robot.**
[SDK quick start](/sdk/quickstart). You don't need the desktop app for this.

**I want to drive using my headset.**
[VR](/guide/vr). The VR page is hosted — no install needed, but the robot must already be paired.

## What's in the box:

Early batches of the Nori L2 will come with:
- Nori robot
- One leader arm, which can be used in conjunction with keyboard teleoperation to control both arms. 
- Clamps for the leader arm.
- A charger for Nori.
<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
A short "what's in the box" section: robot, two leader arms, cables, what the operator supplies
(laptop, network). Plus a diagram of laptop → signaling → robot.
:::
-->
