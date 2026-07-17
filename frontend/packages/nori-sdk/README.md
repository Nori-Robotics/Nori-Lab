# @nori/sdk

Robot-local teleoperation SDK for the **Nori daemon**. Connect to a robot over WebRTC, receive its
video + telemetry, and drive it — from the browser, in ~20 lines.

```
┌ your app ┐        ┌ @nori/sdk ┐   WebRTC    ┌ Pi bridge ┐  NDJSON  ┌ nori daemon ┐
│ video el │  ◄───► │RemoteTeleop│ ◄────────► │webrtc_robot│ ◄─────► │ 50Hz control │
│ keyboard │        └───────────┘  data chan  └───────────┘  :7777   │ safety stack │
└──────────┘         signaling ▲                                     └──────────────┘
                     (Supabase or BYO)
```

> **Safety.** The daemon defends itself — clamping, watchdog, E-STOP, rate-limits and the motor
> torque lifecycle are all on the robot. **No message this SDK can send makes the robot unsafe.**
> That invariant is what makes a client SDK safe to hand out. Targets **nori-protocol v1**
> (`NORI_PROTOCOL_VERSION`); a daemon on a different major rejects the connection.

## Install

Not on public npm (v0 ships to a named team). Install from the release tarball we send you —
or from the GitHub release URL if you have repo access:

```bash
npm i ./nori-sdk-<version>.tgz
# optional peers, only if you use them:
npm i @supabase/supabase-js   # for the reference signaling transport (@nori/sdk/supabase)
npm i three                   # for VR (@nori/sdk/vr)
```

The **core** (`@nori/sdk`) has zero runtime dependencies. VR and Supabase signaling live behind
their own subpath imports so you never pull them unless you ask for them.

## Quick start (Supabase signaling)

The fastest path: use the reference **Supabase** transport with a room + token we provision for
you (you do **not** need your own Supabase account — just the room credentials). See
["Connectivity"](#connectivity-lan-stun-turn) below for when you'd additionally need TURN values.

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
  // TURN is optional and currently not issued by default (see "Connectivity" below).
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

## Develop without a robot (mock mode)

`@nori/sdk/mock` ships a fake robot so you can build and CI-test **with zero hardware, zero
cloud, and zero network** — no Supabase, no credentials, no robot time. Swap only the
signaling option; everything else is the identical SDK path (real WebRTC in-page, real
handshake/ack, real frame parsing), so code developed against the mock talks to a real robot
by changing one line:

```ts
import { RemoteTeleop } from "@nori/sdk";
import { createMockRobot } from "@nori/sdk/mock";

const robot = createMockRobot();          // the fake robot, living in your page
const teleop = new RemoteTeleop({
  signaling: robot.signaling,             // <- the ONLY line that differs from production
  videoEl: document.querySelector("video")!,
  token: "",
  stun: "", turnUrls: [], turnUser: "", turnCred: "", forceRelay: false,
  arm: "right",
  onLog: console.log,
  onConnState: (s) => console.log("conn:", s),
  onTelemetry: (t) => console.log(t.safety, t.state["right_arm_shoulder_pan.pos"]),
  onMode: () => {}, onControlActive: () => {},
});
await teleop.start();                     // connects in ~a second, telemetry + video flowing
// later: robot.restart() simulates a robot reboot; robot.stop() tears it down.
```

What the mock gives you:

- **A drivable robot**: jog (keyboard/`setExternalJog`), absolute `sendAction` targets with the
  full `accepted → active → done|clamped|blocked` action-status lifecycle, range clamping
  (clamp-don't-reject, like the daemon), `estop`/`reset_latch` latching, and an arrival-keyed
  watchdog that stops motion when your control frames go silent — so your error handling is
  testable, not just your happy path.
- **Test-pattern video**: a canvas-drawn composite honoring the `camera_layout` grid, so
  `videoStream()`, `cameraView(role)`, `captureFrame`/`snapshot(role)` all work. Tiles move
  when you jog (a dot tracks `shoulder_pan`), so "is my view wired up" is answerable by eye.
- **The real handshake**: `onReady`/`robotInfo()` deliver a descriptor (12 joints, 4 cameras,
  ranges) shaped exactly like the golden fixture; pass `token:` to `createMockRobot` to
  exercise the HMAC auth path (wrong token → the real nack/`bad_access_code` flow).
- **Determinism for CI**: the simulation core (`MockDaemonSim`) is pure and seeded — no
  `Date.now`/`Math.random` — and can be driven tick-by-tick in Node unit tests without any
  browser at all (`sim.handleFrame(...)` / `sim.tick(ms)`).

The mock speaks the same room handshake as the real robot (`robot_here` + nonce → HMAC `ready`
→ offer, with rate-limited nack/announce), so the auth path you code against is the real one.

Honest limits (v1): no audio tracks (`joinCall()` degrades to local-only), no perception frames
(use `injectPerception()`), motion is *plausible, not kinematically true* — cylindrical dofs
nudge a fixed joint mapping so telemetry visibly responds. Never use mock trajectories to
validate motion or train anything. `createMockRobot()` needs a browser (WebRTC + canvas);
`MockDaemonSim` alone runs anywhere.

Two gotchas worth knowing (they apply to real robots too, so the mock reproduces them):

- **`onTelemetry` fires for more than daemon frames.** RemoteTeleop also emits a view on its
  ~1 Hz video/ABR tick, and that one carries an **empty `state`**. Wait for the field you need
  (`t.state["right_arm_shoulder_pan.pos"] !== undefined`), not merely the first callback.
- **A wrong `token` surfaces as `bad_access_code` after ~2.5 s**, not instantly: the first
  `ready` is legitimately mac-less, so the SDK debounces a nack before believing it. Read the
  failure from `onConnectStatus`'s **`reason`** field (`ConnectStatus.reason`).

## Connectivity: LAN, STUN, TURN

How the media/control connection is established, and what you need for each situation:

- **Same LAN as the robot** (e.g. working on-site): peers connect directly via local host
  candidates. The STUN default is harmless but not even needed. Nothing to configure.
- **Over the internet (WAN)**: the default public **STUN** server lets both peers discover
  their public addresses and connect **directly** — no traffic flows through any third party,
  and this works on typical home/office networks. This is the current default deployment mode.
- **Strict networks** (corporate/university firewalls, hotel or co-working Wi-Fi, CGNAT mobile
  carriers, VPNs): direct connection can be impossible. The symptom is a session stuck at
  ICE/`connecting` that never reaches `connected` — nothing is wrong with your code. This is
  the one case that needs a **TURN relay** (`turnUrls`/`turnUser`/`turnCred`). We do not issue
  TURN credentials by default yet — **if you hit this, tell us and we'll provision relay
  credentials for you**; they slot into the three options above with no other change.
  (`forceRelay: true` then forces all traffic through the relay — useful to *verify* the TURN
  path, not something to leave on.)

Note the relay never sees your media in the clear — WebRTC is DTLS-SRTP end-to-end encrypted;
a TURN server only ever observes IPs and traffic volume.

> **On the robot's LAN and want frames as data (not a browser)?** Multi-camera robots also
> publish raw per-camera MJPEG frames over ZeroMQ — no WebRTC involved. See the nori-protocol
> `CLIENTS.md` § "Camera frames over the LAN" for the port scheme and a ~15-line Python client.

## Handshake: what the robot tells you on connect

Shortly after the control channel opens, the daemon sends its **ack** — a self-description of
the robot you just connected to. Read it at use-time with `robotInfo()` (null until it arrives)
or subscribe with the `onReady` option:

```ts
const teleop = new RemoteTeleop({
  /* ...options as above... */
  onReady: (info) => {
    if (!info.accepted) { console.error("robot refused session:", info.error); return; }
    console.log("protocol v" + info.protocolVersion, "units:", info.normMode);
    console.log("joints:", info.descriptor?.joints);
    console.log("cameras:", info.descriptor?.cameras);   // same roles as the CameraLayout tiles
    console.log("gripper range:", info.descriptor?.ranges?.["right_arm_gripper.pos"]);
  },
});
```

What's in a `RobotInfo`:

| Field | Meaning |
|---|---|
| `accepted` | `false` = the daemon refused the session (`error` says why). The connection stays up so you can see logs/telemetry, but control frames are ignored. |
| `protocolVersion` | The daemon's nori-protocol major. Compared against this SDK's `NORI_PROTOCOL_VERSION`; a difference sets `versionMismatch`. |
| `normMode` | Units of every `.pos` value in state/action: `"range_m100_100"` (normalized) or `"degrees"`. |
| `watchdogProfile` | `{ t_warn_ms, t_stop_ms }` — control-frame silence beyond these slows, then stops, the robot. **Disclosure, not negotiation**: the daemon picks it from the measured link; you can't change it. |
| `descriptor` | What the robot is: `joints` (every drivable `<motor>.pos` key), `base`, `aux` (e.g. lifts), `cameras` (roles, matching the composite layout tiles), and `ranges` — the authoritative `[min, max]` per key. Out-of-range values are **clamped robot-side, never rejected**, so use `ranges` to scale your inputs, not to pre-validate. |
| `initialState` | The joint pose at session start. |
| `versionMismatch` | **Advisory.** Mixed daemon versions exist across the fleet, so the SDK warns and proceeds — unknown frame types are ignored by both sides, so a mismatch means vocabulary gaps, never unsafe behavior. |

Old daemons may send a bare ack — every field except `accepted` is optional, so null-check what
you read. The ack is re-sent on every daemon (re)connect (a robot restart mid-session refreshes
`robotInfo()`). The raw parse is exported as `parseAck(frame)` if you need it standalone.

One rejection worth knowing by name: `accepted:false` with `error:"unauthorized"` is the robot's
**internal** agent token (its own bridge authenticating to its daemon) being missing or stale —
a robot-side provisioning problem. It is **not** your `token` option (the room token, checked
much earlier at signaling); if your room token were wrong you'd never get an offer at all. If
you see `unauthorized`, nothing on your end fixes it — report it to us.

## Driving the robot

Two input paths — both ride the **same** wire (the daemon's jog → IK → clamp → motor path is
identical regardless of source):

**Keyboard** — hand key events to the client (see `keybindLegend(mode)` for the live key map):

```ts
window.addEventListener("keydown", (e) => { if (teleop.onKeyDown(e)) e.preventDefault(); });
window.addEventListener("keyup",   (e) => teleop.onKeyUp(e));
```

**Programmatic jog** — push normalized rates in `[-1, 1]` per DOF (streamed at 50 Hz):

```ts
teleop.setExternalJog({
  right_arm: { shoulder_pan: 0.5, elbow_flex: -0.3 },
  right_lift: 0.2,        // per-arm lift velocity
});
teleop.setExternalJog(null); // stop
```

**Commands & mode:**

```ts
teleop.command("estop");        // also: "reset_latch" | "reset"
teleop.setArm("left");          // switch which arm is driven
teleop.toggleMode();            // cylindrical <-> per-joint
```

**Teardown:**

```ts
await teleop.stop();            // tells the robot to restart cleanly, tears down the peer
```

## The safety contract

The core promise, stated precisely: **every safety mechanism lives on the robot, and none of
them are negotiable from this SDK.** Clamping, watchdog, E-STOP, stall handling, and the motor
torque lifecycle all run in the robot's control daemon; no message you can send — malformed,
malicious, or buggy — disables or loosens them. Limits are **disclosed, not negotiated**: the
handshake tells you what they are (`robotInfo().watchdogProfile`, `descriptor.ranges`), and
there is deliberately no API to change them. If your use case genuinely needs different
limits, that's a conversation with us, not a parameter.

What the robot enforces, and how you see it in telemetry:

**`telemetry.safety`** (typed as `SafetyState`):

| Value | What the robot is doing | What you do |
|---|---|---|
| `"ok"` | Normal operation. | Carry on. |
| `"safe_hold"` | Refusing motion to protect itself — either the Pi is too hot or your control frames went silent past the watchdog stop threshold. Not a latch. | Fix the cause (let it cool / restore your control stream); it clears itself. |
| `"latched"` | **E-STOP is latched** (operator command or the robot's physical button). Motion blocked, motors torque-limited. | Clear deliberately with `command("reset_latch")` once the situation is safe. |

**`telemetry.watchdog`** (typed as `WatchdogState`): `"ok"` → `"warn"` (your control frames
went quiet past `t_warn_ms`, or the robot is shedding thermal load) → `"stop"` (quiet past
`t_stop_ms`; motion blocked until frames resume). The thresholds are per-link (LAN vs WAN) and
arrive in the handshake — you can read them, not set them.

**Stalls are deliberately NOT a safety state.** When a joint is pushed against something, the
robot cuts torque **on that joint only** and keeps everything else running; it self-clears when
you jog the stalled joint *away* from the obstruction. You'll see it as an `action_status`
with `reason: "stall:<joint>"` (Phase E), not as a global stop. Reason strings follow the
pattern `"<cause>:<detail>"` — e.g. `"stall:right_arm_elbow_flex"`, `"estop:button"`.

**The three commands** (`command(...)` on `RemoteTeleop`, also bound to keys):

| Command | Effect |
|---|---|
| `"estop"` | Trip the E-STOP latch now (safety → `"latched"`). Always available; never rate-limited. |
| `"reset_latch"` | Clear the E-STOP and any stall latches, restore normal torque. Deliberate act — nothing else clears a latch. |
| `"reset"` | Return the arm(s) to their neutral pose (a motion command, not a latch operation — refused while latched). |

One more disclosure: **out-of-range targets are clamped, never rejected.** Sending a `.pos`
beyond `descriptor.ranges` moves the joint to the boundary and (for tagged actions) reports
`clamped` in the action status. Use `ranges` to scale your inputs, not to pre-validate.

## Video: attach a sink, and pause to save power

The robot's inbound video is one media track on the peer connection. You can attach it to a
`<video>` element at construction (`videoEl`) **or** re-point it at any time — useful when one
long-lived session renders on different pages:

```ts
teleop.setVideoEl(myVideoEl);   // point the live stream at this element (null to detach)
teleop.setAudioEl(myAudioEl);   // same for the robot's inbound audio sink
```

Detaching with `null` stops *rendering* but the robot keeps encoding + sending. On a Pi 5 (no
hardware H.264 encoder — video is software x264, often the biggest power draw) that's wasteful when
nothing is watching. Pause the **encoder itself**, not just the sink:

```ts
teleop.pauseVideo();            // robot drops frames BEFORE the encoder -> it goes idle (power saved)
teleop.resumeVideo();           // re-enable; the robot forces a keyframe so video reappears at once
```

Notes: pause/resume ride the control data channel (no renegotiation, fast resume) and are safe to
call before the channel is open — the desired state is applied on open (so "pause on connect, resume
only while a viewer is mounted" works). Control + telemetry are a separate transport, so pausing
video never affects jog/telemetry. A fresh session starts flowing at the defaults.

**Grab a still frame** (e.g. to feed a vision model) without a `<video>` element — reads the live
track directly:

```ts
const blob = await teleop.captureFrame();   // JPEG Blob, or null if no video is arriving
// If the encoder may be paused, use snapshot(): it resumes, waits for a frame, grabs, re-pauses:
const still = await teleop.snapshot();       // JPEG Blob, or null
```

**Per-camera stills.** Both take an optional camera `role` (from the layout — see "Per-camera
views" below) to crop one tile out of the composite; this is what a per-camera LLM `look` maps to:

```ts
const wrist = await teleop.snapshot(500, "left_wrist");     // one tile, or null
const over  = await teleop.captureFrame("image/jpeg", 0.7, "overhead");
```

⚠️ **Unknown role → `null`, never the full composite.** Deliberate: if your caller labeled the
frame (e.g. told a vision model "this is left_wrist"), a silent fallback would hand it a mislabeled
image. On `null` with a role set, report the valid roles (`cameraLayoutInfo()?.tiles`) instead.
Single-camera robots send no layout, so any `role` returns `null` there — use the bare calls.
The role→rect mapping itself is exported as `cameraTileRect(layout, role, w, h)` (pure,
unit-tested) if you need the same math elsewhere.

**The raw stream, no DOM required** — for canvas pipelines, ML/CV consumers, or
`MediaRecorder`:

```ts
const stream = teleop.videoStream();        // MediaStream | null (null until the track arrives)
// e.g. record it:
const rec = new MediaRecorder(stream!);
// Do NOT stop() its tracks — they belong to the peer connection. Just drop your reference.
```

**Per-camera views.** The robot sends **one composite track** (all cameras tiled into a grid —
see "What to expect" below). The bridge announces which camera is in which tile
(`cameraLayoutInfo()` / `onCameraLayout`), and `cameraView(role)` crops a tile into its own
`MediaStream` so you never do quadrant math:

```ts
teleop.cameraLayoutInfo();                       // {cols, rows, tiles} | null (also: onCameraLayout)
const view = teleop.cameraView("left_wrist");    // CameraViewHandle | null
if (view) {
  myVideoEl.srcObject = view.stream;             // or feed it to CV / MediaRecorder
  // later:
  view.stop();                                   // ends the crop loop (composite unaffected)
}
```

`cameraView` returns `null` until both the video track **and** the layout frame have arrived,
or if the role isn't in the layout. Single-camera robots send no layout — use `videoStream()`.
Each live view runs a canvas draw loop (per decoded frame when the browser supports
`requestVideoFrameCallback`), so `stop()` views you're not showing.

### Video-only quick start

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

### What to expect from the feed (read before filing a video issue)

- **One H.264 track, composite grid** of all robot cameras (typically 320×240 per tile at
  15 fps as of 2026-07-08). There are no per-camera tracks on the wire — `cameraView()` is
  the supported per-camera access. This is a deliberate design (one encode on the robot).
- **The ceiling is robot power, not the protocol**: the Pi 5 has no hardware H.264 encoder,
  so encode pixels×fps directly hits the robot's power budget. Resolution/fps are tuned to
  measured hardware limits and will improve when the robot's supply hardware does. A
  live-switchable resolution API is designed and lands when that headroom exists.
- `setVideoQuality("low"|"normal")` changes **bitrate only** (bandwidth, not robot CPU);
  `pauseVideo()` is the control that actually saves robot power.
- WAN delivery is typically ~15 fps; the encoder doesn't send more than the link carries.

> **Verification status (v0):** `setVideoEl`/`setAudioEl`, `pauseVideo`/`resumeVideo`,
> `captureFrame`/`snapshot`, and the P4.6 additions (`videoStream`, `cameraView`) are
> implemented and typecheck/build-clean, but **pending on-robot verification** (encoder power
> drop + clean keyframe resume + frame grab + tile-crop against a real composite). The inbound
> video feed itself is hardware-verified and stable.

## Perception — structured world-state (Phase F)

Separate from the video track (human eyes) and the one-shot LLM-vision still: `perceive()` returns
the latest **structured** detections from the daemon's on-Pi perception process, so a *running*
program can react to what the robot sees.

```ts
const world = teleop.perceive();               // PerceptionView | null (null = no frame yet)
const cup = world?.objects.find((o) => o.label === "cup");
if (cup?.xyz && (teleop.perceptionAgeMs() ?? Infinity) < 500) {
  // cup.xyz is [x,y,z] in robot-base meters; cup.bbox is normalized [x,y,w,h]. Both optional —
  // present depends on the detector (2D vs depth). Check age: a dead detector leaves a stale frame.
}
```

Subscribe instead of polling with the `onPerception` option. `objects: []` is an explicit "nothing
seen" — distinct from `null` ("no frame"). Frames ride the control channel (`type:"perception"`,
nori-protocol `perception.json`).

> **Verification status (v0):** the SDK parse/cache/`perceive()`/`injectPerception()` surface is
> implemented and unit-tested, but the **on-Pi detector that emits `perception` frames does not exist
> yet** — `perceive()` returns `null` on real hardware today. `injectPerception()` feeds synthetic
> frames through the same path for development. See `docs/phase_f_perception.md`.

## Action completion (Phase E)

Tag an absolute move with an `action_id` and the daemon reports its lifecycle back
(`accepted → active → done | clamped | blocked | timeout`), so a script can await what *actually*
happened instead of guessing from telemetry:

```ts
const id = teleop.nextActionId();
teleop.sendAction({ "right_arm_shoulder_pan.pos": 30 }, id);   // tag the frame(s)
const status = await teleop.awaitAction(id, { timeoutMs: 5000 });
// status.state: "done" | "clamped" | "blocked" | "timeout" (+ status.reason for blocked/timeout)
```

`actionStatus(id)` returns the latest status seen (any state) — the executor uses it to detect whether
the daemon is participating. `awaitAction` self-resolves to a synthetic `timeout` if the daemon
predates Phase E, so it never hangs; `onActionStatus` streams every transition for logging. The
executor's `nori.moveTo(...)` uses all of this internally and returns the daemon's verdict.

> **Verification status (v0):** SDK + executor implemented and unit-tested. The daemon that emits
> `action_status` is built + selftest-covered but **must be deployed to the robot**, and the tolerances
> tuned on hardware; until then `moveTo` transparently falls back to its client-side heuristic. See
> `docs/phase_e_action_completion.md`.

## Streaming audio to the robot speaker

`sendClipAudio` streams an arbitrary audio **track** to the robot's speaker over the same
reserved uplink the two-way call uses (renegotiation-free `replaceTrack`). It's transport-only —
you supply the `MediaStreamTrack`; the SDK does not fetch, decode, or set levels.

```ts
// Build a track from an audio file WITHOUT playing it on the laptop (route through a
// MediaStream sink only, never ctx.destination), and CAP THE LEVEL (see the caveat):
const ctx = new AudioContext();
const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
const src = ctx.createBufferSource(); src.buffer = buf;
const gain = ctx.createGain(); gain.gain.value = 0.7;     // ← cap output level (see below)
const dest = ctx.createMediaStreamDestination();
src.connect(gain); gain.connect(dest);

await teleop.sendClipAudio(dest.stream.getAudioTracks()[0]); // reserve uplink + start
src.start();
src.onended = () => { void teleop.sendClipAudio(null); ctx.close(); }; // hand uplink back / detach
```

**Requirements & caveats — read before you ship audio:**

- **Robot voice downlink must be ON** (`webrtc_robot.py --voice` / `NORI_VOICE` + a speaker):
  only then is the audio m-line `sendrecv` and does the robot play what you send. Otherwise
  `sendClipAudio` returns `false` and nothing transmits.
- **One audio m-line** — a clip and the mic share it. A clip takes the uplink; `sendClipAudio(null)`
  hands it back to the mic (if a call is active) or detaches.
- **Real-time Opus, not a file transfer** — audio plays as it streams; a network drop drops it.
  The caller owns the track's lifetime (stop it when the source ends).
- **Clips don't ring the robot.** Robots gate their room microphone behind a local accept
  prompt (a person AT the robot must consent before an operator can hear the room). A clip is
  speaker-only — nobody is asking to listen — so `sendClipAudio` announces itself as a clip and
  plays immediately: no accept prompt, and the robot's mic stays shut. `joinCall()` is the one
  that rings: on a consent-gated robot expect silence (no room audio) until someone at the robot
  accepts. Older robot builds ignore the clip marker and may ring anyway — harmless.
- **Output level is capped ON THE ROBOT** (self-defending — you don't have to trust the client):
  the robot clamps downlink playback to `NORI_SPEAKER_GAIN` (default **0.7**) with a `volume`
  element before the sink, so no track you send can overdrive the speaker. This exists because a
  near-full-scale clip drives the speaker amp + hardware-AEC reference far harder than call
  speech; on a full-speed USB DSP speakerphone (MV-SILICON P10S) that browned the device out into
  a **mid-stream USB re-enumeration** (`alsasink … device has been disconnected` spam). Quiet call
  voice never triggered it. You *may* still attenuate client-side (defense-in-depth), but the
  guarantee lives on the robot; for loud playback also prefer a powered USB hub + a robust speaker.
- **Speaker device must be name-stable** — set `NORI_SPEAKER` to a **dmix alias (`nori_out`) or
  `hw:CARD=<name>`, never `hw:<number>`**. A device that re-enumerates comes back as a *new*
  card number, so a numbered device is unrecoverable after any reset.

> The fork ships a reference implementation of all of the above (fetch/decode/gain-cap +
> lifecycle) in `NoriLeLab/frontend/src/nori/remote/audioClip.ts` (`playAudioUrl` /
> `playAudioFile`, default gain `0.7`).

## VR (`@nori/sdk/vr`)

WebXR immersive control. A `VrSession` runs the controller→jog mapper and drives an existing
`RemoteTeleop`. Peer dependency: `three`.

```ts
import { VrSession, DEFAULT_BINDINGS } from "@nori/sdk/vr";

if (await VrSession.isSupported()) {
  const session = new VrSession({
    teleop,                     // a started RemoteTeleop
    videoEl: video,             // same element the robot stream is attached to
    onLog: (m) => console.log(m),
    onEnd: () => console.log("VR ended"),
  });
  // feed telemetry/currents in for the in-VR HUD + haptics:
  //   teleop options onTelemetry -> session.setTelemetry(t)
  //   teleop options onCurrents  -> session.setCurrents(c)
  await session.start();        // enters immersive-vr
}
```

Grip = squeeze-to-move (clutch), trigger = that arm's gripper; see `DEFAULT_BINDINGS` for the map.

## Advanced: bring your own signaling

`SupabaseSignaling` is just one implementation of the `SignalingTransport` contract. To run
without Supabase (your own WebSocket, a different SaaS, even manual copy/paste), implement the
interface — the WebRTC/auth/jog logic is transport-agnostic:

```ts
import type { SignalingTransport, SignalingHandlers } from "@nori/sdk";

class MySignaling implements SignalingTransport {
  async connect(h: SignalingHandlers) {
    // wire your transport to: h.onSdp, h.onIce, h.onRobotHere, h.onOpen
  }
  sendReady(p: { mac?: string }) { /* broadcast 'ready' */ }
  sendSdp(p) { /* broadcast our SDP answer */ }
  sendIce(p) { /* broadcast a local ICE candidate */ }
  sendBye() { /* best-effort 'leaving'; never throw */ }
  async close() { /* tear down; idempotent */ }
}
```

The robot side (`webrtc_robot.py`) must exchange the same named events (`sdp`, `ice`,
`robot_here`, `ready`, `bye`). The event *shapes* are the `SdpPayload` / `IcePayload` /
`RobotHerePayload` types exported from `@nori/sdk`.

## Entry points

| Import | Contains | Extra dep |
|---|---|---|
| `@nori/sdk` | `RemoteTeleop`, telemetry/jog/keybind types, `SignalingTransport` contract, `NORI_PROTOCOL_VERSION` | none |
| `@nori/sdk/vr` | `VrJogMapper`, `VrSession`, `DEFAULT_BINDINGS`, VR types | `three` |
| `@nori/sdk/supabase` | `SupabaseSignaling` (reference transport) | `@supabase/supabase-js` |
| `@nori/sdk/mock` | `createMockRobot`, `MockDaemonSim`, `createLoopbackSignaling` (dev/CI fake robot) | none |

## License & lineage

Apache-2.0 (see `LICENSE`). Developed within Nori's fork of
[huggingface/leLab](https://github.com/huggingface/lelab) (Apache-2.0); the SDK package files
are Nori-original additions, marked with `// NORI:` header comments.

## Status

`v0`, for a small set of collaborating devs — not a public release. The core teleop + VR surface
is stable; the two-way **call** API (`joinCall`/`leaveCall`/mic/camera on `RemoteTeleop`) is
present but **experimental** and may change. Note the robot-side consent gate: `joinCall()`
rings an accept prompt at the robot and room audio stays silent until a person there accepts
(clips via `sendClipAudio` are exempt — see "Streaming audio").
