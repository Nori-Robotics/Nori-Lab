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
console.log(result.state, result.distanceRemainingM, result.error);
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
| `awaitNavigation(goalId, options?)` | Wait for a terminal update without polling. |

Set `onNavigationStatus` in `RemoteTeleopOptions` to receive progress snapshots. The useful
feedback fields are `distanceRemainingM`, `estimatedTimeRemainingS`, and
`numberOfRecoveries`. Terminal states are `succeeded`, `canceled`, `aborted`, `failed`, and
`unavailable`; always render `error` for non-success outcomes.

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
