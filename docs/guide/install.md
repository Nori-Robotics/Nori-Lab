# Install the desktop app

The Nori desktop app bundles everything needed to talk to robot hardware — no Python, no
terminal, no `pip`. Download it, drag it in, open it.

::: warning Status
The desktop app is **not yet published**. The Tauri shell and the frozen backend both build, but
no signed installer has shipped on any OS. Until it does, run from source (below). Track this in
`desktop/HANDOFF.md`.
:::

## Download

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
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
-->

## What the app actually does when it starts

Worth knowing, because most "the app won't open" reports are one of these steps failing:

1. It spawns a **frozen Python backend** bundled inside the app, which serves the API and UI on
   `127.0.0.1:8000`.
2. It waits for that port to answer (up to 60 s).
3. It opens a window pointing at it.

So the app is a local web app in a native window. If port `8000` is already in use by something
else, that's a problem — see [When it goes wrong](#when-it-goes-wrong) below.

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

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- System requirements (RAM, disk — the bundle is ~770 MB on disk because torch ships in it so
  inference never depends on Wi-Fi).
- Updating: how the app checks for and applies a new version.
- Uninstall, and what's left behind (`~/.cache/huggingface/lerobot/` holds calibration, saved
  ports, and config selections).
:::
-->

## When it goes wrong

### The window is blank, or the app quits on launch

**The backend never came up on `:8000`.** After 60 seconds of waiting, the app gives up.

The usual cause: **something else is already using port 8000.** Another copy of the app, a stray
`lelab` process from a previous run, or an unrelated dev server.

Check what's holding the port:

```bash
lsof -i :8000        # macOS / Linux
netstat -ano | findstr :8000   # Windows
```

Kill it, then relaunch.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- Where the app's logs go per platform, and how a user gets at them. **This is the single most
  useful thing to add here** — right now a failed startup gives an operator nothing to send us.
- Whether the port is configurable, and how.
:::
-->

### The OS refuses to open the app

If the build isn't signed and notarized yet, macOS Gatekeeper and Windows SmartScreen will both
block it.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
The deliberate override steps per platform — and, better, remove this section entirely once signed
builds ship.
:::
-->

### A stray backend keeps running after I quit

It shouldn't. The app kills the backend child on window-destroyed and on app-exit, and the backend
additionally self-exits if its parent dies. All three exit paths are covered.

If you still find an orphan on `:8000`, that's a bug worth
[reporting](/guide/getting-help) — tell us how you quit.

### The app can't see my hardware

That's not a desktop-app problem — go to [Leader arms](/guide/leader-arms#troubleshooting).
