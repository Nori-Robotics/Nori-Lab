# What is Nori?

A Nori robot is a two-armed mobile manipulator you drive from a browser, a VR headset, or your
own code. Three pieces make that work:

| Piece | What it is | Where it runs |
|---|---|---|
| **The daemon** | The 50 Hz control loop and the entire safety stack — clamping, watchdog, E-STOP, stall handling, motor torque lifecycle. | On the robot (a Raspberry Pi 5). |
| **The Nori app** | Setup, pairing, calibration, teleoperation, recording, training, marketplace. | Your laptop — as the [desktop app](/guide/install). |
| **`@nori/sdk`** | A TypeScript client. Connect over WebRTC, get video + telemetry, send jog commands. | Your code, in a browser. → [SDK docs](/sdk/) |

The load-bearing design decision, stated once: **every safety mechanism lives on the robot, and
nothing a client sends can disable it.** The app and the SDK are both just clients. That's what
makes it safe to hand the SDK to anyone. See [the safety contract](/sdk/safety).

## Pick your path

**I want to drive a robot.**
[Install the desktop app](/guide/install) → [set up leader arms](/guide/leader-arms) →
[first session](/guide/first-session).

**I want to build software on a robot.**
[SDK quick start](/sdk/quickstart). You don't need the desktop app for this.

**I want to put on a headset.**
[VR](/guide/vr). The VR page is hosted — no install needed, but the robot must already be paired.

::: info 🚧 To write
A short "what's in the box" section: robot, two leader arms, cables, what the operator supplies
(laptop, network). Plus a diagram of laptop → signaling → robot.
:::
