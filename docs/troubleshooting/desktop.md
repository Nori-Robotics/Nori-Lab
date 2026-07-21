# Desktop app

## What the app does at startup

Nearly every "the app won't open" report is one of these three steps failing, so it's worth knowing
them:

1. The app spawns a **frozen Python backend** bundled inside it, which serves the API and UI on
   `127.0.0.1:8000`.
2. It **waits up to 60 seconds** for that port to answer.
3. It opens a window pointing at it.

The app is a local web app in a native window.

## The window is blank, or the app quits on launch

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

## The OS refuses to open the app

If the build isn't signed and notarized yet, macOS Gatekeeper and Windows SmartScreen will both
block it.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
The deliberate override steps per platform — and, better, remove this section entirely once signed
builds ship.
:::
-->

## A stray backend keeps running after I quit

It shouldn't. The app kills the backend child on window-destroyed and on app-exit, and the backend
additionally self-exits if its parent dies. All three exit paths are covered.

If you still find an orphan on `:8000`, that's a bug worth
[reporting](/troubleshooting/getting-help) — tell us how you quit.

## The app can't see my hardware

That's not a desktop-app problem — go to [Leader arms and USB](/troubleshooting/leader-arms).

Install guide: [Install the desktop app](/guide/install).
