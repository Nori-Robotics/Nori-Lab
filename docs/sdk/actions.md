# Action completion

Tag an absolute move with an `action_id` and the daemon reports its lifecycle back — so a script
can await what *actually* happened instead of guessing from telemetry.

The lifecycle: `accepted` → `active` → `done` | `clamped` | `blocked` | `timeout`.

```ts
const id = teleop.nextActionId();
teleop.sendAction({ "right_arm_shoulder_pan.pos": 30 }, id);   // tag the frame(s)
const status = await teleop.awaitAction(id, { timeoutMs: 5000 });
// status.state: "done" | "clamped" | "blocked" | "timeout" (+ status.reason for blocked/timeout)
```

## The surface

| Call | What it does |
|---|---|
| `nextActionId()` | Mint an id. |
| `sendAction(targets, id)` | Send an absolute move, tagged. |
| `awaitAction(id, opts)` | Resolve when the daemon reports a terminal state. |
| `actionStatus(id)` | The latest status seen, in any state. The executor uses it to detect whether the daemon is participating at all. |
| `onActionStatus` | Streams every transition — useful for logging. |

`awaitAction` **self-resolves to a synthetic `timeout`** if the daemon predates this feature, so it
never hangs.

## Reading the terminal states

- **`done`** — it got there.
- **`clamped`** — it moved, but to the boundary of `descriptor.ranges`, not where you asked.
  Out-of-range targets are clamped, never rejected. This is the status that tells you.
- **`blocked`** — something stopped it. Check `reason` (e.g. `"stall:right_arm_elbow_flex"`).
- **`timeout`** — no terminal report arrived in time.

`nori.moveTo(...)` in the executor uses all of this internally and returns the daemon's verdict.

::: warning Verification status (v0)
SDK + executor are implemented and unit-tested. The daemon that emits `action_status` is built and
selftest-covered, but **must be deployed to the robot**, and the tolerances tuned on hardware.

Until then, `moveTo` transparently falls back to its client-side heuristic — so it works, but the
verdict is inferred rather than reported.
:::
