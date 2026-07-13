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
| `"latched"` | **E-STOP is latched** (operator command or the robot's physical button). Motion blocked, motors torque-limited. | Clear deliberately with `command("reset_latch")` once the situation is safe. |

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

Reason strings follow the pattern `"<cause>:<detail>"` — e.g. `"stall:right_arm_elbow_flex"`,
`"estop:button"`.

## The three commands

| Command | Effect |
|---|---|
| `"estop"` | Trip the E-STOP latch now (safety → `"latched"`). Always available; never rate-limited. |
| `"reset_latch"` | Clear the E-STOP and any stall latches, restore normal torque. A deliberate act — nothing else clears a latch. |
| `"reset"` | Return the arm(s) to their neutral pose. A motion command, not a latch operation — so it's refused while latched. |

## Out-of-range targets are clamped, never rejected

Sending a `.pos` beyond `descriptor.ranges` moves the joint **to the boundary** and (for tagged
actions) reports `clamped` in the action status.

Use `ranges` to **scale your inputs, not to pre-validate them**. A value you thought was rejected
was actually executed, at the limit.
