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

To connect to a robot you need the credentials we provision. A real robot's room is a **private**
Supabase Realtime channel gated by RLS, so you also sign the `supabase` client in as the robot's
**paired account** — pairing is a one-time step in the Nori app using the **pair code on the box**:

| Value | What it's for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | The reference signaling transport. Public values; safe in a client bundle. |
| `ROOM` | Which robot you're connecting to (its serial). |
| Signed-in Supabase session | Authenticates you to the private room via **RLS** — only the robot's paired account is admitted; everyone else is refused at join. **No room token** (the legacy HMAC token is retired). Open dev rooms (`nori-dev`) are public and need no sign-in. |

TURN relay credentials are **not** issued by default. You only need them on strict networks — see
[Connectivity](/sdk/connectivity).

## Pairing without the app (API)

Pairing links a robot to your Nori account — the account RLS then admits to the robot's private
room. You'd normally do this once in the Nori app, but you can do it entirely over the API, using
the **pair code printed on the robot's box**. The pair code is used *here and only here* — never by
the SDK at connect time.

```bash
# 1. Get a JWT for your Nori account (Supabase password grant).
ACCESS_TOKEN=$(curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"you@co.com","password":"…"}' | jq -r .access_token)

# 2. First time only: create your customer record.
curl -X POST "$NORI_BACKEND_URL/api/v1/customers/me/provision" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# 3. Pair the robot with its pair code (one-time — the code is consumed here).
curl -X POST "$NORI_BACKEND_URL/api/v1/customers/me/pair" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"robot_serial_number":"NORI-L2-1234","pair_code":"XXXX-XXXX-XXXX-XXXX"}'
```

Now your account owns the robot. At connect time you just sign that same account in and join its
private room (`{ private: true }`) — RLS admits you and the pair code never reappears. See
[Quick start](/sdk/quickstart).

The pair code is case- and hyphen-insensitive. Errors: **403** = wrong/missing pair code (or you're
over your robot limit — the response `detail` says which); **409** = that serial is already paired
to another account. Re-pairing a robot you already own is idempotent (no code needed).

## Entry points

| Import | Contains | Extra dep |
|---|---|---|
| `@nori/sdk` | `RemoteTeleop`, telemetry/jog/keybind types, `SignalingTransport` contract, `NORI_PROTOCOL_VERSION` | none |
| `@nori/sdk/vr` | `VrJogMapper`, `VrSession`, `DEFAULT_BINDINGS`, VR types | `three` |
| `@nori/sdk/supabase` | `SupabaseSignaling` (reference transport) | `@supabase/supabase-js` |

Next: [Quick start](/sdk/quickstart).
