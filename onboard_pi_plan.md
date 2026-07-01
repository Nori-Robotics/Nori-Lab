# Item 2 — Pi Onboarding & Over-the-Air Updates

> **Scope note:** This document lives in the `NoriLeLab` (laptop app) repo **for context only**. The work it describes runs **on the robot (Raspberry Pi)**, not on the laptop. The laptop app's view of these changes — and the LAN contract it depends on — is in [`full_nori_plan.md`](full_nori_plan.md) (see the *Pi daemon LAN contract matrix*).

This phase replaces the prototype bash scripts and Python server architecture with a hardened, embedded-Linux deployment. The core objective is a deterministic, memory-safe execution environment (**< 100 MB baseline RAM**) that survives extended uptimes in consumer homes without GC pauses, memory leaks, or network-induced stutter.

---

## Versioning & Build Order

> **North star: remote WAN teleop — laptop *or* VR headset, with basic controls and a live video stream — is the first product target.** Everything below is sequenced to reach it fast and defer the rest. Autonomy ("fetches and tidies"), polished onboarding, signed OTA, and the native-UI migration come *after* a human can reliably drive the robot over the internet.

These milestones cut **across** the capability sections (§a–§g); they are a delivery order, distinct from the *UI-migration Phases* and the *README deployment Phases*. Numbering is rough and subject to resequencing.

| Milestone | Goal | Pulls in | Deferred / stubbed |
|---|---|---|---|
| **M0 — Daemon substrate** (internal) | The C++ safety/control core, driven from the laptop app over **LAN**. The unavoidable foundation — WAN teleop *is* this plus a network layer. | §b in full (Feetech C++ SDK bus control, 50 Hz loop, **all four motor-protection layers**, network + thermal watchdogs, E-STOP latch); §f JSON control + `protocol_version`; reuse the prototype's **LAN ZMQ video**. | WAN, WebRTC, VR, audio, OTA, onboarding, ATECC (software-key fallback). |
| **M1 — WAN remote teleop, laptop** ⭐ | **The headline target.** An operator anywhere on the internet drives with basic (keyboard / on-screen) controls and sees the live video. | §f WebRTC video (software-encode, ~24 fps) + Supabase **rendezvous/relay** + **TLS + scoped tokens** (R10); §e app "remote mode" as the single control client; WAN watchdog profile. | VR, audio, signed OTA, factory provisioning, native UI. |
| **M2 — VR headset teleop (over WAN)** ⭐ | The same remote session, driven from a Quest 3. | §e VR path: app WebXR → **`jog` mapper (laptop)**, clutch, re-clutch-on-resume, controller **E-STOP** (R13), haptics from current telemetry. **Daemon control path unchanged from M0.** | — (rides M1's session) |
| **M3 — Two-way *audio* presence** ⭐ | The operator hears *and* speaks into the room (a voice call through the robot); robot makes safety/status sounds. | §g two-way audio (robot mic → operator **and** operator voice → robot speaker) with **mandatory AEC**; safety sound-effects; R15 privacy (mute + live indicators, no persist). Additive audio tracks on the existing M1 WebRTC session. **Operator *video* deferred to M6.** | Operator video (M6), wake word, voice/LLM, audio-as-dataset-channel. |
| **M4 — LVGL native face + Python cleanup** ⭐ | Replace the always-on Chromium face; delete legacy Python. | LVGL idle face on DRM/KMS (the RAM win) in a **separate process** from the 50 Hz loop (R2), with a **display-yield hook** so an on-demand call view can borrow the screen; **retire `rpi4/` legacy**. **Timing is RAM-driven** (Chromium stays until its peak forces the swap). **Media bridge stays Python** (sanctioned exception, own process). | webrtcbin C++ port (not doing it); video in LVGL (never — M6 uses on-demand Chromium). |
| **M5 — Productionization / shipping** | Make it a consumer unit, not a dev rig. | §c headless WiFi onboarding; §d signed A/B OTA; **R3 ATECC608B** identity; §a factory imaging + **R12 per-unit provisioning**; AEC ship-part decision. | — |
| **M6 — Telepresence video (deferred)** | Operator's camera on the robot screen — completes the Zoom-like session. | Operator camera → robot DSI via an **on-demand Chromium call view** (launched only during a call, using M4's display-yield hook; torn down after). Additive WebRTC video track. | — (slots in later; M3/M4 reserve space for it) |
| **(parallel) Autonomy & IL** | Policy execution + dataset recording. | Separate Item; reuses the same daemon + recording stream (R5). | Out of this doc's teleop-first scope. |

**On "LAN baseline" vs "WAN first":** WAN teleop is architecturally LAN teleop **plus** a TLS/relay/WebRTC layer over the same control path. So LAN teleop (M0) is the substrate you pass *through* on the way to WAN (M1) — not a separate product milestone to dwell on. Where §e/§f call LAN the "always-working baseline," read that as *the fallback that keeps working*, not *the first thing we ship*.

**[SCOPE INCREASE 2026-06-30, revised 2026-07-01] Two-way presence — audio now, video deferred; UI stays Chromium then LVGL when RAM forces it.** After a feasibility pass, the scope is staged:
1. **M3 = two-way *audio*** (a voice call through the robot): operator→robot voice is pulled forward from §g's *deferred* list; robot→operator mic stays. This makes **AEC mandatory** (playback + capture live at once). **Operator *video* is deferred to M6.**
2. **UI: Chromium now, LVGL when RAM actually forces it** (the original RAM-driven plan — deadlines win; *not* "straight to LVGL"). M4 replaces only the **always-on idle face** with LVGL (the RAM win), in a separate process (R2), with a **display-yield hook**. The **media bridge stays Python** (own process, off the RT loop) — no webrtcbin C++ port.
3. **Video (M6) never renders in LVGL.** The always-on face is LVGL; the *transient* call video is rendered by an **on-demand Chromium** launched only during a call and torn down after — face and call are mutually exclusive in time, so it's a clean **display handoff**, not overlay-plane compositing. This deletes the hardest feasibility risk (LVGL + video on one DRM master).

Rationale under the current hardware gap: M3/M4 are heavily **hardware-gated** (speaker/mic/DSI/AEC acoustics) — design now, validate on a unit. The **laptop-side GUI/LeLab track runs in parallel throughout** (the only hardware-free work). Full feasibility register + the M3a/M3b split + conversational-latency target: see [`m3_m5_implementation_plan.md`](m3_m5_implementation_plan.md).

---

## a) Factory Pre-Imaging & OS Tuning

The Pi ships with the OS, host agent, per-unit identity, and configuration pre-installed.

- **Base image:** headless Pi OS Lite, aggressively stripped — remove Wayland, X11, and unneeded kernel modules. **Keep a minimal ALSA audio stack** — the robot has a speaker + mic (see §g), so audio is *not* stripped; skip PulseAudio/PipeWire until two-way voice/AEC needs them. **Idle RAM target < 100 MB** (daemon baseline) on the **2 GB Pi 5**.
- **Unattended boot:** replace the manual bash-script launch with supervised auto-start on boot via systemd units, so the robot comes up working with no human in the loop.
- **Service management:** the current `start_teleop.sh` wrapper is replaced with a strict systemd unit, `nori-core.service`, configured with:
  - `Restart=always`
  - `RestartSec=2`
  - `OOMScoreAdjust=-1000` — ensures the C++ core daemon outranks all other processes under memory pressure.

---

## b) Local Safety Watchdogs — the `NoriCoreAgent` C++ Engine

Completely deprecate the Python `StallDetector` and JSON-TCP loop in favor of a native **C++20 daemon**. This guarantees strict 50 Hz determinism, zero GIL contention, and true thread parallelism.

```
[Network Broker] ──(Lock-Free SPSC Queue)──► [Real-Time C++ Motor Engine]
       │                                              │
       ▼                                              ▼
 Arrival-time Watchdog (tiered)            Hardware Polling (Core 1/2)
```

### True threading & bus concurrency
Dedicated threads pinned to specific CPU cores via `pthread_setaffinity_np`. Bus 1 (`/dev/xlerobot_bus1`) and Bus 2 (`/dev/xlerobot_bus2`) are driven by the **C++ Feetech SDK** — one `PortHandler` per bus, each on its own pinned thread — so the two buses are polled **concurrently**. (The sequential I/O lag in rpi4 came from Python's single-threaded, GIL-bound loop, *not* from the SDK.) Using the C++ SDK — the same `PortHandler`/`PacketHandler`/`GroupSync` family the Python `scservo_sdk` wraps — keeps the motor layer close to upstream lerobot. **Raw `termios` is a fallback only** if the SDK can't expose a needed fd-level setting (low-latency ioctl / custom packet timeout — both patchable on the SDK's fd, as rpi4 did). Both CH343 boards are reached through the shared USB Type-A peripheral hub (see R16); deterministic `udev` naming must survive the hub topology.

### Servo monitoring (thermal / current)
Motor threads continuously read `Present_Current`, `Present_Position`, and thermal registers. If `Present_Current` spikes while `Present_Position` delta stays near zero (a physical obstruction), the C++ loop immediately sets an atomic `e_stop_latched` flag.

### Latching requirement
Unlike the prototype's stall-soften (which auto-recovers), this C++ state is a **hard latch**: it cuts `Torque_Limit` and drops current instructions. Recovery requires an **explicit user reset via the UI/app** — the obstruction may be a human.

### Port *all four* motor-protection layers — not just stall detection
The prototype's safety is four layers deep (documented in the `rpi4` README). The C++ rewrite re-hosts the bus layer on the **C++ Feetech SDK** and the loop in native C++20, so **every layer must be re-implemented / re-validated natively** — re-porting only the stall detector would be a safety regression on a robot that has already physically killed two motors.

1. **`Torque_Limit=600`** written to SRAM on init — caps peak current so the power station doesn't trip.
2. **Software stall detection** — the latching obstruction response above.
3. **Calibration position clamp** — the prototype clamps every `Goal_Position` to the per-unit calibrated `[range_min, range_max]` (was `motors_bus.py:_unnormalize`). This is the layer that makes it *impossible* to command a motor past its physical limit; it **must** be reimplemented in the bus worker, reading the same per-unit calibration JSON (see provisioning, R12).
4. **Firmware EEPROM backup** (set once via `fix_eeprom.py`): `Protection_Current=450`, `Over_Current_Protection_Time=150`, `Max_Temperature_Limit=70`, `Max_Torque_Limit=600`. These are motor-resident and survive the rewrite, but the daemon must never raise the temperature/time ceilings.

### Network monitoring & the tiered watchdog
The network ingestion thread parses incoming **JSON-line control frames** (see §f — the wire format stays JSON, not packed binary) and pushes the decoded command into a lock-free SPSC ring buffer. The single producer is guaranteed because the **laptop app is the only control client** (VR, keyboard, and on-screen inputs all fan in app-side; the Pi accepts exactly one connection — see §e). The motor thread consumes the freshest command each tick.

Critically, the watchdog keys on the **Pi-monotonic arrival time** of the last accepted frame, *not* on any timestamp embedded by the client. The client-supplied timestamp is used only for **ordering** (discard out-of-order frames) and **latency display** — never in the safety path — which removes any dependency on cross-machine clock sync (NTP).

#### Distinct safety responses — latching vs auto-recovering
The prototype conflated these; the daemon must not. Two responses **latch** (require a deliberate human reset); the rest are **auto-recovering degradations** that resume on their own once the condition clears.

| Trigger | Response | Recovery |
|---|---|---|
| **Network staleness** (frames stop / arrive late) | Graceful degrade to a *safe-hold* | **Automatic** — resume when fresh frames return |
| **Pi thermal / undervoltage** (SoC hot, or firmware throttle/undervoltage flag) | Tiered: shed load, then *safe-hold* | **Automatic** — resume on cooldown / power recovery |
| **Obstruction stall** (high `Present_Current` + ~zero `Present_Position` delta — possibly a human) | Hard latch: cut `Torque_Limit`, drop current | **Manual** reset via UI/app |
| **Explicit E-STOP** (operator / user / headset button) | Hard latch | **Manual** reset via UI/app |

Neither the network nor the thermal watchdog may **hard-latch** — a transient WiFi/WAN blip or a heat spike must never force the user to walk over and reset a robot. They degrade, hold safely, and auto-recover. Only physical obstruction and a deliberate E-STOP latch.

#### Tiered network watchdog (arms ≠ wheels)
Two thresholds, with the response differing by actuator because the failure modes differ:

- **T_warn** → begin a smooth **base deceleration to zero**; **arms hold** their last commanded position under torque (a held object stays held; the pose is preserved and is the natural resume point). UI/headset shows *"link degraded."*
- **T_stop** → base fully stopped, arms still holding → **safe-hold** state. Still auto-recoverable.
- **Fresh contiguous frames** → re-sync from the *actual* current position and ramp motion back in.

Wheels decelerate (a rolling base on stale commands is a collision risk); arms hold rather than go limp (limp drops the load and loses the pose).

#### Threshold profiles — LAN ≠ WAN
A flat 100 ms is unusable: WAN RTT alone is 40–160 ms with jitter, and even bad LAN WiFi spikes past 100 ms (the exact reason the legacy serial-timeout floor was raised to 500 ms). The app declares the link mode at handshake, and the daemon selects a profile:

| Mode | T_warn | T_stop |
|---|---|---|
| **LAN** | ~150 ms | ~500 ms |
| **WAN** | ~300 ms | ~1000 ms |

*Upgrade path (not v1):* make it adaptive — `T_warn = max(150 ms, 3×median_RTT)`, `T_stop = max(500 ms, 6×median_RTT)` — self-tuning with no magic numbers.

#### VR re-clutch on resume
After any safe-hold, **VR teleop requires the operator to re-engage the clutch** (re-squeeze) before motion resumes — otherwise the robot would snap to wherever the operator's hands drifted during the outage. Keyboard teleop resumes directly (it is incremental jog, no jump risk).

#### Pi thermal & power watchdog
A low-rate (~1 Hz) monitor — **off the 50 Hz hot path** — reads the SoC temperature (`/sys/class/thermal/thermal_zone0/temp`) and the firmware throttle/undervoltage bitmask (`vcgencmd get_throttled`). The motivation is control-quality, not just hardware protection: Pi firmware soft-throttles around 80 °C, and a throttled CPU can't guarantee the 50 Hz loop — so the daemon must react *before* the firmware does. Undervoltage (the README's documented USB-power failure mode) is watched on the same monitor.

Tiered, and **auto-recovering** (it belongs with network staleness, not the hard latch):

| Threshold | Response |
|---|---|
| **~70 °C, or undervoltage flag set** (warn) | Surface on telemetry + UI; shed non-critical heat/load — drop camera fps/JPEG quality, dim or pause the kiosk render. Motion continues. |
| **~80 °C (hot)** | Enter **safe-hold** (stop motion) before firmware throttle bites; daemon stays alive to report; auto-resume on cooldown. |

`pi_temp_c` and the throttle flags ship in the periodic (1 Hz) telemetry so the app and NoriScreen display them. Thresholds are Pi 5 starting points — tune against measured in-enclosure thermals.

---

## c) Headless WiFi Onboarding

This is the **only** end-user setup step.

- **Execution:** on first boot, if no known networks are found, a Python utility configures `hostapd` + `dnsmasq` to broadcast a `Nori-Setup-XXXX` access point. The user connects, loads a captive portal, submits home WiFi credentials. The Pi joins the LAN and advertises itself via mDNS (`xlerobot.local`).
- **Framework justification:** Python is used here deliberately — a run-once, exits-after task outside the real-time motor path, where library convenience (HTTP servers, NetworkManager DBus wrappers) outweighs C++ performance benefits.
- **Launch security:**
  - The pairing handshake requires **token authentication**.
  - The pipeline strictly forbids writing **video buffers** to the persistent cache (SD card) to prevent flash wear and privacy leaks. **Resolved in R5 (DECIDED): no persistent Pi-side video — recording frames stream to the laptop app, never the SD card.**
  - Local configs use `.json`; any persistent tensor logic uses `.safetensors` (no `pickle` → no arbitrary code execution).
  - Must be **opt-out** so developers can disable it via SSH.

---

## d) Secure OTA Updates

Field units need a robust, zero-downtime update path for the C++ agent, ML policies, and system dependencies.

- **A/B partitioning:** via a robust controller (RAUC or Mender). Two rootfs partitions; updates stream to the inactive one in the background. On reboot the bootloader flips to the new partition; if `nori-core.service` crashes on boot, it falls back to the previous working partition.
- **Cryptographic identity:** updates are signed and verified against the factory-flashed per-unit identity (in an **ATECC608B secure element** — see R3 resolution; **not** a shared image secret). This same hardware ID authenticates the robot to the Item 3 Supabase registry.
- **Per-unit provisioning caveat:** OTA streams the *same* rootfs image to every unit, but **calibration and identity are per-robot**. The A/B flow must treat these as unit-local state that survives partition swaps (not baked into the image). See R12.

---

## e) Teleoperation Architecture

Teleop is a first-class path the original plan omitted (it described only the autonomous "fetches and tidies" flow). The shipped robot must be drivable by a human — for development, demos, and data collection — over both LAN and WAN.

### The laptop app is the single control client
All operator input converges in the **laptop app**, which holds the *one* connection the Pi accepts. Keyboard, on-screen controls, and the optional VR headset are **input mappers on the laptop side** that feed one outgoing control stream. Consequences:

- The Pi-side contract never changes when VR is toggled on/off — VR is genuinely just a feature switch in the app.
- The daemon's network producer is single by construction (validates the SPSC queue choice in §b).
- The robot exposes exactly **one** authenticated control surface, whether the operator is on the LAN or across the internet.

### One canonical command set; keyboard and VR map onto it
Define the teleop command vocabulary **once**. Both keyboard and VR emit the *same* fields — VR must not grow a parallel code path.

- For v1, VR controller 3D poses map to **exactly the DOF the keyboard already exposes**, nothing more.
- VR adds one control concept now: a **clutch** ("squeeze to move") — release to reposition your hands without moving the robot, re-squeeze to re-engage.
- Workspace scaling, per-arm fine selection, and richer mappings come later behind the same command set.

### Where IK runs — keyboard and VR both emit `jog`; the daemon runs IK (decided 2026-06-24, option a)
- **Canonical path (keyboard + VR):** every input mapper emits the shared **`jog`** task-space command (6-DOF per arm — see `nori_protocol_schema.md`). The VR mapper, **on the laptop**, converts controller pose-deltas into `jog` rates exactly as rpi4 already does (its VR path is delta-based, not 1:1 absolute). The **C++ daemon runs IK + motion smoothing on `jog` regardless of source** — one control path, resampled onto the steady 50 Hz loop, holding the latest state and owning the calibration clamp.
- **Secondary path (kept):** laptop-side IK sending an absolute lerobot `action` dict — for fast IK iteration in Python and the direct-USB bring-up path.
- **Reserved (future, not built):** raw-controller-pose frames with daemon-side IK-from-poses — *only* if true absolute 1:1 hand-tracking is ever wanted. Rejected for now: it adds a second control path for fidelity rpi4 doesn't currently deliver, and contradicts the "same system for laptop and Quest" goal.

### VR connection model
Quest 3 connects to the **app's** WebXR endpoint on the operator's own machine (localhost is a secure context — no cert pain). The app relays into the single control stream. The Pi never terminates the headset connection. *(Quest-direct-to-Pi was rejected: it solves "no laptop," which is the **autonomy** requirement, not a teleop one, while taking on the worst TLS/NAT/load costs.)*

### LAN vs WAN operation
- **LAN (default on home WiFi):** the app discovers the robot via mDNS, connects directly, token auth. Lowest latency; ZMQ video. This is the always-working baseline.
- **WAN (explicit "remote" mode):** the connection is brokered through the **Supabase registry + relay** (see §f). TLS + per-robot authorization; WebRTC video. The *architecture is identical* to LAN — only the security/NAT layer changes.

### E-STOP and reset from inside the headset
A VR operator can't reach the phone or kiosk, so (extends R9 / R13):
- A **Quest controller button maps to E-STOP**, sent as a priority control message.
- **Reset** after a hard latch requires a deliberate gesture (e.g. hold-to-reset) and is gated on the operator seeing the scene via the live video feed before clearing.

### Haptic feedback
The telemetry stream already carries per-motor `Present_Current`, and on the gripper that is the **virtual tactile signal** (current ∝ contact force). Route that to **Quest controller rumble** on contact. This is a reason the telemetry keeps the current channels through any protocol revision.

### Headless (no-headset) feature parity
"As much as possible without a Quest" is a hard requirement, not a nicety. With no headset attached the app must offer:

- Live robot state + video view
- Teleop jog controls (keyboard is the v1 baseline; the frontend's existing rapier3d 3D scene is the natural home for a draggable end-effector target later)
- Record start/stop
- E-STOP + reset
- Grip-force readout

All of these map to control/telemetry that already exists — parity is mostly a UI commitment, not new protocol.

---

## f) Transport, Wire Protocol & WAN Rendezvous

### Control channel — JSON, versioned (not packed binary)
The control channel stays **JSON-line TCP** (the format the laptop clients already speak), with two additions:

- A **`protocol_version`** field asserted in the handshake (and ideally every frame). Both ends refuse mismatched versions **loudly** rather than decoding garbage — the non-negotiable safety tripwire.
- **Golden-fixture tests in both repos** (same canonical message → same decoded result) so any field change breaks CI before it ships.

Rationale: at ~50 Hz the control frames are a few hundred bytes — ~15 KB/s, trivial on any link — and JSON parse in C++ (e.g. simdjson) is ~1–2 µs against a 20 ms loop budget. The zero-copy win of packed structs is real but buys microseconds and kilobytes we don't need, while a silent field reorder/width drift across the C++/Python boundary would corrupt joint commands near a human. JSON keeps the wire human-debuggable (`tcpdump`) and the existing clients working unchanged. This **supersedes the original binary-struct R8 resolution** (see revised R8).

*Upgrade path (only if a measured trigger fires — serialize cost or bandwidth over a stated budget):* move to a codegen **IDL (Cap'n Proto / FlatBuffers)**, never hand-rolled structs, so there's a single source of truth and no hand-maintained drift. Not needed for launch.

### Video channel — ZMQ now (LAN), WebRTC soon (WAN)
- **LAN baseline (keep working):** ZMQ PUB/SUB, MJPEG → base64 JPEG, `CONFLATE=1` per camera (today's proven path; backpressure drops frames, not memory). ZMQ does **not** traverse NAT.
- **WAN (build as soon as possible):** **WebRTC @ ~24 fps.** Because ZMQ can't cross NAT, WAN video needs WebRTC from the first WAN release — it is *near-term, not "someday."* ⚠️ The **Pi 5 has no hardware video encoder** (unlike the Pi 4), so the stream is **software-encoded** on the CPU — pin the encoder to dedicated core(s) so it doesn't starve the 50 Hz loop, keep fps/resolution modest, and budget against R1 (see R11). **Opus audio (§g) rides the same WebRTC session** as a separate track.
- Control stays JSON for both modes; only the video/audio transport differs.
- **[2026-06-30, rev 2026-07-01] The WebRTC session gains a reverse audio path (M3), video-down reserved for M6.** In addition to robot→operator video + robot mic uplink, M3 adds **operator→robot audio** (their voice → robot speaker); **operator→robot video** (their camera → robot DSI) is **deferred to M6**. All are added tracks, not a new transport (inherit NAT traversal + DTLS/SRTP). **Reserve every m-line at connect** (recvonly, muted) so M6 needs no live renegotiation — `webrtcbin` is fragile on renegotiation/teardown (see §g note + `media/README.md`). Control still rides the data channel unchanged.

### WAN rendezvous & authorization — via the Item 3 Supabase registry
The Pi sits behind home NAT; a remote operator can't reach it directly. WAN mode routes through Supabase:

1. **Identity:** the robot authenticates to Supabase with its per-unit hardware identity (R3 / ATECC608B), the same ID used to verify OTA updates.
2. **Authorization:** Supabase records which operator accounts may control which robots and issues a **short-lived, scoped session token** for a specific robot.
3. **Rendezvous / NAT traversal:** the registry brokers the connection — either a managed **relay (TURN-style)** carrying both the JSON control channel and the WebRTC media, or by handing both ends a **WireGuard/Tailscale peer** for a direct encrypted tunnel. WebRTC video and the control channel **share this one signaling/relay path** rather than each inventing its own.
4. **Transport security:** all WAN control traffic is TLS; LAN stays token-only with mDNS discovery.

> The detailed WAN/Supabase sequence (account → authz → token → relay → connect) is a sub-plan to expand during implementation; the four points above are the binding contract.

---

## g) Audio I/O

The robot carries a **speaker and microphone**. Audio is a new I/O subsystem, decoupled from the 50 Hz motor path. **[SCOPE INCREASE 2026-06-30, revised 2026-07-01]** the target grew from one-way uplink to **two-way audio presence** (a voice call *through* the robot); operator *video* is deferred to M6 — see the milestone note.

### M3 scope (two-way audio)
- **Robot mic → operator (uplink) — M3a:** the operator hears the room. Pi capture, Opus-encoded, added as a WebRTC audio track on the existing M1 session (was the original v1 scope). No AEC dependency — can ship first.
- **Operator voice → robot speaker (downlink) — M3b:** the operator talks *through* the robot. Opus track in the reverse direction on the same session. **This is what makes audio two-way**, and it is what forces AEC.
- **Acoustic echo cancellation (AEC) — MANDATORY for two-way audio (M3b gate):** with speaker playback and mic capture live at once, the robot's mic hears its own speaker → echo/howl without AEC. **Preferred: a USB device with *hardware* AEC** (see Hardware below). Software AEC (PipeWire `module-echo-cancel` / WebRTC APM) is the fallback if the hardware part slips — but that reopens the "ALSA-only" stance, so pin the hardware question first (see the M-sequence §6 questions for HW engineers). *Deferring the operator video (M6) does **not** relax AEC — two-way audio alone echoes.*
- **Robot sound effects (output) — M3a:** local playback of short pre-rendered clips (status chimes, alerts), wired to safety events early — an audible cue on **safe-hold / E-STOP** improves the R13 feedback story. Note: operator voice + a sound-effect can play at once → needs a mixer (`dmix` / single owner).

### Deferred
- **Operator camera → robot screen (M6):** rendered by an **on-demand Chromium call view** (not LVGL) — see §UI. Reserve the WebRTC video m-line (recvonly, muted) at session establishment in M3 so it slots in without renegotiation later. *(Call/mute/live signaling rides the **media-bridge message layer**, not the daemon's `nori-protocol` — the daemon never sees audio/video.)*
- **Wake word + voice commands** (mic → STT), and an **LLM intent layer** on top.
- **Audio as a recorded dataset channel** for IL/policy training.

### Transport — WebRTC tracks on the existing session (updated 2026-06-30)
The original plan sent v1 mic as **Opus over RTP** and folded it into WebRTC "later." That's now moot: **M1 already shipped the WebRTC session** (video, control data channel, Supabase signaling, STUN/TURN). So audio and operator video are added as **additional WebRTC tracks on that same peer connection from the start** — they inherit its NAT traversal, DTLS/SRTP encryption, and jitter buffering, and two-way + AEC "become natural there" exactly as anticipated:
- **robot mic → operator (M3a):** Opus send track (Pi `alsasrc ! opusenc` into `webrtcbin`).
- **operator voice → robot (M3b):** Opus recv track → ALSA playback (Pi `webrtcbin → opusdec ! alsasink`).
- **operator camera → robot (M6, deferred):** H.264/VP8 recv track rendered by an **on-demand Chromium call view** (§UI), *not* decoded into an LVGL overlay. The recv m-line is **reserved at connect** in M3 so M6 needs no renegotiation.

> ⚠️ **Negotiate the full track set up front.** `webrtcbin` on this stack is single-shot and fragile on renegotiation/teardown (`media/README.md`). Reserve all m-lines (recvonly, muted) at session establishment; "unmute / add video" = a track-enable flip or a session re-establish (the supervisor already relaunches per session) — never a live renegotiation.

The old standalone `alsasrc ! opusenc ! rtpopuspay ! udpsink` recipe is retained only as a **LAN-only fallback** if a WebRTC track proves troublesome; do **not** put audio on the ZMQ `CONFLATE` camera path — audio needs continuity, not latest-only.

### Process model & OS
- Audio runs in its **own process/thread**, never the 50 Hz daemon loop (mirrors the standalone camera capture). `audio_io.cpp` is its eventual home; v1 may start as a small standalone GStreamer helper.
- **ALSA + AEC (updated 2026-06-30):** ALSA remains the capture/playback layer. Because M3 is two-way, **AEC is required** — the cheapest correct path is a USB speakerphone doing AEC *in hardware* (no PulseAudio/PipeWire/WebRTC-APM software echo-canceller on the Pi). If a software canceller is ever forced, that's when PulseAudio/PipeWire (or WebRTC's `webrtcdsp`) enters the picture — avoid until then.
- **Hardware (pin before factory imaging, like R3):** with two-way now the baseline, **default to a USB conference speakerphone with hardware AEC** (class-compliant, single device = combined speaker+mic+echo-cancel) on the shared peripheral hub — consistent with the all-USB topology (R16), no GPIO/I²S device-tree work. A plain USB speaker + USB mic is the fallback *only* if paired with software AEC. Budget its USB bandwidth/power against R16 alongside the cameras.

### Privacy (mirrors the §2c video rule) — now covers BOTH directions
Audio **and** the operator's video feed are high-trust surfaces — and M3 adds a *live remote person into the home*, so privacy is now bidirectional:
- **Robot mic (into home → out):** **no audio persisted** (no audio to SD), **clear mute + "mic live" indicator**, mic streaming **opt-in**. (original R15.)
- **Operator voice (remote person → into home), M3; operator camera, M6:** a **clear on-screen indicator when a remote operator's audio (M3) or video (M6) is live** in the room, and the operator feed is likewise **never persisted** on the Pi. Reserve the indicator + consent fields in M3. Tracked as an extension of R15.

---

## UI Migration Strategy

The frontend kiosk (`index.html`) follows a staged migration to fit the **2 GB Pi 5 RAM ceiling**. **[UPDATED 2026-07-01]** Reverted from the brief "straight to LVGL" plan back to **RAM-driven** timing (deadlines). Key insight that shaped it: the RAM cost is the **always-on face**, but live video is **transient** (calls only) — so the always-on face becomes LVGL (the RAM win) while the transient call video is rendered by an **on-demand Chromium**, not LVGL.

### Phase 1 (Launch — current) — Chromium NoriScreen
`chromium-browser --kiosk` serving the existing **NoriScreen** kiosk UI (status + E-STOP) — already shipping on the Pi's 7" DSI display over HTTP **9091** (the prototype's `start_teleop.sh` brings it up today). Zero rewrite; **kept for now** (deadlines) and — importantly — **retained past M4** to render the M6 on-demand call view. *(An earlier draft said `localhost:9090`; the actual port is 9091.)*

### Phase 2 = M4 (LVGL always-on face — RAM-driven)
Replace the **always-on idle face** with **LVGL** (chosen over Slint for the smallest footprint + first-class DRM/KMS + framebuffer backends and a mature C API). **Timing is RAM-driven** — measure Chromium's real peak alongside the daemon + cameras + M3 audio first, and swap when the budget demands it, not preemptively.

- **Architecture:** bypasses the X11/Wayland window manager entirely — draws directly to the DSI via **DRM/KMS** (`/dev/fb0` fallback).
- **No video in LVGL:** the face is graphics only (blink/breathe/gaze + status chrome). Live operator video is **M6's on-demand Chromium**, not an LVGL overlay.
- **Display-yield hook (build in M4 for M6):** the LVGL face process must cleanly **release DRM master / the DSI** on request and reacquire it afterward, so the on-demand call view can borrow the screen and hand it back. Face and call are mutually exclusive in time → a **display handoff**, not overlay-plane compositing.
- **Performance:** UI (LVGL toolkit) RAM drops from ~150 MB (Chromium) to **< 20 MB**, stable 60 fps. IPC changes from network WebSockets to internal lock-free event queues. *(Call-time RAM = LVGL yielded + Chromium up; budget it separately — R1.)*
- **Safety (R2):** the LVGL UI runs in a **separate process** from the 50 Hz safety loop (a UI leak/crash must never take down the motor loop); shared-memory lock-free queue. Only the safety process gets `OOMScoreAdjust=-1000`.
- **Media bridge stays Python** (no webrtcbin C++ port) — own process, off the RT loop, so it doesn't threaten determinism.

### M6 — on-demand call video (deferred)
When a call needs the operator's camera: the LVGL face yields the DSI (hook above) → **Chromium is launched to render the call video full-screen** → on call end it's torn down and the face reacquires the screen. Transient ~150 MB is acceptable because it isn't persistent. **Fallback only** if that transient RAM proves unacceptable: the harder LVGL + GStreamer + **DRM/KMS overlay-plane** path (SW-decode → dmabuf → overlay plane; LVGL chrome on a second alpha plane) — the DRM-master-contention path we are deliberately avoiding; spike standalone before adopting.

> **Outcome (by milestone):** first (M1/M2) a remote operator — on a laptop or in a VR headset, anywhere on the internet — drives the robot with live video; later (M5 + the autonomy Item) an assistive user unboxes it, connects WiFi via their phone, and the robot tidies with zero code. Developers get open LeRobot underneath, a mathematically stable native C++ hardware profile, and ROS/remote access without web-browser overhead.

---

## Repo Schema

Proposed layout (rough, subject to change):

```
nori-teleop/
├── .gitignore
├── README.md
│
├── nori_core_agent/              ◀── NEW: Isolated C++ Onboard Project Root
│   ├── CMakeLists.txt            ◀── Native build toolchain definition
│   ├── include/                  ◀── Public header blueprints (.h / .hpp)
│   │   ├── bus_controller.hpp
│   │   ├── safety_watchdog.hpp
│   │   ├── wire_protocol.hpp     ◀── JSON control/telemetry schema (from nori-protocol submodule)
│   │   └── ui_manager.hpp
│   └── src/                      ◀── Implementation source blocks (.cpp)
│       ├── main.cpp              ◀── Init, affinity layout, core thread setup
│       ├── bus_controller.cpp    ◀── Feetech C++ SDK bus worker (one PortHandler/bus, own thread)
│       ├── safety_watchdog.cpp   ◀── 50 Hz stall + tiered arrival-time watchdog
│       ├── video_grabber.cpp     ◀── Zero-copy kernel mmap frame capture
│       ├── network_broker.cpp    ◀── JSON control channel / ZMQ + WebRTC video broker
│       ├── audio_io.cpp          ◀── Two-way audio: mic uplink + operator-voice playback (ALSA + HW-AEC device) as WebRTC tracks; sound-effects
│       └── ui/                   ◀── LVGL always-on face in a SEPARATE process (R2); DRM/KMS + display-yield hook (M6 call video = on-demand Chromium, not LVGL)
│           ├── screens/          ◀── LVGL screen/widget definitions (idle face, status, call view)
│           └── ui_manager.cpp    ◀── LVGL integration bridge + shared-mem queue to the safety process
│
└── rpi4/                         ◀── RETAINED & HARDENED: Python On-Pi Utilities
    ├── onboard_wifi_setup.py     ◀── Python captive-portal wizard (Item 2c)
    └── services/
        ├── nori-core.service     ◀── systemd unit auto-starting the C++ binary
        └── nori-wifi.service     ◀── systemd unit managing onboarding states
```

### Decisions

- **Complete separation of `nori_core_agent/`.** Rather than scattering `.cpp` files inside the Python tree, all native systems engineering lives in its own root. The build target stays isolated: compiling on the Pi or via a cross-compiler toolchain only needs CMake against this single directory → an unencumbered `nori_agent` binary.
- **`rpi4/` streamlined to non-realtime tasks.** Legacy `teleop_server.py` and `image_server.py` are wiped out. The only Python on the Pi is `onboard_wifi_setup.py` — matching the rule: Python for run-once/exits-after convenience tasks, native C++ for all real-time paths.

---

## [NEW] Open Issues & Risks (flagged 2026-06-16)

These are tensions or gaps surfaced while aligning this doc with the laptop app's [`full_nori_plan.md`](full_nori_plan.md). None block beta, but each needs an owner/decision.

| ID | Risk | Why it matters | Suggested resolution |
|---|---|---|---|
| **R1** | **Chromium kiosk vs. RAM budget** | Phase 1 keeps Chromium (~150 MB) on the 2 GB Pi 5 *alongside* the daemon, V4L2 camera buffers (ZMQ JPEG at LAN launch; software WebRTC encode once WAN ships — see R11), and the audio stack (§g). The "< 100 MB idle" target is the daemon baseline only — 2 GB helps but headroom with Chromium + cameras + encode is still finite. | Measure real Phase-1 peak RAM with cameras streaming **before** committing to ship on Chromium. Have the Slint/LVGL path (Phase 2) ready earlier than "when budget is breached." |
| **R2** | **UI compiled into the safety daemon** | Phase 2 compiles the UI into `NoriCoreAgent`. A UI render bug/leak can now crash the process that owns the 50 Hz safety loop. `OOMScoreAdjust=-1000` would also protect the memory-hungry UI from the OOM killer, defeating its purpose. | Keep the safety/motor loop in a **separate process** from the UI even after the Chromium removal; communicate over the lock-free queue across a process boundary (shared memory). Only the safety process gets `OOMScoreAdjust=-1000`. |
| **R3** | **No secure enclave on stock Pi 4/5** (DECIDED 2026-06-24) | The Pi has no TPM by default, and the boot EEPROM isn't a general secret store. Per-unit signed identity needs a concrete mechanism. | **DECIDED: ATECC608B secure element** — see resolution below. Pin before factory imaging. |
| **R4** | **A/B partitioning storage cost** | Two rootfs partitions roughly doubles rootfs storage on the SD/eMMC, and RAUC/Mender add bundle staging space. | Confirm the flash size budget covers 2× rootfs + update staging. (No persistent recording buffer to budget — R5 streams to the laptop.) |
| **R5** | **"No video to SD" vs. on-Pi recording buffer** (DECIDED 2026-06-24) | Item 2c forbids writing video buffers to persistent cache (SD); an earlier `full_nori_plan.md` draft implied an on-flash recording buffer. | **DECIDED: no persistent Pi-side video — stream frames to the laptop app (matches the prototype); WAN recording, if ever needed, uses tmpfs/RAM, never SD.** See resolution below. |
| **R6** | **mDNS reliability** | `xlerobot.local` resolution fails on some routers/OSes (mDNS blocked, client subnet isolation). | Already covered laptop-side by manual-serial fallback; ensure the daemon **also** exposes a reachable IP path and the captive portal surfaces the assigned IP for manual entry. |
| **R7** | **Transport split: TCP control vs. video channel** | `network_broker.cpp` brokers both the JSON control channel and video (ZMQ on LAN / WebRTC on WAN). The laptop expects a single control socket + a separate video channel. | Confirm the broker cleanly separates the two so a video stall can't backpressure the control stream (and vice versa). Version the JSON control schema (see revised R8). |
| **R8** | **Shared wire-protocol drift across two repos** (resolved 2026-06-16; revised 2026-06-24) | The Pi daemon (`nori-teleop`) and the laptop app (`NoriLeLab`) are **separate repos — this is intentional and correct** (different toolchains: C++/CMake-on-ARM vs. Python/npm-on-x86; different deploy paths: signed A/B OTA vs. PyPI/installer; different blast radius). The split is *not* the risk. The risk is that the Pi daemon's protocol definition and the laptop's parse/serialize code become **two hand-maintained definitions of one message format** that drift silently — a renamed, reordered, or retyped field corrupts joint commands with no error, on a robot moving near a human. | **Keep both repos.** Fix drift with a single source of truth + a runtime tripwire (see resolution below). |
| **R9** | **E-STOP reset path** | The hard latch requires an explicit user reset, but the reset command's transport/auth isn't specified. | Define the reset as an authenticated command on the TCP control channel (see laptop `full_nori_plan.md` LAN matrix), and confirm it's reachable even when the control stream is in safe-stop. **VR-specific branch: see R13.** |

### [NEW] R8 resolution — shared protocol contract *(revised 2026-06-24: JSON, not binary)*

Two repos, one contract. Don't merge them; add a thin shared definition both pull from, plus a version check that turns silent drift into a loud failure. **The wire format is JSON** (see §f for the rationale — packed binary buys perf we don't need at 50 Hz while adding a cross-language drift hazard near a moving robot).

1. **Shared schema in a `nori-protocol` submodule** — one canonical definition of the JSON control + telemetry messages (a JSON Schema, or a single annotated `.py`/`.hpp` pair of field lists), consumed as a **git submodule** in both `nori-teleop` and `NoriLeLab` so neither repo owns a private copy.
2. **`protocol_version` in the handshake** (and ideally every frame). Both ends assert it and **refuse mismatched versions loudly** instead of decoding garbage. Non-negotiable safety tripwire.
3. **Golden-fixture test in both repos** — same canonical message → same decoded result — so any field change breaks CI before it ships.

Upgrade path: only if a measured trigger fires (serialize cost / bandwidth over budget), swap JSON for a **codegen IDL** (Cap'n Proto / FlatBuffers) — never hand-rolled structs. Not needed for launch.

### [DECIDED 2026-06-24] Resolutions from the teleop / transport design pass

These close several open risks and add detail surfaced while specifying the teleop + LAN/WAN architecture (§e, §f).

**R3 (per-unit identity) — DECIDED: ATECC608B secure element.**
Stock Pi 4/5 has no usable TPM, and a key sealed in a read-only partition is extractable by anyone with physical SD access (per-unit, but not tamper-resistant). OP-TEE/TrustZone on the Pi is fragile without fused keys and not production-grade here. The **ATECC608B** (I²C, ~$1) stores the private key non-extractably, does ECDSA on-chip, is well-supported (cryptoauthlib), behaves identically on Pi 4/5, and **decouples identity from the OS image** so A/B partition swaps never touch it. Cost: a small BOM addition + I²C provisioning at the factory — acceptable since the hardware is ours. *Dev note:* abstract identity behind an interface with a **software-key fallback** so software work proceeds now; swap to ATECC at hardware bring-up. Pin before factory imaging.

**R5 (no-video-to-SD vs recording buffer) — DECIDED: no persistent Pi-side video; stream to the app.**
The conflict is largely illusory. The prototype's recording path already **streams frames to the laptop, which writes the `LeRobotDataset`** — the Pi never persists video. That is simultaneously the best-performance option (no SD I/O contention with the 50 Hz loop, no RAM pressure beyond the stream buffer) and fully satisfies the 2c "no video to SD" privacy/flash-wear rule with **zero conflict**. Keep it for launch. The only case tempting a Pi-side buffer is **WAN recording**, where you don't want lossy H.264 as training data — and even then it must be a **tmpfs/RAM ring flushed per-episode, never SD**. Default: stream to the app.

**Provisioning (per-unit calibration + identity) — DEFERRED to pre-ship, constraint documented now (R12).**
Not a blocker today: calibration is provisioned manually (scp the per-unit JSON, per the README) and works. The automation only becomes necessary at factory-imaging time, because OTA ships one image to all units while **calibration and identity are per-robot**. Action now: §a (imaging) and §d (OTA) must not assume a single golden image with no per-unit step. Owner: shipping phase.

| ID | Risk | Why it matters | Suggested resolution |
|---|---|---|---|
| **R10** | **WAN attack surface** | WAN mode exposes robot control to the public internet. Weak auth = remote control of a machine moving near humans. | TLS on all WAN control; short-lived scoped per-robot tokens from Supabase (R3 identity); never expose the control port via naive port-forwarding — broker through the relay/VPN (§f). |
| **R11** | **WebRTC encode load on the Pi 5 (no HW encoder)** | WAN video (WebRTC, ~24 fps) is the heaviest single addition. **The Pi 5 removed the Pi 4's hardware H.264 encoder and has no HW video encoder at all**, so WAN video must be **software-encoded** on the CPU — competing with the 50 Hz loop and the new audio stack (§g). | Pin the software encoder to dedicated core(s) away from the motor threads; keep resolution/fps modest (e.g. 640×480 @ 24 fps); budget CPU/RAM against R1 and validate on the 2 GB Pi 5 before committing WAN video. Opus audio encode is cheap by comparison. |
| **R12** | **Per-unit factory provisioning** (calibration + identity) | OTA ships one image; calibration + identity are per-robot. No automated provisioning step exists yet. | Deferred to pre-ship (see above). Document the constraint in §a/§d now; design the factory flow before first batch. |
| **R13** | **E-STOP / reset reachability in VR** | A headset operator can't reach the phone/kiosk to stop or reset. | Map a Quest controller button to E-STOP; gate reset behind a deliberate gesture + live-video confirmation (extends R9). |
| **R14** | **Pi thermal / undervoltage throttling** (spec'd 2026-06-24) | Firmware throttle at ~80 °C breaks 50 Hz determinism; undervoltage (the README's USB-power issue) does the same. | Addressed: tiered, auto-recovering thermal/power watchdog in §b (1 Hz monitor, shed-load → safe-hold, telemetry). Tune thresholds against in-enclosure thermals. |
| **R15** | **Microphone privacy in the home** | A home mic is a higher trust surface than cameras; persisted or always-on audio is a serious privacy/PR risk. | No audio persisted (no audio to SD, mirrors R5); clear mute + "mic live" indicator; mic streaming opt-in. See §g. |
| **R16** | **Shared USB hub: power, bandwidth & single point of failure** | All peripherals — both motor buses (CH343), cameras, and USB audio — reach the Pi 5 through one USB Type-A multi-port **data hub**. That concentrates power draw, USB bandwidth, and failure into one part: motor inrush can brown out neighbors (the README's USB-power failure mode, now *shared*), multiple MJPEG cameras + audio compete for one host-controller lane, and a hub fault drops *everything* at once. | Use a **powered** hub with headroom for motor inrush + cameras + audio; verify per-port current under simultaneous load. Keep deterministic `udev` naming keyed on **port path / serial** so `/dev/xlerobot_bus{1,2}` stay stable through the hub. Budget aggregate USB bandwidth (cameras + audio) against the host controller. The §b undervoltage watchdog flags hub-induced brownouts; surface a dropped bus rather than letting it silently stall. |
