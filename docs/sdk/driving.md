# Driving the robot

Two input paths — both ride the **same** wire. The daemon's jog → IK → clamp → motor path is
identical regardless of source, so neither is privileged over the other.

## Keyboard

Hand key events to the client. See `keybindLegend(mode)` for the live key map — it changes with
the control mode, so render it rather than hardcoding a table.

```ts
window.addEventListener("keydown", (e) => { if (teleop.onKeyDown(e)) e.preventDefault(); });
window.addEventListener("keyup",   (e) => teleop.onKeyUp(e));
```

## Programmatic jog

Push normalized rates in `[-1, 1]` per DOF. The SDK streams them at 50 Hz.

```ts
teleop.setExternalJog({
  right_arm: { shoulder_pan: 0.5, elbow_flex: -0.3 },
  right_lift: 0.2,        // per-arm lift velocity
});
teleop.setExternalJog(null); // stop
```

::: warning Keep the frames coming
Jog is a *stream*, not a fire-and-forget command. If your control frames go silent past the
watchdog thresholds, the robot slows and then stops on its own. That's the watchdog doing its job
— see [the safety contract](/sdk/safety).
:::

## Base {#base}

The mobile base rides the same jog stream under the `base` group, as normalized rates with
**REP-103 signs: +`linear` drives forward, +`angular` turns LEFT** (counter-clockwise). Emit
that convention and nothing else — never negate client-side:

```ts
teleop.setExternalJog({ base: { linear: 0.4, angular: -0.2 } }); // forward, turning right
```

::: tip The L2 exception is handled for you
The frozen L2 fleet's firmware turns opposite on `angular` and can never be updated, so the
SDK flips that one sign on the wire for a **positively-matched L2 only** (resolved from
`ack.model`, else the signaling room's fleet serial). Your code stays sign-blind either way.
For an L2 living in a room the auto-detection can't classify — a non-fleet dev room — pass
`baseSigns: "l2-legacy"` to `RemoteTeleop`; everything else is already the default
(`"rep103"`), and an unknown serial never resolves to the legacy branch.
:::

Omitting the `base` group in a jog means **stop**, never "hold the last velocity".

## Commands and mode

```ts
teleop.command("estop");        // also: "reset_latch" | "reset"
teleop.setArm("left");          // switch which arm is driven
teleop.toggleMode();            // cylindrical <-> per-joint
```

## Absolute moves

To command a joint to a *position* rather than a rate — and find out whether it actually got
there — tag the move with an action id and await the daemon's verdict. See
[Action completion](/sdk/actions).

## Teardown

```ts
await teleop.stop();            // tells the robot to restart cleanly, tears down the peer
```
