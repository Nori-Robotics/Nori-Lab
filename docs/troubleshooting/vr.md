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
https://<vr-domain>/nori/vr?room=<robot-serial>
```

`?room=` only pre-fills the **Robot code** field. If it didn't survive whatever you sent it
through, type the serial into the field by hand — nothing else is lost.

::: tip Looking for the `#token=` part?
It's gone. Room-token auth is **retired**; access to a real robot's room is gated by Supabase RLS
against the account the robot is paired to. There is no token to carry, scrub, or leak — so a
mangled fragment is no longer a failure mode.
:::

If the page connects but the robot never appears, the account you're signed in as probably isn't
the one the robot is paired to. Check the Pairing page in the app.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- Getting a link onto a Quest without typing it (the actual recommended flow).
- The on-device acceptance checklist: what a working session looks like step by step.
:::
-->

## Controls feel wrong

**Grip** is squeeze-to-move — it's a **clutch**, so the arm only follows while you're squeezing.
People who expect continuous tracking read this as "the arm keeps stopping."

**Trigger** is that arm's gripper.

Full map: `DEFAULT_BINDINGS`. See [SDK: VR](/sdk/vr).

## An arm stops mid-motion in VR

If **one joint** stopped and the rest still work, that's a **stall** and it's working as designed —
jog it away from whatever it's pushing against. [Safety states](/troubleshooting/safety-states).

Guide: [VR](/guide/vr).
