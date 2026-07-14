# Implementation Plan — M3 → M6 (Two-way audio → LVGL face → Productionization → deferred telepresence video)

> **Source of truth for *what* and *why*:** [`onboard_pi_plan.md`](onboard_pi_plan.md) (robot architecture + the **[SCOPE INCREASE 2026-06-30]** note) and [`full_nori_plan.md`](full_nori_plan.md) (laptop app).
> **This doc is the *how*** — build order, task breakdown, acceptance criteria, and a Risks/feasibility register.
> Continues [`m0_m2_implementation_plan.md`](m0_m2_implementation_plan.md).

**Milestones (revised 2026-07-01 after the feasibility pass):**
- **M3 — Two-way *audio* presence** (mic uplink + operator voice downlink + AEC + sound-effects). Operator *video* deferred to M6.
- **M4 — LVGL native face + Python cleanup** — **RAM-driven timing** (Chromium stays until its peak RAM actually forces the swap). LVGL replaces only the always-on idle face; the media bridge **stays Python** (sanctioned exception).
- **M5 — Productionization / shipping** (the original `onboard_pi_plan.md` "M4").
- **M6 — Full telepresence video (deferred)** — operator camera → robot screen via an **on-demand Chromium call view**, added later without touching the M3/M4 architecture.

> **Two decisions locked 2026-07-01 (do not reopen without cause):**
> 1. **Chromium now, LVGL when RAM forces it** (not "straight to LVGL"). Deadlines win; the RAM-driven migration is the original plan.
> 2. **Video rendering never goes into LVGL.** The always-on face is LVGL (the RAM win); the *transient* call video is rendered by an **on-demand Chromium** launched only during a call and torn down after. Face and call are mutually exclusive in time → a **display-ownership handoff**, not overlay-plane compositing. This deletes the hardest feasibility risk (LVGL + video on one DRM master).

---

## 0. Status going in & the hardware constraint

**Where M0–M2 left us:** M1 (WAN laptop teleop + WebRTC video/control + Supabase signaling + STUN/TURN wiring) is effectively done. M0 and M2 are **code-complete but hardware-unvalidated** — the Track-B (real dual-bus) M0 boxes and *all four* M2 acceptance criteria are open, and recent bring-up hit motor brownouts on the shared USB hub (R16).

**Constraint (no hardware on hand):** M3 and M4 are **heavily hardware-gated** (speaker/mic/DSI/AEC acoustics). Rule for now:
- **Write code that compiles against the existing stub/mock** (`external/scservo_stub`, mock bus, `NORI_FAKE_*` overrides) now.
- **Defer "does it work on the real screen/speaker/acoustic path" validation** until a unit is back.
- **Front-load the parallel laptop track (§P)** — the only fully hardware-free work.

> ⚠️ **R16 carried forward (blocking-class).** M3 adds a USB audio device; the audio device + cameras + two motor buses share one powered hub. The brownout class debugged during M2 bring-up is **not** closed. See Risk R-X.6.

---

## 1. Where code lives

| Area | Path | Notes |
|---|---|---|
| **C++ real-time core** | `rpi5/nori_core_agent/` | 50 Hz loop + safety. Unchanged by M3–M6 **except the §5.5 Z-lift closed-loop height feature** (isolated lift state/homing/P-loop). |
| **Python media bridge (stays Python)** | `rpi5/media/` | `webrtc_robot.py`, `signaling.py`, GStreamer. **Sanctioned exception** — own process, off the RT loop. Audio tracks added here in M3. |
| **Legacy Python (delete in M4)** | `rpi4/` | `teleop_server.py`, `image_server.py` — flagged dead (`onboard_pi_plan.md` §Repo Schema). |
| **Kiosk / on-screen UI** | `deploy/kiosk/` | Chromium NoriScreen face today; LVGL face replaces it in M4. Chromium retained for the M6 on-demand call view. |
| **Shared wire schema** | `nori-protocol/` submodule | Daemon contract only (hello/control/command/telemetry). **Unchanged by M3** — call/mute/live signaling does *not* go here (see note below). |
| **Media-bridge signaling** | `rpi5/media/` (`webrtc_robot.py` + operator client) | Call/mute/live/call-state messages live here, alongside the existing `ready`/`bye`/`offer`/`ice` messages. The daemon never sees audio → no `protocol_version` bump. |
| **Laptop app** | `NoriLeLab/` | Operator mic (M3) + camera (M6) capture, call UI, teleop GUI (§P). |

---

## 2. Milestone M3 — Two-way *audio* presence ⭐

**Goal:** the M1 WebRTC session gains audio in both directions — the operator hears the room **and** speaks into it — plus safety sound-effects. **No change to the 50 Hz control path.** Operator video is **out of scope** (M6), but the protocol/session/display leave room for it (see §M6 "keep-clean" rules).

**Split for de-risking:**
- **M3a — uplink + effects (no AEC dependency; ship first):** robot mic → operator, and local safety sound-effects.
- **M3b — downlink + AEC (gated on the AEC hardware decision):** operator voice → robot speaker. Two-way audio echoes without AEC, so this half waits on the hardware answer (§6).

### 2.1 Components & tasks

**A. (M3a) Robot mic → operator (uplink)**
- [x] Add an Opus **send** audio track to the robot's `webrtcbin` (`--audio`/`--mic`/`--audio-test`, negotiated at connect; now includes the `micvalve` mute stage). *(Pi runtime validation pending.)*
- [x] Laptop plays it — done in NoriLeLab Phase 7 §B (audio sink in `remote.tsx`; CallBar; see `NoriLeLab/todos.md`). **Stream-layout answer (their A1 open):** route by `ev.track.kind`, never by stream grouping — the bridge's video+audio are separate gst tracks and msid grouping is not guaranteed (`webrtc_operator.html` already does this).
- [ ] Small jitter buffer; verify continuity (not latest-only). *(Pi/hardware.)*
- **Note on reserved m-lines (laptop A3):** sessions are one-per-process under the supervisor, so the track set is fixed *per session* while every reconnect gets a **fresh offer** — adding the M3b `SENDRECV` audio / M6 reserved-video m-lines later is a bridge config change between sessions, **not** a live renegotiation. No need to pre-reserve today.

**B. (M3a) Safety/status sound-effects**
- [x] **[built 2026-07-02]** Synthesized chimes (no asset files) in `rpi5/media/sound_effects.py`; the `webrtc_robot.py` consumer (`_safety_sfx`) watches `telemetry.status.safety` **edges** (`safe_hold` / `latched`+`estop` / back-to-`ok`) and plays via `aplay` on `NORI_SPEAKER`. No daemon hook or protocol field — the RT daemon is untouched. One-at-a-time (bursts don't stack); fires during an operator session (telemetry flows through the bridge then). *(Pi runtime playback validation pending.)*
- [x] Off-hardware: `python3 sound_effects.py [name]` renders + plays standalone; WAV synthesis unit-checked. (Real acoustic playback Pi-gated.)

**C. (M3b) Operator voice → robot speaker (downlink)**
- [x] **[built + hardware-validated 2026-07-02]** `--voice`/`NORI_VOICE` makes the robot's audio m-line **SENDRECV**; the robot decodes the operator's Opus voice on `webrtcbin` `pad-added` (`opusdec ! alsasink` on `NORI_SPEAKER`, `_on_incoming_audio`). ✅ Operator voice confirmed playing through the robot speaker (headphones on the robot; **no AEC yet** — D).
- [x] **Operator-side uplink reservation (the other half — corrects the earlier "no client change" note).** A browser *answers* the robot's sendrecv offer as **recvonly** by default (it only agreed to receive), so no send transceiver existed and the mic never transmitted. `teleop.ts` now flips its audio transceiver to `sendrecv` **before `createAnswer`** (`offerWantsAudioUplink`), reserving the send; joining the call is then a pure `replaceTrack` — no renegotiation. This is the **per-session** form of R-X.1: the robot needs no pre-reservation (fresh offer per session), but the **operator must reserve at answer time**.

**D. (M3b) AEC — mandatory for two-way audio**
- [ ] Resolve the hardware question with the HW engineers (§6 has the exact questions). Preferred: a USB device with **hardware AEC**; fallback: software AEC (PipeWire `module-echo-cancel` / WebRTC APM), which reopens the "ALSA-only" stance.
- [ ] **Validation is hardware-gated** — needs the real acoustic path.

**E. Simultaneous-playback mixing** — ⚠️ **confirmed real 2026-07-02**
- [ ] Operator voice **and** sound-effects can play at once → one device, two playback streams → needs `dmix` or a single mixing owner (R-X.4). **Observed on hardware:** with `--voice` live, the GStreamer `alsasink` holds `NORI_SPEAKER` (raw `hw:`) for the session, so the sound-effects `aplay` **can't open the device — safety chimes are silent during a voice call.** Fix paths: (a) a shared ALSA `dmix` PCM as the device both open, (b) PipeWire, or (c) a single playback owner that mixes effects into the voice sink (e.g. route chimes through the same GStreamer pipeline via an `audiomixer`). Deferred alongside AEC — both touch the playback stack, so decide them together.

**F. Privacy (R15, bidirectional-ready)**
- [ ] Robot mic: mute control + "mic live" indicator; opt-in; no audio persisted.
- [ ] Reserve the operator-feed-live indicator + consent fields now (used fully in M6).
- [x] **Robot-local mic consent interface (person-at-the-robot control) — built 2026-07-02.**
  The person at the robot can now mute/unmute independently of the operator via **`kill -USR1
  <pid>`** and/or a **physical button** on `NORI_MUTE_GPIO` (gpiozero), both driving the same
  `micvalve` (`set_local_mute`/`toggle_local_mute`, `_apply_mic_valve`). **Consent-first:** the
  local mute **ORs** over the operator's, so the operator can never force the room back on-air;
  `robot_mic_live` reflects the combined state to the operator's CallBar.
- [ ] 🔴 **Flip the default to muted — SECURITY TODO (still open).** The interface exists, but the
  mic is still **unmuted by default**; setting `NORI_MIC_DEFAULT_MUTED=1` starts it muted so room
  audio streams only after an **explicit local unmute**. Left unmuted for now to unblock bring-up.
  **Must be muted-by-default (and paired with a discoverable UI — a NoriScreen/DSI toggle, not just
  a signal) before any non-lab / in-home deployment.**
- [x] **[refined 2026-07-01 ×2 — reconciled with the laptop's implemented Part B and BUILT]**
  Call-state sync wire (matches `NoriLeLab/todos.md` §B, which shipped first):
  - **Operator → robot:** `{type:"call", state:"join"|"leave", mic_muted}` rides the **existing
    control data channel** (laptop B3) — but the **media bridge intercepts it**
    (`webrtc_robot.py _dc_message`) and it is **never forwarded to the daemon**. The bridge owns
    the mic; the daemon stays audio-free; **no `nori-protocol` change, no `protocol_version`
    bump** (the strict version check would otherwise force a lockstep redeploy).
  - **Robot → operator:** the bridge **injects `robot_mic_live`** into the telemetry frames it
    already relays (~15 Hz) — the laptop's CallBar reads exactly that field off telemetry
    (`teleop.ts handleTelemetry`). The daemon never emits it; the bridge does.
  - **Authority model:** operator-mic state is operator-authoritative (local `track.enabled`);
    robot-mic state is robot-authoritative (`robot_mic_live` = capture configured ∧ session up ∧
    not muted). No consolidated echo — resolves the laptop B3 open question.
  - **Robot-mic mute** is renegotiation-free: a GStreamer `valve` in the mic branch
    (`micvalve drop=true` on a reserved `robot_mic_muted` call field); the m-line stays (R-X.1).
  - *(Pi-gated: gst runtime validation on hardware; logic + wire shapes verified off-Pi.)*

### 2.1a — 🔧 When the AEC hardware + integrated mic/speaker arrive (deferred TODOs)
Everything AEC-independent is **done + validated 2026-07-02** (mic uplink, sound-effects, voice
downlink, operator uplink reservation). The following are **blocked on the incoming hardware**
(HW-AEC device + integrated mic/speaker, ~few days out) and should be picked up the day it lands.
Do them in this order:

- [ ] **(4) Re-run `setup_audio.sh` for the integrated device.** New mic/speaker → new ALSA
  names; the by-id `hw:CARD=<id>` pins will change. Confirm `NORI_MIC`/`NORI_SPEAKER`, mic level,
  and speaker tone. Note the HW-AEC device may expose a single combined capture/playback node.
- [ ] **(4) AEC bring-up + open-air two-way.** Preferred: the **USB hardware-AEC** device does
  the cancellation; fallback: software AEC (PipeWire `module-echo-cancel` / WebRTC APM). Then
  **remove the robot headphones** and confirm `--voice` two-way with **no echo/howl** while the
  mic uplink is live. (This is acceptance §2.2 M3b + risk D.)
- [ ] **(2→validate) Measure one-way latency < 300 ms** on the real acoustic path using the
  latency harness (built now, hardware-independent scaffold — see §P/tools). Target < 150 ms good,
  > 400 ms disruptive (R-X.2).
- [ ] **(6) Finalize playback mixing (R-X.4)** on the shipping audio stack so **sound-effects can
  play *during* a voice call** (today `alsasink` holds the speaker exclusively → chimes muted
  mid-call). If AEC lands on **PipeWire**, mixing comes with it; otherwise a shared ALSA `dmix`
  device or a single GStreamer `audiomixer` owner. **Decide together with the AEC path** (both
  touch the playback stack — avoid solving mixing twice).
- [ ] **(later, needs arms/daemon online)** Re-validate two-way audio coexisting with the 50 Hz
  loop and **hub power under load** (R16 / R-X.6 — the M2-bringup brownout class).

> ✅ **Done 2026-07-02 (hardware-independent):** robot-local mute interface (§2.1-F — SIGUSR1 +
> `NORI_MUTE_GPIO` button) and the operator-side latency harness (R-X.2 — `?audiolatency` logs the
> network + jitter-buffer breakdown; the acoustic-loopback half is the hardware-day step above).

### 2.2 M3 acceptance criteria *(hardware-gated)*
- [ ] (M3a) Operator hears the room; sound-effects fire on safety events.
- [ ] (M3b) Operator speaks through the robot with **no echo/howl** (AEC works).
- [ ] Simultaneous voice + effect plays cleanly (mixing works).
- [ ] Mute + live indicators behave; nothing persisted to SD.
- [ ] Robot mic is **muted by default**, broadcasting only after a **local** unmute (robot-side consent interface, §2.1-F). *(Currently unmuted-by-default — security TODO before any non-lab use.)*
- [ ] Two-way audio coexists with `loop_hz ≈ 50` and does not brown out the hub (R16, R-X.6).
- [ ] **Conversational one-way audio latency measured and within target** (R-X.2 — target < 300 ms, good < 150 ms).

---

## 3. Milestone M4 — LVGL native face + Python cleanup (RAM-driven) ⭐

**Goal:** replace the always-on Chromium face with a native **LVGL** face (the RAM win), and delete the legacy Python. **Timing is RAM-driven** — measure Chromium's real peak first; do the swap when the budget demands it, not preemptively. The 50 Hz path is untouched.

### 3.1 Components & tasks

**A. Measure before migrating**
- [ ] Measure real Chromium-face peak RAM alongside the daemon + camera(s) + M3 audio streaming (R1). This gates the migration timing.

**B. Delete legacy Python**
- [ ] Delete the `rpi4/` directory (legacy Python teleop + camera server). The behavioral-spec reference (`teleop_server.py`) + the prototype README were preserved in `rpi5/reference/` (2026-07-01); the rest is dead. Confirm nothing in deploy/service calls them.
- [ ] **Media bridge stays Python** — record as a sanctioned exception (own process, off RT loop).

**C. LVGL always-on face**
- [ ] Bring up **LVGL on DRM/KMS** (`/dev/fb0` fallback), bypassing X11/Wayland. Port the NoriScreen idle face (blink/breathe/gaze).
- [ ] **Display-yield hook (make room for M6 now):** the face process must cleanly **release DRM master / the DSI** on request and reacquire it afterward, so the M6 on-demand call view can take the screen and hand it back. Build this hook even though M6 is deferred.
- [ ] **R2 process split:** LVGL UI in a **separate process** from the safety loop; shared-memory lock-free queue; only the safety process gets `OOMScoreAdjust=-1000`.
- [ ] **No video in LVGL** — the face is graphics only. Live video is M6's on-demand Chromium.

### 3.2 M4 acceptance criteria
- [ ] Only `onboard_wifi_setup.py` Python remains in the RT/deploy path (media bridge Python is the sanctioned exception). *(Verifiable by inspection now.)*
- [ ] LVGL face renders on the DSI at ~60 fps; UI RAM (toolkit) < 20 MB. *(Hardware.)*
- [ ] Face process **yields and reacquires** the display cleanly on request (proves the M6 handoff). *(Partly testable with any second DRM client.)*
- [ ] Killing the UI process does **not** disturb the 50 Hz loop (R2 holds). *(Testable off-hardware.)*

---

## 4. Milestone M5 — Productionization / shipping

**Goal:** a consumer unit. Original `onboard_pi_plan.md` "M4" content, renumbered.

### 4.1 Components & tasks
- [ ] **§c Headless WiFi onboarding** — captive-portal wizard (`onboard_wifi_setup.py`); surface the assigned IP for manual entry (R6).
- [ ] **§d Signed A/B OTA** — RAUC/Mender; confirm 2× rootfs + staging fits the flash (R4).
- [ ] **R3 ATECC608B identity** — per-unit secure element; pin the part before factory imaging.
- [ ] **§a Factory imaging + R12 per-unit provisioning** — calibration + identity + room/token at manufacture (replaces manual scp / software-key).
- [ ] **Auth hardening** — Supabase-minted short-lived scoped tokens + per-operator identity (replaces the M1 shared-secret `NORI_ROOM_TOKEN`); auto-minted TURN creds.
- [ ] **AEC ship-part decision (from M3-D):** confirm whether the shipping speaker+mic keeps the USB hardware-AEC part or moves to an integrated module (→ software AEC) — this belongs to factory hardware (R-X.3).

### 4.2 M5 acceptance criteria
- [ ] Unbox → phone WiFi onboarding → paired, zero terminal.
- [ ] Signed OTA updates and rolls back cleanly on a bad image.
- [ ] Each unit boots with its own identity + calibration from the factory image.
- [ ] Expired/unauthorized tokens refused; no static shared secret in the field.

---

## 5. Milestone M6 — Full telepresence video (DEFERRED)

**Goal:** the operator's camera appears on the robot's screen — the last piece of the Zoom-like session. **Deliberately deferred**; slots in after M4/M5 without reworking earlier milestones *because* M3/M4 reserved space for it.

**Rendering decision:** an **on-demand Chromium call view**, not LVGL video. When a call starts, the LVGL face **yields the DSI** (M4-C hook) → Chromium renders the operator video full-screen → on call end, Chromium is torn down and the face reacquires the screen. Transient ~150 MB is acceptable because it's not always-on.

### 5.1 Components & tasks
- [ ] Operator page/LeLab captures camera → H.264 (or VP8) **send** track — added as part of the call's **fixed session track set at establishment** (upgrading an audio-only call to video = tear down + re-establish, never mid-call renegotiation; R-X.1).
- [ ] On-demand Chromium launcher wired to the M4 display-yield hook; renders the incoming video track; clean teardown returns the screen to the face.
- [ ] Operator-feed-live on-screen indicator + consent (fields reserved in M3-F) go fully live.
- [ ] Keep operator→robot video **low-res** (≤480p — a 7" DSI needs no more; keeps SW decode cheap; R-X.7).

### 5.2 M6 acceptance criteria
- [ ] Operator camera renders on the robot screen at usable latency/fps during a call.
- [ ] Face ↔ call-view display handoff is clean both ways; no stuck black screen.
- [ ] Transient RAM during a call stays within the 2 GB budget with everything else streaming.

> **Fallback (only if on-demand Chromium's transient RAM proves unacceptable):** the harder LVGL + GStreamer + DRM/KMS **overlay-plane** path (software-decode → dmabuf → overlay plane, LVGL chrome on a second alpha plane). This is the DRM-master-contention path we are avoiding — treat as last resort and spike before adopting (R-X.5).

---

## 5.5. Robot-side feature — Z-lift closed-loop height (encoder) 🟡 *(target: by end of M6; not ultra-high priority)*

**Goal:** give each lift **absolute height feedback** so the SDK can command a target *height* (closed-loop position), not just the velocity jog it has today. This is what lets the laptop's 3D pose view (NoriLeLab C6) place the arms at the right Z, and lets policies/records carry a real lift coordinate.

**Why it isn't free today:** the lift is Feetech **ID 7** on each bus (`left_lift`/`right_lift`, `registers.hpp:70,80`), run in **velocity mode** (`Operating_Mode=1`, continuous rotation — `bus_controller.cpp`, `lift_jog_to_raw`). The servo's `Present_Position` (reg 56) is **single-turn (0–4096, wraps)**, so across a multi-revolution lead-screw travel the absolute height is lost. It's declared `RANGE_M100_100` in the motor table but never tracked as a position.

**Chosen approach — B, revised 2026-07-02: STALL-BASED homing + software multi-turn** (originally a homing switch; the HW team confirmed there is **no endstop and none is planned** — the rails are bounded by the physical frame, so homing drives gently into the frame end and stall-detects, like `calibrate.cpp`'s drive-to-stall. Picked over pure-software multi-turn, which loses its zero on every restart, and over an external I²C absolute encoder, which is far more hardware/firmware):

- **Software multi-turn tracker (daemon):** read ID 7 `Present_Position` each 50 Hz tick, detect 4096↔0 wraps, accumulate a multi-turn count → convert to height via the lead-screw pitch.
- **Stall homing:** on demand (bring-up / after a desync), drive toward the frame end at a LOW velocity + torque, detect the stall (velocity+current pattern per `calibrate.cpp`), back off slightly, and **zero the multi-turn count** (`LiftAxis::zero_here()`). This makes the height absolute and repeatable across power cycles. The screw is **self-locking (HW-confirmed)**, so the count also survives torque-off idle between homings.
- **Closed-loop command:** with height known, run a **P-loop on height error → `Goal_Velocity`** (mirrors the arm P-control), clamped to travel limits, feeding the existing lift velocity path. The SDK gains a `left_lift.pos` / `right_lift.pos` **target** alongside today's velocity jog.

> ⚠️ **This is a STALE COPY.** The canonical §5.5 lives in `NoriTeleop/docs/m3_m5_implementation_plan.md`; the lift facts below were corrected there on 2026-07-07 (scale) and 2026-07-14 (direction). Kept in sync only for the two constants LeLab actually consumes.

**Mechanical constants (HW team 2026-07-02; CORRECTED on-unit 2026-07-03):** the HW-quoted 28.455 mm per "motor revolution" is on a shaft ~4.06× faster than the servo's **encoded output**, so the value the tracker needs is **≈115.6 mm per encoder rev**, NOT 28.455 (`NORI_LIFT_MM_PER_REV`; the old default under-read heights ~4×). Full travel **950 mm (tall variant) / 650 mm (short variant)** ≈ 33.4 / 22.8 motor revs — set `NORI_LIFT_TRAVEL_MM` per unit (deploy env; enables soft limits + the R-X.10 sanity check). **Direction (2026-07-14):** a per-unit **calibration bit** (`drive_mode` on the lift's `robot.json` entry, set by `manual_calibrate.py <side> --lift`) — NOT the old `NORI_LIFT_SIGN`, which is retired because it flipped only the reported height and never the jog. Still open (need a unit): **max safe velocity** (default stays a conservative 4000 raw ≈ 28 mm/s).

### 5.5.1 Components & tasks
- [x] **Multi-turn tracker** in the daemon *(2026-07-02: `lift.hpp`/`lift.cpp` `LiftAxis` + per-tick `read_lift_ticks()` in `main.cpp`; wrap detection, dropped-read desync tripwire (R-X.10), travel sanity check. `NORI_LIFT_MM_PER_REV` defaults to **115.6** (the 28.455 "motor-rev" figure was the wrong shaft); direction is per-unit calibration as of 2026-07-14)*.
- [ ] **Stall-based homing routine** (was "homing switch" — **no endstop exists or is planned**; rails are frame-bounded): drive toward the frame end at low velocity/torque, stall-detect (reuse the `calibrate.cpp` velocity+current pattern), back off, `LiftAxis::zero_here()`. Run at bring-up and to recover a desync. *(Until built: zero = pose at first read, per power cycle, `homed()` stays false. Self-locking screw (HW-confirmed) means the count holds across torque-off idle.)*
- [ ] **Lift obstruction stop** (from the HW guidance "when hitting something it should stop"): extend stall detection to the lifts during normal motion — a lift that stops advancing at high current should zero its velocity command (and drop any height target), not grind against the frame or an obstacle. *(Not built; the arm StallDetector only watches position-mode arm joints today.)*
- [x] **Height P-controller** *(2026-07-02: height error → clamped `Goal_Velocity` into the existing lift velocity path; target held across ticks like the arm targets; cleared — not paused — on E-STOP/safe-hold; nonzero lift jog overrides; soft travel limits when `NORI_LIFT_TRAVEL_MM` is set. Selftest + mock-daemon E2E pass; gains untested on hardware)*.
- [x] **Protocol (`nori-protocol`)** *(2026-07-02: `left_lift.pos`/`right_lift.pos` in telemetry `state` (omitted while the tracker is invalid) + accepted as `action` height targets. **Resolved: NO version bump** — the v1 schemas' `<motor>.pos` patternProperties already admit the keys, so per design principle 3 this is additive; new golden fixtures `control_lift_target.json` / `telemetry_lift.json` validate against v1 unchanged)*.
- [x] **Laptop (NoriLeLab) — live readout** *(2026-07-02: "Rail height" card on the remote teleop page — `RailHeight` in `TeleopStatus.tsx`, center-zero bar + signed mm per rail at telemetry rate; renders "unknown" when the Pi omits the key. `teleop.ts` passes `state` through unchanged.)* Remaining: the **C6 3D viz** consumes the same keys for the Z offset *(track in `NoriLeLab/todos.md` C6)*.

### 5.5.2 Acceptance criteria
- [ ] After homing, a commanded lift height is reached within tolerance and is **repeatable across power cycles**.
- [ ] Height is reported in telemetry `state`; the laptop 3D pose view reflects the real lift. *(2026-07-02: telemetry keys + a live 2D "Rail height" readout are done and mock-verified; open = real-hardware check and the C6 3D view.)*
- [ ] The multi-turn count survives a **full-travel sweep** with no lost sync (no missed wraps at 50 Hz — see R-X.10).

### 5.5.3 Notes / gating
- **Hardware-gated** — needs a unit (no endstop hardware required anymore — homing is stall-based against the frame); batch validation with the other hardware-gated work. On-unit checklist: **lift direction — `manual_calibrate.py <side> --lift`, both sides, EVERY unit** (an uncalibrated rail is disabled); max safe velocity (`NORI_LIFT_MAX_VEL`), stall-homing thresholds, P gain feel.
- **Exception to §1's "C++ core unchanged by M3–M6"** — this is the one robot-side feature that edits the RT core in this window. Keep it isolated (lift state/homing/P-loop), off the arm/base paths.
- **Related state-exposure work (from the C6 discussion, 2026-07-02):** the laptop's arm/gripper-tip FK wants **physical joint angles**, but telemetry `state` is lerobot-normalized `[-100,100]`, not degrees. The Pi should expose degrees (it owns the calibration + kinematic convention) via a reserved **`use_degrees`** telemetry variant / parallel `state_deg` field (`nori_protocol_schema.md:25` already reserves the profile), leaving `state` untouched. Same "enrich robot-side state feedback" theme as this z-lift task; spec separately if/when C6 FK is scheduled.

---

## 5.6. Robot-side feature — L2 leader-arm teleop (daemon-native) 🟢 *(landed 2026-07-02; hardware validation pending)*

**What landed:** passive dual-SO101 leader arms drive the followers through `nori_agent serve`. New additive `control.leader_action_deg` field (absolute SO101 degrees, grippers 0–100; converted to normalized units **on the Pi** via the follower calibration — clients never learn it), `hello.input_mode: "leader"`, jog arm-presence flags (a base/lift-only jog no longer touches the arms), and the operator toolchain under `examples/xlerobot/` (ID setup → configure → calibrate → `leader_teleop_client.py`). No `protocol_version` bump — additive per design principle 3; schemas + golden fixtures updated (`control_leader_deg.json`, `hello_leader.json`).

**Daemon-side slew guard (added 2026-07-02, closing the connect-lurch gap):** `leader_action_deg` targets are absolute, so a leader/follower pose mismatch at connect (or a mid-session yank / WAN burst) would otherwise slam the followers. The daemon now clamps each applied leader target to `NORI_LEADER_SLEW` normalized units/s (default 200; 0 disables) away from the last applied value, seeded from the follower's observed pose on the first leader frame — a jump becomes a bounded ramp; normal 1:1 puppeteering stays under the cap and feels direct. Client-side `--hold` / `NORI_LEADER_SLEW_DEG_PER_SEC` remain as optional extra smoothing, but the safety floor is server-side like every other lurch guard. Only the **newest** leader frame per tick is applied (matches jog's latest-only rule).

### 5.6.1 ⚠️ Flags pending hardware validation
- [ ] **Degree-zero convention (potential issue):** `normalize_leader_degrees` maps leader 0° → encoder center tick 2047 and assumes every follower joint's calibrated range is centered there via homing offset. If any joint's calibrated center is off-center, leader zero ≠ follower neutral on that joint (skewed held pose). **Validate on hardware before trusting; owner: Alexander.**
- [ ] **Whole leader chain is hardware-unvalidated** (ID setup, calibration wizard, inversion flags, 50 Hz read rate on the shared leader bus, slew-cap feel). Tune `NORI_LEADER_SLEW` on hardware — 200 units/s is a bench guess.

### 5.6.2 Decision — `leader_action_deg` **and** `action`/`use_degrees` both stay (2026-07-02)
Exposing both vocabularies is deliberate, not drift: `action` = normalized lerobot dict (dataset/policy-native), `leader_action_deg` = physical degrees for clients that shouldn't know the follower calibration, and the reserved `use_degrees`/`state_deg` is the **output** twin for FK (C6). SDK flexibility is worth the surface area. Guardrails so it stays cheap: (1) **one degree convention** — any future degrees-on-the-wire feature must reuse `normalize_leader_degrees`'s center-2047 convention (single conversion site in `calibration.cpp`), never a second mapping; (2) **precedence is defined**: `leader_action_deg` is applied after `action` in the same frame, so leader wins on shared keys (documented in the schema); (3) both stay additive — no version bumps.

### 5.6.3 Future work — WAN + SDK integration (not scheduled)
- [ ] **WAN:** the daemon needs nothing (same NDJSON over any transport) and NoriLeLab already tunnels control frames over the WebRTC data channel with WAN watchdog profiles. The work is getting leader **serial reads** to the operator app: (a) pragmatic — run `l2_leader_common`'s reader as a small localhost helper the frontend consumes, frontend adds `leader_action_deg` to its frames + `input_mode:"leader"` (~2–4 days); or (b) native — port the Feetech packet protocol to WebSerial/TS + an in-app calibration import/wizard (~1–2 weeks, wizard is the bulk). Server-side slew guard is a **prerequisite for leader-over-WAN** (done).
- [ ] **SDK / lerobot:** the calibration already writes to the lerobot teleoperator cache (`nori_l2_dual_leader`), so the shape is a thin lerobot `Teleoperator` wrapper around `DualLeaderReader` paired with the planned `XLerobot2Wheels` network Robot class → LeLab teleop/record flows work unchanged, datasets stay lerobot-native (daemon normalizes before telemetry). ~2–5 days once `XLerobot2Wheels` exists — that Robot class (full_nori_plan) is the actual long pole, shared with §5.5's lift-data consumers.

---

## P. Parallel track — Laptop GUI + LeLab app (hardware-free, runs throughout)

Not a milestone: independent of the Pi and the **only** fully-validatable-without-hardware work. Start here now.

- [ ] **Teleop GUI overhaul** — operator/VR control surface (`webrtc_operator.html` + LeLab `/nori/remote`, `/nori/vr`): clearer connection/telemetry state (link mode, `loop_hz`, watchdog level, stalled joints), grip-force/current readout, keybind discoverability, cylindrical/per-motor toggle UX. *(2026-07-02: live "Rail height" card added to `/nori/remote` — §5.5 lift telemetry, per-rail mm readout.)*
- [ ] **Call UI (audio-first)** — operator mic capture + mute + "on air" indicators now (M3); camera capture + self-view built but **gated** behind the M6 flag.
- [ ] **LeLab app improvements** — per `full_nori_plan.md` (account/pairing/marketplace polish, teleop UX), additive under `frontend/src/nori/`.
- [ ] All testable against the mock daemon / WebRTC loopback, no robot.

---

## 6. Open decisions to pin
- [ ] **AEC hardware (M3-D / M5)** — resolve with HW engineers. Questions: (1) integrated vs discrete speaker+mic; (2) on-chip AEC / full-duplex? (part# + datasheet); (3) USB Audio Class compliant?; (4) **dev part == ship part?** (integrated module likely → software AEC); (5) acoustic coupling/separation; (6) DSP added latency; (7) if discrete, is the playback reference available to the mic path?; (8) power/bandwidth on the shared hub (R16). **#4 gates the software stack — pin first.**
- [x] **webrtcbin stays Python** (resolved 2026-07-01) — media bridge is a sanctioned Python exception (own process, off the RT loop); no C++ port.
- [x] **Video rendering = on-demand Chromium, not LVGL** (resolved 2026-07-01). DRM-overlay LVGL video is fallback-only.
- [x] **Call/mute/live signaling location** (resolved 2026-07-01) — the **media-bridge message layer**, *not* `nori-protocol`; no daemon `protocol_version` bump (daemon never sees audio). Sound-effects consume existing `telemetry.status` transitions — also no protocol change.
- [ ] **Session track-set policy** — confirm the "fixed track set per session; upgrade = re-establish" rule is enforced in `webrtc_robot.py` + operator client (R-X.1). *(M3a keeps audio SENDONLY; M3b makes it SENDRECV from session start.)*
- [x] **Z-lift mechanical constants (§5.5)** — **answered by the HW team 2026-07-02:** 28.455 mm/rev (lead screw, direct drive, both lifts); travel 950 mm tall / 650 mm short (per-unit `NORI_LIFT_TRAVEL_MM`); **no homing endstop, ever** (frame-bounded → stall-based homing, and "hitting something should stop" → lift obstruction-stop task in §5.5.1); lead screw self-locking when unpowered (multi-turn count valid across torque-off idle). Still open, need a unit: max safe velocity + direction sign (both env-tunable, conservative defaults in place).

---

## 7. Risks & feasibility register

Severity: 🔴 dig in before scheduling · 🟠 plan around it · 🟡 note/measure.

| ID | Sev | Risk | Mitigation / what to look into |
|---|---|---|---|
| **R-X.1** | 🔴 | **Bidirectional WebRTC = renegotiation, and `webrtcbin` is documented-fragile there.** Current code is robot-**offerer**, video transceiver forced **`SENDONLY`** (`webrtc_robot.py:201`), `webrtcbin` is "single-shot," "deadlocks if set to NULL mid-connection," "occasional segfault on re-run" (`media/README.md`). | **Negotiate all tracks up front** (recvonly placeholders, muted); a call's track set is **fixed at establishment**; "add video / unmute" = track-enable or session re-establish (the supervisor already relaunches per session) — **never** live renegotiation. Enforce in robot + operator clients. |
| **R-X.2** | 🔴 | **Conversational audio latency.** One-way mouth-to-ear stacks: capture + Opus encode + WAN RTT/2 + jitter buffer + Opus decode + AEC DSP + ALSA/USB playback. Too high → unnatural talk-over. | **Target: one-way < 300 ms (good < 150 ms; > 400 ms disruptive).** Separate metric from the control watchdog (300/1000 ms). **Partly built (2026-07-02):** operator-side `getStats` harness (`audioLatency.ts`, `?audiolatency`) logs the **network RTT/2 + jitter-buffer** breakdown now. **Still needs the real path** for the acoustic half (timestamped loopback/clap test: operator speaks → time to robot speaker, and back) — a hardware-day step. Keep jitter buffers minimal. |
| **R-X.3** | 🟠 | **AEC dev-part vs ship-part fork.** A USB hardware-AEC puck de-risks dev but isn't a shippable form factor; an integrated speaker+mic module usually has **no** HW AEC → software AEC (PipeWire/WebRTC APM) returns, contradicting "ALSA-only." | Pin question #4 with HW (§6) **early**. If ship = integrated, budget software AEC now (extra CPU + PipeWire/PipeWire-less decision). |
| **R-X.4** | 🟠 | **Simultaneous playback needs mixing — CONFIRMED 2026-07-02.** Operator voice + sound-effects to one device at once; raw ALSA doesn't mix. Observed live: the `--voice` `alsasink` holds `NORI_SPEAKER` exclusively → the sound-effects `aplay` is blocked during a call (chimes silent mid-call). | Shared `dmix`/mixing PCM, PipeWire, or a single playback owner that mixes (e.g. GStreamer `audiomixer`). Resolve alongside AEC (M3b hardware). |
| **R-X.5** | 🟠 | **LVGL + live video on one DRM master** (only if the M6 Chromium fallback is ever needed). Two renderers, one DRM master; stock LVGL drm driver won't do multi-plane. | **Avoided by design** (M6 = on-demand Chromium). If forced to the overlay-plane path, spike it standalone first; verify the Pi 5 DSI KMS exposes a scalable overlay plane with alpha. |
| **R-X.6** | 🔴 | **Shared USB hub power/bandwidth (R16).** M3 adds USB audio to a hub already carrying 2× CH343 motor buses + camera(s); motor inrush browns out neighbors (the M2 fault). | Powered hub with headroom; verify per-port current under simultaneous motor+camera+audio load; keep deterministic `udev` naming; the undervoltage watchdog must surface a dropped bus, not silently stall. **Blocking for M3 hardware validation.** |
| **R-X.7** | 🔴 | **Aggregate CPU/thermal no longer proven.** M1 measured **encode-only** (26% of a core, loop 49.9). M3 adds 2× Opus (+ SW AEC?), M6 adds SW H.264 **decode** of the operator video (Pi 5 has **no H.264 HW decoder** — HEVC only, unusable over browser WebRTC), plus LVGL. 4 cores host OS/control-RT/bus/media. | **Re-run the `encoder_spike.sh` + `measure_loop_hz.py` harness with the full stack** before committing M3/M6 to hardware. Keep operator→robot video ≤480p. Re-check core pinning/allocation. |
| **R-X.8** | 🟡 | **Video crosses a process boundary** (only relevant if M6 ever uses the LVGL-overlay fallback, not on-demand Chromium). | N/A for the chosen path; on-demand Chromium owns its own decode+render in one process. |
| **R-X.9** | 🟡 | **"< 20 MB UI RAM" is the LVGL toolkit only** — call-time Chromium (M6) + decode buffers add transient RAM. | Report always-on (LVGL face) and peak-during-call (LVGL yielded + Chromium up) RAM separately in the R1 budget. |
| **R-X.10** | 🟡 | **Z-lift missed-wrap at 50 Hz (§5.5).** Software multi-turn tracking loses count if the lift's single-turn `Present_Position` moves > 2048 ticks (half a turn) between reads — the wrap direction becomes ambiguous and height desyncs silently. | Cap lift velocity so the per-tick delta stays well under half a turn at 50 Hz (direct drive confirmed 2026-07-02: default 4000 raw ≈ 80 ticks/tick — 25× margin); rely on bounded travel + stall homing to re-zero; sanity-check the count against travel limits each tick (needs per-unit `NORI_LIFT_TRAVEL_MM`); dropped-read desync tripwire implemented in `LiftAxis`. |

---

## 8. Sequencing & dependencies

```
        (parallel, hardware-free, start NOW)
  ┌─ P  Laptop GUI + LeLab + audio call UI ─────────────────────────────┐
  │                                                                      │
M2 ─> M3 two-way AUDIO ─> M4 LVGL face (RAM-driven) ─> M5 productionization ─> M6 telepresence VIDEO (deferred)
       M3a uplink+FX (early)        + display-yield hook                        on-demand Chromium call view
       M3b downlink+AEC (gated)     + delete rpi4 Python                        (uses M4's yield hook)
```

- **M3a** ships first (no AEC dependency). **M3b** waits on the AEC hardware answer.
- **M4** timing is **RAM-driven** — Chromium stays until measured peak forces the swap; but build the **display-yield hook** regardless (it's what M6 needs).
- **M6** is deferred but *unblocked-by-design*: M3 reserves the protocol/session fields, M4 provides the display handoff. Adding it is additive.
- **M5** functionally depends on nothing in M3/M4 but shouldn't ship before them.
- **§5.5 Z-lift closed-loop height** is an independent robot-side feature (not on the audio/face/video path); **target by end of M6**, lower priority. Hardware-gated on the endstop, and its `nori-protocol` bump should be batched with any other daemon-contract change. Slot its (mostly off-hardware) daemon logic — multi-turn tracker + P-loop against the mock bus — into the stub-coding phase; defer homing/endstop validation to the hardware session.

**Recommended order (no hardware):** (1) drive **P** to a better teleop + audio-call GUI; (2) write **M3a/M3b/E/F** and the reserved protocol fields against stubs; (3) build **M4-B** (delete rpi4) + the **LVGL face + display-yield hook**; (4) batch hardware-gated validation (M3 acoustics/AEC, M4 DSI/RAM, R-X.6/R-X.7 budgets) for the session the unit returns; (5) M5, then M6 when the video feature is scheduled.
