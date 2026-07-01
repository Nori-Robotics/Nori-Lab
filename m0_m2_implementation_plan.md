# Implementation Plan — M0 → M2 (Daemon substrate → WAN laptop teleop → VR over WAN)

> **Source of truth for *what* and *why*:** [`onboard_pi_plan.md`](onboard_pi_plan.md) (architecture + decisions) and [`full_nori_plan.md`](full_nori_plan.md) (laptop app / backend).
> **This doc is the *how*** — the build order, file layout, task breakdown, and acceptance criteria to get from nothing to a human driving the robot over the internet (laptop **or** VR).
>
> Milestones M3+ are covered in [`m3_m5_implementation_plan.md`](m3_m5_implementation_plan.md). **Note (2026-06-30 scope increase):** M3 grew from audio-uplink to **two-way telepresence**, the LVGL native-UI migration became its own milestone **M4**, and productionization slipped to **M5** (see `onboard_pi_plan.md`).

---

## 0. Ground rules & where code lives

| Area | Path | Notes |
|---|---|---|
| **New C++ daemon** | `NoriTeleop/rpi5/` | Greenfield. All real-time/native code (`nori_core_agent/`). |
| **Old working reference** | `NoriTeleop/rpi4/` | Fully-working **LAN** Python teleop. **Reference only** — do not extend. Best anchors: port setup, register map, calibration clamp, protocol, kinematics (see §1). |
| **Shared wire schema** | `nori-protocol/` (new repo, git submodule) | One canonical **JSON** control + telemetry definition, consumed by both the daemon and the laptop app. Per `onboard_pi_plan.md` §f / R8. |
| **Laptop app / video sink / VR mapper** | `NoriLeLab/` (separate repo) | Single control client; WebRTC video sink; WebXR→`jog` mapper. |
| **WAN rendezvous / auth** | Supabase backend (Item 3) | Relay/TURN or WireGuard + scoped tokens. M1+. |

**Build strategy:** build **natively on the Pi 5** first (simplest, fastest iteration). Add a cross-compile/CMake-toolchain path later (M4). Target **C++20**, CMake.

**Two cross-cutting decisions to lock before coding (carried from `onboard_pi_plan.md`):**
- **Protocol is JSON, versioned.** `full_nori_plan.md` still says "binary C-struct protocol" in several places — that is **stale**; reconcile it to JSON when the laptop Robot class is touched (M1). Track as a checklist item, don't silently leave both.
- **Daemon is the single real-time authority.** All four motor-protection layers (esp. the **calibration position clamp**) live in the daemon. Never command a raw goal that skips the clamp.

---

## 1. rpi4 reference map (read these before writing the C++)

The Python prototype already solved the hard hardware details. Port the *logic*, not the language.

| What you need | rpi4 anchor | Port to |
|---|---|---|
| **Port setup** — CH343 boards enumerate as `/dev/ttyACM*` (cdc_acm), pinned to `/dev/xlerobot_bus{1,2}` by **USB serial** | `rpi4/99-xlerobot.rules`, `teleop_server.py:84-86,299-302` | `bus_controller.cpp` (Feetech SDK `PortHandler` @ **1 000 000 baud**) |
| **Register map** (STS3215 addresses/lengths) | `teleop_server.py:61-80` (`REG`) | `bus_controller.hpp` constants |
| **Sign-magnitude** (bit 15) for Goal/Present Velocity & Present Current | `teleop_server.py:82,226-243` | bus codec |
| **Sync read/write** groups (positions, currents, goals, wheel velocities) | `teleop_server.py:361-424` | bus worker |
| **Calibration clamp** (the safety layer — clamp to `[range_min,range_max]` then un-normalize) | `teleop_server.py:258-270` (`clamp_and_unnormalize`) | clamp in `bus_controller.cpp` |
| **Calibration load** (per-unit JSON, same path/format) | `teleop_server.py:875-889,1018-1024` | calibration loader |
| **Bus init order** (configure → write_calibration → torque/mode setup) | `teleop_server.py:343-358,966-1040` | daemon startup |
| **50 Hz loop + protocol** (hello/ack, keys/vr/arm_targets/wheel_targets/reset/bye, telemetry) | `teleop_server.py:1000-1130+` | `network_broker.cpp` + loop |
| **Control math** — P-control arms/head, smooth base, SO101 IK, stall detect | `teleop_server.py:430-810` | control modules |
| **Dead-man / constants** — `FPS=50`, `DEAD_MAN_SEC=0.5`, `TCP_PORT=7777`, `TELEMETRY_INTERVAL=10` | `teleop_server.py:88-91` | daemon config |
| **Camera ZMQ** (reuse as-is for M0 video) | `rpi4/image_server.py` | run unchanged on Pi 5 |
| **E-STOP listener** (HTTP 9091 / NoriScreen) | `teleop_server.py:891-930` | event input |

> ✅ **Use the C++ Feetech SDK — do *not* hand-roll termios** (decided 2026-06-24). **SDK chosen: [SCServo_Linux](https://github.com/adityakamath/SCServo_Linux)** (adityakamath fork of FEETECH's official Linux SDK) — the `SMS_STS` application class over the `SCS` protocol base. rpi4's pure-Python `scservo_sdk` (DynamixelSDK-style) has **no C++ twin**, so we map rpi4's REG-driven `FeetechBus` (`teleop_server.py:287-424`) onto the `SCS` base's low-level register API (`writeByte`/`writeWord`/`readByte`/`readWord`/`Ping`/`syncWrite` + the `syncRead*` sequence) — 1:1 on semantics, different call syntax. `SMS_STS()` defaults to `End=0` (STS little-endian) = rpi4's `PacketHandler(0)`. One `SMS_STS` per bus on its own pinned thread (the concurrency win is threading, not abandoning the SDK). **CH343-safe writes:** goal-position is written **per motor** (`writeWord`), mirroring rpi4's default — its sync-write path is flagged *"known to kill the direct CH343 USB bus"* (`:1283`). Sync write is used only for wheel velocities. If STS3215 EEPROM commits time out during `configure()`, loosen `SCSerial::IOTimeOut` (rpi4's `setPacketTimeout` patch, `:276-284`). The `REG` map + sign-magnitude in rpi4 remain the behavioral spec. The boundary is one file (`bus_controller.cpp`); a build-only stub (`external/scservo_stub`) compiles the path off-Pi.

---

## 2. Milestone M0 — Daemon substrate (LAN, internal)

**Goal:** the C++ `NoriCoreAgent` owns both buses at a deterministic 50 Hz with the full safety stack, and is driven from a laptop over LAN using the **`nori-protocol`** schema (see `nori_protocol_schema.md`). **Validation trick:** port `examples/xlerobot/teleop_client.py`'s keymap to emit `jog` intents (a ~small change — this keymap *is* the seed of the laptop input-mapper) and drive the daemon with it. The daemon's IK/P-control/safety logic is otherwise the rpi4 logic re-hosted, so this isolates the test to transport + control parity.

**Out of scope for M0:** WAN, WebRTC, VR, audio, OTA, onboarding, real secure element.

### 2.1 Components & tasks

**A. Project scaffold** (`rpi5/nori_core_agent/`)
- [x] `CMakeLists.txt` (C++20), `include/`, `src/` per `onboard_pi_plan.md` Repo Schema.
- [x] Pick JSON lib: **nlohmann/json** for ergonomics (control rate is trivial; simdjson optional later if profiling demands).
- [x] `main.cpp`: thread/affinity layout — `realtime.{hpp,cpp}` (`pin_to_core` + SCHED_FIFO `request_realtime`, Linux-only, no-op off-Pi). Control loop pins to core 1 @ prio 20; `CORE_*` constants are the shared layout (control=1, bus=2, media=3). *(Per-bus worker threads land with the SDK, Track B; graceful shutdown still TODO.)*

**B. Bus layer** (`bus_controller.{hpp,cpp}`) — **SCServo_Linux (`SMS_STS`/`SCS`)**
- [x] Bus layer written against SCServo_Linux; mirrors rpi4's `FeetechBus` (`teleop_server.py:287-424`) via the `SCS` low-level register API. `begin(1_000_000, port)` per bus. Compiles + runs end-to-end against the stub (`serve --arm`).
- [x] `syncRead*` for positions/currents; **per-motor `writeWord` for goal position (CH343-safe)**; `syncWrite` for wheel velocities; sign-magnitude bit-15 for velocity/current (`registers.hpp`, port `:226-243`); `REG` map (`:61-80`).
- [ ] `setPacketTimeout` equivalent (`SCSerial::IOTimeOut`) — apply **only if** EEPROM commits time out on the Pi (`:276-284`). Verify on hardware.
- [ ] **One `SMS_STS` + worker thread per bus, pinned to its own core**, polled concurrently. *(Single-bus path done; per-bus threads land at Stage 3, full robot.)*
- [ ] Deterministic device naming validated through the **shared USB hub** (R16) — confirm `udev` symlinks survive hub topology. *(Pi/hardware.)*

**C. Calibration + clamp** (safety layer 3 — do not skip)
- [ ] Load per-unit JSON (same path as `teleop_server.py:1018`; M0 keeps the manual scp provisioning — R12 deferred).
- [ ] Port `clamp_and_unnormalize` (`teleop_server.py:258-270`) — every `Goal_Position` clamped to `[range_min,range_max]`.
- [ ] `write_calibration` (Homing_Offset + Min/Max_Position_Limit) on init.

**D. Motor protection — all four layers** (`onboard_pi_plan.md` §b)
- [ ] L1 `Torque_Limit=600` in SRAM on init. *(set in `configure_bus_for_teleop`; needs Pi to verify)*
- [x] L2 stall detection (`StallDetector`, `safety.{hpp,cpp}`, port of `teleop_server.py:740-805`): retry-once, gripper grip-hold, **per-motor torque reduction** on obstruction, **auto-clears when the joint is jogged to a new target** (rpi4 semantics). Revised 2026-06-24 from a global hard-latch to soft per-motor protection — a bump on one joint no longer freezes the whole arm or needs a manual reset (that was a recovery deadlock, since jog was blocked the target could never change to clear). E-STOP remains the only hard latch. Verified on hardware (single arm) + `selftest`.
- [x] L3 calibration clamp (C above) — `clamp_and_unnormalize`, verified in `selftest`.
- [ ] L4 firmware EEPROM: **reuse the existing `examples/xlerobot/fix_eeprom.py` one-shot** for now (it's a run-once tool; no need to port to C++ for M0). Document that bring-up runs it once.

**E. Control loop @ 50 Hz** (port from rpi4)
- [x] SO101 IK (`teleop_server.py:430-460`), `TeleopArm`/`HeadControl` P-control (`461-686`), base/z-lift helpers (`688-738`). Verified on the single arm (jog→IK→P-control→clamp→motor).
- [x] Freshest command consumed each tick from the broker; goals via **per-motor `writeWord`** (CH343-safe, not GroupSyncWrite — see §1).
- [x] **Bring-up refinements (2026-06-24, divergences from rpi4 for safe/consistent teleop):** (a) **seed targets from current pose on connect** — arm holds instead of lurching to home; (b) **reset → IK rest pose** (repeatable home; first x/y jog after reset is smooth, no jump); (c) **jog targets clamped to joint range** — driving into a limit settles cleanly (no stall flicker); (d) soft stall (see D-L2).

**F. Safety responses** (`onboard_pi_plan.md` §b — latching vs auto-recovering) — `safety.{hpp,cpp}`, wired into `serve`
- [x] Network watchdog: **arrival-time keyed** (Pi-monotonic, not client ts), **tiered** T_warn/T_stop, arms-hold / wheels-decel, **LAN {150/500} / WAN {300/1000} profiles** selected at handshake. Auto-recover. Verified: silence → warn → stop → resume with no latch.
- [x] **Thermal/power watchdog**: 1 Hz monitor of `/sys/class/thermal/thermal_zone0/temp` + `vcgencmd get_throttled`; ~70 °C shed-load → ~80 °C safe-hold (with hysteresis); auto-recover; ships `pi_temp_c` + `throttle_flags` in telemetry. `NORI_FAKE_TEMP_C` override exercises it off-Pi. Verified safe-hold at 85 °C.
- [x] E-STOP: hard latch + **manual reset** via `command{estop}` / `command{reset_latch}`. Verified latch + reason + reset. *(NoriScreen HTTP 9091 listener as an additional input still TODO — needs the screen.)*

**G. Protocol** (`network_broker.cpp`) — implements **`nori_protocol_schema.md`**
- [ ] NDJSON TCP server on **7777**, **one client at a time**.
- [ ] Handshake: `hello` → `ack` (with `protocol_version`, `norm_mode`, `descriptor`, `watchdog_profile`, `initial_state`). Version mismatch ⇒ hard reject (R8 tripwire).
- [ ] Parse `control` (`jog` / `action` / `reset`; `clutch` lands in M2; `vr` raw-pose frame reserved/not built), `command` (`estop` / `reset_latch`), `bye`. Watchdog keyed on arrival time; `seq`/`send_ms` ordering/latency only.
- [ ] Telemetry every tick: `ts_ns`, `state` (lerobot `.pos`/`.vel`), `currents`; periodic block adds `loop_hz`/`errors`/`stalled`/`pi_temp_c`/`throttle_flags` + `status`.
- [ ] Land the **`nori-protocol` submodule** (JSON Schema + golden fixtures) in M0 — both repos validate against it.

**H. Video (M0): reuse Python ZMQ as-is**
- [ ] Run `rpi4/image_server.py` unchanged on the Pi 5. No porting yet — it's replaced by WebRTC in M1.

**I. Service**
- [x] `nori-core.service` systemd unit (`deploy/nori-core.service` + `deploy/README.md`): `Restart=always`, `RestartSec=2`, `OOMScoreAdjust=-1000`, `AmbientCapabilities=CAP_SYS_NICE` + `LimitRTPRIO=40` (for SCHED_FIFO), `dialout` group for serial, start-limit backstop. Install + operate steps documented. *(Verify on the Pi.)*

**J. On-robot display — NoriScreen kiosk (Chromium, ⚠️ THROWAWAY)**
> 🧹 **STRIP-OUT FLAG.** This whole section is a *deliberately temporary* Phase-1
> stopgap (`onboard_pi_plan.md` §UI staging, R1/R2). It exists so the 7" DSI shows
> a face for early demos with **zero daemon changes**, and is to be **removed in
> full** when the UI is rewritten in **LVGL/Slint compiled into `NoriCoreAgent`**
> (Phase 2). When LVGL lands, delete *everything* below — nothing depends on it:
> - `rpi5/nori_core_agent/deploy/kiosk/` (the whole dir: launcher, unit, copied UI)
> - the kiosk block in `rpi5/media/run_robot.sh` (between the `--- NoriScreen
>   kiosk ---` markers) + its `start_kiosk`/`stop_kiosk` calls
> - on the Pi: `sudo rm -rf /opt/nori/kiosk` (+ `/etc/systemd/system/nori-kiosk.service` only if the boot unit was ever installed)
>
> No C++ / daemon / protocol code is touched, so removal is purely deletion.

- [x] **Display-only NoriScreen idle face**, reusing the rpi4 prototype's UI verbatim (`rpi4/noriscreen/index.html`, copied into `deploy/kiosk/noriscreen/`, **design unchanged**). Self-driven idle animation (blink + breathe + gaze drift, neutral expression) via `requestAnimationFrame` — needs **no backend**: the UI's status WebSocket (`:9090`) and E-STOP POST (`:9091`) simply never connect, so it holds `IDLE` forever. The only no-backend artifact is the design's built-in 10px "disconnected" dot. Verified on the Pi's DSI.
- [x] **Chromium launch** = the prototype's exact kiosk incantation (`--kiosk --noerrdialogs --disable-infobars --incognito --start-fullscreen`, `+ --disable-background-networking` to mute GCM noise) over `DISPLAY=:0` (labwc + Xwayland). Static UI served by a throwaway `python3 -m http.server` (`deploy/kiosk/nori-kiosk.sh`). *(Benign log noise: `--no-decommit-pooled-pages` comes from the Pi's `/etc/chromium.d/` defaults, not us — harmless.)*
- [x] **Lifecycle = tied to the run-robot launcher, NOT boot (per request).** `rpi5/media/run_robot.sh` starts the kiosk in its own process group on launch and tears it down (Chromium + http.server + renderers) on exit. Skip with `NORI_KIOSK=0`. *(A boot-start `deploy/kiosk/nori-kiosk.service` unit also ships but is intentionally **not enabled** — left for if/when an always-on face is wanted.)*
- [x] **E-STOP on the screen is cosmetic here** (its POST has no listener); rely on the VR / laptop E-STOP paths. Wiring a working on-screen E-STOP would require a small HTTP/WS surface on the daemon — **deliberately not done**, since the kiosk is throwaway.

### 2.2 M0 acceptance criteria
*(Track A = mock + TCP client off-hardware; Track B = real bus on the Pi, gated on vendoring the SCServo SDK.)*
- [~] A `jog`-emitting client connects and drives **both arms + head + base + Z-lift** (transport + jog→IK→`.pos` parity); telemetry `state` matches lerobot keys. **Track A ✓** (mock); on-robot confirm pending Track B.
- [~] Sustained **`loop_hz ≈ 50`** — now measured over a 1 s window and shipped in telemetry. **Track A ✓** (mock ~50); under dual-bus load pending Track B.
- [ ] Pull a motor cable → **stall latch** fires, requires manual reset. *(StallDetector logic verified in `selftest`; needs real currents on the Pi — Track B.)*
- [x] Kill the client → **network watchdog**: wheels decel, arms hold, **auto-resume** on reconnect (no latch). **Track A ✓** (silence → warn → stop → resume).
- [x] Heat-soak / force throttle → thermal watchdog sheds load then safe-holds; `pi_temp_c` visible in telemetry. **Track A ✓** via `NORI_FAKE_TEMP_C=85` (safe-hold); real heat-soak on Pi confirms sysfs/`vcgencmd` read.
- [x] `protocol_version` mismatch → **loud refusal**, not garbage motion. (handshake rejects + `error{version_mismatch, fatal}`.)
- [x] Calibration clamp verified: a goal beyond `range_max` is clamped — `selftest` shows `norm=999 → clamped to range_max`. On-robot spot check pending Track B.

---

## 3. Milestone M1 — WAN remote teleop, laptop ⭐

**Goal:** an operator **anywhere on the internet** drives with basic (keyboard / on-screen) controls and sees a live video stream. This is M0 + a network/security/media layer; the control core does not change.

### 3.1 Components & tasks

**A. Video over WebRTC** (`network_broker.cpp` / new `video` path) — **DECIDED: GStreamer `webrtcbin`**
- [ ] **Stack: GStreamer `webrtcbin`** on the Pi (pinned): `v4l2src → videoconvert → x264enc/openh264enc (zerolatency) → rtph264pay → webrtcbin`. One media framework, **reused for §g audio** (`opusenc` joins the same pipeline later). libdatachannel is the fallback only if encoder thread-isolation proves unworkable.
- [ ] ⚠️ **Pi 5 has no hardware video encoder** (R11) → software encode. **Run the media pipeline in its own process and pin it to dedicated core(s)** away from the 50 Hz motor threads; cap at **640×480 @ ~24 fps**; budget RAM/CPU (R1) and measure early.
- [ ] Retire `image_server.py` from the WAN path (LAN ZMQ may remain as the LAN-mode fallback).

**B. ICE / NAT traversal — DECIDED: WebRTC + Supabase signaling + STUN first, TURN fallback** (no Tailscale)
- [ ] **Signaling:** Supabase brokers the SDP/ICE exchange (offer/answer + candidates) between robot and operator. This is the reusable core — build it once; it is unchanged whether the path ends up direct, STUN, or TURN.
- [ ] **STUN first:** configure `webrtcbin` with a STUN server (public or self-hosted). Many home-NAT ↔ laptop pairs connect **directly** via server-reflexive candidates — proves M1 over the real internet with **zero relay, no third party**.
- [ ] **TURN as ICE fallback (additive, only when a NAT blocks direct):** stand up self-hosted **coturn** (or a managed TURN service); Supabase mints **short-lived HMAC TURN credentials** (standard coturn REST pattern). Adding TURN is `webrtcbin` `turn-server` config + one Supabase endpoint — **not** a media-stack rebuild. Control (JSON/TLS) and WebRTC media share the same ICE path (`onboard_pi_plan.md` §f).
- [ ] *(Tailscale rejected for the teleop data path — it only saves time if used as a crutch that skips signaling/WebRTC, which is exactly what makes the later transition expensive. May be adopted separately for fleet SSH/debug ops; not here.)*

**C. WAN auth** (Supabase, Item 3)
- [ ] **Identity:** software-key fallback now (ATECC608B deferred to M4 per R3 dev-note); robot authenticates to Supabase.
- [ ] **Authz:** Supabase issues a **short-lived scoped session token** for `operator X ↔ robot Y` (R10), and the ephemeral TURN credentials (B).
- [ ] **TLS** on all WAN control traffic.

**D. Daemon networking**
- [ ] Accept the control connection over WAN; assert the scoped token; select the **WAN watchdog profile {300/1000 ms}** at handshake.
- [ ] Drive `webrtcbin` signaling through the Supabase exchange (B).

**E. Laptop app "remote mode"** (`NoriLeLab`)
- [ ] Single control client (per `onboard_pi_plan.md` §e): connect over WAN, send the **same JSON** control frames.
- [ ] **WebRTC video sink** (the `lelab/` sink described in `full_nori_plan.md` Phase 5) — decode + render.
- [ ] **`full_nori_plan.md` already reconciled** (2026-06-24) to JSON + WebRTC/STUN; keep the `protocol_version` assertion.
- [x] LAN vs WAN watchdog profile — ✅ **2026-06-26, auto from ICE (supersedes the
  separate ZMQ LAN stack for this purpose).** The original design was two transport
  stacks (LAN = mDNS + token + direct/ZMQ; WAN = Supabase + token + WebRTC) with a
  manual toggle. But WebRTC's ICE **already gives LAN-where-available for free**: on the
  same subnet it selects a host↔host candidate pair, so media + control flow **directly
  over the LAN with zero relay**, even in "remote" mode (TURN is used only when no direct
  path exists). So a parallel ZMQ LAN path buys only marginal latency at large
  complexity. What remained was the *watchdog profile*: the operator now measures the
  selected ICE pair (`getStats`) and sends a `{type:"link", mode:"lan"|"wan"}` control
  message (lan ⇔ both candidates `host`); the daemon **starts on the safe WAN profile
  from `hello` and tightens to LAN {150/500} only when the path is confirmed direct**
  (safe direction — never the reverse). Reconfig is timer-preserving (`configure()` swaps
  thresholds only), so switching mid-session never trips. Files: `network_broker`
  (`PollResult.link_mode` + `link` parse), `main.cpp` (live `link_mode`, reconfigure,
  status), operator `teleop.ts` + the deprecated `webrtc_operator.html`.
- [x] **Room defaults to the robot serial (2026-06-26).** The Supabase channel is keyed
  by `NORI_ROOM`; a paired robot's room == its serial. The `/nori/remote` page now
  auto-fills Room from `customer.robot_serial_number` (already supplied by the existing
  `/nori/customers/me` profile — **no backend change**), so a paired operator types
  nothing; a manual value still wins. Pi side: set `NORI_ROOM` to the serial so they
  line up (documented in `.env.example` + media/README). This is the cheap precursor to
  mDNS — removes the room-typing for paired users without any discovery infra.
- [ ] **mDNS discovery** (auto-fill room for *unpaired*/local-only robots, and confirm
  "on this LAN"): Pi advertises a DNS-SD service (`_nori._tcp`, TXT = serial/room/port/
  ver — **never the token**); the LeLab *backend* browses (the browser can't do mDNS)
  via a new `GET /nori/discover`; the page offers discovered robots. **Token stays out
  of mDNS** — it comes from Supabase (signed-in + paired → backend returns the room/
  scoped token), which is the M4 token-minting work. QR is the alternative for securely
  handing the token across at first pairing. An explicit operator LAN/WAN override is
  *not* needed (the watchdog profile is automatic, above).

### 3.2 M1 acceptance criteria
- [ ] From a laptop on a **different network / behind NAT**, connect via Supabase signaling and drive the robot with keyboard/on-screen controls (STUN-direct where the NATs allow; TURN fallback otherwise).
- [ ] Live video renders at **~24 fps**; measure glass-to-glass latency.
- [ ] WAN jitter does **not** false-trip the watchdog (WAN profile holds; safe-hold + auto-resume behave).
- [ ] Software encode coexists with **`loop_hz ≈ 50`** (media pipeline in its own core-pinned process; verify no motor-loop starvation).
- [ ] Unauthorized/expired token is **refused**; no control port exposed via naive port-forward (R10).
- [ ] TURN-fallback path validated at least once (force a relayed connection) so it's not dead code when a real customer NAT needs it.

### 3.3 M1 — Day-1 kickoff (start here) 🚦

**Where M0 left us (2026-06-24):** single-arm LAN control is **hardware-validated** —
SMS_STS bus layer drives real STS3215 motors, jog→IK→P-control→clamp works, full
safety stack (tiered watchdog, thermal, E-STOP, soft stall) verified, keyboard
client drives the arm. Control is **LAN/TCP only**; the `mode` field merely selects
the watchdog profile. Pi 5 + a USB camera are on hand.

**M1 progress (2026-06-25):** Steps 1–2 done. **R11 retired** — Pi 5 software
H.264 of 640×480@24 costs ~26% of one core and does **not** disturb the 50 Hz loop
(49.9/49.8 `loop_hz` concurrently). **Video now exists** in the new stack: live
camera streams to a laptop browser over WebRTC (`webrtcbin`), validated on hardware
(see `rpi5/media/`). Next: **Step 3 — Supabase signaling + STUN** to take it off the
LAN (same media pipeline, swap the hand-copied SDP/ICE for the backend exchange).

**Prerequisites to have ready before coding (do these first thing):**
- [ ] Pi: `sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad,ugly} gstreamer1.0-nice libgstreamer1.0-dev` (webrtcbin lives in `-plugins-bad`; `-nice` is ICE).
- [ ] A **Supabase project** (URL + anon/service keys) for signaling + tokens (Item 3).
- [ ] Confirm the camera: `v4l2-ctl --list-devices` / `--list-formats-ext` → note the `/dev/video*` node and that it does MJPEG/raw at 640×480.

**Ordered build path (each step is independently testable):**
1. ✅ **R11 RETIRED (2026-06-25, measured on the Pi 5).** Software H.264 (`x264enc`
   zerolatency/ultrafast) of the camera's MJPG 640×480 @24, core-pinned (core 3):
   **gst CPU avg 26% / max 29% of one core**, and the control loop held **49.9 mean /
   49.8 min `loop_hz`** *concurrently* (identical to idle baseline — zero starvation),
   temp steady ~51 °C. Software encode at this res is comfortable; no reshape needed.
   Camera (`v4l2-ctl`): MJPG + YUYV both do 640×480@30, headroom to 720p/30. Harness:
   `rpi5/media/encoder_spike.sh` + `rpi5/media/measure_loop_hz.py` (see `media/README.md`).
2. ✅ **DONE (2026-06-25) — `webrtcbin` over LAN validated on hardware.** Live
   camera renders in a laptop browser over WebRTC end-to-end (Pi offerer →
   hand-copied SDP/ICE → browser answerer): `rpi5/media/webrtc_sender.py` +
   `webrtc_receiver.html`, reusing the R11 pipeline (`decodebin → convert/scale/rate
   → x264enc → rtph264pay → webrtcbin`), core-pinnable. Media path also confirmed
   sans-WebRTC via `rpi5/media/rtp_lan_test.sh` (H.264/RTP/UDP to a laptop).
   **Three `webrtcbin` fixes needed on gst 1.26.2 / PyGObject 3.50 / py3.13**
   (documented in `media/README.md` so we don't relearn them): (a) force the
   transceiver `SENDONLY` before `create-offer` (else
   `set_local_description: should not be reached`); (b) call `set-local-description`
   synchronously while the `create-offer` promise reply is still in scope (deferring
   it frees the reply → dangling offer → segfault); (c) collect ICE via the
   `on-ice-candidate` signal, not
   `local-description` (returns None). **Known residual:** occasional segfault on a
   *re-run* (webrtcbin negotiation timing race); clean SIGINT teardown mitigates,
   re-run if it hits — spike-only, gone once Step 3 owns signaling. `webrtcsink`
   (gst-plugins-rs, internal negotiation) is the fallback if it recurs in
   production, but is **not** packaged on the Pi (would need a Rust source build) —
   not pursued since bare `webrtcbin` works.
3. **Supabase signaling** — replace the hand-copied SDP/ICE with the Supabase
   exchange (offer/answer + candidates). This is the reusable core (§3.1-B); build
   once. Add a **public STUN** (`stun.l.google.com:19302`) → expect STUN-direct on
   most home NATs.
   ✅ **Built (2026-06-25), hardware test pending:** `rpi5/media/signaling.py`
   (hand-rolled Supabase Realtime/Phoenix broadcast client, only dep
   `websocket-client`; reuse existing backend Supabase project, isolate by channel
   `realtime:<NORI_ROOM>`), `webrtc_robot.py` (offerer; Step-2 pipeline + trickle
   ICE + STUN from `.env`; offers on operator `ready`), `webrtc_operator.html`
   (supabase-js answerer, no paste boxes). Config via `rpi5/media/.env`
   (`.env.example` + zero-dep `env_config.py` loader). **WAN-validated 2026-06-25**
   — live camera to an off-network laptop via STUN-direct. Gotcha: if Realtime
   authorization is on, channels are private and need an RLS policy for anon
   broadcast (`--debug` shows the Phoenix frames). ✅ **VERIFIED COMPLETE
   2026-06-25** — stable idle (heartbeats flowing), leave/join/exit at will.
   **Reconnection/session handling (done):** signaling does blocking recv +
   heartbeat + auto-reconnect with backoff (fixed a 10 s socket-timeout that killed
   idle links). `webrtcbin` is single-shot and **deadlocks if torn down to NULL
   mid-connection** (froze the GLib loop → no reconnect *and* no Ctrl-C), so we use
   **one session per process + a `run_robot.sh` supervisor**: the robot serves one
   operator then exits cleanly (operator `bye` / failed connection), and is
   relaunched for the next — process exit reclaims camera/DTLS. Operator page: fresh
   `RTCPeerConnection` per offer, `ready` retry until connected, `bye` on close,
   re-`ready` on `robot_here`. Reconnect either side freely; no "connect within
   seconds" constraint. (Toward §3.2 safe-hold + auto-resume.) **Idle-stability bug
   fixed 2026-06-25:** the Phoenix heartbeat thread self-deadlocked (`_next_ref()`
   grabbed the same non-reentrant lock already held by the heartbeat `send`), so no
   heartbeat ever went out and Supabase closed every idle socket at its ~60 s
   timeout; split into a separate `_reflock`. Also sends an `access_token` push +
   `private:false` join to match supabase-js.
   **Step 3 is a functional spike — known limitations flagged in `media/README.md`
   ("harden before real use"):** no auth (public anon channel), single operator,
   process-level reconnect (~1 s gap), no TURN yet, `webrtcbin` fragility, and video
   is not yet unified with the control session. Those are Steps 4–6 (auth/TLS/token,
   TURN, control-on-WAN) — addressed when we return to M1 hardening.
4. **Unify control onto the WAN session** — daemon selects the **WAN watchdog
   profile {300/1000}** at handshake (already plumbed via `mode`), assert a Supabase
   **scoped token**, wrap control in **TLS**. Verify WAN jitter doesn't false-trip
   the watchdog (the WAN profile + the non-blocking telemetry fix already help).
   ✅ **Built 2026-06-25 (functional; TLS+token deferred):** control rides a WebRTC
   **data channel** on the same connection as video (shares NAT traversal).
   `webrtc_robot.py` opens a `control` channel and bridges it to the daemon's NDJSON
   TCP `:7777` via `DaemonBridge` (sends `hello` `mode=wan` → WAN watchdog profile;
   forwards operator jog/command in, telemetry out). `webrtc_operator.html` captures
   the keyboard, streams 50 Hz level jog, and shows telemetry. Daemon stays the
   single RT authority (just relayed jog frames). Run: daemon + `run_robot.sh` on the
   Pi, operator page drives.
   ✅ **WAN auth added 2026-06-25 (§3.1-C, M1 baseline):** shared-secret
   `NORI_ROOM_TOKEN` with an **HMAC challenge-response** — robot broadcasts a
   per-session nonce in `robot_here`, operator returns `HMAC-SHA256(token, nonce)` in
   `ready`, token never transmitted, replay-resistant per session. Wrong/missing →
   rejected (no offer, no control); blank = open dev room (`webrtc_robot.py`
   `_authorized`, `webrtc_operator.html` `hmacHex`, `env_config` `room_token`).
   **TLS is already satisfied** end-to-end: WebRTC data channel = DTLS, Supabase
   signaling = WSS — no plaintext control on the wire. **Deferred to M4:** short-lived
   Supabase-*minted* scoped tokens + per-operator identity (current token is the
   software-key fallback per R3).
   **Control scheme switched to per-motor (joint space) 2026-06-25** (the rpi4
   hybrid task-space jog felt unintuitive): added `ArmJog` joint fields +
   `TeleopArm::apply_joint_jog` (direct per-motor deltas, no IK/coupling, clamped),
   auto-selected when a frame carries joint keys (`protocol.cpp`); both clients
   (`webrtc_operator.html`, `clients/keyboard_teleop.py`) send joint deltas. Keys:
   Q/A W/S E/D R/F T/G Y/H = the 6 motors (+/-). **The task-space/IK jog path is
   preserved** (frames with x/y/pitch) for M2 VR. Verified on the mock: a joint jog
   moves only the commanded motor.
   **Revised to a toggle, default cylindrical (2026-06-25):** the user confirmed the
   rpi4 cylindrical scheme feels great, so both clients now default to it with `M`
   toggling to per-motor (daemon supports both; verified on mock — cylindrical `x`
   moves shoulder_lift+elbow via IK, per-motor moves one joint).
   **Critical stall-detector fix (2026-06-25):** the L2 stall was misreading a joint
   *holding the arm against gravity* (high current, not moving) as an obstruction and
   cutting torque → arm went limp, `reset_latch` couldn't recover (it doesn't clear
   thermal/stall-from-gravity). Fixed in `safety.cpp`: a non-gripper joint only
   accrues a stall while *actively commanded to move* (target changing) but not
   moving; static holds never trip. Real obstruction still latches (selftest passes);
   gripper grip-hold preserved. This was likely the main cause of the "controls stop
   working after a while, reset doesn't help" reports across schemes.
5. **Laptop "remote mode"** (`NoriLeLab`) — ✅ **BUILT 2026-06-25, hardware test
   pending.** The standalone `webrtc_operator.html` is ported into the NoriLeLab laptop
   app as a first-class page so the app is the single control client (§e). New files:
   `NoriLeLab/frontend/src/nori/remote/teleop.ts` (`RemoteTeleop` — framework-agnostic
   TS port: same Supabase signaling wire protocol, WebRTC answerer with fresh
   `RTCPeerConnection` per offer, unreliable+unordered control data channel, HMAC
   room-token auth, STUN/TURN + force-relay, cylindrical/per-motor keymaps, telemetry)
   and `NoriLeLab/frontend/src/nori/pages/remote.tsx` (video + settings + telemetry +
   keyboard), routed at `/nori/remote` with a nav entry. It **reuses the app's existing
   Supabase client** (URL/anon key from `/nori/config`) — no paste boxes — so the laptop
   and the **Pi `.env` must target the same Supabase project**, and **Room/Room-token
   must match the Pi**. Typechecks + lints clean (only a pre-existing unrelated
   `meshLoaders.ts` tsc warning). LAN/WAN: the daemon's WAN watchdog profile is selected
   by the robot bridge's `mode=wan` handshake; the operator doesn't need a separate
   toggle (the same session works on either network — only ICE differs).
6. **TURN relay fallback** — 🔌 **WIRED 2026-06-25 (provider TBD).** Provider-agnostic
   relay-fallback path is in place end-to-end: `webrtc_robot.py` adds any configured
   TURN servers via `add-turn-server` (`NORI_TURN`/`NORI_TURN_USER`/`NORI_TURN_CRED`,
   creds URL-encoded into the URI by `env_config.turn_uris()`); `webrtc_operator.html`
   has matching TURN URL/user/cred fields, builds `iceServers`, a **"force relay"**
   checkbox (`iceTransportPolicy:"relay"`) for the acceptance test, and `getStats`
   logs the winning candidate type (`host`/`srflx`/`relay`). It is **additive** — ICE
   still prefers host/STUN-direct; blank `NORI_TURN` = STUN-only (unchanged default).
   **Remaining:** pick + plug in a provider (managed Cloudflare/Metered/Twilio, or a
   self-hosted coturn on a public-IP VM — config identical, only URL/creds differ) and
   run the force-relay validation (§3.2 acceptance: one relayed connection proven).
   **M4:** auto-minted short-lived TURN creds (coturn REST / provider API) instead of
   pasted static ones.

**Code locations:** media pipeline as a **separate core-pinned process** under
`rpi5/` (not in the 50 Hz daemon); Supabase signaling client shared; laptop app in
`NoriLeLab`. Keep the daemon's control path **unchanged** — M1 is an additive
network/media layer (the whole point of the M0 contract).

**Don't reopen (decisions locked):** GStreamer `webrtcbin`; Supabase signaling +
STUN-first + coturn TURN fallback; **no Tailscale** in the data path; nlohmann/json.

---

## 4. Milestone M2 — VR headset teleop (over WAN) ⭐

**Goal:** the same remote session, driven from a Meta Quest 3. **VR is almost entirely laptop-side** — it emits the same `jog` command set as the keyboard, so the **daemon's control path is unchanged from M0/M1** (no daemon IK work for M2). Decided 2026-06-24 (`onboard_pi_plan.md` §e, option (a)): VR → `jog`, not raw poses.

### 4.1 Components & tasks

**A. App WebXR → `jog` mapper** (`NoriLeLab`, laptop — the bulk of M2)
- [x] Quest connects to the **app's** WebXR endpoint on the operator machine (localhost = secure context via `adb reverse tcp:8080 tcp:8080`, no cert pain) — per `onboard_pi_plan.md` §e. ✅ `frontend/src/nori/remote/vr-session.ts` (`VrSession`) runs a three.js `immersive-vr` session: robot WebRTC video as a 2m scene panel, per-frame `XRInputSource` grip-pose + gamepad sampling → `VrFrame`. Page `frontend/src/nori/pages/vr.tsx` (route `/nori/vr`, nav "VR") reuses the Remote page's saved session settings; keyboard works as a headless fallback.
- [x] **Port the delta math from rpi4 to the laptop mapper:** ✅ `frontend/src/nori/remote/vr.ts` (`VrJogMapper`) ports `handle_vr_input`/`get_vr_base_action` (`teleop_server.py:512-612,816-831`) → normalized **`jog`** rates over the 6-DOF task space (`shoulder_pan,x,y,pitch,wrist_roll,gripper`) + base + z-lift. Rate = per-frame delta ÷ daemon step (`kXyStep`/`kDegreeStep`), clamped ±1. Both arms (L ctrl→left_arm, R ctrl→right_arm).
- [x] No new daemon control code: ✅ mapper emits the daemon's existing `control{jog}` payload via `RemoteTeleop.setExternalJog` — jog→IK→clamp→motor path byte-for-byte unchanged from M0. (`teleop.ts` refactored: `jogTick` prefers an injected `ExternalJog`, else keyboard; new public `command()`.)

**B. VR control semantics** (`onboard_pi_plan.md` §e/§b)
- [x] **Clutch** ("squeeze to move"): ✅ handled **laptop-side** in `VrJogMapper` (grip button, hysteresis) — release → emits zero/hold `jog` and forgets the pose baseline; re-squeeze re-establishes baseline (no snap). **No `control.clutch` daemon field** — keeps the C++ untouched per the "VR queries the jogger" directive.
- [x] **Re-clutch on resume**: ✅ `VrJogMapper.reclutch()` drops both baselines so a fresh squeeze is required after any safe-hold. Wired in `VrSession` (inline on E-STOP/reset) and by `pages/vr.tsx` when `connState` → `failed`/`disconnected`.
- [x] **Controller E-STOP** button → `command{estop}`: ✅ left-X rising edge in the mapper (`VrMapResult.estop`) → `teleop.command("estop")` + `reclutch()`. **reset** = hold left-Y 1.5s (`VrSession.handleResetHold`) → `command("reset_latch")`; R13 confirmation is satisfied by the operator being in-headset watching live video.

**C. Haptics**
- [x] Map gripper current (telemetry `currents` — the virtual tactile signal) → **Quest controller rumble** on contact (laptop-side). ✅ `RemoteTeleop.onCurrents` surfaces `currents`; `VrSession.applyHaptics` maps `{left,right}_arm_gripper` current → that hand's `gamepad.hapticActuators[0].pulse()`. Thresholds (`HAPTIC_IDLE`/`HAPTIC_FULL`) are placeholders to tune on hardware.

### 4.2 M2 acceptance criteria
> Status (2026-06-26): **§4.1 code complete** (mapper + WebXR session + haptics; `tsc`,
> `eslint`, and `vite build` all clean). The criteria below are **pending hardware** — they
> need a Quest 3 + robot. Runbook to run them: `rpi5/media/README.md` → "M2 — VR teleop".
- [ ] Drive both arms from the Quest **over WAN** with clutch engage/disengage working naturally.
- [ ] Mid-session link drop → safe-hold → **re-clutch required** to resume (verified, no snap).
- [ ] Controller E-STOP latches; reset requires the deliberate gesture + visible scene.
- [ ] Contact on the gripper produces a perceptible rumble.

---

## 5. Sequencing, dependencies & risk pins

```
M0  bus+loop+safety+JSON ──┬─> M1  webrtcbin + Supabase signaling + STUN + app remote ──> M2  VR→jog mapper (laptop)
   (LAN, jog client tests) │      (off-network laptop + video; TURN fallback)              (Quest over WAN; daemon unchanged)
                           └─> nori-protocol submodule + golden tests (shared, start in M0)
```

**Hard dependencies**
- M1 needs Supabase **signaling + auth** (Item 3) — **start that backend track in parallel with M0** so it's ready when M1 begins. (Signaling is the reusable core; STUN needs no server; TURN/coturn is an additive fallback.)
- M2 needs M1's WebRTC session (video/data transport) and the app's WebXR relay.

**Decisions pinned (no longer open)**
- WebRTC library: **GStreamer `webrtcbin`** (reused for §g audio); libdatachannel only as a fallback if encoder isolation fails.
- NAT traversal: **WebRTC + Supabase signaling + STUN first, self-hosted coturn/TURN as ICE fallback. No Tailscale in the data path.**
- JSON lib: **nlohmann/json** (M0).

**Risks carried from `onboard_pi_plan.md` to watch during build**
- **R11** (Pi 5 software encode starving the loop) — the single biggest M1 unknown; measure early, core-pin.
- **R16** (shared USB hub power/bandwidth) — validate motor inrush + cameras + (later audio) on the powered hub during M0 bring-up.
- **R8** (protocol drift) — the `nori-protocol` submodule + golden fixtures must land in M0, not retrofitted.
- **R12 / R3** (per-unit calibration + identity) — stubbed (manual scp + software key) through M2; real provisioning is M4.

---

## 6. First concrete steps (week 1)
1. `git init` `nori-protocol`; draft the JSON control+telemetry schema from rpi4's protocol; wire it as a submodule into `rpi5/`.
2. Scaffold `rpi5/nori_core_agent/` (CMake, dirs, nlohmann, **link the C++ Feetech SDK**); hello-world that opens one bus via `PortHandler` and pings all motors.
3. In parallel: spike the Supabase **WebRTC signaling + scoped-token** flow (SDP/ICE exchange) so M1 isn't blocked — STUN-only to start; coturn comes later as the fallback.
4. Port the bus codec + GroupSync ops; get `sync_read_positions` matching rpi4 output on the same robot.
