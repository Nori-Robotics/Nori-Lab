# Deploying the Nori operator app

How the operator web app (this `frontend/`) ships to consumers. Companion to the
robot-side plan (`NoriTeleop/docs/rpi5_deployment_plan.md`); this is the operator-app
side, which had no deployment plan before.

## The decision: two vehicles, one per audience

The app has two halves with opposite hosting needs, so they ship as two things:

| Vehicle | For | Delivery | Needs a local LeLab? |
|---|---|---|---|
| **Full NoriLeLab app** | The operator's main surface: setup, pairing, marketplace, training, keyboard teleop, leader-arm | **Tauri desktop app** (`desktop/`) — double-click, frozen LeLab backend inside | Yes — bundled |
| **VR counterpart** | Easy headset access, no laptop | **Hosted static page** (Vercel / Cloudflare Pages), LeLab-free | No |

Rationale: the full app genuinely needs the local server (hardware, config, the
JWT proxy). The VR drive loop does **not** — so it gets to be a plain hosted page you
open directly in the Quest browser. Don't force one vehicle to do both jobs.

`adb reverse` remains the **dev** path and is fine there — this doc is about shipping.

## 1. Topology

| Part | What it is | Where it runs |
|---|---|---|
| **Operator app** (`frontend/`) | Vite/React SPA. WebRTC + WebXR run *in the browser*. | Quest browser / desktop webview |
| **LeLab server** (`lelab/server.py`) | FastAPI. `/nori/config` (Supabase creds from env), `/nori/*` proxy → Nori-Backend (attaches JWT), local hardware (`/nori/leader/*`), serves `frontend/dist`. | Bundled in the desktop app (`127.0.0.1:8000`) |
| **Nori-Backend** | Cloud services (datasets/training/marketplace). | Railway |

Signaling (Supabase Realtime) and media (WebRTC, Quest↔Pi via STUN/TURN) are
peer/cloud-direct — they do **not** pass through LeLab. LeLab is only on the
bootstrap + account/marketplace/pairing paths.

Key code facts:
- `src/contexts/ApiContext.tsx` — `baseUrl` defaults to `http://localhost:8000`,
  overridable with `?api=<url>`.
- `src/nori/NoriContext.tsx` → tries `GET /nori/config`; **on failure or when
  unconfigured, falls back to build-time public config** (`getBuildTimeConfig()` in
  `src/nori/api/client.ts`, from `VITE_SUPABASE_*`). This fallback is what makes the
  LeLab-free VR page possible; the LeLab-served path is unchanged when those vars are absent.
- LeLab CORS is `allow_origins=["*"]`.

## 2. Vehicle 1 — the full app (Tauri desktop bundle)

`desktop/` already packages this: a Tauri shell spawns the PyInstaller-frozen LeLab
backend (`uvicorn lelab.server:app` on `127.0.0.1:8000`) and opens a webview at that
URL. No Python, no terminal, no browser setup. Local inference stays in the bundle;
training dispatches to Nori-Backend as today.

Status/work: see `desktop/HANDOFF.md` (scope, decision log, ordered TODOs). Nothing to
host — it's a native download. **This can be built in parallel with app iteration** —
the bundle just packages whatever `frontend/dist` + `lelab` currently are; the only
stable contract it depends on is "LeLab serves API + UI on `127.0.0.1:8000`", which is
long-settled. Rebuild the freeze per release.

## 3. Vehicle 2 — the VR counterpart (hosted, LeLab-free)

The VR drive loop needs only: the **public Supabase anon key**, STUN/TURN, and a
room + token. Signaling is a Supabase Realtime broadcast channel keyed by room name
(`signaling-supabase.ts`) — no login required for the handshake; the room token is the
gate. So the page can be fully standalone.

The enabling change (**done**): `NoriContext` falls back to `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` when `/nori/config` isn't reachable. Baking the anon key is
safe — it already ships to every browser via `/nori/config`. See `.env.example`.

The surface itself is **`/nori/vr`** (`src/nori/pages/vr.tsx`): a standalone route
registered in `App.tsx` as a *sibling* of `/nori`, so it gets the NoriProvider +
TeleopSessionProvider but **not** NoriLayout's nav or its auth redirect. It reuses the
same `TeleopSessionContext.connect()` + `VrSession` as the Remote page (no parallel
control path) — just trimmed to a headset-first room/token → Connect → Enter VR flow.

### Deploy to Vercel (first-timer)

`vercel.json` (committed here) sets the Vite preset, `npm ci`, `dist` output, and the
SPA catch-all rewrite.

1. Sign in at https://vercel.com with the GitHub account that has this repo.
2. **Add New… → Project**, import the `NoriLeLab` repo.
3. **Root Directory → `frontend`** (monorepo; the app is not at repo root). Vercel
   auto-detects Vite and reads `vercel.json`.
4. **Environment Variables** — add the two PUBLIC values (see `.env.example`):
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. ⚠️ Public only — never a service-role
   key or any server secret; VITE_ vars ship in the client bundle.
5. **Deploy** → `https://<project>.vercel.app` (valid HTTPS ⇒ WebXR secure context).
6. Open `https://<project>.vercel.app/nori/vr` in the **Meta Quest browser** — the
   standalone headset landing (`src/nori/pages/vr.tsx`): no app nav, no login, just a
   robot-code + token prompt → **Connect** → **Enter VR**. No adb, no tunnel, no laptop.
7. (Optional) Custom domain: Project → Settings → Domains → add e.g. `vr.nori…`; Vercel
   provisions the cert.

Cloudflare Pages works identically (same `vercel.json` semantics via its Vite preset +
an SPA fallback rule).

### Domain: use a subdomain, not the marketing apex

Put the app on a **subdomain of the main root domain** (e.g. `app.nori.com` or
`vr.nori.com`) as its **own Vercel project**, separate from the NoriWebsite project.

- ✅ **Subdomain (recommended).** Brand-consistent, but independent deploys, rollbacks,
  and env vars. No routing collisions. On Vercel: add the domain to *this* project;
  point a CNAME at Vercel. WebXR just needs HTTPS, which any subdomain gets.
- ⚠️ **Same apex + subpath** (`nori.com/app`). Avoid. This app is a catch-all SPA (the
  `/(.*) → index.html` rewrite); sharing the apex means that rewrite fights the
  marketing site's routes, and the two deploys become entangled. Only worth it with a
  deliberate path-prefix reverse proxy, which is more moving parts than a subdomain.

So: same *brand domain*, different *subdomain*. Keep NoriWebsite and the app as two
Vercel projects under one root domain.

### The laptop → headset handoff (the "Enter VR" link)

Mental model: the full app does **not** push the user into VR. The headset is the
operator — it opens the hosted `/nori/vr` page directly and holds the WebRTC session to
the robot. The full app just **hands off a link**. Flow:

1. In the full app (Remote → VR control card) the operator sees an **"Open on your Quest
   browser"** link: `https://<vr-domain>/nori/vr?room=<robot>` (+ optional `#token=`).
2. They open it on the Quest → the page pre-fills room/token → **Connect** → **Enter VR**.
   The laptop can be closed; the headset drives directly.

For the link to point at the hosted page (not `localhost`), the full-app / desktop build
bakes **`VITE_VR_BASE_URL`** = the VR domain (e.g. `https://app.nori.com`). The hosted
build itself leaves it blank (falls back to its own origin).

**Token embedding is opt-in and uses the URL _fragment_, not the query.** The room rides
in `?room=` (semi-public serial); the token rides in `#token=`. Fragments are **never
sent to the server**, so the access token never lands in CDN/proxy access logs or the
`Referer` header — the main leak surface of a URL-borne credential. On arrival the VR page
captures the token (into localStorage) and **scrubs it from the address bar** via
`history.replaceState`, so it isn't left for bookmarking / re-share. What remains
(clipboard, local history) is on the user's own devices. The checkbox is still off by
default and warns the user (`src/nori/components/VrHandoff.tsx`); with the fragment scheme
it is safe to default-on if desired (a one-line change). The proper long-term replacement
is a short-lived one-time pairing code (R14 room-auth work), not any URL-borne secret.

## 4. What a hosted page does NOT solve

- **NAT traversal.** WAN WebRTC behind CGNAT needs **TURN (coturn)** — separate infra
  (rpi5 plan's ICE fallback).
- **Room auth.** The room token is still the only thing gating robot control until R14
  (`signaling_room_auth_plan.md`) lands. A public VR URL raises the stakes on it —
  gate the first consumer VR unit on R14.

## 5. On-device validation (M2 VR acceptance, pending a Quest)

Open the HTTPS URL in the Quest browser, enter VR, confirm:

- [ ] Drive both arms **over WAN**; clutch engage/disengage feels natural.
- [ ] Mid-session link drop → safe-hold → **re-clutch required** to resume (no snap).
- [ ] Controller **E-STOP** latches; reset needs the deliberate gesture + visible scene.
- [ ] Gripper contact produces a perceptible **rumble**.

Runbook cross-ref: `NoriTeleop/rpi5/media/README.md` → "M2 — VR teleop".

## 6. Config resolution order (reference)

1. `?api=<url>` query param → sets `baseUrl` (persisted to localStorage).
2. `GET {baseUrl}/nori/config` (LeLab). If it responds `configured`, use it.
3. Else `getBuildTimeConfig()` — `VITE_SUPABASE_*` baked at build (the hosted VR path).
4. Else the "Nori auth is not configured" state.
