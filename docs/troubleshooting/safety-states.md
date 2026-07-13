# Safety states

When the robot stops moving, it is usually **not** broken. It's refusing to move on purpose, and
it will tell you which of these it's in.

Read `telemetry.safety`:

| State | What it means | How it clears |
|---|---|---|
| `ok` | Normal operation. | — |
| `safe_hold` | Refusing motion to protect itself: the Pi is too hot, **or** your control frames went silent past the watchdog stop threshold. **Not a latch.** | **Clears itself** once you fix the cause — let it cool, or restore your control stream. |
| `latched` | **E-STOP is latched** — an operator command, or the physical button on the robot. Motion blocked, motors torque-limited. | **Only** `command("reset_latch")`. Deliberate, by design. |

## "It stopped and won't start again"

You're in `latched`. Nothing clears an E-STOP latch except clearing it explicitly:

```ts
teleop.command("reset_latch");
```

That's intentional. A latch you can clear by accident isn't a latch. Confirm the situation is
actually safe first — that's the whole point of the state existing.

Note that `reset` (return to neutral pose) is a **motion** command, so it's **refused while
latched**. Trying to `reset` your way out of a latch will look like the robot ignoring you. Clear
the latch first, then reset.

## "It stopped on its own, and then started working again"

`safe_hold`, and it self-cleared. Two causes:

**The robot got too hot.** It shed load until it cooled.

**Your control frames went quiet.** This is the one people trip over. Jog is a *stream* — if you
stop sending, the watchdog escalates:

`ok` → `warn` (frames quiet past `t_warn_ms`) → `stop` (quiet past `t_stop_ms`; motion blocked
until frames resume)

A UI that stops streaming while a tab is backgrounded, or a control loop that stalls on garbage
collection, will trip this. The thresholds arrive in the handshake
(`robotInfo().watchdogProfile`) — you can read them, not change them.

## "One joint stopped, everything else still works"

That's a **stall**, and it is working exactly as designed — not a safety state at all.

When a joint is pushed against something, the robot cuts torque **on that joint only** and keeps
everything else running. **Jog the stalled joint away from the obstruction and it self-clears.**

You'll see it as an `action_status` with `reason: "stall:<joint>"` — e.g.
`"stall:right_arm_elbow_flex"` — not as a global stop.

## "I sent a position and the arm went somewhere else"

It was **clamped**, not rejected. Out-of-range targets move the joint **to the boundary** of
`descriptor.ranges` and report `clamped` in the action status.

There is no "invalid value" error to catch here. Use `ranges` to **scale** your inputs, not to
pre-validate them.

## Why none of this is configurable

Every one of these mechanisms lives on the **robot**, and no message a client can send disables or
loosens any of them. Limits are disclosed through the handshake, never negotiated.

That's deliberate: it's what makes it safe to hand the SDK to anyone. If your use case genuinely
needs different limits, that's a conversation with us, not a parameter.

Full detail: [The safety contract](/sdk/safety).
