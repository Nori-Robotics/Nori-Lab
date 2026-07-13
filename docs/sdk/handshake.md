# The handshake

Shortly after the control channel opens, the daemon sends its **ack** — a self-description of the
robot you just connected to. Read it at use-time with `robotInfo()` (null until it arrives) or
subscribe with the `onReady` option:

```ts
const teleop = new RemoteTeleop({
  /* ...options as usual... */
  onReady: (info) => {
    if (!info.accepted) { console.error("robot refused session:", info.error); return; }
    console.log("protocol v" + info.protocolVersion, "units:", info.normMode);
    console.log("joints:", info.descriptor?.joints);
    console.log("cameras:", info.descriptor?.cameras);   // same roles as the CameraLayout tiles
    console.log("gripper range:", info.descriptor?.ranges?.["right_arm_gripper.pos"]);
  },
});
```

## What's in a `RobotInfo`

| Field | Meaning |
|---|---|
| `accepted` | `false` = the daemon refused the session (`error` says why). The connection stays up so you can see logs/telemetry, but control frames are ignored. |
| `protocolVersion` | The daemon's nori-protocol major. Compared against this SDK's `NORI_PROTOCOL_VERSION`; a difference sets `versionMismatch`. |
| `normMode` | Units of every `.pos` value in state/action: `"range_m100_100"` (normalized) or `"degrees"`. |
| `watchdogProfile` | `{ t_warn_ms, t_stop_ms }` — control-frame silence beyond these slows, then stops, the robot. **Disclosure, not negotiation**: the daemon picks it from the measured link; you can't change it. |
| `descriptor` | What the robot is: `joints` (every drivable `<motor>.pos` key), `base`, `aux` (e.g. lifts), `cameras` (roles, matching the composite layout tiles), and `ranges` — the authoritative `[min, max]` per key. Out-of-range values are **clamped robot-side, never rejected**, so use `ranges` to scale your inputs, not to pre-validate. |
| `initialState` | The joint pose at session start. |
| `versionMismatch` | **Advisory.** Mixed daemon versions exist across the fleet, so the SDK warns and proceeds — unknown frame types are ignored by both sides, so a mismatch means vocabulary gaps, never unsafe behavior. |

Old daemons may send a bare ack — every field except `accepted` is optional, so **null-check what
you read**. The ack is re-sent on every daemon (re)connect, so a robot restart mid-session
refreshes `robotInfo()`. The raw parse is exported as `parseAck(frame)` if you need it standalone.

## One rejection worth knowing by name

`accepted: false` with `error: "unauthorized"` is the robot's **internal** agent token — its own
bridge authenticating to its daemon — being missing or stale. That's a robot-side provisioning
problem.

It is **not** your `token` option. The room token is checked much earlier, at signaling; if your
room token were wrong you'd never get an offer at all.

If you see `unauthorized`, **nothing on your end fixes it.** Report it to us.
