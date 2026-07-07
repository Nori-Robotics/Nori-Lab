# LeLab desktop bundle (Option 1: Tauri + frozen backend)

Packages LeLab as a native, double-click desktop app for macOS / Windows / Linux.
No Python install, no terminal. The React UI + FastAPI backend run exactly as they
do today; only the delivery vehicle changes.

> **Picking this up? Start with [HANDOFF.md](HANDOFF.md)** — scope, current state,
> decision log, and the ordered TODO list. This README is the mechanics; HANDOFF is
> the map.

## How it works

```
┌─────────────────────────── LeLab.app / .exe / .AppImage ──────────────────────────┐
│  Tauri shell (Rust, src/main.rs)                                                   │
│    ├─ spawns  resources/backend/lelab-backend   (frozen PyInstaller bundle)        │
│    │            └─ uvicorn  lelab.server:app  on 127.0.0.1:8000  (API + UI)        │
│    └─ waits for :8000, then opens a webview window at http://127.0.0.1:8000/       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **Inference stays local.** `lelab.rollout` spawns `lerobot.scripts.lerobot_rollout`
  as a child. Inside the bundle that becomes `lelab-backend _child lerobot.scripts.lerobot_rollout …`,
  which `backend_entry.py` runs via `runpy`. torch ships in the bundle — the follower's
  control loop never depends on the network.
- **Training stays cloud.** Dispatched to Nori-Backend (`nori_cloud`) / HF (`hf_cloud`)
  exactly as today.

## Files

| File | Role |
|---|---|
| `backend_entry.py` | Frozen entry: `_child` module dispatch, else boot uvicorn (headless). |
| `lelab_desktop.spec` | PyInstaller spec — collects lerobot, **excludes** rerun/wandb/cmake. |
| `build.sh` | Fresh venv → CPU torch → freeze → smoke test → stage into Tauri. |
| `tauri/` | Rust shell: `src/main.rs`, `Cargo.toml`, `build.rs`, `tauri.conf.json`. |
| `../lelab/utils/child_process.py` | `module_cmd()` — the frozen/source subprocess shim. |

## Build (run on each target OS — PyInstaller can't cross-compile)

```bash
# 0. Build the frontend once (backend serves frontend/dist)
cd frontend && npm run build && cd ..

# 1. Freeze the backend (CPU torch + excludes + smoke test), stage into Tauri
./desktop/build.sh

# 2. Generate app icons once (needs the Tauri CLI: `cargo install tauri-cli`)
cd desktop/tauri && cargo tauri icon path/to/logo.png

# 3. Build the installer
cargo tauri build          # -> src-tauri/target/release/bundle/{dmg,nsis,appimage}
```

## Expected size

| Strategy | On disk | ~Download |
|---|---|---|
| Naive (CUDA torch, everything) | ~3 GB | ~1 GB |
| **This config** (CPU torch + exclude rerun/wandb/cmake) | ~1.0 GB | **~350–450 MB** |

`build.sh` prints the final `du -sh` so you can track it. If a build regresses,
the usual culprit is a CUDA torch wheel sneaking back in — confirm step 2 used the
`download.pytorch.org/whl/cpu` index and no `nvidia_*` dirs are in the bundle.

## Known limitations (by design)

- **Local training runner is unsupported in the bundle.** `wandb` is excluded and
  `train.py` still emits `[python_executable, "-m", …]`. Desktop training must use
  the `nori_cloud` / `hf_cloud` runners (which is the intended model). Wire the local
  runner through `module_cmd()` and drop `wandb` from `excludes` if you ever need it.
- **Dataset visualization (rerun) is excluded.** The in-app WebSocket joint viz is
  unaffected; the standalone `lerobot_dataset_viz` rerun path is not bundled.
- **`.env` / Nori cloud config** is read from the user's environment as usual. For a
  shipped app, surface `NORI_BACKEND_URL` / Supabase keys via the UI or a bundled
  default rather than a repo-root `.env`.

## Signing (needed to avoid OS scare screens)

- **macOS:** Apple Developer ID ($99/yr) → codesign + notarize. Tauri does this via
  `APPLE_CERTIFICATE` / `APPLE_ID` env vars during `cargo tauri build`.
- **Windows:** Authenticode cert (~$100–400/yr) to avoid SmartScreen. Optional but
  strongly recommended.
- **Linux:** AppImage needs no signing.

Running cost of the app itself: **$0/mo** — everything executes on the user's machine.

## Validate before shipping

The build's smoke test only checks imports. Before release, run the real bundle and
exercise the hardware paths (they can't be unit-tested):

1. Launch the app; confirm the window opens at `:8000`.
2. Calibrate → teleoperate → record a short episode (serial + cameras).
3. **Run inference** on a checkpoint — this is the torch/`_child` path the bundle
   most easily breaks. If it fails to import, a needed module is in `excludes`.
