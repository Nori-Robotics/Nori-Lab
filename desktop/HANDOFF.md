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

### 3. Wrap it in Tauri (1–2 days)
- [ ] `cargo install tauri-cli`; generate icons: `cargo tauri icon <logo.png>`.
- [ ] `cd desktop/tauri && cargo tauri build`. The Rust is written against the Tauri v2
      API but has never been compiled — expect small API/signature fixes.
- [ ] Verify lifecycle: window opens at `:8000` only after the backend answers, and the
      backend child is **killed on window close** (check for orphan `lelab-backend` procs).

### 4. Build matrix + signing (1–2 days)
- [ ] GitHub Actions matrix (macos / windows / ubuntu) running `build.sh` + `cargo tauri
      build`, uploading installers as artifacts. (I offered to draft this — not done yet.)
- [ ] macOS: Apple Developer ID ($99/yr) → codesign + notarize (unsigned = Gatekeeper block).
- [ ] Windows: Authenticode cert (~$100–400/yr) or users hit SmartScreen.

### 5. Config UX (½ day)
- [ ] Today Nori features read `NORI_BACKEND_URL` / Supabase keys from a repo-root `.env`.
      A shipped app has no repo. Decide: bundle a default, or add a settings screen. Until
      then, calibrate/teleop/record/inference work offline; only cloud features need it.

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
