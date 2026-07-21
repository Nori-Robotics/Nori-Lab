# Building the Nori Lab desktop app on Windows

This walks you through producing a **Windows installer (`.exe`)** for the Nori Lab desktop app
from source, on a Windows PC. The app is a Tauri shell wrapping a frozen Python (FastAPI +
LeRobot) backend; this doc is everything you need to build it end to end.

**Why you and not Jasmine:** PyInstaller (which freezes the Python backend) **cannot
cross-compile**. A Windows `.exe` must be built *on* Windows. Everything in the codebase
already branches correctly for Windows — there are **no code changes to make**, just this build.

**Estimated time:** ~30–45 min the first time (most of it installing prerequisites + one
~1 GB download of PyTorch). Rebuilds are ~10 min.

---

## ⚠️ Read first: hard requirements

- **Must be x86-64 (Intel/AMD) Windows.** NOT ARM Windows (Surface Pro X, Snapdragon laptops).
  There are no prebuilt PyTorch/LeRobot wheels for Windows-on-ARM, so the freeze will fail.
  Verify after installing Python (step 1) — the check is in there.
- **Windows 10 or 11.**
- ~15 GB free disk (build artifacts + a second copy of PyTorch in a venv are large).

---

## Part A — Install prerequisites (one time)

Install these in order. Where a "verify" line is given, run it in a **new** terminal
(so PATH updates take effect) and confirm the expected output before moving on.

### 1. Python 3.13 (64-bit)
Download the **Windows installer (64-bit)** from <https://www.python.org/downloads/>.
Pick **3.13.x** — *not* 3.14 (no torch wheels yet), *not* 3.12.
- ✅ On the first installer screen, check **"Add python.exe to PATH"**.

Verify (in a new terminal):
```powershell
python --version
# -> Python 3.13.x

python -c "import platform; print(platform.machine())"
# -> AMD64        (if you see ARM64, STOP — this is ARM Windows and won't work)
```

### 2. Node.js LTS (for building the frontend)
Install the **LTS** from <https://nodejs.org/>. Verify:
```powershell
node -v    # -> v20.x or v22.x
npm -v     # -> 10.x
```

### 3. Git for Windows (includes Git Bash)
Install from <https://git-scm.com/download/win>. Accept defaults.
We run the build script in **Git Bash** (it's a bash script). You'll find "Git Bash" in the
Start menu after install.

Enable long paths (Windows' 260-char path limit otherwise breaks deep PyTorch/node paths):
```powershell
git config --global core.longpaths true
```
And, in an **Administrator** PowerShell (then reboot once):
```powershell
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1
```

### 4. Rust (rustup)
Install from <https://rustup.rs/> — run `rustup-init.exe`, accept the default
(`x86_64-pc-windows-msvc`). Verify in a new terminal:
```powershell
cargo --version   # -> cargo 1.8x.x
```

### 5. Visual Studio C++ Build Tools (the MSVC linker Tauri/Rust need)
Download **"Build Tools for Visual Studio 2022"** from
<https://visualstudio.microsoft.com/downloads/> (scroll to "Tools for Visual Studio").
In the installer, check the **"Desktop development with C++"** workload → Install.
> Without this, `cargo tauri build` fails with `link.exe not found` or a linker error.

### 6. WebView2 runtime
Preinstalled on Windows 11 and up-to-date Windows 10. If the app later opens a blank
window, install the **Evergreen Bootstrapper** from
<https://developer.microsoft.com/microsoft-edge/webview2/>.

### 7. Tauri CLI
```powershell
cargo install tauri-cli --version "^2" --locked
cargo tauri --version   # -> tauri-cli 2.x
```

---

## Part B — Get the code and config

### 1. Clone and pick the commit
```bash
git clone https://github.com/Nori-Robotics/Nori-Lab.git NoriLeLab
cd NoriLeLab
git checkout main
git pull
git rev-parse --short HEAD      # <-- WRITE THIS DOWN. It's the build's version.
```
Record that short SHA — you'll put it in the installer's filename so we know exactly what
was built (the repo's `main` moves fast).

### 2. Drop in the cloud config file
The app bakes in three **public** config values (Supabase URL + anon key + backend URL).
This file is gitignored, so it's not in the clone. **Get `desktop/env.public` from Jasmine**
(a small 3-line file — all values are browser-safe, no secrets) and save it at exactly:
```
NoriLeLab/desktop/env.public
```
Its shape is shown in `desktop/env.public.example` if you want to sanity-check it. If you
skip this, the app still builds and runs but shows "Nori auth is not configured".

---

## Part C — Build

Do all of this in **Git Bash**, from the repo root (`NoriLeLab/`).

### 1. Build the frontend
(The freeze step bundles `frontend/dist`, so it must exist first — `build.sh` does *not* do this.)
```bash
cd frontend
npm ci
npm run build
cd ..
```

### 2. Freeze + stage the Python backend
`build.sh` makes a clean venv, installs **CPU-only** PyTorch (critical — avoids a ~2 GB CUDA
download), installs the app, freezes it with PyInstaller, smoke-tests it, and stages the
result plus your `env.public` into the Tauri resources folder.

On Windows, pass `PYTHON=python` (the script's default of `python3.12` doesn't exist here):
```bash
PYTHON=python ./desktop/build.sh
```
Expect a few minutes and a **~1 GB** bundle. The script prints the final size at the end.
> If it prints a size near 3 GB, the CPU-torch step was bypassed — see Troubleshooting.

### 3. Build the installer
```bash
cd desktop/tauri
cargo tauri build
```
First run compiles the whole Tauri crate tree (~2–5 min); later runs are fast.

---

## Part D — Find, test, and hand off the installer

The installer is written to:
```
NoriLeLab/desktop/tauri/target/release/bundle/nsis/Nori Lab_0.1.0_x64-setup.exe
```

### Test it on this machine
1. Double-click the `.exe`.
2. **SmartScreen will warn** ("Windows protected your PC") because it's unsigned — click
   **"More info" → "Run anyway"**. (This is expected; code-signing is a separate future step.)
3. Complete the install, launch **Nori Lab** from the Start menu.
4. A window should open after ~10 seconds (it waits for the backend to boot on port 8000).
5. Confirm the UI loads and does **not** say "Nori auth is not configured" (that means
   `env.public` was picked up).

You don't need a robot arm to confirm the build itself works — a window that loads the UI
means the frozen backend booted and is serving. (Hardware paths — calibrate/teleop/record/
inference — are tested separately by Jasmine.)

### Hand it back
Rename the installer to include the SHA from Part B, e.g.:
```
Nori-Lab-<shortsha>-x64-setup.exe
```
and send it to Jasmine (Google Drive / Slack — it's ~400 MB).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `python3.12: command not found` | You dropped the `PYTHON=python` prefix on step C.2. |
| `platform.machine()` prints `ARM64` | This is ARM Windows — it can't build this app. Use an x86-64 PC. |
| Bundle is ~3 GB / has `nvidia_*` folders | The CPU-torch step was skipped. Delete `desktop/.build-venv` and re-run `PYTHON=python ./desktop/build.sh` from a clean state. |
| `link.exe not found` / MSVC linker error (during `cargo tauri build`) | Install the VS **"Desktop development with C++"** workload (Part A step 5). |
| Build fails deep in a torch/node path ("path too long", "cannot find file") | Enable long paths (Part A step 3), then reboot. |
| `cargo: command not found` or `cargo tauri` unknown | Reopen the terminal after installing Rust; run `cargo install tauri-cli --version "^2" --locked`. |
| App installs but opens a **blank** window | Install the Evergreen WebView2 runtime (Part A step 6). |
| Windows Defender quarantines the `.exe` | PyInstaller binaries sometimes false-positive. Restore it / add a temporary exclusion for the build folder. |
| PyInstaller step errors on a missing module | A dependency isn't collected in `desktop/lelab_desktop.spec`. Note the module name and send it to Jasmine — it's a one-line spec fix, not a Windows-specific problem. |

---

## What this produces vs. the Mac build (FYI)

Same 4-step chain as macOS (frontend → freeze → stage → `cargo tauri build`); only the
outputs differ: a **NSIS `.exe` installer** instead of a `.dmg`, and unsigned apps hit
**SmartScreen** instead of macOS Gatekeeper. Signing (an Authenticode certificate) is a
later step and is not needed for this test build.
