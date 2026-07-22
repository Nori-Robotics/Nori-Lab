# Policy-stream integration — the laptop side (send & receive)

> Status 2026-07-21: PLAN. The robot half is DONE and merged (NoriTelop
> `675aa3c`, `rpi5/media/policy_streamer.py` + `docs/protocol_streaming_design.md`;
> contract verified unchanged through `origin/main a8b2dcb`). The laptop half —
> everything below — does not exist yet; Nori-Lab contains zero `policy_stream`
> references today. Option B (`lelab/nori_cam_zmq.py`, laptop-side direct SUB of
> the Pi camera sockets) is DEPRECATED in favour of this: it is dead on
> customer-provisioned units (loopback-bound cameras), carries no capture
> timestamps, and delivers no calibration.
>
> DECISION 2026-07-21: the BROWSER-CAPTURE route is deprecated for BOTH
> recording and policy inference. The Pi raw-bundle recorder is the recording
> path; the policy stream is the observation path. The browser composite
> survives only as (a) the live operator preview and (b) a warned legacy
> fallback for policies trained on composite data.

## 0. The fixed contract (theirs — do not redesign)

- The **robot connects OUT** to a client-supplied `ip:port` (private/link-local
  only, enforced robot-side) and sends **4-byte big-endian length-prefixed
  blobs** over TCP.
- **Blob 0** — JSON preamble:
  `{"kind":"policy_stream_meta", serial, mono_epoch, wall_epoch, cameras:[...],
  fps, calibration:<robot.json contents|null>}`. Unknown fields must be ignored.
- **Blob 1..N** — one camera-PUB payload verbatim:
  `b"<name> <capture_monotonic_seconds>\n" + <jpeg>` (sensor-quality JPEG,
  no re-encode under the default passthrough).
- **Control** rides the existing WebRTC data channel:
  `{type:"policy_stream","action":"start"|"stop"|"status"[,"dest","target"]}`
  → reply `{type:"policy_stream_status", ok, streaming, dest, fps_out,
  frames_sent, dropped, error?}`. `start` may take up to ~8 s (robot-side sink
  connect + preamble).
- Robot behaviour we rely on: bounded newest-wins buffer (drop-oldest, honest
  `dropped` counter), frame-silence auto-stop (~5 s), dead-sink auto-stop
  (~10 s), **no silent reconnect** — a died stream is visible by design.
- Robot-side gating: `NORI_POLICY_ENABLED=1` (shipped default 0) and
  `NORI_POLICY_CAMERAS` (**default `overhead` — must be widened to
  `left_wrist,overhead` for the MolmoAct2 two-view contract**; per their §9 a
  config change + bandwidth re-check, not a redesign).
- The `laptop` sink has **no auth in v1** (their open question §9); mitigations
  are ours (§1 below).

## 1. `lelab/policy_stream_rx.py` — the receiver (new)

Pure-Python TCP listener, testable with no robot.

- **Arming model.** `StreamListener(port=NORI_STREAM_PORT|0, host=NORI_STREAM_HOST|auto)`
  binds and accepts **exactly one** connection, only inside an arming window
  (~30 s after `open`). Later/second connections are refused. Not a daemon —
  exists per rollout session, closed on unload.
- **Framing.** Read length prefix, cap blob size (8 MB) so garbage can't balloon
  memory, decode blob 0 as the preamble, then frames.
- **Guards (v1, in lieu of sink auth).** Single connection + arming window +
  preamble must parse with `kind=="policy_stream_meta"` + **`serial` must match
  the session's robot serial** (caller passes the expected serial; mismatch →
  drop the connection, loud log). This bounds the no-auth risk to "a LAN host
  that knows the window, fakes the paired robot's serial, and races the real
  robot" — acceptable for v1, real auth tracked with NoriTelop §9.
- **Frame store.** Per-camera latest-wins slot `{name: (jpeg, capture_ts, recv_ts)}`.
  Staleness is judged from **capture** `mono_ts` mapped through the preamble's
  `mono_epoch`/`wall_epoch` anchor — the stream's whole advantage over the
  deprecated arrival-time heuristic.
- **Interface parity** with the deprecated `ZmqCameraSource`, so it drops into
  the same seam in `nori_rollout.py`:
  `frames_b64(view_keys) -> dict|None` (all-or-nothing; stale = missing),
  `status()` (cameras, per-camera `age_s`, `frames_seen`, serial,
  `calibration_present`), `close()`.
- **Calibration capture.** The preamble ships `robot.json` (per-motor
  `range_min/range_max/drive_mode/homing_offset` — non-secret by design).
  Keep it on the object and persist to `~/.nori_robot_calib.json`. This
  **automatically unblocks the units-conversion work** the moment a first
  stream starts.
- **Failure = fallback, loudly.** Reader thread never raises into the rollout;
  disconnect → slots age out → `frames_b64` returns `None` → existing composite
  fallback, `frame_source` flips visibly.

## 2. lelab wiring (`nori_rollout.py`)

- `POST /nori/rollout/stream/open` — the request carries `expected_serial`,
  supplied by the FRONTEND APP from its pairing/session state
  (`TeleopSessionContext`; the SDK itself does not know the serial) — arms a
  listener and returns `{host, port}`. `POST .../stream/close`.
  `/stream/status` exposes `{connected, serial, preamble_received,
  calibration_present}` for the start-sequence poll. Status folded into
  the existing rollout `status()` (`frame_source`, per-camera ages, streamer
  counters when known).
- Source preference in `_cloud_act`: **stream > deprecated direct-SUB (only if
  explicitly configured; warns) > composite (deprecated legacy fallback —
  logs a deprecation warning every time it engages)**. `frame_source ∈
  {"stream","zmq","composite"}`.
- Host auto-detection: default-route private address (UDP-connect trick),
  `NORI_STREAM_HOST` override for multi-NIC laptops.
- View mapping: `observation.images.<role>` → preamble camera name. If a
  requested view is not in the streamed set, fail the load loudly listing what
  IS streamed (mirror of the existing composite-tile error).

## 3. SDK send side (`frontend/packages/nori-sdk` `teleop.ts`)

- `policyStream(action, opts?)` → sends `{type:"policy_stream",...}`;
  `onPolicyStreamStatus` surfaces `policy_stream_status` (incl. `dropped` —
  the honest congestion signal worth showing in the deploy card).
- Wait ≥10 s for the start reply (robot relay timeout is 8 s).

## 4. `policyRun` orchestration

Start sequence (all failures → composite fallback + console warning, never
silent):

1. `POST /nori/rollout/stream/open` → `{host, port}`
2. `teleop.policyStream("start", {dest:"laptop", target:`${host}:${port}`})`
3. Wait: SDK status `ok` **and** lelab `/stream/status` shows the preamble
   arrived (≤5 s poll)
4. `POST /nori/rollout/load` as today — views resolved against streamed cameras
5. Tick loop: while the stream is live the browser STOPS attaching composite
   JPEGs to `/act` bodies (upload shrinks to joint state) — P3 work now that
   the composite path is deprecated, not polish. Observation no longer depends
   on the preview video element; the encoder pause/resume dance stays purely a
   preview-UX concern.

Stop: `policyStream("stop")` + `/stream/close`, best-effort, in `stop()`.

## 5. Local (laptop ACT) inference — provenance rule

Wiring is identical (same source object attached at `_load_bundle`), but the
frame source must **match the policy's training domain**:

- Trained on **raw-bundle** (Pi recorder) data → stream frames. Same bytes as
  training.
- Trained on **browser-capture** data → keep the composite. Full-quality frames
  would be the same train/infer mismatch we just fixed, inverted.

With browser capture deprecated, this table is transitional: NEW policies are
raw-bundle-trained and take the stream; EXISTING composite-trained checkpoints
(e.g. `observation.images.remote` policies) run on the legacy composite path
with a deprecation warning until retired or retrained. v1: explicit flag on
`/rollout/load`; follow-on: stamp `capture_source` into `nori_meta.json` at
promotion and choose automatically — `"browser"` provenance then also gates the
warning.

## 5b. Deprecating browser-capture RECORDING (companion track)

The browser catcher (`datasetCapture.ts` → `lelab/browser_capture.py` →
`capture_export.py`) is deprecated in favour of the Pi raw-bundle recorder
(already the primary path). Scope is marking, not deleting:

- Deprecation banners on all three modules + a warning when a browser capture
  starts; ~~the record UI labels the option "legacy"~~ — MOOT, verified
  2026-07-22: no UI constructs a recording DatasetCapture anymore (the Remote
  card is the ROBOT recorder); only the listDatasets helper is still consumed.
- New browser-capture recordings go behind an env flag (default off) once the
  raw-bundle UI covers the workflow; viewing/assembly of EXISTING captures is
  untouched.
- Removal is a later decision, after the raw-bundle path has proven it covers
  every workflow.
- PENDING (2026-07-22): Michael to verify the raw-bundle capture pipeline
  end-to-end; NORI_BROWSER_CAPTURE stays default-ALLOW (warned) until then,
  flips to default-off on his confirmation.

## 6. Phases

| # | What | Needs robot? |
|---|---|---|
| P0 | Deprecate option B (done in this commit) | no |
| P1 | Receiver + tests against a fake streamer speaking their wire (their `test_policy_streamer.py` FakeSink is the reference decoder — ours is the mirror image) | no |
| P2 | lelab endpoints + cloud-path wiring + status | no |
| P3 | SDK + policyRun orchestration; skip composite upload while the stream is live (+ dist rebuild, localhost checklist) | no |
| P4 | Live bench: robot build deployed, `NORI_POLICY_ENABLED=1`, `NORI_POLICY_CAMERAS=left_wrist,overhead` — coordinate w/ NoriTelop (their own Pi bench §7.5 is still pending) | **yes** |
| P5 | Units conversion derived from the streamed `robot.json` (scale = `(max−min)×360/(200×4096)` per joint, ≤1.8 sanity bound, gripper passthrough; A/B against the fitted affine in `dryrun_cloud` before replacing `NORI_INFER_CALIB`) | file only |
| P6 | Local-ACT provenance gating + `capture_source` stamp | no |
| P6b | Browser-capture recording deprecation (§5b) | no |
| P7 | Polish: client live-view bitrate downshift during runs; RTC `delay` from true capture age instead of the RTT EWMA | no |

## 6b. P4 bench runbook (the first robot-dependent step)

Off-hardware E2E is green (`tests/test_policy_stream_e2e.py`): fake robot →
real receiver → real endpoints → real chunk queue, incl. the stream-death →
422 → composite recovery leg and the calibration persist. P4 is the same run
with the real robot.

Robot side (Shanying's deployment, no code changes):
1. Deploy a build containing `675aa3c`+ (policy streamer).
2. `NORI_POLICY_ENABLED=1`, `NORI_POLICY_CAMERAS=left_wrist,overhead` in
   `media.env` (bandwidth re-check per their §7.5 bench — still pending their
   side).

Laptop side, from the Remote page (everything is already wired):
1. Connect the session as usual, open the cloud deploy card, Observe-only ON.
2. Start. Expected console: `[policyRun] policy stream live — cameras:
   ["left_wrist","overhead"]`. If it warns `composite fallback`, the robot
   refused/unreachable — check `NORI_POLICY_ENABLED` and the LAN route.
3. `curl -s localhost:8000/nori/rollout/status | python3 -m json.tool`:
   `frame_source` must read `"stream"`, `stream.age_s` under ~0.2 s per
   camera, streamer `dropped` near 0.
4. `~/.nori_robot_calib.json` must now exist — the P5 unblock. Run the units
   check against it (scale = (max−min)×360/(200×4096) ≤ 1.8 per joint).
5. Kill test: stop the robot's streamer mid-run (or disconnect) — the browser
   must log `policy stream lost — re-attaching DEPRECATED composite` and keep
   ticking; the run must NOT die.
6. Stop the run: robot streamer must stop (its own status goes idle), lelab
   listener closed.

Abort criteria: teleop loop_hz or live-view degradation while streaming
(uplink contention — drop to `NORI_POLICY_CAMERAS=overhead` and re-check), or
`dropped` climbing steadily (sink congestion).

## 7. Answers to NoriTelop §9 open questions (handoff — already established)

- **State vector**: 6 floats, ONE arm, order `shoulder_pan, shoulder_lift,
  elbow_flex, wrist_flex, wrist_roll, gripper`. Joints 0-4 in **degrees from the
  calibration midpoint** (`deg = (ticks − (range_min+range_max)/2) × 360/4096`;
  proven — the model card's example state sits exactly on the encoder tick
  grid). Gripper is **0–100 % of calibrated travel**, not degrees. A 12-dim
  bimanual vector does NOT error — the model pads to 32 and silently misreads.
- **Rate**: a 30-action chunk is **one second of motion at 30 Hz**; the client
  strides `chunk_hz/fps` per tick (already implemented).
- **`rtc.session`**: client-allocated opaque id, one per rollout; the server
  caches the previous chunk per session (cap 8). RTC measured NOT viable on the
  a10g today (~2 s compute vs the 1 s chunk) — off by default.
- **`Authorization`**: enforced (constant-time compare, 401 without). Token
  rotated 2026-07-21.
- **Cold start**: ~3–6 min; the client now classifies 503/timeouts as
  "warming" and holds the rollout (up to 480 s) instead of dying.

## 8. Out of scope (their design says so, agree)

- Remote (non-LAN) operators — needs the SCTP-data-channel transport follow-on.
  Detect no private route → composite, visibly.
- The `dest=cloud` sink — honestly refused robot-side until a genuine streaming
  ingest exists; the laptop drives `/act` (their §3.2a decision matches our
  built client exactly).
- Operator/policy arbitration and the safety envelope — their sibling track.
