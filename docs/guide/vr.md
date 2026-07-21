# VR

Immersive control from a WebXR headset (Quest). Grip squeezes to move — a clutch — and the
trigger works that arm's gripper.

## The VR page is hosted, not installed

Unlike the rest of the app, VR runs from a **hosted web page**. There's nothing to install on the
headset: you open a URL in the headset's browser and you're in.

This works because the VR drive loop needs no local server — it talks to the robot directly over
WebRTC, exactly like any other SDK client.

## The handoff link

You don't want to type a URL into a headset. Open the VR page with the robot code already in the
query string:

```
https://<vr-domain>/nori/vr?room=<robot-serial>
```

The `?room=` is a convenience only — it pre-fills the **Robot code** field so nobody has to type a
serial on a VR keyboard. You can also just open the page bare and type the code in.

::: tip There is no token in this URL
Earlier builds carried `#token=…` in the fragment. **Room-token auth is retired.** A robot's room
is a private Supabase channel gated by RLS: the robot admits the account it's paired to, and
nothing else. There is no secret in the link, so it's safe to send over chat — and a link that a
URL shortener mangles no longer breaks anything but the pre-fill.
:::

::: info 🚧 To write
- The actual VR domain, once it's assigned.
- The on-device checklist: getting the link onto the Quest, browser requirements, what "Enter VR"
  looks like when it's ready.
- The controller binding map (`DEFAULT_BINDINGS`), as a diagram.
- What the in-VR HUD shows (telemetry, currents, haptics).
:::

## Requirements

- **A secure context (HTTPS).** WebXR refuses to start otherwise — this is why "Enter VR" is
  greyed out on a plain-HTTP page.
- **A WebXR-capable browser** on the headset.
- The robot already paired and reachable.

Building your own VR client instead: [SDK: VR](/sdk/vr).

Headset problems: [VR troubleshooting](/troubleshooting/vr).
