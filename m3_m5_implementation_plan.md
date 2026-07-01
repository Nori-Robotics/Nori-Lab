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
| **C++ real-time core** | `rpi5/nori_core_agent/` | 50 Hz loop + safety. Unchanged by M3–M6. |
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
- [ ] Add an Opus **send** audio track to the robot's `webrtcbin`. **Negotiate it at connect** as part of the fixed session track set — do **not** add it mid-call (see R-X.1).
- [ ] Laptop plays it (WebRTC audio sink in the operator page / LeLab).
- [ ] Small jitter buffer; verify continuity (not latest-only).

**B. (M3a) Safety/status sound-effects**
- [ ] Short pre-rendered clips; play on safe-hold / E-STOP / stall latch (improves R13 feedback). **[refined 2026-07-01]** No new daemon hook or protocol field needed — a small robot-side consumer watches the existing `telemetry.status.safety` transitions (`ok`→`safe_hold`/`latched`) and plays the matching clip (ALSA). Keeps the RT daemon untouched.
- [ ] Testable off-hardware by feeding synthetic telemetry transitions (playback itself is hardware-gated).

**C. (M3b) Operator voice → robot speaker (downlink)**
- [ ] Operator page/LeLab captures mic → Opus **send** track; robot receives → `opusdec` → ALSA playback.
- [ ] **Reserve this recvonly m-line at connect even if muted** so enabling it is a track-mute flip, not a renegotiation (R-X.1).

**D. (M3b) AEC — mandatory for two-way audio**
- [ ] Resolve the hardware question with the HW engineers (§6 has the exact questions). Preferred: a USB device with **hardware AEC**; fallback: software AEC (PipeWire `module-echo-cancel` / WebRTC APM), which reopens the "ALSA-only" stance.
- [ ] **Validation is hardware-gated** — needs the real acoustic path.

**E. Simultaneous-playback mixing**
- [ ] Operator voice **and** sound-effects can play at once → one device, two playback streams → needs `dmix` or a single mixing owner (R-X.4).

**F. Privacy (R15, bidirectional-ready)**
- [ ] Robot mic: mute control + "mic live" indicator; opt-in; no audio persisted.
- [ ] Reserve the operator-feed-live indicator + consent fields now (used fully in M6).
- [ ] **[refined 2026-07-01, during M3a impl]** mute/live/**call-state** signaling lives in the **media-bridge message layer** (alongside `ready`/`bye`), **not** `nori-protocol` — the daemon never sees audio, so **no `protocol_version` bump**. The daemon does a *strict* version-equality check (`protocol.hpp` `PROTOCOL_VERSION`), so putting call-state there would force a lockstep daemon+bridge+client redeploy for a message the daemon just ignores. Keep it out.

### 2.2 M3 acceptance criteria *(hardware-gated)*
- [ ] (M3a) Operator hears the room; sound-effects fire on safety events.
- [ ] (M3b) Operator speaks through the robot with **no echo/howl** (AEC works).
- [ ] Simultaneous voice + effect plays cleanly (mixing works).
- [ ] Mute + live indicators behave; nothing persisted to SD.
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

## P. Parallel track — Laptop GUI + LeLab app (hardware-free, runs throughout)

Not a milestone: independent of the Pi and the **only** fully-validatable-without-hardware work. Start here now.

- [ ] **Teleop GUI overhaul** — operator/VR control surface (`webrtc_operator.html` + LeLab `/nori/remote`, `/nori/vr`): clearer connection/telemetry state (link mode, `loop_hz`, watchdog level, stalled joints), grip-force/current readout, keybind discoverability, cylindrical/per-motor toggle UX.
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

---

## 7. Risks & feasibility register

Severity: 🔴 dig in before scheduling · 🟠 plan around it · 🟡 note/measure.

| ID | Sev | Risk | Mitigation / what to look into |
|---|---|---|---|
| **R-X.1** | 🔴 | **Bidirectional WebRTC = renegotiation, and `webrtcbin` is documented-fragile there.** Current code is robot-**offerer**, video transceiver forced **`SENDONLY`** (`webrtc_robot.py:201`), `webrtcbin` is "single-shot," "deadlocks if set to NULL mid-connection," "occasional segfault on re-run" (`media/README.md`). | **Negotiate all tracks up front** (recvonly placeholders, muted); a call's track set is **fixed at establishment**; "add video / unmute" = track-enable or session re-establish (the supervisor already relaunches per session) — **never** live renegotiation. Enforce in robot + operator clients. |
| **R-X.2** | 🔴 | **Conversational audio latency.** One-way mouth-to-ear stacks: capture + Opus encode + WAN RTT/2 + jitter buffer + Opus decode + AEC DSP + ALSA/USB playback. Too high → unnatural talk-over. | **Target: one-way < 300 ms (good < 150 ms; > 400 ms disruptive).** Separate metric from the control watchdog (300/1000 ms). **Measure on the real path** (timestamped loopback or clap test: operator speaks → time to robot speaker, and back). Log per-hop where possible; keep jitter buffers minimal. |
| **R-X.3** | 🟠 | **AEC dev-part vs ship-part fork.** A USB hardware-AEC puck de-risks dev but isn't a shippable form factor; an integrated speaker+mic module usually has **no** HW AEC → software AEC (PipeWire/WebRTC APM) returns, contradicting "ALSA-only." | Pin question #4 with HW (§6) **early**. If ship = integrated, budget software AEC now (extra CPU + PipeWire/PipeWire-less decision). |
| **R-X.4** | 🟠 | **Simultaneous playback needs mixing.** Operator voice + sound-effects to one device at once; raw ALSA doesn't mix. | `dmix`, or a single process that owns playback and mixes. Decide before M3b. |
| **R-X.5** | 🟠 | **LVGL + live video on one DRM master** (only if the M6 Chromium fallback is ever needed). Two renderers, one DRM master; stock LVGL drm driver won't do multi-plane. | **Avoided by design** (M6 = on-demand Chromium). If forced to the overlay-plane path, spike it standalone first; verify the Pi 5 DSI KMS exposes a scalable overlay plane with alpha. |
| **R-X.6** | 🔴 | **Shared USB hub power/bandwidth (R16).** M3 adds USB audio to a hub already carrying 2× CH343 motor buses + camera(s); motor inrush browns out neighbors (the M2 fault). | Powered hub with headroom; verify per-port current under simultaneous motor+camera+audio load; keep deterministic `udev` naming; the undervoltage watchdog must surface a dropped bus, not silently stall. **Blocking for M3 hardware validation.** |
| **R-X.7** | 🔴 | **Aggregate CPU/thermal no longer proven.** M1 measured **encode-only** (26% of a core, loop 49.9). M3 adds 2× Opus (+ SW AEC?), M6 adds SW H.264 **decode** of the operator video (Pi 5 has **no H.264 HW decoder** — HEVC only, unusable over browser WebRTC), plus LVGL. 4 cores host OS/control-RT/bus/media. | **Re-run the `encoder_spike.sh` + `measure_loop_hz.py` harness with the full stack** before committing M3/M6 to hardware. Keep operator→robot video ≤480p. Re-check core pinning/allocation. |
| **R-X.8** | 🟡 | **Video crosses a process boundary** (only relevant if M6 ever uses the LVGL-overlay fallback, not on-demand Chromium). | N/A for the chosen path; on-demand Chromium owns its own decode+render in one process. |
| **R-X.9** | 🟡 | **"< 20 MB UI RAM" is the LVGL toolkit only** — call-time Chromium (M6) + decode buffers add transient RAM. | Report always-on (LVGL face) and peak-during-call (LVGL yielded + Chromium up) RAM separately in the R1 budget. |

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

**Recommended order (no hardware):** (1) drive **P** to a better teleop + audio-call GUI; (2) write **M3a/M3b/E/F** and the reserved protocol fields against stubs; (3) build **M4-B** (delete rpi4) + the **LVGL face + display-yield hook**; (4) batch hardware-gated validation (M3 acoustics/AEC, M4 DSI/RAM, R-X.6/R-X.7 budgets) for the session the unit returns; (5) M5, then M6 when the video feature is scheduled.
