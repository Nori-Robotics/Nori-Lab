# Install

Not on public npm (v0 ships to a named team). Install from the release tarball we send you — or
from the GitHub release URL if you have repo access:

```bash
npm i ./nori-sdk-<version>.tgz
# optional peers, only if you use them:
npm i @supabase/supabase-js   # for the reference signaling transport (@nori/sdk/supabase)
npm i three                   # for VR (@nori/sdk/vr)
```

The **core** (`@nori/sdk`) has zero runtime dependencies. VR and Supabase signaling live behind
their own subpath imports, so you never pull them unless you ask for them.

## What you need from us

To connect to a robot you need credentials we provision — you do **not** need your own Supabase
account:

| Value | What it's for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | The reference signaling transport. Public values; safe in a client bundle. |
| `ROOM` | Which robot you're connecting to. |
| `ROOM_TOKEN` | Authenticates you to that room. `""` for an open dev room; HMAC-authed otherwise. |

TURN relay credentials are **not** issued by default. You only need them on strict networks — see
[Connectivity](/sdk/connectivity).

## Entry points

| Import | Contains | Extra dep |
|---|---|---|
| `@nori/sdk` | `RemoteTeleop`, telemetry/jog/keybind types, `SignalingTransport` contract, `NORI_PROTOCOL_VERSION` | none |
| `@nori/sdk/vr` | `VrJogMapper`, `VrSession`, `DEFAULT_BINDINGS`, VR types | `three` |
| `@nori/sdk/supabase` | `SupabaseSignaling` (reference transport) | `@supabase/supabase-js` |

Next: [Quick start](/sdk/quickstart).
