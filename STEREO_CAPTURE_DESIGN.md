# Stereo capture: front + overhead as a stereo pair

Status: **frontend BUILT** (this branch); robot + backend **DESIGNED ONLY —
nothing below the wire is implemented yet**. The wire contract is pinned by
`frontend/packages/nori-sdk/src/mock/sim.ts` and
`frontend/src/nori/remote/mockRobot.test.ts` (the mock is the spec).

## Goal

Coordinate the **front** and **overhead** cameras into a stereo pair:

1. Every uploaded episode carries the measured **distance/angle between the
   two cameras** (operator-provided extrinsics), stored with the episode so a
   stereo view can be reconstructed later. Display is out of scope for now.
2. The Remote page's "Record training dataset" card gains an
   **"Enforce stereo view"** toggle, chosen before a recording session. When
   on, the robot enforces that front and overhead record at **one matched
   frame rate** so frames pair 1:1.

## Wire contract (implemented app-side on this branch)

- `{type:"record", action:"session_start", task, stereo:true}` — the flag is
  **session-scoped**, fixed at session open. It also rides `episode_start`
  purely for the dropped-`session_start` recovery (same rule as `task`); a
  mid-session flag on an already-open session is **ignored** (pinned by test).
- Every `record_status` reply echoes `stereo:true` **while a stereo session is
  open**, cleared once it closes. The UI reports enforcement only from this
  echo — a robot that predates the vocabulary silently ignores the field and
  the UI shows nothing rather than a false promise.
- The extrinsics are **not** sent by the app. They are robot-local
  configuration (see below): the app asks for enforcement; the robot owns the
  physical truth.

App-side pieces (built): SDK `record(action, task?, {stereo})` +
`RecordState.stereo`; mock sim emulation; `DatasetCaptureCard` toggle
(persisted in `localStorage`, disabled-by-construction once a session is open,
"stereo" pill on the open session, "· stereo enforced" in the robot status
line, driven by the robot's echo).

## Robot design (nori_ws — NOT built)

### 1. Gateway (`nori_gateway/protocol.py`)

- `_handle_record`: on `session_start` (and the `episode_start` that
  auto-opens a session) read `stereo = message.get("stereo") is True` into a
  session-scoped `self._session_stereo`; clear it wherever `_session_open`
  clears.
- `_do_start_episode`: pass `["stereo"]` as the StartEpisode `tags` when
  enforcing — **`StartEpisode.srv` already has `tags`, so no interface
  change**.
- `_emit_record_status`: include `"stereo": True` while `self._session_stereo`
  (this is the echo the UI trusts).

### 2. Recorder (`nori_dataset`)

Config additions (`episode_recorder.yaml`):

```yaml
stereo_pair: [front, overhead]
stereo_extrinsics_file: ~/.config/nori/stereo_extrinsics.yaml
```

Extrinsics file (operator-provided, per robot — schema v1):

```yaml
schema_version: 1
pair: [front, overhead]
baseline_meters: 0.412        # distance between optical centers
angle_degrees: 38.5           # relative pitch between optical axes
measured_at: "2026-08-16"
method: "tape measure + inclinometer"
# room for a future full 6-DoF pose (translation_m: [x,y,z], rpy_deg: [r,p,y])
```

Behavior:

- **Always** (stereo session or not): at episode start, load the extrinsics
  file fresh (same pattern as `capture()`) and stamp it into `meta.json` under
  `"stereo"`, plus `"enforced": <bool>` and, when enforcing,
  `"enforced_fps": <rate>`. Missing/invalid file → `"stereo": null` + a
  warning in the start reply, never a refusal (extrinsics absent must not
  block ordinary recording).
- **When the `stereo` tag is present** on StartEpisode:
  - Require both pair cameras' topics to be live (the existing required-topics
    gate, extended) — refuse the episode loudly otherwise.
  - Enforce equal **stored** rate: `enforced_fps = min(front.fps,
    overhead.fps)` and set both cameras' fps caps to it, reusing the existing
    phase-preserving decimation. This deliberately does NOT touch the camera
    drivers (no relaunch mid-session; the U20s free-run anyway). Equality of
    the *stored* streams is what training and stereo pairing consume; source
    rates are still recorded per camera in `meta.cameras`.

**Upload needs zero new transport**: `meta.json` already travels in the
episode bundle and the shipper is content-agnostic — the backend stores the
extrinsics the moment this lands, with no backend change.

### 3. ⚠️ Decision required: the front-camera privacy rule

`episode_recorder.yaml` currently **refuses `front` in `recorded_cameras`**
("never the front camera, never audio") — a deliberate privacy rule: front
faces people. Stereo capture is meaningless without recording front, so one of:

- **(a) Proposed:** the stereo flag adds `front` to the recorded set **for
  that session only** — an explicit operator opt-in, stamped loudly in
  `meta.json` (`"privacy": {"front_recorded": true, "reason": "stereo"}`).
  Cloud-side face-blur (the marketplace anonymization pipeline) remains the
  backstop for anything published.
- (b) Keep the rule absolute; stereo sessions are refused unless the robot's
  config already lists front — which today means never.

(a) is recommended but this reverses a recorded privacy decision, so it needs
an explicit sign-off before the robot build.

### 4. Backend (nori-backend — nothing to build now)

- Storage: none needed (rides `meta.json`).
- Later, for display/consumption: `raw_bundle_assembler` copies `meta.stereo`
  into the session sidecar; stereo frame pairing = nearest-timestamp match
  within `1/(2*enforced_fps)`; a library-card marker can be cached like the
  episode-timing fields (migration 038 pattern). All deferred.

## Compatibility

- Old robot + new app: `stereo` field ignored, no echo, UI shows plain
  recording — degrades honestly.
- New robot + old app: no `stereo` field ever arrives; nothing enforced.
- The L2 daemon ignores unknown record fields identically.

## Robot-side test plan (for the build)

- Gateway: flag parsed on session_start / auto-open episode_start; ignored
  mid-session; echoed in every status while open; cleared on close; tag passed
  to StartEpisode.
- Recorder: extrinsics stamped always; enforcement caps both pair cameras to
  min-fps (decimation counters prove it); refusal when a pair camera is
  absent; meta records enforced_fps + privacy marker.
- End-to-end: record a stereo episode, verify uploaded bundle's meta.json, and
  that stored frame counts of front/overhead agree within one frame.
