# Safety states

When the robot stops moving, it is usually **not** broken. It's refusing to move on purpose, and
it will tell you which of these it's in.

Read `telemetry.safety`:

| State | What it means | How it clears |
|---|---|---|
| `ok` | Normal operation. | — |
| `safe_hold` | Refusing motion to protect itself: the Pi is too hot, **or** your control frames went silent past the watchdog stop threshold. **Not a latch.** | **Clears itself** once you fix the cause — let it cool, or restore your control stream. |
| `latched` | Something latched: a **software E-STOP** operator command, **or** the robot protecting a motor from over-temperature or sustained over-current. Motion blocked. | **Only** `command("reset_latch")`. Deliberate, by design. |

Then read `latch_reason` — it tells you *which*:

| `latch_reason` | What happened |
|---|---|
| `estop:<reason>` | A human stopped it. |
| `overtemp:<motor>` | That servo got too hot. Its torque was cut. |
| `overcurrent:<motor>` | That joint pulled too much current for too long. Its torque was cut. |
| `stall:<motor>` | That joint is pressed into an obstruction. **This one does not set `safety: latched`** — a stall reports a reason while `safety` stays `ok`. |

## "It stopped and won't start again"

You're in `latched`. Nothing clears a latch except clearing it explicitly:

```ts
teleop.command("reset_latch");
```

That's intentional. A latch you can clear by accident isn't a latch. Confirm the situation is
actually safe first — that's the whole point of the state existing.

**Check `latch_reason` before you reset.** If it's `overtemp:<motor>`, the servo is genuinely hot
and resetting immediately will just re-trip it — let it cool. If it's `overcurrent:<motor>`, the
joint was working against something; find out what before you re-energize it.

## "The robot latched and nobody touched it"

That's the motor protection doing its job, and it's new enough that it surprises people who
learned `latched` == E-STOP.

The robot watches every arm joint two ways:

- **Temperature.** A servo whose case temp crosses the limit has its torque **cut and latched
  off** (`latch_reason: "overtemp:<motor>"`). The servo's own firmware alarm sits behind that as a
  backstop for the case where the daemon isn't running at all.
- **Sustained current.** A joint pulling above the current floor accumulates against a budget;
  cross it and torque is **cut and latched off** (`latch_reason: "overcurrent:<motor>"`). Higher
  current trips faster. This catches the failure temperature is too slow to catch: a joint quietly
  cooking under a load that's below the stall threshold, or creeping into something soft.

::: danger That joint is now limp, and limp arms fall
These guards cut torque on the offending joint deliberately — the joint is what's being damaged.
A raised arm whose shoulder or elbow just went limp **will drop**. Clear the area before you
`reset_latch`.
:::

Both are manual-recovery only. Neither is configurable from a client.

## A joint shows up in `motorFaults` {#motor-faults}

`telemetry.motorFaults` maps a motor name to what's wrong with it. Only unhealthy motors appear;
`{}` means everything answered and is healthy. The app renders the same data as chips under the
grip-force card.

Two very different things live in that map:

**A decoded hardware fault** — e.g. `"overload,overheat (0x24)"`. This is the servo's own status
byte. The **hex is authoritative**; the names are best-effort decoding. The app shows these in
red. Expect it alongside an over-temp or over-current latch.

**The exact string `"no response"`** — the motor stopped answering the bus for several reads. It
was dropped, unplugged, or lost power. The app shows these in amber. This is a *cabling* problem,
not a thermal one, and it's why the distinction exists: a dead motor used to look identical to a
healthy one.

The same events also stream into the Robot logs panel as `motor_fault` / `motor_unreadable` /
`motor_recovered` lines.

Note that `reset` (return to neutral pose) is a **motion** command, so it's **refused while
latched**. Trying to `reset` your way out of a latch will look like the robot ignoring you. Clear
the latch first, then reset.

## "The computer is on, but every motor is off"

Check the physical E-stop. Unlike the software latch described above, the physical E-stop cuts
the motors' electrical power while leaving the robot's computer and other non-motor systems on.
Release the physical E-stop only after the area is safe. `reset_latch` cannot restore power that a
physical control has cut.

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
