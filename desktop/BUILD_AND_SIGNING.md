# Step 4 — Build matrix, code-signing & release automation (handoff)

**Owner:** _<your name here>_ · **Prereq reading:** [`HANDOFF.md`](HANDOFF.md) (the decision
log + steps 1–3). This doc is step 4, broken out because it's a self-contained chunk
(CI + platform signing) that can be done without touching the app code.

**Goal:** turn the locally-proven bundle into **downloadable, trusted installers for
macOS, Windows, and Linux**, produced by CI on every release — so a non-technical
operator double-clicks an installer and the OS doesn't scare them off.

> **Where step 4 starts from:** steps 1–3 are done. `desktop/build.sh` freezes the
> Python backend and stages it into `desktop/tauri/resources/backend/`; `cargo tauri
> build` then wraps it into an installer. This all works **locally on macOS arm64
> today**. Your job is to run it *per-OS in CI* and *sign the output*. You are not
> expected to change how the app works.

---

## 0. The one thing to internalize first

**PyInstaller cannot cross-compile.** A macOS bundle can only be frozen on macOS, Windows
on Windows, Linux on Linux. So this is a **matrix build — one native runner per OS**, not
a single machine emitting three installers. Everything below follows from that.

The per-OS build is always the same two stages:

1. `PYTHON=python3.13 ./desktop/build.sh` — freezes the backend (CPU torch → PyInstaller
   → smoke test) and copies it to `desktop/tauri/resources/backend/`.
2. `cd desktop/tauri && cargo tauri build` — bundles the Tauri shell + `frontend/dist` +
   the staged backend into the installer declared in `tauri.conf.json`
   (`"targets": ["dmg", "nsis", "appimage"]`).

**Run `cd frontend && npm run build` before both** — the backend serves `frontend/dist`
and Tauri embeds it (`frontendDist: "../../frontend/dist"`).

---

## 1. Deliverables (definition of done)

- [ ] A GitHub Actions workflow (`.github/workflows/desktop-release.yml`) with a
      **3-OS matrix** (`macos-14` arm64, `windows-latest`, `ubuntu-22.04`) that runs the
      two-stage build and uploads each installer as a release artifact.
- [ ] **macOS** `.dmg` is **Developer ID-signed and notarized** — installs on a stranger's
      Mac with no Gatekeeper "unidentified developer" block.
- [ ] **Windows** `.exe`/NSIS installer is **Authenticode-signed** — no SmartScreen
      "unknown publisher" red warning (or a much reduced one while reputation builds).
- [ ] **Linux** AppImage builds and runs (Linux has no mandatory signing; ship as-is or
      add a detached GPG sig + checksums).
- [ ] Triggered on a version tag (e.g. `v0.1.0`) and attaches all three to a GitHub Release.
- [ ] A short "how to cut a release" note appended to this doc once it works.

---

## 2. The CI matrix (skeleton)

Draft to adapt — **not yet committed**. Pin action versions when you add it.

```yaml
name: desktop-release
on:
  push:
    tags: ["v*"]
  workflow_dispatch: {}      # manual runs while iterating

jobs:
  build:
    strategy:
      fail-fast: false       # one OS failing shouldn't kill the others
      matrix:
        include:
          - os: macos-14        # Apple silicon; use macos-13 for an x86_64 build
          - os: windows-latest
          - os: ubuntu-22.04    # oldest glibc you support — newer runners raise the floor
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with: { python-version: "3.13" }   # NOT 3.14 — no torch/lerobot wheels yet

      - uses: actions/setup-node@v4
        with: { node-version: "20" }

      - name: Rust toolchain
        uses: dtolnay/rust-toolchain@stable

      # Linux-only: Tauri's system deps (webkit2gtk etc.)
      - name: Linux deps
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
            librsvg2-dev patchelf

      - name: Build frontend
        run: cd frontend && npm ci && npm run build

      - name: Freeze backend
        shell: bash
        run: PYTHON=python3.13 ./desktop/build.sh

      - name: Stage public .env into the bundle       # see step 5 dependency below
        shell: bash
        run: cp desktop/env.public.example desktop/tauri/resources/backend/.env
        # ^ replace with the real public values via a repo/Actions variable, NOT a secret file

      - name: Tauri build (+ sign)
        run: cd desktop/tauri && npx @tauri-apps/cli@^2 build
        env:
          # macOS signing/notarization (see §3)
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}     # app-specific password
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          # Windows signing (see §4)
          # (Tauri reads a signing cert via tauri.conf.json > bundle.windows, or sign post-build)

      - uses: actions/upload-artifact@v4
        with:
          name: nori-lab-${{ matrix.os }}
          path: |
            desktop/tauri/target/release/bundle/**/*.dmg
            desktop/tauri/target/release/bundle/**/*.exe
            desktop/tauri/target/release/bundle/**/*.AppImage
```

> **CI cost/time note:** `build.sh` downloads CPU torch (~200 MB) and freezes ~768 MB every
> run. Cache the pip wheels (`actions/cache` on `~/.cache/pip`) but **do not** cache
> `.build-venv` across torch-version bumps. Expect 10–20 min/OS.

---

## 3. macOS — Developer ID signing + notarization

**Why:** an unsigned/un-notarized `.dmg` triggers *"'Nori Lab' can't be opened because
Apple cannot check it for malicious software"* — most operators will not know to
right-click→Open around it. Notarization removes that.

**What to buy/get:**
- **Apple Developer Program** membership — **$99/yr** (individual or org).
- A **Developer ID Application** certificate (created in the Apple Developer portal or via
  Xcode) — this is the "Developer ID", *not* the Mac App Store cert.
- An **app-specific password** for your Apple ID (appleid.apple.com → Sign-In & Security)
  for the notary service.

**Wire into CI** (Tauri reads these env vars during `tauri build`):
| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` export of the Developer ID cert + private key |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Nori Robotics (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` | Apple ID + the app-specific password (notarization) |
| `APPLE_TEAM_ID` | 10-char team id |

Tauri signs the `.app`, staples, and notarizes automatically when these are present.
**Verify on a clean Mac (or `spctl -a -vvv Nori\ Lab.app`)** that Gatekeeper accepts it —
CI "green" is not proof the notarization ticket stapled.

**Gotcha — the frozen backend is a second Mach-O.** The bundle ships an embedded
`resources/backend/lelab-backend` binary (+ its `.dylib`s from torch). Hardened-runtime
notarization must sign those too. Confirm the notary log lists no unsigned nested binaries;
if it complains, sign the backend folder before `tauri build` or enable Tauri's deep-sign.

---

## 4. Windows — Authenticode signing

**Why:** an unsigned `.exe` hits **SmartScreen** "Windows protected your PC — unknown
publisher". Signing (plus download reputation over time) removes it.

**What to buy/get:**
- An **Authenticode code-signing certificate**, ~**$100–400/yr** (Sectigo/DigiCert/etc.).
  - **OV** cert: cheaper, but SmartScreen reputation must build up over downloads.
  - **EV** cert: instant SmartScreen trust, but requires a hardware token / cloud HSM —
    **this complicates CI** (can't just drop a `.p12` in a secret). Decide OV vs EV early;
    it changes the CI design.
- Sign the NSIS installer output. Options: Tauri's `bundle.windows.certificateThumbprint`
  (self-hosted signer), `signtool` as a post-build step, or a cloud-signing action
  (Azure Trusted Signing / DigiCert KeyLocker) if you go EV/HSM.

**Verify** with `signtool verify /pa /v installer.exe` and a manual download on a fresh
Windows box.

---

## 5. Linux — AppImage

No mandatory signing. `build.sh` + `cargo tauri build` already emits an AppImage
(`"appimage"` target). To do:
- [ ] Confirm the AppImage runs on a clean Ubuntu (and ideally one non-Ubuntu distro).
- [ ] Optionally publish **SHA-256 checksums + a detached GPG signature** so users can verify.
- [ ] Watch the **glibc floor**: build on the *oldest* distro you intend to support
      (hence `ubuntu-22.04`, not `-latest`) — an AppImage built on newer glibc won't run on
      older systems.

---

## 6. Cross-cutting gotchas (read before you start)

- **CUDA size trap (Windows/Linux).** The default `torch` wheel on non-Mac is the CUDA
  build → drags ~2 GB of `nvidia_*`. `build.sh` step [2/5] installs **CPU torch first** to
  prevent this. If a Windows/Linux bundle balloons past ~1 GB, that step got skipped or
  pip re-resolved a CUDA torch — check for `nvidia_*` dirs in `resources/backend/`.
- **Python 3.13, not 3.14.** 3.14 has no prebuilt torch/lerobot wheels. `build.sh` defaults
  to `python3.12`; pass `PYTHON=python3.13`. Whatever the runner has, keep it 3.12–3.13.
- **Step 5 dependency — the `.env`.** A shipped bundle needs three *public* config values
  (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NORI_BACKEND_URL`) staged as
  `resources/backend/.env` (loaded by `backend_entry.py::_load_adjacent_env`). CI must write
  that file before `tauri build` (see the matrix skeleton). **Source the values from an
  Actions *variable*, not a secret file — they are public. NEVER put the Supabase
  service-role key or `ANTHROPIC_API_KEY` in it** (see the secret-handling decision in
  `HANDOFF.md` §5). We're coordinating the exact values with the app owner — confirm before
  first release.
- **Icons must exist.** `tauri.conf.json` references `icons/{32x32.png,128x128.png,
  icon.icns,icon.ico}`. Generate from a source logo with `cargo tauri icon <logo.png>` if
  any are missing (some platform icon files are gitignored).
- **Identifier / product name are set** — `com.nori.lelab` / "Nori Lab" in
  `tauri.conf.json`. Bump `version` there per release; the tag should match.
- **Don't cache-poison across OSes.** Each matrix leg is independent; never share a frozen
  `resources/backend/` between OSes.

---

## 7. Suggested order of attack

1. Get the **matrix building unsigned installers** on all three OSes first (prove the
   freeze + tauri build works in CI, per-OS). This is the bulk of the value and surfaces
   the platform-specific breakage early.
2. Add **macOS notarization** (most impactful — it's the platform the first operators use).
3. Add **Windows signing** (decide OV vs EV first).
4. Wire the **tag-triggered GitHub Release** upload.
5. Append a "cutting a release" runbook here.

Ping the app owner if the freeze or Tauri build fails in a way that looks like an app bug
(missing module, backend won't boot) rather than a CI/signing issue — that's steps 1–3
territory, documented in `HANDOFF.md`, not yours to debug from scratch.
