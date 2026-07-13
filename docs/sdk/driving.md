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
