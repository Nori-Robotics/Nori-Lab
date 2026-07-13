# Getting help

## Where to reach us

- **[Discord](https://discord.gg/d7gv7E6PZ)** — fastest. Community support and updates.
- **[GitHub](https://github.com/nori-robotics)** — bugs and feature requests.
- **[X](https://x.com/norirobotics)** — updates.

## What to send us

A report we can act on beats a fast one. Include:

**What you were doing** — teleoperating from the app, running your own SDK client, in VR, mid-recording.

**What you expected, and what happened instead.** "It didn't work" costs us a round-trip.

**The safety state.** `telemetry.safety` at the moment it went wrong — `ok`, `safe_hold`, or
`latched`. This single field routes the whole diagnosis, and a robot in `latched` is not a bug.
See [safety states](/troubleshooting/safety-states).

**The connection state.** Where `onConnState` stalled — particularly whether it ever reached
`connected`.

**Your network.** Corporate/university Wi-Fi, hotel, VPN, mobile hotspot? If a session won't
connect, this is usually the answer, and knowing it lets us just send you TURN credentials rather
than debug your code. See [connection troubleshooting](/troubleshooting/connection).

**Whether it correlates with load.** A peripheral that drops under load and is fine when idle is a
[power problem](/troubleshooting/power), not a software one.

**Logs**, if you can get them.

::: info 🚧 To write
Tell people exactly how to collect logs: browser console for SDK clients, the desktop app's log
location per platform (**still undocumented — the biggest gap in this page**), and how to pull
robot-side daemon logs.
:::

## Things we already know

Don't spend your afternoon on these — they're expected:

- **Low-res, ~15 fps video.** It's the robot's power budget, not a bug.
  [Why](/troubleshooting/connection#video-quality).
- **`perceive()` returns `null` on real hardware.** The on-Pi detector doesn't exist yet.
  [Perception](/sdk/perception).
- **A stall stops one joint, not the robot.** By design. [Safety states](/troubleshooting/safety-states).
- **Silence after `joinCall()`** until someone at the robot accepts the prompt. By design.
  [Audio](/troubleshooting/audio).
- **Sessions that hang at `connecting` on strict networks.** You need TURN credentials — just ask.

## If these docs are wrong

Tell us. A page that contradicts what your robot actually does is a bug, and we'd rather hear
about it than have you work around it. Every page has an **Edit this page** link if you want to fix
it yourself.
