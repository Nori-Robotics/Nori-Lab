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

---

## What's built (current state)

| File | State | Verified? |
|---|---|---|
| `lelab/utils/child_process.py` | `module_cmd()` shim — frozen vs source subprocess argv | ✅ compiles, lints clean |
| `lelab/rollout.py` (edited) | inference spawn routed through `module_cmd()`; removed unused `import sys` | ✅ compiles, lints clean |
| `desktop/backend_entry.py` | frozen entry: `_child` runpy dispatch, else headless uvicorn | ✅ compiles |
| `desktop/lelab_desktop.spec` | PyInstaller: collect lerobot, exclude rerun/wandb/cmake | ⚠️ never run |
| `desktop/build.sh` | CPU-torch pin → freeze → smoke test → stage into Tauri | ⚠️ never run |
| `desktop/tauri/*` | Rust shell (v2 API): spawn backend, wait for port, open window | ⚠️ never compiled |

**"Verified" means the Python compiles and lints — it does NOT mean a bundle was
produced or run.** No PyInstaller build, no `cargo build`, no hardware test has happened.
Treat the `.spec`, `build.sh`, and Rust as first-draft-that-should-work, not proven.

---

## TODO — in order

### 1. Produce a working backend bundle (½–1 day)
- [ ] `cd frontend && npm run build` (backend serves `frontend/dist`).
- [ ] Run `./desktop/build.sh` on macOS. Fix whatever PyInstaller misses — expect
      **`hiddenimports` gaps** (lerobot/draccus load modules by string; the spec has a
      starter list but won't be complete) and possibly a missing data file.
- [ ] Confirm the smoke test passes (it checks the `_child` inference import survives the
      excludes). **Record the actual `du -sh`** — target ~1 GB on disk / ~400 MB packed.

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
