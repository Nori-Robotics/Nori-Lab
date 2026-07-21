# The safety contract

The core promise, stated precisely: **every safety mechanism lives on the robot, and none of them
are negotiable from this SDK.**

Clamping, watchdog, E-STOP, stall handling, and the motor torque lifecycle all run in the robot's
control daemon. No message you can send — malformed, malicious, or buggy — disables or loosens
them.

Limits are **disclosed, not negotiated**: the handshake tells you what they are
(`robotInfo().watchdogProfile`, `descriptor.ranges`), and there is deliberately no API to change
them. If your use case genuinely needs different limits, that's a conversation with us, not a
parameter.

## What the robot enforces, and how you see it

### `telemetry.safety` (`SafetyState`)

| Value | What the robot is doing | What you do |
|---|---|---|
| `"ok"` | Normal operation. | Carry on. |
| `"safe_hold"` | Refusing motion to protect itself — either the Pi is too hot, or your control frames went silent past the watchdog stop threshold. **Not a latch.** | Fix the cause (let it cool / restore your control stream); it clears itself. |
| `"latched"` | Something latched. **E-STOP** (operator command or the robot's physical button), **or** a motor-protection trip — an over-temperature or sustained-over-current joint cut. Motion blocked. | Clear deliberately with `command("reset_latch")` once the situation is safe. |

::: warning `latched` is no longer synonymous with E-STOP
A robot can latch on its own to protect a motor. Read `latch_reason` before you assume a human
pressed something — see [Motor protection](#motor-protection) below.
:::

### `latch_reason`

Reason strings follow `"<cause>:<detail>"`:

| Value | Meaning |
|---|---|
| `estop:<reason>` | A human (app command, SDK `command("estop")`, or the physical button). `safety` = `latched`. |
| `overtemp:<motor>` | That servo's case temperature crossed the over-temp threshold. Torque cut on that joint. `safety` = `latched`. |
| `overcurrent:<motor>` | That joint drew too much current for too long (a sustained-load integral, not an instantaneous spike). Torque cut on that joint. `safety` = `latched`. |
| `stall:<motor>` | That joint is pressing into an obstruction. **`safety` stays `ok`** — a stall is not a global stop. |
| `null` | Nothing latched and nothing stalled. |

::: warning `latch_reason` can be set while `safety` is `ok`
A stall reports itself through `latch_reason` but deliberately does **not** raise `safety`. Branch
on `safety` for "is the robot stopped", and read `latch_reason` for "why" — don't treat a non-null
`latch_reason` as a stop.
:::

**Do not switch exhaustively on these.** The `<cause>` set is open and grows; show the string.

## Motor protection {#motor-protection}

Beyond E-STOP, the daemon runs three independent motor guards. Two of them **latch**, which is
the behavior change most likely to surprise a client written before them:

| Guard | Trips on | Effect | Recovery |
|---|---|---|---|
| **Stall detector** | A joint pressing into an obstruction. | That joint's torque is capped low and its goal parked at the present position — it holds at the obstacle instead of cranking into it. Everything else keeps running. | **Self-clears**: jog that joint to a new target. Or `reset_latch`. |
| **Sustained-current trip** | A joint drawing above the current floor for long enough that the integral exceeds its budget. Higher current trips faster (a hard stall in seconds, a mild cook in tens of seconds). Grippers exempt. | That joint's torque is **cut and latched off**. `safety` → `latched`, `latch_reason` → `overcurrent:<motor>`. | **`reset_latch` only.** |
| **Over-temp latch** | A servo's case temperature crossing the threshold (read ~1 Hz). | That joint's torque is **cut and latched off**. `safety` → `latched`, `latch_reason` → `overtemp:<motor>`. | **`reset_latch` only**, and only once it has cooled — it will re-trip otherwise. |

The current and temperature guards exist because a joint can *cook* while drawing too little to
look like a stall. They are deliberately not tunable from a client.

::: tip Torque is not dropped on a latch
An E-STOP blocks motion but **leaves torque engaged** — dropping a gravity-loaded arm is more
dangerous than holding it. The per-joint guards above are the exception: they cut torque on the
one offending joint, on purpose, because that joint is the thing being damaged. **A joint that
goes limp can fall.**
:::

### `telemetry.watchdog` (`WatchdogState`)

`"ok"` → `"warn"` (your control frames went quiet past `t_warn_ms`, or the robot is shedding
thermal load) → `"stop"` (quiet past `t_stop_ms`; motion blocked until frames resume).

The thresholds are per-link (LAN vs WAN) and arrive in the handshake. **You can read them, not set
them.**

## Stalls are deliberately NOT a safety state

When a joint is pushed against something, the robot cuts torque **on that joint only** and keeps
everything else running. It self-clears when you jog the stalled joint *away* from the
obstruction.

You'll see it as an `action_status` with `reason: "stall:<joint>"` — not as a global stop.

Note the contrast with the over-temp and over-current guards above: those **do** latch the whole
robot and need an explicit `reset_latch`. A stall does not.

## The three commands

| Command | Effect |
|---|---|
| `"estop"` | Trip the E-STOP latch now (safety → `"latched"`). Always available; never rate-limited. Torque stays engaged. |
| `"reset_latch"` | Clear **every** latch — E-STOP, stall, over-temp, over-current — and re-engage torque on any joint that was cut. A deliberate act; nothing else clears a latch. |
| `"reset"` | Return the arm(s) to their neutral pose. A motion command, not a latch operation — so it's refused while latched. |

## Out-of-range targets are clamped, never rejected

Sending a `.pos` beyond `descriptor.ranges` moves the joint **to the boundary** and (for tagged
actions) reports `clamped` in the action status.

Use `ranges` to **scale your inputs, not to pre-validate them**. A value you thought was rejected
was actually executed, at the limit.
