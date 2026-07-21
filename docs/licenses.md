# Licenses & attribution

Nori ships with third-party open-source software. Their licenses require that the license
text and attribution travel **with the product** — i.e. with this documentation and the
printed/PDF manual, not just in an internal repo.

::: warning This page is not complete yet
The full attribution notices are still being compiled and are **not** reproduced below yet. Nori
is `v0` and has not shipped to a customer; this page is a ship blocker and will carry the verbatim
notices before it does.

If you need the current inventory before then — for your own compliance review, or because you're
redistributing something built on Nori — [ask us](/troubleshooting/getting-help) and we'll send it.

Components known to be in scope include SCServo_Linux (MIT), nlohmann/json (MIT), GStreamer and
its plugins (LGPL-2.1, with some GPL packages in the robot image), pynput (LGPL), and openh264
(BSD). Nori's own code is Apache-2.0.
:::

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write — REQUIRED before ship (legal sign-off received 2026-07-14)
Legal confirmed we don't need to relicense anything — we just need to **ship the correct
license + attribution notices alongside the manual and these docs**. This page (and the
manual's equivalent section) is where that text goes. It is not done yet.

**What belongs here:** the full, verbatim license text for each bundled third-party
component, with its copyright line, grouped by license. Do **not** paraphrase — open-source
licenses require the exact notice.

**Known components to cover** (authoritative inventory lives in the NoriTeleop repo at
`docs/licensing_status.md` — reconcile against it, don't hand-maintain a second list):

- **SCServo_Linux** — MIT, © 2024 FTServo. Vendored at
  `NoriTeleop/rpi5/nori_core_agent/external/SCServo_Linux/` (see its `LICENSE` + `VENDORED.md`).
- **nlohmann/json** — MIT.
- **GStreamer** and plugins — LGPL-2.1, plus `gstreamer1.0-plugins-ugly` (GPL) in the robot
  image. Confirm with legal how the GPL-ugly package is presented, since it's a system
  package the media process shells out to rather than links.
- **pynput** — LGPL (leader/keyboard tooling).
- **openh264** — BSD (if shipped in the encoder path — verify it's actually bundled).
- Anything else `docs/licensing_status.md` lists as shipped.

**Also do:** confirm with legal whether the manual needs the same text inline or may point
here by URL, and whether an offline copy (bundled with the desktop app / on the robot) is
required for units without internet.

**Owner:** _unassigned — pick this up before the first customer ship._
:::
-->
