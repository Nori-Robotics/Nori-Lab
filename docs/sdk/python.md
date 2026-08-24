# Python client (`nori-sdk`)

The Python operator client. It speaks the same **nori-protocol** over a WebRTC data channel as
`@nori/sdk`, and exists for the clients a browser can't serve: headless scripts, policy and agent
drivers, dataset tooling, and CI.

::: warning Alpha
The pure layers — protocol, types, motion helpers, and the mock — are complete and tested. The
live session (`RemoteTeleop`) is written but **not yet verified against a real robot**. Develop
against the mock; treat the hardware path as pre-release.
:::

## Install

Not on PyPI yet — that lands with the open-source release. Until then, install from the repo or
the wheel we send you:

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

## Reference

The package `README.md` is the reference: the full `RemoteTeleop` surface (motion, safety,
recording, video, events), the module layering, and exactly what is and isn't verified. The
public API is pinned by a test, so it can't drift by accident.
