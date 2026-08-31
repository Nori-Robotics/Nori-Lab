# Named navigation

`RemoteTeleop` can save the robot's current localized position as a named waypoint and later
ask Nav2 to return there. The API deliberately does not accept raw coordinates or maps: the
robot owns localization, active-map matching, motion safety, and the one active navigation goal.

Navigation is available when the handshake advertises the `named_navigation` capability. A
saved-map navigation launch must be running and AMCL must be localized before a waypoint can be
remembered or used.

::: danger Navigation causes autonomous motion
Keep the robot in sight and keep its operating area clear. `navigateToWaypoint()` is an explicit
motion command. The robot's software E-stop blocks new goals and cancels the active goal;
ending the SDK session also cancels the goal owned by that session. Do not use a lost network
connection as a stop mechanism: use the physical E-stop when delivery cannot be confirmed.
:::

## TypeScript

```ts
const saved = await teleop.rememberWaypoint("charging station");
if (!saved.ok) throw new Error(saved.error ?? "could not save waypoint");

const listed = await teleop.listWaypoints();
console.log(listed.waypoints);

const started = await teleop.navigateToWaypoint("charging station");
if (!started.ok || !started.goalId) {
  throw new Error(started.error ?? "navigation was refused");
}

const result = await teleop.awaitNavigation(started.goalId, { timeoutMs: 120_000 });
if (result.unreachable) {
  // The robot never answered. It may still be driving — see "Unreachable" below.
  console.warn("lost contact while navigating:", result.error);
} else {
  console.log(result.state, result.distanceRemainingM, result.error);
}
```

The methods return `Promise<NavigationStatus>`:

| Method | Meaning |
|---|---|
| `listWaypoints()` | List destinations for the active map. |
| `rememberWaypoint(name)` | Save the current localized pose. Reusing a name replaces it. |
| `deleteWaypoint(name)` | Delete a destination. Refused while a goal is active. |
| `navigateToWaypoint(name)` | Start one map-matched Nav2 goal and return its `goalId`. |
| `cancelNavigation(goalId?)` | Cancel this SDK session's active goal, optionally matching its ID. |
| `getNavigationStatus()` | Request the current robot-side snapshot. |
| `latestNavigationStatus()` | Read the latest cached reply or unsolicited update. |
| `awaitNavigation(goalId, options?)` | Wait for a terminal update without polling. Resolves `unreachable` if the timeout expires first. |

Set `onNavigationStatus` in `RemoteTeleopOptions` to receive progress snapshots. The useful
feedback fields are `distanceRemainingM`, `estimatedTimeRemainingS`, and
`numberOfRecoveries`. Terminal states are `succeeded`, `canceled`, `aborted`, `failed`, and
`unavailable`; always render `error` for non-success outcomes.

### Unreachable: the robot did not answer

Every method above can also resolve with **`unreachable: true`**. That status was synthesized
by the client, not sent by the robot: the reply never arrived within the timeout, the control
channel was closed, or the session was torn down.

`unreachable` is not a robot state. It means the robot's state is **unknown**, and a lost reply
is not a lost command — a `navigateToWaypoint()` that resolves `unreachable` may be driving
right now. On such a status `state` and `active` are the last values the *robot* reported,
carried forward and therefore stale; when the client has heard nothing at all they fall back to
`unavailable` / `false`, which is an absence of information rather than an observation.

::: warning
Never treat `active: false` on an unreachable status as confirmation that the robot has
stopped. Branch on `unreachable` before you read `state`, `active`, or `ok`. If you need the
robot stopped and cannot confirm delivery, use the physical E-stop.
:::

Statuses the robot actually sent never carry the field, so `if (result.unreachable)` cleanly
separates "the robot told me it failed" from "I could not reach the robot".

## Python

The Python client has the same lifecycle with snake-case names:

```python
saved = await robot.remember_waypoint("charging station")
if not saved.ok:
    raise RuntimeError(saved.error)

started = await robot.navigate_to_waypoint("charging station")
if not started.ok or not started.goal_id:
    raise RuntimeError(started.error)

result = await robot.await_navigation(started.goal_id, timeout=120.0)
print(result.state, result.distance_remaining_m, result.error)
```

`list_waypoints()`, `delete_waypoint()`, `cancel_navigation()`, and
`get_navigation_status()` mirror the TypeScript methods. `robot.navigation_status` is the
latest cached `NavigationStatus`.

::: warning The Python client raises where TypeScript returns
There is no `unreachable` field in Python. When the robot does not answer, the call **raises
`RobotUnreachable`** (a `TeleopError`) rather than returning a status, because returning one
would mean inventing `state` and `active`. The exception carries the robot's last real
snapshot on `.last_known` — stale by definition, never evidence of the present.

```python
from nori_sdk import RobotUnreachable

try:
    result = await robot.await_navigation(started.goal_id, timeout=120.0)
except RobotUnreachable as lost:
    # The goal did not report finishing. The robot may still be driving.
    print("lost contact; last seen:", lost.last_known)
```

This matches `record()` and `policy_stream()`, which already raise on a reply timeout. A
*refusal* (`ok=False`) is still returned, not raised.
:::

## Delivery and ownership

Navigation commands are one-shot messages rather than a jog stream. The SDK retries a command
with the same request UUID until it receives a reply; the gateway caches that UUID, so a lost
packet or response cannot start the goal twice.

The gateway accepts navigation only from an authenticated private-room session with a valid
grant for that robot. Goals are tagged with the session owner: one client cannot cancel another
client's goal, and disconnect cleanup only targets the departing session's goal.

Waypoints are bound to a fingerprint of the active occupancy map. Changing the map makes old
waypoints unavailable rather than silently applying their coordinates to a different space.

## Develop against the mock

Both SDK mocks advertise `named_navigation` and implement deterministic save, list, start,
progress, completion, cancel, and request-deduplication behavior. This validates client state
handling without robot motion. It does not validate localization, Nav2 tuning, obstacles, or
network timing.
