# Python client (`nori-sdk`)

The Python operator client. It speaks the same **nori-protocol** over a WebRTC data channel as
`@nori/sdk`, and exists for the clients a browser can't serve: headless scripts, policy and agent
drivers, dataset tooling, and CI.

::: tip v1 — on PyPI as `nori-sdk`
The full surface — protocol, types, motion helpers, the mock, and the live `RemoteTeleop`
session — is tested, and the live session has driven real hardware (the mock's
`A3_DESCRIPTOR` is transcribed from a live A3's wire descriptor). The package `README.md`'s
Status section is the authoritative list of what is and isn't hardware-verified. Develop
against the mock first: it now mirrors the gateway's refusals verbatim (`unknown_joint`,
`empty_action`, `estop_latched`, `empty_pose`), so what passes here behaves the same way on
a robot.
:::

## Install

Published on [PyPI as `nori-sdk`](https://pypi.org/project/nori-sdk/); source lives at
[Nori-Robotics/nori-sdk-py](https://github.com/Nori-Robotics/nori-sdk-py):

```bash
pip install "nori-sdk[all]"   # the live session + Supabase signaling
pip install nori-sdk          # protocol, types, motion, mock — zero dependencies
```

Mirroring `@nori/sdk`, the core has **zero runtime dependencies**: aiortc (WebRTC) and
websocket-client (Supabase signaling) sit behind extras and are imported lazily.

## Start with the mock

`mock_session()` drives a `MockRobot` through a real session — no hardware, no credentials.
Every line runs unchanged against a real robot; one line differs:

```python
async with mock_session() as robot:                          # development
async with RemoteTeleop(SupabaseSignaling(...)) as robot:    # hardware
```

The mock **enforces the watchdog** — control-frame silence past `t_stop_ms` stops motion and
reports `safe_hold` — because that's the one rule a script can violate and still appear to work
locally. A green mock run proves your logic, not your network: ICE, TURN, video, and real timing
are out of scope.

## Quick start (against a robot)

```python
import asyncio
from nori_sdk import RemoteTeleop, SupabaseSignaling, UserAuth
from nori_sdk.motion import JogBuilder

async def main():
    auth = UserAuth(SUPABASE_URL, ANON_KEY, "me@example.com", "password")
    signaling = SupabaseSignaling(
        SUPABASE_URL, ANON_KEY, room="NORI-A3-0001", token_provider=auth.token
    )

    async with RemoteTeleop(signaling) as robot:
        info = await robot.wait_ready()
        print(info.descriptor.joints)          # never hard-code a joint list

        jog = JogBuilder(info.descriptor).base(linear=0.4).build()
        await robot.jog(jog, duration=1.5)     # streams at 20 Hz, then stops cleanly

        await robot.action({"left_arm_gripper.pos": 30}, wait=True)

asyncio.run(main())
```

The thing to internalize is the same as in TypeScript: **jog is a stream, and silence is a stop
command** — `jog(payload, duration=...)` handles the repetition; if you drive the stream yourself,
resend inside `info.watchdog_profile.t_warn_ms`. [The safety contract](/sdk/safety) applies
unchanged — it lives on the robot, not in either SDK.

Named waypoint navigation is also shared across the two clients. Use
`remember_waypoint()`, `list_waypoints()`, `navigate_to_waypoint()`,
`await_navigation()`, and `cancel_navigation()`; see the complete
[named navigation contract](/sdk/navigation), including map binding and session ownership.

The opt-in [LiDAR and IMU streams](/sdk/sensors) are shared too:
`configure_sensor_streams(lidar_hz=…, imu_hz=…)` turns them on, samples arrive through
`on("lidar_scan")` / `stream("imu")`, and `robot.lidar_scan` / `robot.imu_sample` hold the
latest of each. Both feeds are off until you ask for them.

Two places the Python SDK is deliberately stricter than the browser client, for the same
reason each time — a failure that could be mistaken for success is worse than a raise.

`estop()` **raises `TeleopError`** when the control channel is known-dead, because a silently
dropped E-STOP must never read as success — and `estop_confirmed(timeout=...)` goes further,
awaiting the robot *reporting* the latch in telemetry before returning. Delivery is not
execution; unattended scripts should use the confirmed form.

A correlated request the robot never answers **raises `RobotUnreachable`** (a `TeleopError`)
rather than returning a status, where the TypeScript client returns one flagged
`unreachable`. Returning one here would mean inventing `state` and `active`, and for
`navigate_to_waypoint()` — the one call that makes the robot drive itself — a caller reading
`active=False` off an invented status would read a lost reply as a halted robot. The
exception carries the robot's last real snapshot on `.last_known`. A *refusal* (`ok=False`)
is still returned, not raised: "waypoint not found" is an answer, not a failure.

## Reference

The package `README.md` is the reference: the full `RemoteTeleop` surface (motion, safety,
recording, video, events), the module layering, and exactly what is and isn't verified. The
public API is pinned by a test, so it can't drift by accident.
