# VR (`@nori/sdk/vr`)

WebXR immersive control. A `VrSession` runs the controller→jog mapper and drives an existing
`RemoteTeleop`.

Peer dependency: `three`.

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

## Controls

**Grip** = squeeze-to-move (a clutch). **Trigger** = that arm's gripper.

See `DEFAULT_BINDINGS` for the full map.

## Requirements

- **A secure context (HTTPS).** WebXR refuses to start otherwise — this is the usual reason
  `isSupported()` returns `false` or an "Enter VR" button is disabled.
- A WebXR-capable browser on the headset.
- A `RemoteTeleop` that has already `start()`ed.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- Feeding telemetry and currents in, and what the in-VR HUD renders from them.
- Haptics: what triggers them.
- Writing custom bindings rather than using `DEFAULT_BINDINGS`.
:::
-->

Using Nori's hosted VR page instead of building your own: [Guide: VR](/guide/vr).

Headset problems: [VR troubleshooting](/guide/vr#when-it-goes-wrong).
