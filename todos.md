# NoriLeLab — Work Queue (todos)

> **Purpose:** the concrete task list for the laptop app. Derived from
> [`full_nori_plan.md`](full_nori_plan.md) (what/why), [`m3_m5_implementation_plan.md`](m3_m5_implementation_plan.md)
> (the M3→M6 how), and [`onboard_pi_plan.md`](onboard_pi_plan.md) (robot side).
>
> **Current stage (2026-07-01):** Phases 1–6 (all Nori-Backend integration) are **done**.
> M1 WAN remote teleop + WebRTC video/control is **done**. VR teleop is **in active
> development**. The live front is **Phase 7 — two-way audio call + teleop GUI overhaul**
> (the laptop half of robot M3), plus the §P parallel track. This is the highest-value
> **fully hardware-free** work: testable against a mock daemon / WebRTC loopback with no robot.

---

## Legend

- ✅ **Done** — built, in-tree, verified.
- 🟢 **Now** — unblocked, hardware-free, actively targetable.
- 🟡 **Partial** — the static / non-protocol slice is doable; the LAN-transport slice is blocked.
- 🔴 **Blocked** — depends on the Pi daemon's protocol / WebRTC / mDNS. Reference only; do **not** start.

Tagging rule: in-place edits to existing LeLab files get a `# NORI:` comment so upstream
merges stay easy. Additive files (`frontend/src/nori/`, `lelab/nori_client.py`) need no tag.

---

## Done ledger (Phases 0–6 + M1)

Compressed — see git history / `full_nori_plan.md` for detail. Do not re-open without cause.

- ✅ **Phase 0** — env (Node, both servers, OpenAPI reachable).
- ✅ **Phase 1** — Nori scaffolding: `frontend/src/nori/` tree, generated `api/types.ts`,
  `api/client.ts`, Supabase `auth/`, `lelab/nori_client.py`, env config, `/nori/*` routes.
- ✅ **Phase 2** — auth + provisioning: sign-in, two-hop JWT plumbing (`X-Nori-JWT` → `Bearer`),
  provision-on-sign-in, account page, auth guard.
- ✅ **Phase 3** — marketplace: browse + source filter, install (acquire→download / direct),
  streaming policy download to local cache.
- ✅ **Phase 4** — HF reroute (client + plumbing): 4-step presigned-S3 `upload_dataset()`,
  manifest build/validate (unit-tested), training dispatch + log-polling proxies,
  `runners/nori_cloud.py` `NoriCloudJobRunner` wired into the job registry.
- ✅ **Phase 6** — polish: pairing (manual serial), consents grant/revoke, deletion request,
  training-history page with live log polling + "Start training" trigger.
- ✅ **M1 — WAN remote teleop:** `frontend/src/nori/remote/teleop.ts` (`RemoteTeleop`) —
  WebRTC answerer, Supabase signaling, fresh-peer-per-offer, unreliable control data channel,
  HMAC room-token auth, LAN/WAN link-mode detection from the selected ICE pair (drives the
  daemon watchdog profile), telemetry view (`loop_hz`, safety, watchdog, temp, currents).

**In active development (uncommitted):**
- 🟢 **VR teleop** — `remote/vr.ts` (jog mapper) + `remote/vr-session.ts` (`VrSession`, WebXR
  controller→jog mapping), offered as an option on top of remote. Feeds `ExternalJog` into the
  same control wire the keyboard uses. Finish/stabilize before layering the call UI on top.

---

## Phase 7 — Two-way audio call + teleop GUI overhaul  🟢 (laptop half of robot M3)

> **Goal:** the M1 WebRTC session gains **two-way audio** (operator hears the room + speaks
> into it) and a teleop control surface worth shipping. Operator **video is deferred to M6** —
> build it but ship it dark behind a flag. **No change to the control data channel.**
>
> **Where it lives:** `frontend/src/nori/remote/` (session logic) + `frontend/src/nori/pages/remote.tsx`
> (UI) + the VR surface (`remote/vr-session.ts`). Robot-side counterparts (mic/speaker, AEC,
> sound-effects) are `onboard_pi_plan.md` M3 — not in this repo.
>
> **The one hard rule (R-X.1) — read before writing any audio code:** `webrtcbin` on the Pi is
> fragile under renegotiation. The **track set is fixed at session establishment**. All m-lines
> (robot video, robot→operator audio, operator→robot audio, and a **reserved muted video m-line**
> for M6) must be present in the **first** offer/answer. "Unmute mic" / "enable video" later is a
> **track-enable flip or a full session re-establish — never a live renegotiation.** The browser
> is the **answerer**, so this depends on the robot's offer proposing those m-lines (see §D).

### A. Audio track plumbing on the existing peer connection

*Target: `remote/teleop.ts` (`RemoteTeleop`), reused by `remote/vr-session.ts`.*

- [ ] **A1 — Robot audio playback (uplink; M3a, ship first, no AEC dependency).**
  Extend `pc.ontrack` (`teleop.ts:259`) to route an **incoming audio** track to an audio sink.
  Today it only handles video (`videoEl.srcObject`). Add a hidden `<audio autoplay>` element (or
  set the audio track on a dedicated `MediaStream`) and attach it. Small jitter buffer; verify
  continuity, not latest-only.
  - ✅ *Resolved (2026-07-01, Pi team):* **route by `ev.track.kind`, never by stream grouping** —
    the bridge's video + audio are separate gst tracks and msid grouping is not guaranteed
    (`webrtc_operator.html` already routes by kind; do the same in `teleop.ts`).
- [ ] **A2 — Operator mic capture (downlink; M3b).**
  `getUserMedia({ audio: true })`; attach the mic track to the **audio m-line the robot's offer
  proposes** (via the matching `RTCRtpTransceiver` — do **not** `addTrack` a new m-line, that
  forces renegotiation). Gate acquisition behind an explicit "join call" action (permission
  prompt UX), not on page load.
  - *Open:* mic constraints — echoCancellation/noiseSuppression/autoGainControl on the browser
    side? (Robot-side AEC is the real fix per M3-D, but browser AEC is free insurance.) **TWEAK.**
- [ ] **A3 — Establishment-time track contract.** On building the answer, ensure the peer has
  transceivers for: robot-video (recv), robot-audio (recv), operator-audio (send), and a
  **reserved operator-video transceiver set to `inactive`/muted** (M6). No mid-call `addTrack`.
  - *Depends on §D + Pi:* the browser can only fill m-lines the robot offered. If the robot's
    current offer is video-only (`SENDONLY` video, per `m3_m5_implementation_plan.md` R-X.1),
    this is **coordination-gated** on the Pi adding the audio + reserved-video m-lines to its offer.

### B. Call UI + control-channel state sync

*Target: `pages/remote.tsx` (+ shared indicator component under `nori/remote/` or `components/`).*

> **Basic laptop-side layout done 2026-07-01** — `CallState` + call API on `RemoteTeleop`
> (`joinCall`/`leaveCall`/`setMicMuted`/`enableCamera`/`disableCamera`, `onCall` events),
> `CallBar` in `remote/TeleopStatus.tsx`, audio sink + self-view slot in `remote.tsx`. All
> renegotiation-free (attach to transceivers the robot offers). **Visuals are throwaway** —
> front-end team redoes them; the point is every control + indicator is now wired/exposed.
> Still gated on the **Pi offering audio (M3) / video (M6) m-lines** — until then mic/cam
> capture works locally but `micSending=false` (surfaced in the UI).

- [x] **B1 — Mic mute toggle** (done): `RemoteTeleop.setMicMuted()` flips `track.enabled`; default
  muted on join. No renegotiation.
- [x] **B2 — "On air" indicators** (done): `CallBar` shows operator (`active && !muted && micSending`)
  and robot (`robotMicLive || robotAudio`) live dots. Robot-side truth read from the reserved
  `robot_mic_live` telemetry field + the inbound audio track's mute/ended events.
- [x] **B3 — Call-state sync over the control channel** (done): `joinCall`/`leaveCall`/`setMicMuted`
  emit `{type:"call", ...}` over the existing control channel (same `dcSend` wire as `link`/`jog`).
  - ✅ *Resolved (2026-07-01, Pi team — robot side BUILT in `rpi5/media/webrtc_robot.py`):*
    **no consolidated echo; keep exactly what you built.** Authority split: operator-mic state is
    operator-authoritative (local `track.enabled` + local render); robot-mic state is
    robot-authoritative via **`robot_mic_live` injected into telemetry by the media BRIDGE**
    (not the daemon — `{type:"call"}` is intercepted at the bridge and never forwarded, so
    there is **no `nori-protocol` change and no `protocol_version` bump**). A reserved
    `robot_mic_muted: bool` field on `{type:"call"}` mutes the robot mic renegotiation-free
    (gst `valve`) when the UI wants it. See `m3_m5_implementation_plan.md` §2.1-F.
- [x] **B4 — Operator camera + self-view, GATED** (done): full capture + attach + self-view built;
  UI hidden unless `isM6VideoEnabled()`. **Flag decision:** localStorage `nori_m6_video=1` dev
  toggle (`remote/flags.ts`) — cheap to promote to a build-time default later.

### C. Teleop GUI overhaul

*Target: `pages/remote.tsx` + the VR surface. Much of the data already exists in `TelemetryView`
/ `onCurrents` — this is mostly surfacing it well.*

- [x] **C1 — Clear connection/telemetry panel** (done 2026-07-01): `TelemetryPanel` in
  `remote/TeleopStatus.tsx` — conn state, link path (LAN/WAN, now surfaced on `TelemetryView`),
  `loop_hz` (toned <45/<30), safety, watchdog, temp, and a **stale** flag (no telemetry frame
  for >1.5 s while control is active).
- [x] **C2 — Grip-force / current readout** (done 2026-07-01): `GripForce` bars from
  `TelemetryView.currents` (grippers first). Currents now ride the telemetry view, not just VR
  haptics. Also added a visible **Mode** toggle button (`RemoteTeleop.toggleMode()`).
- [x] **C3 — Keybind discoverability** (done 2026-07-01): `ControlLegend` derived from the
  exported `keybindLegend(mode)` in `teleop.ts` (single source of truth — the maps the jog
  stream uses), mode-aware.
- [x] **C4 — VR recenter/reposition** (done 2026-07-01; trigger reworked 2026-07-02):
  `VrSession.serviceRecenter()` moves the panel cluster PANEL_DIST in front of the operator's
  current facing. Triggered by an **in-VR "Recenter" button anchored above the left controller,
  poked with the right controller** (`updateRecenterButton` → `VrSession.recenter()`). Hand-anchored
  so it stays reachable after the operator physically turns around; poke (not ray+trigger) because
  both triggers are already the grippers. *(Evolution: double-tap right-thumbstick gesture → browser
  "Recenter view" button → in-VR poke button. The browser button was unusable in-headset; recentering
  has to be done from inside the VR environment while turning.)*
- [x] **C4b — VR telemetry HUD parity** (done 2026-07-01): the VR scene previously showed *only*
  the camera feed. Now forwards `TelemetryView` into `VrSession.setTelemetry()` and paints a
  canvas-texture HUD with the **same stats as the keyboard `TelemetryPanel` + `GripForce`**
  (control/path/loop/safety/watchdog/temp + grip-force bars, same tone thresholds + staleness).
  Video panel shrunk (2.0×1.5 → 1.6×1.2) and both panels moved into a `THREE.Group` (recenter
  moves the cluster; leaves room to the right/left for the C7 multi-cam + C6 cube panels).
- [x] **C5 — Call-window layout** (basic, done 2026-07-01): robot video with an overlaid reserved
  self-view slot (hidden until M6), the `CallBar` beneath it, then telemetry / grip-force /
  legend. Throwaway visuals; front-end team owns the real design.
- [ ] 🟡 **C6 — Basic 3D visual of robot** (arm/rail positioning as cubes, for fully-remote teleop).
  **CORRECTION (2026-07-02):** the earlier "no joint positions in telemetry" note was **wrong**.
  The daemon's telemetry frame **already carries a full `state` dict** with every `<motor>.pos`
  (all 12 arm joints, normalized) + `x.vel`/`theta.vel` (`NoriTeleop` `main.cpp:386` `to_state`,
  `nori_protocol_schema.md` §state). The laptop simply **was not parsing it** — `teleop.ts`
  `handleTelemetry` read only `loop_hz/temp/status/currents/robot_mic_live`.
  - [x] **Parse `state` into `TelemetryView.state`** (done 2026-07-02) — arm-joint positions now
    received laptop-side; surfaced via `onTelemetry`.
  - [ ] **Arm/gripper-tip 3D:** run forward kinematics from the joint angles in the VR three.js
    scene (link geometry is static — hardcode in the descriptor). **Unit wrinkle:** `.pos` is
    lerobot-normalized `[-100,100]` (grippers `[0,100]`), NOT degrees — see the Pi-side
    `use_degrees` telemetry field decision below (normalize/convert on the Pi, which owns the
    per-unit calibration + kinematic convention).
  - [ ] **Base/body pose + Z-lift height:** still genuine gaps — telemetry has base *velocity*
    only (no odometry) and no lift position (velocity-mode motor, single-turn encoder). Separate
    robot-side work (odometry; lift encoder — see the z-lift task).
- [ ] 🟡 **C7 — Multi-camera display (3 feeds: `left_wrist` / `right_wrist` / `overhead`).**
  Today `teleop.ts` `ontrack` funnels all video to one `videoEl` and `remote.tsx` renders one
  `<video>`. **Operator-side work (this repo):** route incoming video by `ev.transceiver.mid` →
  role via a `Map<role, HTMLVideoElement>`; render a primary + thumbnails grid (throwaway visuals,
  front-end redoes). In VR, add the two secondary feeds as extra panels. **Depends on:** the robot
  offering 3 video m-lines + announcing a **`mid → role` map** on the media-bridge message layer
  (robot-side port of `configure_cameras.py` + `webrtc_robot.py` multi-branch pipeline — see
  `onboard_pi_plan.md` §f "Multi-camera video" and `SDK_DIRECTION.md`; that work lives in the
  private `NoriTeleop` repo). **Testable now** by extending the mock `webrtc_robot.py --source test`
  to emit 3 test patterns + the mid→role map. ⚠️ Pi CPU/thermal for 3× SW encode is unvalidated (R11/R-X.7).

### D. Shared protocol contract (`nori-protocol`)

> Prerequisite for the B3 call-state messages and the reserved fields. Coordinate with the Pi
> team — this is a **shared submodule**, one source of truth. Section-6 partial promoted here
> because Phase 7 needs it.

- [ ] **D1 — Stand up the `nori-protocol` git submodule** + `protocol_version` handshake
  convention + golden-fixture test harness; wire it into NoriLeLab. **Blocked slice:** the
  concrete daemon struct/field layout is owned by the Pi team — leave a versioned placeholder
  until they pin it.
- [x] ~~**D2 — Add the new fields** to `nori-protocol`~~ **SUPERSEDED (2026-07-01):** call-state /
  mute / on-air fields deliberately stay **out of `nori-protocol`** — they live on the control
  data channel but are **intercepted by the media bridge** (the daemon never sees audio; no
  `protocol_version` bump; avoids a lockstep daemon+bridge+client redeploy). Already implemented
  both ends (laptop B3 + bridge `_handle_call`/telemetry injection). D1/D3 remain valid for the
  *existing* daemon contract (hello/control/command/telemetry).
- [ ] **D3 — Migrate `teleop.ts` off hand-rolled JSON** to parse/serialize against the shared
  schema; **assert `protocol_version` on connect** (fail loudly on mismatch).
  - *Open:* how strict is version mismatch — hard-refuse, or warn + best-effort? **DECIDE.**

### Phase 7 acceptance criteria (laptop side; audio validation is hardware-gated on the robot)

- [ ] Operator hears the robot's room (A1) — verifiable against a WebRTC loopback / mock.
- [ ] Operator mic reaches the session; mute flip works with **no renegotiation** (A2/B1).
- [ ] On-air indicators on both ends agree via the control channel (B2/B3).
- [ ] Operator video is present in code but inert behind the flag (B4).
- [ ] Telemetry panel, current readout, keybind legend, mode toggle all render (C1–C4).
- [ ] `protocol_version` asserted on connect; call-state messages validated by fixtures (D).
- [ ] *(Hardware-gated, robot M3):* no echo/howl (AEC), latency < 300 ms, no hub brownout.

---

## Section 6 partials — static / non-protocol slices only 🟡

- [ ] **`XLerobot2WheelsConfig` static descriptor** (Phase 5 declarative part): DOF count + names,
  motor mapping, kinematic profile, calibration interface, camera enumeration — following the
  `SO101LeaderConfig`/`SO101FollowerConfig` pattern. Own module (minimize upstream-merge
  conflict). **Blocked part:** the constructor's LAN transport — build the descriptor, leave
  `connect()` stubbed.

---

## 🔴 Blocked by Pi code — do NOT start (reference only)

- Phase 5 LAN transport: TCP JSON control/state, WebRTC video sink + signaling host on the
  laptop, E-STOP reset command on the control channel.
- `tools/export_lerobot_dataset.py` — parses the Pi's live recording stream into Parquet + `.mp4`;
  schema owned by the daemon.
- The recording-stream ingest from `xlerobot.local` (Phase 4 pre-upload step).
- WebRTC/OpenCV video sink feeding `rollout.py` inference + the React canvas mirror.
- mDNS/QR discovery pairing UX (needs the daemon's `xlerobot.local` advertisement).
- Robot push of a downloaded policy (`rollout` against live hardware).
- Robot-side M3 audio (mic/speaker, AEC, sound-effects), M4 LVGL face, M6 on-demand Chromium
  call view — all `onboard_pi_plan.md`.

---

## Suggested execution order

1. **Stabilize VR** (finish the in-flight uncommitted work).
2. **D1/D2** — stand up `nori-protocol` + reserve the call-state/video fields (unblocks B3 cleanly).
3. **A1** — robot audio playback (uplink; simplest, no AEC dependency, immediate value).
4. **A2/A3/B1–B3** — operator mic + mute + on-air sync (coordinate the robot's offer m-lines).
5. **C1–C5** — teleop GUI overhaul (mostly surfacing existing telemetry; parallelizable).
6. **B4** — operator video, built dark behind the M6 flag.
7. **Section 6 partial** (`XLerobot2WheelsConfig` descriptor) — opportunistic.

All of the above is hardware-free and testable against a mock daemon / WebRTC loopback.
Batch the robot-side audio validation (AEC, latency, hub power) for when a unit is back.
