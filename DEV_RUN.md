# Dev run & test — Nori remote teleop / VR / two-way call

How to run the laptop app and exercise the Phase 7 work (remote teleop GUI, VR, two-way
audio call) **without robot hardware**, using the mock robot in the `NoriTeleop` repo.

> For the broader plan see [`full_nori_plan.md`](full_nori_plan.md) and [`todos.md`](todos.md).
> This doc is just "how do I run it and see it work."

---

## What you can and can't test without hardware

| Feature | Testable now? | Notes |
|---|---|---|
| Remote teleop GUI (telemetry panel, keybind legend, mode toggle) | ✅ | Panels render; `loop_hz`/currents/safety stay blank/stale without the C++ daemon. |
| WebRTC video | ✅ | Mock robot sends a moving-ball test pattern. |
| VR immersive session + **recenter** (double-tap right stick) | ✅ | Needs a headset + a live session (mock robot is enough). |
| **Robot → operator audio** (you hear the room) | ✅ | Mock robot sends a 440 Hz test tone (`--audio --audio-test`). |
| **Operator → robot audio** (you speak into the robot) | ❌ (gated) | Robot offers no operator-audio uplink m-line yet (Pi **M3b**). Your mic is captured + your "you" dot lights, but a **"mic local-only"** badge shows — nothing is transmitted. |
| Operator camera (M6) | ✅ build, dark by default | Behind the `nori_m6_video` flag; self-view works, uplink gated (Pi **M6**). |
| Live telemetry (`loop_hz`, grip-force currents, safety, watchdog) | ⚠️ | Needs the C++ `nori_core_agent` daemon on `:7777`. Without it the control channel still opens (control shows "active") but no telemetry flows. |
| 3D robot cubes (C6) | ❌ | Not built — needs joint positions in the telemetry schema. |

---

## Prerequisites

- **Node** ≥ 22 and **Python** ≥ 3.12, `pip install -e .` done in this repo.
- A **Supabase project** (URL + anon key) — the same project is used for WebRTC signaling
  by both the laptop app and the mock robot.
- Laptop `.env` (repo root) already has `SUPABASE_URL` + `SUPABASE_ANON_KEY` (Phase 1/2).
- The mock robot lives in the sibling repo `../NoriTeleop`. Its media deps (GStreamer) —
  see `NoriTeleop/rpi5/media/README.md`. `audiotestsrc`/`videotestsrc` need **no capture
  hardware**, so a laptop is enough to run it.

---

## 1. Run the laptop app

**Recommended for headset testing — single-origin production build on `:8000`:**

```bash
cd frontend && npm run build
cd .. && lelab            # serves UI + /nori/* proxy on :8000, opens a browser
```

Single origin means the Quest only needs **one** `adb reverse` (port 8000), and `localhost`
is a WebXR secure context (so `navigator.xr` + `crypto.subtle` work with no cert).

**For desktop iteration with hot-reload** (optional): `lelab --dev` serves the UI on `:8080`
(API still on `:8000`). Fine on the desktop; less convenient for the Quest (needs both ports
reversed).

---

## 2. Run the mock robot (no hardware)

One-time — create `../NoriTeleop/rpi5/media/.env` with the **same Supabase project** as the
laptop and a shared room name:

```ini
SUPABASE_URL=<same as NoriLeLab/.env>
SUPABASE_ANON_KEY=<same as NoriLeLab/.env>
NORI_ROOM=nori-dev
# NORI_ROOM_TOKEN=   # leave unset = open dev room (no HMAC auth)
```

Then, in a second terminal:

```bash
cd ../NoriTeleop/rpi5/media
NORI_KIOSK=0 python3 webrtc_robot.py --source test --audio --audio-test
```

- `--source test` → moving-ball video (no camera needed).
- `--audio --audio-test` → 440 Hz Opus test tone as the robot mic (no mic needed).
- `NORI_KIOSK=0` → skip the on-Pi Chromium face sidecar (irrelevant off-Pi).
- The control data channel opens even with **no daemon** — control just goes nowhere and no
  telemetry flows (expected). Run `nori_core_agent serve` on `:7777` if you want live
  telemetry / grip-force.

The robot process exits when the operator disconnects; `./run_robot.sh --source test` wraps
it in a relaunch loop if you want reconnect-friendly behavior.

---

## 3. Desktop smoke test (do this before the headset)

1. Open `http://localhost:8000/nori/remote`, sign in.
2. **Session settings** → Room = `nori-dev`, token blank → **Connect**.
3. Expect: ball video; status panel shows `link=connected`, `control=active`, `path=WAN`.
   - `loop`/`temp` read `0`/`—` and grip-force says "no current telemetry yet" — **expected
     without the daemon.**
4. **Join call** → allow mic access.
   - You now hear the 440 Hz tone (**robot audio only plays once you've joined**).
   - The **robot** dot is lit.
   - **Unmute mic** → your **you** dot lights; a **"mic local-only (Pi M3 pending)"** badge
     appears — correct: your mic is hot locally but there's no uplink to the robot yet.
5. **M6 camera (optional):** in the browser console:
   ```js
   localStorage.setItem("nori_m6_video", "1"); location.reload();
   ```
   A **Camera on** button appears → self-view thumbnail over the video. (Uplink still gated.)

---

## 4. Headset test (Quest)

1. Enable developer mode, connect over USB, then:
   ```bash
   adb reverse tcp:8000 tcp:8000
   ```
2. In the Quest browser open `http://localhost:8000/nori/remote`, sign in, **Connect**
   (same `nori-dev` room).
3. **Enter VR** (enabled once the session is `connected`).
   - Grip = clutch (squeeze to move), trigger = gripper, A/X & B/Y = that arm's lift,
     left stick-press = E-STOP, hold right stick-press = reset.
   - **Recenter (C4):** physically turn ~90°, then **double-tap the right thumbstick press**
     → the video panel snaps to your current facing (log: "recenter — video panel moved…").

---

## Expected gaps (by design — not bugs)

- **You won't speak into the robot yet.** Operator→robot audio needs the Pi to offer the
  uplink m-line (M3b). Until then: mic captured, "you" dot lit, "mic local-only" badge shown.
- **No live telemetry without the daemon.** `loop_hz`/currents/safety/watchdog need
  `nori_core_agent` on `:7777`. The control channel opening (control="active") is separate.
- **3D robot cubes (C6)** aren't built — they need joint positions added to the telemetry
  frame (confirm the schema with the Pi team).

---

## Troubleshooting

- **No video / stuck "waiting for robot offer":** the room names don't match, or the two
  `.env`s point at different Supabase projects. Both must share the project and `NORI_ROOM`.
- **"Enter VR" disabled:** you're not `connected` yet (needs the mock robot running), or the
  browser isn't a WebXR secure context (use `http://localhost:...`, via `adb reverse`).
- **No audio after Join:** browser autoplay — click anywhere on the page once, or re-toggle
  Join. Robot audio is intentionally muted until you Join.
- **Auth fails / can't sign in:** the laptop `.env` is missing `SUPABASE_URL` /
  `SUPABASE_ANON_KEY`, so `/nori/config` can't configure Supabase.
