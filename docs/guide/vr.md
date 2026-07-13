# VR

Immersive control from a WebXR headset (Quest). Grip squeezes to move — a clutch — and the
trigger works that arm's gripper.

## The VR page is hosted, not installed

Unlike the rest of the app, VR runs from a **hosted web page**. There's nothing to install on the
headset: you open a URL in the headset's browser and you're in.

This works because the VR drive loop needs no local server — it talks to the robot directly over
WebRTC, exactly like any other SDK client.

## The handoff link

You don't type a URL into a headset. You generate a handoff link on the laptop and open it on the
headset:

```
https://<vr-domain>/nori/vr?room=<robot>#token=<token>
```

The token rides in the URL **fragment** deliberately — fragments are never sent to a server, so
the token stays out of server logs. The page scrubs it from the address bar once it's read.

::: info 🚧 To write
- The actual VR domain, once it's assigned.
- Exactly how an operator generates the handoff link in the app (which page, which button).
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
