# Telemetry

The robot streams a `TelemetryView` at roughly the control-loop rate. Subscribe with the
`onTelemetry` option; there is no polling accessor — telemetry is a stream, not a snapshot.

```ts
const teleop = new RemoteTeleop({
  /* ...options as usual... */
  onTelemetry: (t) => {
    if (t.safety !== "ok") console.warn("robot stopped:", t.safety);
    if (t.batteryPercent !== null && t.batteryPercent < 15) console.warn("low battery");
    for (const [motor, fault] of Object.entries(t.motorFaults)) console.error(motor, fault);
  },
});
```

## The fields

| Field | Type | Meaning |
|---|---|---|
| `loopHz` | `number` | The daemon's measured control-loop rate. ~50 on a healthy robot. |
| `safety` | `SafetyState` | `"ok"` / `"safe_hold"` / `"latched"`. See [the safety contract](/sdk/safety). |
| `watchdog` | `WatchdogState` | `"ok"` / `"warn"` / `"stop"` — how your control stream is doing. |
| `tempC` | `number` | The **Pi's** temperature, not a motor's. Motor heat surfaces via `motorFaults` and the over-temp latch. |
| `active` | `boolean` | Whether the control data channel is open — i.e. whether jog/commands go anywhere. Also delivered on its own via `onControlActive`. |
| `linkMode` | `"lan" \| "wan" \| null` | The *measured* ICE path. `null` until the candidate pair resolves. This is what picks the watchdog profile — it isn't something you declare. |
| `state` | `Record<string, number>` | The lerobot-native pose dict. See [Joint state](#joint-state). |
| `currents` | `Record<string, number>` | Per-motor current. **Raw units** — see [Currents](#currents). |
| `videoNet` | `VideoNetState \| null` | The adaptive-bitrate loop's link verdict. See [Video](/sdk/video). |
| `batteryPercent` | `number \| null` | Pack state-of-charge. See [Battery](#battery). |
| `motorFaults` | `Record<string, string>` | Per-motor hardware faults. See [Motor faults](#motor-faults). |

## Joint state {#joint-state}

`state` is the daemon's lerobot observation dict, carried verbatim so you can run forward
kinematics off it:

- `"<motor>.pos"` for every joint — arm joints normalized **[-100, 100]**, grippers **[0, 100]**.
  These are **not degrees**. The units are declared in the handshake (`robotInfo().normMode`), so
  read them rather than assuming.
- `"x.vel"` / `"theta.vel"` for the base.
- `"left_lift.pos"` / `"right_lift.pos"` — rail height in **real millimeters**, zero at the pose
  the daemon started in.

::: warning The lift keys are omitted, not zeroed, when height is unknown
The rail tracker is startup-relative and can invalidate (dropped reads, an out-of-band move). When
it does, the key **disappears from the dict**. Treat absence as "height unknown" — reading it as
`0` puts a rail at the top of its travel in your model when it may be anywhere.
:::

## Currents {#currents}

`currents` is per-motor `Present_Current`, keyed like `"right_arm_gripper"` (no `.pos` suffix).
It's the "virtual tactile" signal — the same values that drive VR haptics and the on-screen
grip-force readout.

::: warning These are raw Feetech LSBs, not milliamps
Convert with the exported helper rather than a magic number of your own:

```ts
import { currentMa, CURRENT_MA_PER_LSB, CURRENT_FULL_LSB } from "@nori/sdk";

const ma = currentMa(t.currents["right_arm_gripper"]);   // LSB -> mA
```

`CURRENT_FULL_LSB` is the value that maps to a full grip-force bar. It's a **display**
normalization mirroring the torque-limit span — not a current limit, and not a safety threshold.
:::

The **sign is meaningful** (direction), so `Math.abs()` before you treat a reading as force.

## Battery {#battery}

`batteryPercent` is pack state-of-charge, `0`–`100`, injected by the robot's bridge.

`null` means **unknown**, and there are several legitimate ways to get there: the robot has no
battery monitor fitted, the monitor's reader is down, the pack voltage is out of range, or the
robot is running an older bridge that doesn't send the field at all.

::: tip Render `null` as "—", never as 0%
A robot without a monitor is not a robot at 0%. Every consumer that has gotten this wrong has
shown an alarming empty battery on a perfectly charged robot.
:::

Only percentage is reported today. Voltage, current, and time-remaining are not on the wire.

## Motor faults {#motor-faults}

`motorFaults` maps a motor name to what's wrong with it. **Only unhealthy motors appear** — `{}`
is the healthy steady state, and is also what an older daemon that doesn't send the field
produces. Two distinct kinds of value live in it:

**A decoded hardware fault**, e.g. `"overload,overheat (0x24)"` — the servo's own status byte. The
**hex is authoritative**; the decoded names are best-effort. Show the whole string; don't parse
the names.

**The exact string `"no response"`** — the motor stopped answering the bus across several reads.
It was dropped, unplugged, or lost power. This is a cabling fault, not a thermal one, and keeping
it distinct is the point of the field: a dead motor used to be indistinguishable from a healthy
one.

The same transitions also arrive as log lines (`motor_fault` / `motor_unreadable` /
`motor_recovered`), so you can log edges rather than diffing the map yourself.

Diagnosing what you see: [Safety states](/troubleshooting/safety-states).
