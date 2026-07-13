# @nori/sdk

Robot-local teleoperation SDK for the **Nori daemon**. Connect to a robot over WebRTC, receive its
video + telemetry, and drive it — from the browser, in ~20 lines.

```
┌ your app ┐        ┌ @nori/sdk ┐   WebRTC    ┌ Pi bridge ┐  NDJSON  ┌ nori daemon ┐
│ video el │  ◄───► │RemoteTeleop│ ◄────────► │webrtc_robot│ ◄─────► │ 50Hz control │
│ keyboard │        └───────────┘  data chan  └───────────┘  :7777   │ safety stack │
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

## Where to start

- [**Install**](/sdk/install) — it's not on public npm; you install from a tarball we send you.
- [**Quick start**](/sdk/quickstart) — a connected, driving robot in one code block.
- [**The safety contract**](/sdk/safety) — the part you must read.

## Status

`v0`, for a small set of collaborating devs — not a public release.

The core teleop + VR surface is stable. The two-way **call** API (`joinCall` / `leaveCall` / mic /
camera on `RemoteTeleop`) is present but **experimental** and may change.

Note the robot-side consent gate: `joinCall()` rings an accept prompt at the robot, and room audio
stays silent until a person there accepts. Audio clips sent via `sendClipAudio` are exempt — see
[Audio](/sdk/audio).

Several pages carry a **Verification status** note where the SDK surface exists but the robot-side
half isn't deployed or verified yet. Those are real: trust them over the surrounding prose.

## License and lineage

Apache-2.0. Developed within Nori's fork of
[huggingface/leLab](https://github.com/huggingface/lelab) (Apache-2.0); the SDK package files are
Nori-original additions, marked with `// NORI:` header comments.
