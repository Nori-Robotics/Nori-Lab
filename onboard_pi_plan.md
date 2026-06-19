# Item 2 — Pi Onboarding & Over-the-Air Updates

> **Scope note:** This document lives in the `NoriLeLab` (laptop app) repo **for context only**. The work it describes runs **on the robot (Raspberry Pi)**, not on the laptop. The laptop app's view of these changes — and the LAN contract it depends on — is in [`NORI_PLAN.md`](NORI_PLAN.md) (see the *Pi daemon LAN contract matrix*).

This phase replaces the prototype bash scripts and Python server architecture with a hardened, embedded-Linux deployment. The core objective is a deterministic, memory-safe execution environment (**< 100 MB baseline RAM**) that survives extended uptimes in consumer homes without GC pauses, memory leaks, or network-induced stutter.

---

## a) Factory Pre-Imaging & OS Tuning

The Pi ships with the OS, host agent, per-unit identity, and configuration pre-installed.

- **Base image:** headless Pi OS Lite, aggressively stripped — remove Wayland, X11, PulseAudio, and unneeded kernel modules. **Idle RAM target < 100 MB.**
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
 Timestamp Validator (100 ms)              Hardware Polling (Core 1/2)
```

### True threading & bus concurrency
Dedicated threads pinned to specific CPU cores via `pthread_setaffinity_np`. Bus 1 (`/dev/xlerobot_bus1`) and Bus 2 (`/dev/xlerobot_bus2`) are polled **concurrently** via raw C `termios` calls, eliminating the sequential I/O propagation lag of the old `scservo_sdk`.

### Servo monitoring (thermal / current)
Motor threads continuously read `Present_Current`, `Present_Position`, and thermal registers. If `Present_Current` spikes while `Present_Position` delta stays near zero (a physical obstruction), the C++ loop immediately sets an atomic `e_stop_latched` flag.

### Latching requirement
Unlike the prototype's stall-soften (which auto-recovers), this C++ state is a **hard latch**: it cuts `Torque_Limit` and drops current instructions. Recovery requires an **explicit user reset via the UI/app** — the obstruction may be a human.

### Network monitoring & buffer depth
The network ingestion thread unpacks incoming binary C-structs and pushes them into a lock-free ring buffer. The motor thread checks `timestamp_us` of the active chunk.

- **Reconciliation:** if `std::chrono::steady_clock` exceeds the newest buffered timestamp by `WATCHDOG_THRESHOLD` (~100 ms), the daemon executes a mathematically smooth deceleration ramp to a safe-stop (not a hard stop). It resumes only when the buffer is refilled with fresh, contiguous timestamps.
- ⚠️ **Open value:** current baseline is a 500 ms dead-man timer; the proposed ~100 ms is the *start-worrying* threshold — settle the exact value against measured buffer depth.

---

## c) Headless WiFi Onboarding

This is the **only** end-user setup step.

- **Execution:** on first boot, if no known networks are found, a Python utility configures `hostapd` + `dnsmasq` to broadcast a `Nori-Setup-XXXX` access point. The user connects, loads a captive portal, submits home WiFi credentials. The Pi joins the LAN and advertises itself via mDNS (`xlerobot.local`).
- **Framework justification:** Python is used here deliberately — a run-once, exits-after task outside the real-time motor path, where library convenience (HTTP servers, NetworkManager DBus wrappers) outweighs C++ performance benefits.
- **Launch security:**
  - The pairing handshake requires **token authentication**.
  - The pipeline strictly forbids writing **video buffers** to the persistent cache (SD card) to prevent flash wear and privacy leaks. **See risk R5 below — this needs reconciliation with the recording flow.**
  - Local configs use `.json`; any persistent tensor logic uses `.safetensors` (no `pickle` → no arbitrary code execution).
  - Must be **opt-out** so developers can disable it via SSH.

---

## d) Secure OTA Updates

Field units need a robust, zero-downtime update path for the C++ agent, ML policies, and system dependencies.

- **A/B partitioning:** via a robust controller (RAUC or Mender). Two rootfs partitions; updates stream to the inactive one in the background. On reboot the bootloader flips to the new partition; if `nori-core.service` crashes on boot, it falls back to the previous working partition.
- **Cryptographic identity:** updates are signed and verified against the factory-flashed per-unit identity (in a secure enclave or read-only EEPROM — **not** a shared image secret). This same hardware ID authenticates the robot to the Item 3 Supabase registry.

---

## UI Migration Strategy

The frontend kiosk (`index.html`) follows a staged migration to fit the **1 GB Pi RAM ceiling**:

### Phase 1 (Launch)
`chromium-browser --kiosk` serving the existing HTML/WebSocket UI over `localhost:9090`. Works today, zero rewrite, allows immediate beta shipping.

### Phase 2 (RAM-driven C++ migration)
When the RAM budget is breached by Phase 3's heavy V4L2 zero-copy camera streams, Chromium is removed and the UI is rewritten in **Slint** or **LVGL**, compiled into the `NoriCoreAgent` daemon.

- **Architecture:** bypasses the X11/Wayland window manager entirely — draws directly to the DSI screen via DRM/KMS or `/dev/fb0`.
- **Performance:** UI memory drops from ~150 MB (Chromium) to **< 20 MB**, hitting a stable 60 fps. IPC changes from network WebSockets to internal lock-free event queues between UI and motor threads.

> **Launch outcome:** an assistive user unboxes the robot, connects WiFi via their phone, runs the laptop application, and the robot fetches and tidies — zero code. Developers get open LeRobot underneath, a mathematically stable native C++ hardware profile, and ROS/remote access without web-browser overhead.

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
│   │   ├── binary_protocol.hpp
│   │   └── ui_manager.hpp
│   └── src/                      ◀── Implementation source blocks (.cpp)
│       ├── main.cpp              ◀── Init, affinity layout, core thread setup
│       ├── bus_controller.cpp    ◀── termios Feetech bus worker logic
│       ├── safety_watchdog.cpp   ◀── 50 Hz stall + timestamp monitoring loops
│       ├── video_grabber.cpp     ◀── Zero-copy kernel mmap frame capture
│       ├── network_broker.cpp    ◀── Binary payload / WebRTC broker
│       └── ui/
│           ├── face_canvas.slint ◀── Declared UI layout definitions
│           └── ui_manager.cpp    ◀── Slint integration bridge (or LVGL)
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

These are tensions or gaps surfaced while aligning this doc with the laptop app's [`NORI_PLAN.md`](NORI_PLAN.md). None block beta, but each needs an owner/decision.

| ID | Risk | Why it matters | Suggested resolution |
|---|---|---|---|
| **R1** | **Chromium kiosk vs. RAM budget** | Phase 1 keeps Chromium (~150 MB) on a 1 GB Pi *alongside* the daemon, V4L2 camera buffers, and WebRTC encode. The "< 100 MB idle" target is the daemon baseline only — total system headroom at launch is thin. | Measure real Phase-1 peak RAM with cameras streaming **before** committing to ship on Chromium. Have the Slint/LVGL path (Phase 2) ready earlier than "when budget is breached." |
| **R2** | **UI compiled into the safety daemon** | Phase 2 compiles the UI into `NoriCoreAgent`. A UI render bug/leak can now crash the process that owns the 50 Hz safety loop. `OOMScoreAdjust=-1000` would also protect the memory-hungry UI from the OOM killer, defeating its purpose. | Keep the safety/motor loop in a **separate process** from the UI even after the Chromium removal; communicate over the lock-free queue across a process boundary (shared memory). Only the safety process gets `OOMScoreAdjust=-1000`. |
| **R3** | **No secure enclave on stock Pi 4/5** | "secure enclave or read-only EEPROM" — the Pi has no TPM by default, and the boot EEPROM isn't a general secret store. Per-unit signed identity needs a concrete mechanism. | Decide between an add-on secure element (e.g. ATECC608 / OP-TEE) vs. a sealed key in a read-only partition. Pin this before factory imaging — it's hard to retrofit. |
| **R4** | **A/B partitioning storage cost** | Two rootfs partitions roughly doubles rootfs storage on the SD/eMMC, and RAUC/Mender add bundle staging space. | Confirm the flash size budget covers 2× rootfs + update staging + the recording flash buffer (R5) simultaneously. |
| **R5** | **"No video to SD" vs. on-Pi recording buffer** ⚠️ | Item 2c forbids writing video buffers to persistent cache (SD). But `NORI_PLAN.md` (realigned) says the Pi stores recording frames as a **binary stream on local flash** during a run, which the laptop later pulls. These directly conflict. | Reconcile explicitly: e.g. (a) recording buffer is **RAM-backed / tmpfs**, not the SD persistent cache; or (b) recording is an **opt-in exception** to the no-persist privacy rule, deleted immediately after the laptop pull. Document which. |
| **R6** | **mDNS reliability** | `xlerobot.local` resolution fails on some routers/OSes (mDNS blocked, client subnet isolation). | Already covered laptop-side by manual-serial fallback; ensure the daemon **also** exposes a reachable IP path and the captive portal surfaces the assigned IP for manual entry. |
| **R7** | **Transport split: TCP control vs. WebRTC/UDP video** | `network_broker.cpp` brokers both the binary control payload and WebRTC video. The laptop expects a single TCP control socket + a separate WebRTC/UDP video channel. | Confirm the broker cleanly separates the two so a video stall can't backpressure the control stream (and vice versa). Version the binary control struct. |
| **R8** | **Shared wire-protocol drift across two repos** (resolved 2026-06-16) | The Pi daemon (`nori-teleop`) and the laptop app (`NoriLeLab`) are **separate repos — this is intentional and correct** (different toolchains: C++/CMake-on-ARM vs. Python/npm-on-x86; different deploy paths: signed A/B OTA vs. PyPI/installer; different blast radius). The split is *not* the risk. The risk is that `binary_protocol.hpp` (Pi) and the laptop's pack/unpack code become **two hand-maintained definitions of one byte layout** that drift silently — a reordered field or changed int width corrupts joint commands with no error, on a robot moving near a human. | **Keep both repos.** Fix drift with a single source of truth + a runtime tripwire (see resolution below). |

### [NEW] R8 resolution — shared protocol contract

Two repos, one contract. Don't merge them; add a thin shared definition both pull from, plus a version check that turns silent drift into a loud failure.

1. **New repo `nori-protocol`** — the canonical wire format. Start hand-rolled (easiest now): one authoritative `binary_protocol.hpp` (fixed-layout C structs, the format the daemon already speaks) + a matching Python `ctypes`/`struct` mirror for the laptop. Consume it as a **git submodule** in both `nori-teleop` and `NoriLeLab` so neither repo owns a private copy.
2. **`protocol_version` field in the TCP handshake** (and ideally every frame). Both ends assert it on connect and **refuse mismatched versions loudly** instead of decoding garbage. This is the non-negotiable safety tripwire.
3. **Golden-bytes fixture test in both repos** — same hex blob → same decoded struct — so any struct change breaks CI before it ships.

Upgrade path: if the struct set later grows beyond a handful, swap the hand-rolled header for a codegen IDL (FlatBuffers / Cap'n Proto — both zero-copy, fine for the 50 Hz path). Not needed now.
| **R9** | **E-STOP reset path** | The hard latch requires an explicit user reset, but the reset command's transport/auth isn't specified. | Define the reset as an authenticated command on the TCP control channel (see laptop `NORI_PLAN.md` LAN matrix), and confirm it's reachable even when the control stream is in safe-stop. |
