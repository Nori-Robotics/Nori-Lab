# Entry points

| Import | Contains | Extra dep |
|---|---|---|
| `@nori/sdk` | `RemoteTeleop`, telemetry/jog/keybind types, `SignalingTransport` contract, `NORI_PROTOCOL_VERSION` | none |
| `@nori/sdk/vr` | `VrJogMapper`, `VrSession`, `DEFAULT_BINDINGS`, VR types | `three` |
| `@nori/sdk/supabase` | `SupabaseSignaling` (reference transport) | `@supabase/supabase-js` |

The **core** has zero runtime dependencies. VR and Supabase signaling sit behind their own subpath
imports so you never pull them unless you ask for them.

## Protocol version

The SDK targets **nori-protocol v1**, exported as `NORI_PROTOCOL_VERSION`. A daemon on a different
**major** rejects the connection outright.

A *minor* difference is advisory: the handshake sets `versionMismatch`, the SDK warns and proceeds.
Mixed daemon versions exist across the fleet, and unknown frame types are ignored by both sides —
so a mismatch means vocabulary gaps, never unsafe behavior. See [the handshake](/sdk/handshake).

## Surface that exists but isn't documented here yet

These ship in the package today. They work; they just don't have a prose page, so the source is
the reference until they do. Listed so you don't conclude they're missing:

| Call | What it is |
|---|---|
| `record(action, task?)` / `recordState()` / `onRecord` | Robot-side episode recording for policy training — a session opens, records N episodes, and ships when the robot next idles. Records **full-quality** frames on the robot, not the degraded stream you're watching. |
| `daemonStatus()` / `onDaemonStatus` | Bridge-reported health of the motor-control daemon, so a UI can say "motor control offline, reconnecting" instead of silently doing nothing. |
| `setPolicyDriving(on)` | Hand the arms to a running policy — suppresses the jog/leader heartbeat so the two don't fight. |
| `setLeaderAction(deg)` | Drive from physical leader arms (absolute joint angles in degrees). |
| `connectStatus()` | Finer-grained connect progress than `onConnState` — which phase a stuck session is stuck in. |
| `setKeyboardSpeed(s)` | Scale keyboard jog rates. |
| `currentMa()`, `CURRENT_MA_PER_LSB`, `CURRENT_FULL_LSB` | Motor-current unit conversion — see [Telemetry](/sdk/telemetry#currents). |
| `@nori/sdk` rail + robot-ops exports | Rail-height reading helpers, and the generated robot command vocabulary the LLM/agent surfaces are built from. |

::: info 🚧 To write
A full API reference — every option on `RemoteTeleop`, every telemetry field, every exported type,
including everything in the table above.

Best generated from the TypeScript source (`frontend/packages/nori-sdk/src/`) rather than written
by hand, so it can't drift. TypeDoc into a `/sdk/api/` subtree is the obvious path.
:::

## Source of truth

These pages are maintained in `docs/sdk/` in the NoriLeLab repo. The SDK package's own `README.md`
covers the same ground for developers reading the tarball offline.

If the two ever disagree, **the code wins** — tell us and we'll fix the page.
