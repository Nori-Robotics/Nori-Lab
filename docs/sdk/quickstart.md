# Quick start

The fastest path: use the reference **Supabase** transport with a room + token we provision for
you (you do **not** need your own Supabase account — just the room credentials). See
[Connectivity](/sdk/connectivity) for when you'd additionally need TURN values.

```ts
import { RemoteTeleop } from "@nori/sdk";
import { SupabaseSignaling } from "@nori/sdk/supabase";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // values we give you
const video = document.querySelector("video")!;

const teleop = new RemoteTeleop({
  signaling: new SupabaseSignaling(supabase, ROOM, (...m) => console.log(...m)),
  videoEl: video,
  token: ROOM_TOKEN,        // "" for an open dev room; HMAC-authed otherwise
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
  token, stun, turnUrls, turnUser, turnCred, forceRelay: false,
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
