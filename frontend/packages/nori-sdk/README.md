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

> **Safety.** The daemon defends itself — clamping, watchdog, E-STOP, rate-limits and the motor
> torque lifecycle are all on the robot. **No message this SDK can send makes the robot unsafe.**
> That invariant is what makes a client SDK safe to hand out. Targets **nori-protocol v1**
> (`NORI_PROTOCOL_VERSION`); a daemon on a different major rejects the connection.

## Install

```bash
npm i @nori/sdk
# optional peers, only if you use them:
npm i @supabase/supabase-js   # for the reference signaling transport (@nori/sdk/supabase)
npm i three                   # for VR (@nori/sdk/vr)
```

The **core** (`@nori/sdk`) has zero runtime dependencies. VR and Supabase signaling live behind
their own subpath imports so you never pull them unless you ask for them.

## Quick start (Supabase signaling)

The fastest path: use the reference **Supabase** transport with a room + token + TURN creds we
provision for you (you do **not** need your own Supabase account — just the room credentials).

```ts
import { RemoteTeleop } from "@nori/sdk";
import { SupabaseSignaling } from "@nori/sdk/supabase";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // values we give you
const video = document.querySelector("video")!;

const teleop = new RemoteTeleop({
  signaling: new SupabaseSignaling(supabase, ROOM, (...m) => console.log(...m)),
  videoEl: video,
  token: ROOM_TOKEN,        // "" for an open dev room; HMAC-authed otherwise
  stun: "stun:stun.l.google.com:19302",
  turnUrls: [TURN_URL],     // provisioned for WAN; omit for same-LAN
  turnUser: TURN_USER,
  turnCred: TURN_CRED,
  forceRelay: false,
  arm: "right",             // which arm keyboard/jog drives
  onLog: (m) => console.log(m),
  onConnState: (s) => console.log("conn:", s),
  onTelemetry: (t) => {     // live: loopHz, safety, tempC, per-joint state{}, lift height mm…
    console.log("safety:", t.safety, "state:", t.state);
  },
  onMode: (mode) => console.log("mode:", mode),
  onControlActive: (a) => console.log("control:", a),
});

await teleop.start();       // subscribes, answers the robot's offer, opens the control channel
```

Video now flows into your `<video>` element and `onTelemetry` fires ~50×/s.

## Driving the robot

Two input paths — both ride the **same** wire (the daemon's jog → IK → clamp → motor path is
identical regardless of source):

**Keyboard** — hand key events to the client (see `keybindLegend(mode)` for the live key map):

```ts
window.addEventListener("keydown", (e) => { if (teleop.onKeyDown(e)) e.preventDefault(); });
window.addEventListener("keyup",   (e) => teleop.onKeyUp(e));
```

**Programmatic jog** — push normalized rates in `[-1, 1]` per DOF (streamed at 50 Hz):

```ts
teleop.setExternalJog({
  right_arm: { shoulder_pan: 0.5, elbow_flex: -0.3 },
  right_lift: 0.2,        // per-arm lift velocity
});
teleop.setExternalJog(null); // stop
```

**Commands & mode:**

```ts
teleop.command("estop");        // also: "reset_latch" | "reset"
teleop.setArm("left");          // switch which arm is driven
teleop.toggleMode();            // cylindrical <-> per-joint
```

**Teardown:**

```ts
await teleop.stop();            // tells the robot to restart cleanly, tears down the peer
```

## VR (`@nori/sdk/vr`)

WebXR immersive control. A `VrSession` runs the controller→jog mapper and drives an existing
`RemoteTeleop`. Peer dependency: `three`.

```ts
import { VrSession, DEFAULT_BINDINGS } from "@nori/sdk/vr";

if (await VrSession.isSupported()) {
  const session = new VrSession({
    teleop,                     // a started RemoteTeleop
    videoEl: video,             // same element the robot stream is attached to
    onLog: (m) => console.log(m),
    onEnd: () => console.log("VR ended"),
  });
  // feed telemetry/currents in for the in-VR HUD + haptics:
  //   teleop options onTelemetry -> session.setTelemetry(t)
  //   teleop options onCurrents  -> session.setCurrents(c)
  await session.start();        // enters immersive-vr
}
```

Grip = squeeze-to-move (clutch), trigger = that arm's gripper; see `DEFAULT_BINDINGS` for the map.

## Advanced: bring your own signaling

`SupabaseSignaling` is just one implementation of the `SignalingTransport` contract. To run
without Supabase (your own WebSocket, a different SaaS, even manual copy/paste), implement the
interface — the WebRTC/auth/jog logic is transport-agnostic:

```ts
import type { SignalingTransport, SignalingHandlers } from "@nori/sdk";

class MySignaling implements SignalingTransport {
  async connect(h: SignalingHandlers) {
    // wire your transport to: h.onSdp, h.onIce, h.onRobotHere, h.onOpen
  }
  sendReady(p: { mac?: string }) { /* broadcast 'ready' */ }
  sendSdp(p) { /* broadcast our SDP answer */ }
  sendIce(p) { /* broadcast a local ICE candidate */ }
  sendBye() { /* best-effort 'leaving'; never throw */ }
  async close() { /* tear down; idempotent */ }
}
```

The robot side (`webrtc_robot.py`) must exchange the same named events (`sdp`, `ice`,
`robot_here`, `ready`, `bye`). The event *shapes* are the `SdpPayload` / `IcePayload` /
`RobotHerePayload` types exported from `@nori/sdk`.

## Entry points

| Import | Contains | Extra dep |
|---|---|---|
| `@nori/sdk` | `RemoteTeleop`, telemetry/jog/keybind types, `SignalingTransport` contract, `NORI_PROTOCOL_VERSION` | none |
| `@nori/sdk/vr` | `VrJogMapper`, `VrSession`, `DEFAULT_BINDINGS`, VR types | `three` |
| `@nori/sdk/supabase` | `SupabaseSignaling` (reference transport) | `@supabase/supabase-js` |

## Status

`v0`, for a small set of collaborating devs — not a public release. The core teleop + VR surface
is stable; the two-way **call** API (`joinCall`/`leaveCall`/mic/camera on `RemoteTeleop`) is
present but **experimental** and may change.
