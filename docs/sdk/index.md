# @nori/sdk

Robot-local teleoperation SDK for the **Nori daemon**. Connect to a robot over WebRTC, receive its
video + telemetry, and drive it — from the browser, in ~20 lines.

```
┌ your app ┐        ┌ @nori/sdk ┐   WebRTC    ┌robot bridge┐  NDJSON  ┌ nori daemon ┐
│ video el │  ◄───► │RemoteTeleop│ ◄────────► │webrtc_robot│ ◄─────► │ 50Hz control │
│ keyboard │        └───────────┘  data chan  └────────────┘ :7777   │ safety stack │
└──────────┘         signaling ▲                                     └──────────────┘
                     (Supabase or BYO)
```

::: danger Safety
The daemon defends itself — clamping, watchdog, E-STOP, rate-limits and the motor torque
lifecycle are all on the robot. **No message this SDK can send makes the robot unsafe.** That
invariant is what makes a client SDK safe to hand out.

Targets **nori-protocol v1** (`NORI_PROTOCOL_VERSION`); a daemon on a different major rejects the
connection. Read [the safety contract](/sdk/safety) before you ship.
:::

The SDK is not model-specific: the same client drives a **Nori L2** or a **Nori A3** — including
the one model-dependent wire quirk (the frozen L2 fleet's base-angular sign), which the SDK
resolves internally so your code never learns it exists (see [Driving → Base](/sdk/driving#base)).
If you have an A3, see [Nori A3](/guide/a3) — including a published robot description you can
load into a simulator today.

Two clients speak the protocol: **`@nori/sdk`** (TypeScript — the browser client these pages
document, source at [Nori-Robotics/Nori-SDK](https://github.com/Nori-Robotics/Nori-SDK)) and
[**`nori-sdk` for Python**](/sdk/python) — headless scripts, policy and agent drivers, dataset
tooling, CI. The Python client is on [PyPI](https://pypi.org/project/nori-sdk/)
([source](https://github.com/Nori-Robotics/nori-sdk-py)); the TypeScript package is not on npm
yet. The wire dialect both implement is specified in
[Nori-Robotics/Nori-Protocol](https://github.com/Nori-Robotics/Nori-Protocol) — JSON Schemas
plus validated fixtures for every message.

Need lower-level than an operator SDK — your own control loops on the robot itself, nothing
through Nori's cloud? That's the planned [developer posture](/guide/dev-posture).

## Where to start

- [**Install**](/sdk/install) — from the release tarball we send you.
- [**Quick start**](/sdk/quickstart) — a connected, driving robot in one code block, and a
  [mock robot](/sdk/quickstart#develop-without-a-robot) for building with zero hardware.
- [**Named navigation**](/sdk/navigation) — save map-bound destinations, start Nav2 goals,
  observe progress, and cancel them safely.
- [**Telemetry**](/sdk/telemetry) — every field the robot streams back, and what `null` means in each.
- [**LiDAR and IMU**](/sdk/sensors) — opt-in filtered scans and inertial samples with bounded rates.
- [**The safety contract**](/sdk/safety) — the part you must read.

## Status

The core teleop + VR surface is stable. The two-way **call** API (`joinCall` / `leaveCall` / mic /
camera on `RemoteTeleop`) is present but **experimental** and may change.

Note the robot-side consent gate: `joinCall()` rings an accept prompt at the robot, and room audio
stays silent until a person there accepts. Audio clips sent via `sendClipAudio` are exempt — see
[Audio](/sdk/audio).

Where an SDK surface exists but the robot-side half isn't live yet, the page says so in a
callout. Read those before building on the feature.

## License and lineage

Apache-2.0. Developed within Nori's fork of
[huggingface/leLab](https://github.com/huggingface/lelab) (Apache-2.0); the SDK package files are
Nori-original additions.
