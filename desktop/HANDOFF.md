# Desktop packaging — handoff

**Goal:** ship LeLab as a native double-click app for macOS / Windows / Linux, so a
non-technical robot operator installs it without Python, a terminal, or `pip`.

**Status:** scaffolding complete and Python-side verified; **not yet built into an
installer on any OS.** Everything here is a starting point for you to build, test on
hardware, and productionize. Read this first, then [README.md](README.md) for the
mechanics.

---

## The decision (so you don't relitigate it)

We evaluated three paths. Picked **Option 1: Tauri shell + frozen Python backend.**

| Option | Verdict |
|---|---|
| **1. Tauri + frozen backend** | ✅ **Chosen.** Reuses 100% of the existing React + FastAPI code; the frontend is already origin-agnostic. $0/mo to run. It's a packaging chore, not a rewrite. |
| 2. Cloud UI + thin local agent | Deferred. Better for fleet/remote, but inherits Option 1's packaging *and* adds cloud→localhost cert/latency problems. It's the *next* step, not the first. |
| 3. Browser WebSerial/WebUSB | Rejected. Chrome/Edge-only; would throw away the LeRobot Python stack. |

**Two load-bearing sub-decisions:**

1. **Inference stays local (torch ships in the bundle).** A robot's motor-command loop
   must not depend on Wi-Fi. This is why the download is ~400 MB, not ~200 MB. Accepted
   deliberately. Moving inference to the cloud is a *possible future* size lever, not a TODO.
2. **Training stays cloud** (already true via `nori_cloud`/`hf_cloud` in `jobs.py`). The
   bundle therefore excludes `wandb` and does **not** support the local training runner.

**Scope boundary — the VR counterpart ships separately, not from this bundle.** The
easy-access VR surface is a *hosted, LeLab-free static page* (Vercel/Cloudflare Pages),
because the VR drive loop needs no local server — see
[`../frontend/DEPLOY_FRONTEND.md`](../frontend/DEPLOY_FRONTEND.md). So this desktop
bundle owns the full operator app (setup/pairing/marketplace/training/keyboard teleop);
it does **not** need to solve headset access. The two tracks are independent and can be
built in parallel. (This hosted page is a first taste of Option 2 above, scoped down to
the one surface that doesn't need the local agent.)

---

## What's built (current state)

| File | State | Verified? |
|---|---|---|
| `lelab/utils/child_process.py` | `module_cmd()` shim — frozen vs source subprocess argv | ✅ compiles, lints clean |
| `lelab/rollout.py` (edited) | inference spawn routed through `module_cmd()`; removed unused `import sys` | ✅ compiles, lints clean |
| `desktop/backend_entry.py` | frozen entry: `_child` runpy dispatch, else headless uvicorn | ✅ compiles |
| `desktop/lelab_desktop.spec` | PyInstaller: collect lerobot, exclude rerun/wandb/cmake | ✅ runs; produces a working 768 MB bundle (macOS arm64) |
| `desktop/build.sh` | CPU-torch pin → freeze → smoke test → stage into Tauri | ✅ run on macOS (use `PYTHON=python3.13`; 3.12 default absent) |
| `desktop/tauri/*` | Rust shell (v2 API): spawn backend, wait for port, open window | ⚠️ never compiled |

**"Verified" means the Python compiles and lints — it does NOT mean a bundle was
produced or run.** No PyInstaller build, no `cargo build`, no hardware test has happened.
Treat the `.spec`, `build.sh`, and Rust as first-draft-that-should-work, not proven.

---

## TODO — in order

### 1. Produce a working backend bundle (½–1 day) — ✅ DONE on macOS arm64
- [x] `cd frontend && npm run build` (backend serves `frontend/dist`).

> **Build only from a committed, CI-green tree.** The spec bundles two generated artifacts that
> must agree: `frontend/dist` (the executor — ScriptDriver/AgentSession) and
> `frontend/packages/nori-sdk/robot-tools.json` (the agent's tool schemas, loaded by `server.py`).
> Both are committed and the `robot-ops.drift` test guards that they match at commit time, so a
> bundle from committed `main` is internally consistent by construction. Do NOT bundle from a dirty
> tree where you edited the manifest but skipped `npm run gen:robot-tools` — you'd ship an agent
> whose tool list disagrees with its own executor.
- [x] Run `./desktop/build.sh` on macOS. **Invoke as `PYTHON=python3.13 ./desktop/build.sh`**
      — the script defaults to `python3.12`, which may be absent (3.13 satisfies
      requires-python; avoid 3.14 — no prebuilt torch/lerobot wheels yet).
- [x] Confirm the smoke test passes — `_child lerobot.scripts.lerobot_rollout --help`
      imports cleanly with torch. **Bundle size: 768 MB on disk** (under the ~1 GB target).
      No `nvidia_*` CUDA leak; rerun/wandb excludes held.

**Spec fixes made to get here** (`lelab_desktop.spec`) — lerobot gates optional deps behind
`require_package("<name>")` calls that `find_spec()` at import time, so each must be
physically bundled or the frozen `_child` aborts. Two rounds surfaced `datasets` then `av`;
rather than loop, the spec now `collect_all`s **every installed `require_package` target**
(datasets, av, accelerate, deepdiff, gymnasium, jsonlines, pandas, pynput, serial). Also
fixed: the old spec collected `feetech_servo_sdk` — **a module that does not exist**; the
real feetech import name is **`scservo_sdk`**, so the serial driver was never actually
bundled before (latent hardware-path bug, would've bitten in step 2). `rerun` is installed
but stays excluded (dataset-viz only, not on our paths) — revisit if a record path needs it.

**Critically, `lelab` itself must be collected.** The serving path is
`uvicorn.run("lelab.server:app")` — a *string* import PyInstaller can't see statically — so
without `"lelab"` in the collect list the frozen backend boots and dies with
`ModuleNotFoundError: No module named 'lelab'`. The old `_child`-only smoke test missed this
because it imports lerobot, not lelab. The build now **also boots the backend headless and
asserts `:8000` answers `HTTP 200`** — test the real serving path, not just imports. When
you add a new string/lazy import to the serving path, extend this boot test too.

> ⚠️ This was built with Python **3.13** (`python3.14` is the machine default but lacks
> torch wheels). The `.build-venv` is warm; a fast re-freeze that skips the torch download
> is: `source desktop/.build-venv/bin/activate && cd desktop && rm -rf build dist &&
> pyinstaller lelab_desktop.spec --noconfirm --distpath ./dist --workpath ./build`.

### 2. Prove the hardware paths in the frozen bundle (1 day, needs an arm)
The build smoke test only checks imports. Run the *actual* bundle binary and:
- [ ] Calibrate → teleoperate (serial ports open from inside the bundle).
- [ ] Record a short episode (cameras + `av`/`pyarrow` write parquet).
- [ ] **Run inference on a checkpoint** — the torch + `_child` path most likely to break.
      If an import fails here, a needed module is in `excludes` in the spec — pull it out.

**Fixed en route — leader auto-detect hung on Bluetooth serial ports.** The leader-setup
page auto-runs `autoDetectPort()` on load, which probed *every* `/dev/cu.*` port. A paired
Bluetooth audio device (a Bose speaker / Razer headset showed up as `cu.MicroBoseSpeaker`,
`cu.RazerKrakenBTKittyEditi`) isn't caught by the name blocklist, and opening its RFCOMM
serial port can block macOS indefinitely — freezing the loading wheel. Fix
(`nori_leader_setup.py`): `_is_probeable_port` now **allowlists USB serial only**
(`usbmodem`/`usbserial`/`ttyUSB`/`ttyACM`, or a populated USB hwid) instead of blocklisting
Bluetooth names — a leader bus is always USB. Verified auto-save dropped from ~6 s (two BT
ports × 3 s deadline) to ~0 s. NOTE: the real arm still needs an on-device check that it
detects (its `cu.usbmodem*`/`cu.usbserial*` node passes the allowlist).

### 3. Wrap it in Tauri (1–2 days)
- [ ] `cargo install tauri-cli`; generate icons: `cargo tauri icon <logo.png>`.
- [ ] `cd desktop/tauri && cargo tauri build`. The Rust is written against the Tauri v2
      API but has never been compiled — expect small API/signature fixes.
- [ ] Verify lifecycle: window opens at `:8000` only after the backend answers, and the
      backend child is **killed on window close** (check for orphan `lelab-backend` procs).

**Orphan-kill hardening (implemented) — three exit paths covered:** (1) `main.rs`
`WindowEvent::Destroyed` kills the child on window close; (2) `main.rs` now also handles
`RunEvent::Exit` (via `.build().run(|handle, event| …)`) so a Cmd+Q that skips Destroyed
still tears it down; (3) `backend_entry.py::_install_parent_death_watchdog()` polls
`getppid()` and hard-exits when the parent dies — the only thing that catches a Ctrl+C on
`tauri dev`, a crash, or a force-quit, none of which fire the Rust handlers. Symptom this
fixes: `[Errno 48] Address already in use` on the next launch because a prior frozen
backend still held :8000. Manual clear if ever needed:
`lsof -nP -iTCP:8000 -sTCP:LISTEN -t | xargs kill`.

### 4. Build matrix + signing (1–2 days) — 📄 OWNED SEPARATELY
**Full handoff:** [`BUILD_AND_SIGNING.md`](BUILD_AND_SIGNING.md). Assigned to a colleague;
it's a self-contained CI + platform-signing chunk that doesn't touch app code. Summary:
- [ ] GitHub Actions matrix (macos-14 / windows / ubuntu-22.04) running `build.sh` + `cargo
      tauri build`, uploading installers as release artifacts (one native runner per OS —
      PyInstaller can't cross-compile).
- [ ] macOS: Apple Developer ID ($99/yr) → codesign + notarize (unsigned = Gatekeeper block).
- [ ] Windows: Authenticode cert (~$100–400/yr, OV vs EV decision) or users hit SmartScreen.
- [ ] Linux AppImage: no signing; verify on clean Ubuntu, watch the glibc floor.
- Depends on step 5's public `.env` being staged into the bundle before `tauri build`.

### 5. Config UX + secret handling (½–1 day)
Nori cloud features need **three PUBLIC values** in the frozen backend's env:
`SUPABASE_URL`, `SUPABASE_ANON_KEY` (browser auth via `/nori/config`) and **`NORI_BACKEND_URL`**
(the JWT proxy target — its default `http://localhost:8001` is dev-only, so without it every
cloud feature proxies to nowhere even when auth works). A shipped app has no repo `.env`, and
the frozen backend's CWD is `resources/backend/`, so lelab's own `load_dotenv()` finds nothing.

**Mechanism (implemented):** `backend_entry.py::_load_adjacent_env()` loads a `.env` sitting
next to the executable (`override=False`, so a real exported env var still wins for dev). Template:
`desktop/env.public.example`.
- [x] **Wire `build.sh` to stage the `.env` into the bundle (done).** After staging the
      frozen backend, `build.sh` copies a public `.env` next to the binary. Source, in
      priority order: `$NORI_BUNDLE_ENV` (a path — use in CI) → `desktop/env.public` (a
      gitignored local copy you fill from `env.public.example`). Missing → warns but still
      builds (app runs, cloud stays unconfigured). So to self-configure a build now:
      `cp desktop/env.public.example desktop/env.public && $EDITOR desktop/env.public`,
      then re-run `build.sh`. `desktop/env.public` is gitignored.
- [ ] For **local `tauri dev`** you can skip the file and just export the three vars first
      (they're inherited by the spawned backend): `export SUPABASE_URL=… SUPABASE_ANON_KEY=…
      NORI_BACKEND_URL=https://nori-backend-production.up.railway.app`.
- NEVER put the Supabase service-role key or `ANTHROPIC_API_KEY` in this file (see the
  secret-handling decision above — LLM routes through Railway). `resources/backend/` is
  gitignored, so a filled-in `.env` there won't be committed.

**LLM cloud-proxy — ✅ CODE-COMPLETE (pending Railway key + deploy).** The Anthropic key no
longer lives on the laptop or in the bundle. All three LLM surfaces now forward through
Nori-Backend behind the customer JWT:
- **Nori-Backend** (branch `feat/llm-cloud-proxy`): new `POST /api/v1/agent/llm/messages`
  and `/messages/stream` in `src/routes/agent.py` — gate on the daily budget (429 if capped),
  call Anthropic with the server-held key, charge the turn's real usage, return the raw
  message. `anthropic` added to `requirements.txt`; `ANTHROPIC_API_KEY` documented in
  `.env.example`.
- **LeLab**: `NoriClient.llm_messages` / `llm_messages_stream` (`nori_client.py`) forward the
  payload; `server.py`'s `nori_llm_generate`, `nori_llm_generate_stream`, and `nori_llm_agent`
  dropped their local `anthropic.Anthropic(...)` calls. Codegen is now metered too (it forwards
  the JWT via the existing `X-Nori-JWT` the frontend already sends — no frontend change).
- **To go live (human steps):** (1) set `ANTHROPIC_API_KEY` (and optionally `NORI_LLM_MODEL`)
  in Railway's env; (2) review + deploy the `feat/llm-cloud-proxy` branch (the requirements
  bump makes Railway install `anthropic`). Neither repo has been committed/pushed.

**Decision — the Anthropic key must NEVER live on a customer machine (route LLM through
the cloud).** A desktop bundle is fully in the customer's hands: PyInstaller archives unzip,
`strings` finds embedded keys, traffic can be sniffed. So *no* long-lived provider secret
(`ANTHROPIC_API_KEY`, Supabase service-role) may ship in the bundle. Verified the current
bundle is clean — PyInstaller doesn't embed env vars, `build.sh` copies no secrets, `main.rs`
injects none, and a `strings` scan finds no `sk-ant…`. The consequence is that today the
agent/coding endpoints return `503 ANTHROPIC_API_KEY not set` in a shipped app.

The fix (implement later): **`lelab/server.py`'s LLM endpoints proxy to Nori-Backend
(Railway) instead of calling `anthropic.Anthropic(...)` directly with a local key.** Railway
holds the key server-side and authenticates per-user via the forwarded JWT — the exact
pattern the other `/nori/*` proxy routes already use (`_nori_proxy`). Then no key ever
touches a customer's machine. Cost is already governed there: the agent loop
(`nori_llm_agent`, `server.py:860`) gates on `GET /agent/usage` (429 when `hard_capped`) and
charges actual usage post-turn, per-customer, JWT-keyed, failing closed. TODO when doing
this: extend the same per-user gate to the one-shot coding endpoint (`_llm_prepare`,
`server.py:498`), which currently checks the key but not the daily budget.
- Supabase **anon** key is public by design — safe to bake (VITE_ / `/nori/config`).
  Service-role key stays Railway-only, never client-side.

---

## Risks & gotchas

- **CUDA regression = the #1 size trap.** On Windows/Linux a stray default `torch` wheel
  drags ~2 GB of `nvidia_*`. `build.sh` installs CPU torch first to prevent this — if the
  bundle balloons, that step got skipped or reordered. Verify no `nvidia_*` dirs land in
  the bundle.
- **PyInstaller can't cross-compile.** You need a real machine (or CI runner) per OS.
- **`sys.executable` re-exec.** The whole `_child` dance exists because a frozen binary's
  `sys.executable` is the app, not python. If you add any new `subprocess` that runs a
  Python module, route it through `module_cmd()` too — don't hardcode `-m`.
- **Excludes are correctness-risky.** `rerun`/`wandb`/`cmake` are excluded because nothing
  in teleop/calibrate/record/inference reaches them. If you enable a feature that does
  (e.g. local training, dataset viz), the app crashes at import — pull it from `excludes`.

## Out of scope (don't touch)

- The Nori planning docs — `todos.md`, `full_nori_plan.md`, `m0_m2_*`, `m3_m5_*`,
  `onboard_pi_plan.md` — are active work for the teleop/Pi effort, unrelated to packaging.
- Option 2 (cloud UI) and cloud-inference — future direction, explicitly deferred above.

## Security audit findings (2026-07-15)

From a cross-repo secret/security audit (NoriLeLab + Nori-Backend). **Secret hygiene is clean** — no server secret reaches the browser: `GET /nori/config` (`lelab/utils/config.py:90-104`) returns only `supabaseUrl`/`supabaseAnonKey`/`noriBackendUrl`; the committed `frontend/dist/` bundle has no keys; the `ANTHROPIC_API_KEY` lives only on Nori-Backend and is never reflected back; there's no `shell=True` / command injection (argv lists throughout); the server binds `127.0.0.1` only; Tauri capabilities are minimal (`opener:allow-open-url` scoped to https). The items below are hardening, ordered by real-world impact. **The backend-side counterparts live in `../Nori-Backend/todos.md` → "Security audit hardening (2026-07-15)".**

### 🔴 H1 — Wildcard CORS makes unauthenticated robot-control endpoints drive-by-reachable
`lelab/server.py:176-182` sets `allow_origins=["*"]`, `allow_methods=["*"]`, `allow_headers=["*"]`. The state-changing control endpoints have **no auth / no CSRF token**: `POST /move-arm` (`:334`), `/stop-teleoperation` (`:340`), `/start-inference` (`:357`), `/start-recording` (`:1441`), `/start-calibration` (`:1790`), `/nori/rollout/load` + `/act` (`nori_rollout.py:158,182`). These take `application/json`, which normally forces a CORS preflight a cross-origin page can't pass — but the `["*"]` config makes the preflight **succeed**, so **any website the user visits while `lelab` is running can POST to `http://127.0.0.1:8000/...` and physically move the arm, start recording, or run a policy.** `127.0.0.1` binding does not help — the request originates from the user's own browser. This is the only finding with real-world actuation impact; fix first.

**Fix:** restrict `allow_origins` to the actual app origins (`http://localhost:8000`, `http://localhost:8080`, and the packaged Tauri origin), drop `allow_methods/headers=["*"]`, and add an Origin check (or a required custom header / CSRF token) on every state-changing control endpoint. See "Is web teleop safe at all?" note below — the local server needs a same-origin/token boundary regardless of CORS.

### 🔴 M1 — LLM proxy does no auth at the LeLab layer
`/nori/llm/generate`, `/generate/stream`, `/nori/llm/agent` (`server.py:549,571,766`) forward whatever `X-Nori-JWT` header is present (or `None`) straight to Nori-Backend via `_nori_client(request)` (`:836`); LeLab never checks a JWT exists. It only fails closed because the backend rejects it — and combined with H1's wildcard CORS these are cross-origin reachable. **Fix:** reject missing/invalid `X-Nori-JWT` at the LeLab layer before forwarding (defense in depth), and scope CORS per H1. (Pairs with backend H1 token-reservation work.)

### 🟢 Low
- **`/ws/joint-data` has no Origin check** (`server.py:1409-1438`) — WebSockets bypass CORS, so any open website can connect and read live joint telemetry (read-only leak). Validate `websocket.headers["origin"]` in `manager.connect`.
- **Path-traversal hardening is inconsistent** — `ensure_local_dataset` (`datasets.py:58`, `_lerobot_cache_root() / repo_id`) and `setup_calibration_files` (`utils/config.py:150-151`, joins a caller-supplied config name) lack the resolve-and-contain guard that `handle_delete_dataset` (`record.py:503-508`) correctly uses. Apply the same `.resolve()` + containment check; reuse the `_safe_bundle_name` pattern from `nori_client.py:51-63`.
- **Tauri webview has no CSP** — `tauri.conf.json` `app.security.csp: null`. Any XSS in the local UI runs unconstrained. Set a restrictive `csp` (self + known backend/Supabase/Nori-Backend origins).
- **Verbose `detail=str(exc)` to the browser** at `server.py:893,895,1223,1230,1508,1523,1659,1661,1857` can leak local paths/internals. Return generic messages; log detail server-side.
