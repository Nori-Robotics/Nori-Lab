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

::: info 🚧 To write
A full API reference — every option on `RemoteTeleop`, every telemetry field, every exported type.

Best generated from the TypeScript source (`frontend/packages/nori-sdk/src/`) rather than written
by hand, so it can't drift. TypeDoc into a `/sdk/api/` subtree is the obvious path.
:::

## Source of truth

These pages are maintained in `docs/sdk/` in the NoriLeLab repo. The SDK package's own `README.md`
covers the same ground for developers reading the tarball offline.

If the two ever disagree, **the code wins** — tell us and we'll fix the page.
