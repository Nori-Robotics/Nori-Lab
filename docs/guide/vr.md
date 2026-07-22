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

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- The actual VR domain, once it's assigned.
- The on-device checklist: getting the link onto the Quest, browser requirements, what "Enter VR"
  looks like when it's ready.
- The controller binding map (`DEFAULT_BINDINGS`), as a diagram.
- What the in-VR HUD shows (telemetry, currents, haptics).
:::
-->

## Requirements

- **A secure context (HTTPS).** WebXR refuses to start otherwise — this is why "Enter VR" is
  greyed out on a plain-HTTP page.
- **A WebXR-capable browser** on the headset.
- The robot already paired and reachable.

Building your own VR client instead: [SDK: VR](/sdk/vr).

## When it goes wrong

### "Enter VR" is disabled / `isSupported()` returns false

**You're not on a secure context.** WebXR refuses to start over plain HTTP from a non-localhost
origin. This is a browser rule, not a Nori one, and there's no flag to talk it out of it.

Serve the page over **HTTPS**. The hosted VR page already is; if you're running one locally, you
need a certificate — see the HTTPS setup notes.

Other candidates, once HTTPS is confirmed:

- The headset's browser doesn't support WebXR.
- No VR-capable device is connected.

### The headset connects but there's no video

Check the **robot code** first. A mismatch between what the handoff link carries and what the robot
is actually in produces a session that looks connected and carries no media.

Then: [Remote → when it won't connect](/guide/remote#connection-trouble) — everything there applies
equally to VR, because VR is just another SDK client.

### The handoff link doesn't work

`?room=` only pre-fills the **Robot code** field. If it didn't survive whatever you sent it
through, type the serial into the field by hand — nothing else is lost.

If the page connects but the robot never appears, the account you're signed in as probably isn't
the one the robot is paired to. Check the Pairing page in the app.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- Getting a link onto a Quest without typing it (the actual recommended flow).
- The on-device acceptance checklist: what a working session looks like step by step.
:::
-->

### Controls feel wrong

**Grip** is squeeze-to-move — it's a **clutch**, so the arm only follows while you're squeezing.
People who expect continuous tracking read this as "the arm keeps stopping."

**Trigger** is that arm's gripper.

Full map: `DEFAULT_BINDINGS`. See [SDK: VR](/sdk/vr).

### An arm stops mid-motion in VR

If **one joint** stopped and the rest still work, that's a **stall** and it's working as designed —
jog it away from whatever it's pushing against. [Safety states](/guide/safety-states).
