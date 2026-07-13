# Install the desktop app

The Nori desktop app bundles everything needed to talk to robot hardware — no Python, no
terminal, no `pip`. Download it, drag it in, open it.

::: warning Status
The desktop app is **not yet published**. The Tauri shell and the frozen backend both build, but
no signed installer has shipped on any OS. Until it does, run from source (below). Track this in
`desktop/HANDOFF.md`.
:::

## Download

::: info 🚧 To write
Download links per platform, once installers ship:

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `Nori Lab.dmg` | Notarized — no Gatekeeper warning. |
| Windows | `Nori Lab.exe` | NSIS installer, signed. |
| Linux | `Nori Lab.AppImage` | `chmod +x`, then run. |

Also cover: what the OS scare screen looks like if a build *isn't* signed yet, and how to get
past it deliberately.
:::

## What the app actually does when it starts

Worth knowing, because most "the app won't open" reports are one of these steps failing:

1. It spawns a **frozen Python backend** bundled inside the app, which serves the API and UI on
   `127.0.0.1:8000`.
2. It waits for that port to answer (up to 60 s).
3. It opens a window pointing at it.

So the app is a local web app in a native window. If port `8000` is already in use by something
else, that's a problem — see [Desktop app troubleshooting](/troubleshooting/desktop).

## Run from source (until installers ship)

Requires Python ≥ 3.12 and Node.

```bash
git clone https://github.com/nori-robotics/NoriLeLab
cd NoriLeLab
pip install -e .
lelab            # serves API + UI on :8000 and opens a browser
```

For frontend development, `lelab --dev` runs Vite on `:8080` against a reloading backend on
`:8000`.

::: info 🚧 To write
- System requirements (RAM, disk — the bundle is ~770 MB on disk because torch ships in it so
  inference never depends on Wi-Fi).
- Updating: how the app checks for and applies a new version.
- Uninstall, and what's left behind (`~/.cache/huggingface/lerobot/` holds calibration, saved
  ports, and config selections).
:::
