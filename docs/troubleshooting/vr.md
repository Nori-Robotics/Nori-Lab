# VR and headsets

## "Enter VR" is disabled / `isSupported()` returns false

**You're not on a secure context.** WebXR refuses to start over plain HTTP from a non-localhost
origin. This is a browser rule, not a Nori one, and there's no flag to talk it out of it.

Serve the page over **HTTPS**. The hosted VR page already is; if you're running one locally, you
need a certificate — see the HTTPS setup notes.

Other candidates, once HTTPS is confirmed:

- The headset's browser doesn't support WebXR.
- No VR-capable device is connected.

## The headset connects but there's no video

Check the **room name** first. A mismatch between what the handoff link carries and what the robot
is actually in produces a session that looks connected and carries no media.

Then: [Connection troubleshooting](/troubleshooting/connection) — everything there applies equally
to VR, because VR is just another SDK client.

## The handoff link doesn't work

The link looks like:

```
https://<vr-domain>/nori/vr?room=<robot>#token=<token>
```

The token is in the **fragment** (`#token=…`) deliberately, so it never reaches a server log. Two
consequences that bite people:

- **Anything that rewrites or strips the fragment breaks the link.** Some chat apps and URL
  shorteners do exactly that. Send the link in a way that preserves it verbatim.
- The page **scrubs the token from the address bar** once it's read. That's expected — the link in
  your history won't work a second time if you copy it back out.

::: info 🚧 To write
- Getting a link onto a Quest without typing it (the actual recommended flow).
- The on-device acceptance checklist: what a working session looks like step by step.
:::

## Controls feel wrong

**Grip** is squeeze-to-move — it's a **clutch**, so the arm only follows while you're squeezing.
People who expect continuous tracking read this as "the arm keeps stopping."

**Trigger** is that arm's gripper.

Full map: `DEFAULT_BINDINGS`. See [SDK: VR](/sdk/vr).

## An arm stops mid-motion in VR

If **one joint** stopped and the rest still work, that's a **stall** and it's working as designed —
jog it away from whatever it's pushing against. [Safety states](/troubleshooting/safety-states).

Guide: [VR](/guide/vr).
