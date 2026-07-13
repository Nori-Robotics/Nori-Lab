# Bring your own signaling

`SupabaseSignaling` is just one implementation of the `SignalingTransport` contract. To run
without Supabase — your own WebSocket, a different SaaS, even manual copy/paste — implement the
interface. The WebRTC, auth, and jog logic is transport-agnostic.

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

## The contract

The robot side (`webrtc_robot.py`) must exchange the same named events:

| Event | Direction | Payload type |
|---|---|---|
| `ready` | client → robot | `{ mac?: string }` |
| `robot_here` | robot → client | `RobotHerePayload` |
| `sdp` | both | `SdpPayload` |
| `ice` | both | `IcePayload` |
| `bye` | client → robot | — |

The payload *shapes* are exported from `@nori/sdk` as `SdpPayload` / `IcePayload` /
`RobotHerePayload`, so you don't have to reverse-engineer them.

Two rules worth honoring: `sendBye()` is best-effort and must **never throw**, and `close()` must
be **idempotent**.
