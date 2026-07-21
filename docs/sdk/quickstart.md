# Quick start

The fastest path: use the reference **Supabase** transport with the room + Supabase credentials we
provision for you. Access to a real robot's room is gated by **Supabase RLS** on a private channel:
you sign the `supabase` client in as the robot's paired account and RLS admits you — there is **no
room token** to pass (the legacy HMAC room token is retired). Pairing an account to a robot is a
one-time step done in the Nori app using the **pair code printed on the robot's box**; that's
upstream of the SDK, not a connect option. See [Connectivity](/sdk/connectivity) for when you'd
additionally need TURN values.

```ts
import { RemoteTeleop } from "@nori/sdk";
import { SupabaseSignaling } from "@nori/sdk/supabase";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // values we give you
const video = document.querySelector("video")!;

const teleop = new RemoteTeleop({
  signaling: new SupabaseSignaling(supabase, ROOM, (...m) => console.log(...m)),
  videoEl: video,
  // No room token: a real robot's private room is gated by Supabase RLS (sign `supabase`
  // in as the paired account). Pass `{ private: true }` to SupabaseSignaling for a real
  // robot; open dev rooms (`nori-dev`) use the default public join.
  stun: "stun:stun.l.google.com:19302",
  // TURN is optional and currently not issued by default (see "Connectivity").
  // If we've sent you relay credentials, add: turnUrls: [TURN_URL], turnUser, turnCred.
  forceRelay: false,
  arm: "right",             // which arm keyboard/jog drives
  onLog: (m) => console.log(m),
  onConnState: (s) => console.log("conn:", s),
  onTelemetry: (t) => {     // live: loopHz, safety, tempC, per-joint state{}, lift height mm…
    console.log("safety:", t.safety, "state:", t.state);
  },
  onMode: (mode) => console.log("mode:", mode),
  onControlActive: (a) => console.log("control:", a),
});

await teleop.start();       // subscribes, answers the robot's offer, opens the control channel
```

Video now flows into your `<video>` element and `onTelemetry` fires ~50×/s.

## Video only

"Watch the robot" in its entirety — no jog, no telemetry:

```ts
import { RemoteTeleop } from "@nori/sdk";
import { SupabaseSignaling } from "@nori/sdk/supabase";

const teleop = new RemoteTeleop({
  signaling: new SupabaseSignaling(supabase, room, console.log),
  videoEl: document.querySelector("video")!,
  stun, turnUrls, turnUser, turnCred, forceRelay: false,
  arm: "right", onLog: console.log, onConnState: console.log,
  onTelemetry: () => {}, onMode: () => {}, onControlActive: () => {},
});
teleop.start();                                  // video appears in the element when connected
// teleop.stop() to tear down.
```

## Next

- [Driving the robot](/sdk/driving) — keyboard, programmatic jog, commands.
- [The handshake](/sdk/handshake) — what the robot tells you about itself on connect.
- [The safety contract](/sdk/safety) — **read this before you ship.**

If `start()` never reaches `connected`, it's almost certainly the network:
[Connectivity](/sdk/connectivity).
