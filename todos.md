# NoriLeLab — Pre-Pi Work Queue (todos)

> **Purpose:** the concrete task list of work that can start **now**, before the Pi-side
> C++ `NoriCoreAgent` daemon exists. Derived from [`NORI_PLAN.md`](NORI_PLAN.md) and
> [`onboard_pi_plan.md`](onboard_pi_plan.md), reconciled 2026-06-18.
>
> **The single blocker** is the Pi daemon and its LAN contract (TCP binary control/state,
> WebRTC/UDP video, binary recording-log pull, mDNS presence). Anything that talks to
> `xlerobot.local` is blocked. Everything that talks to **Nori-Backend is unblocked** —
> the backend is verified up and running, and all required endpoints exist (re-verified
> 2026-06-16 in `NORI_PLAN.md`'s dependency matrix).

---

## Legend

- ✅ **Unblocked** — no Pi dependency; can be built and tested against Nori-Backend now.
- 🟡 **Partial** — the static / non-protocol slice is doable; the LAN-transport slice is blocked.
- 🔴 **Blocked** — depends on the Pi daemon's binary protocol / WebRTC / mDNS. Listed for
  reference only; do **not** start.

Tagging rule (from `NORI_PLAN.md`): in-place edits to existing LeLab files get a `# NORI:`
comment so upstream merges stay easy. Additive files (`frontend/src/nori/`,
`lelab/nori_client.py`) need no tag.

---

## 0. Environment setup (do first)

- [ ] **Install Node.js / npm** — *currently missing on this machine; this is why
  `lelab --dev` fails with `no such file or directory: 'npm'`.* The dev launcher
  (`lelab/scripts/lelab.py:105,109`) shells out to `npm install` then `npm run dev` for the
  Vite server on :8080. Fix:
  ```bash
  brew install node       # Homebrew present at /opt/homebrew (arm64, macOS 15.3.2)
  node --version && npm --version   # verify on PATH
  ```
  (Node 22 LTS matches `@types/node ^22` in `frontend/package.json`.)
- [ ] `pip install -e .` in a fresh venv (Python ≥3.10); verify `lelab` boots.
- [ ] After Node is installed, verify `lelab --dev` brings up Vite (:8080) + uvicorn (:8000).
- [ ] Confirm Nori-Backend reachable: `GET http://localhost:8000/openapi.json` returns the spec
  (needed for type generation in Phase 1). **Note:** health is mounted at `/health`, NOT
  `/api/v1/health`.
- [ ] *(Optional, if SO-101 hardware on hand)* exercise legacy calibrate/teleop/record to
  validate the inherited upstream base. Uses the serial path, not the Pi.

---

## 1. Phase 1 — Nori scaffolding ✅ DONE (2026-06-19)

> Verified: `npx tsc -b --noEmit` clean, `npm run build` clean, `ruff check` clean,
> backend imports + `.env` load verified. The eslint `react-refresh` warning on
> `NoriContext.tsx` matches the existing `ApiContext.tsx` pattern (non-blocking).
>
> **⚠️ Port collision resolved:** LeLab and Nori-Backend both default to `:8000`. The
> Nori default is now `:8001` (`NORI_BACKEND_URL`). Run Nori-Backend locally with
> `uvicorn main:app --port 8001`, or set `NORI_BACKEND_URL` to wherever it actually is.

- [x] Created the additive frontend tree under `frontend/src/nori/` (api/, auth/, pages/,
  components/) + `NoriContext.tsx` bootstrap provider.
- [x] Generated typed API client `frontend/src/nori/api/types.ts` from the live backend
  (1380 lines). Added `npm run gen:types` script (defaults to `:8001`, override via env).
- [x] Built `frontend/src/nori/api/client.ts` — typed wrapper hitting LeLab `/nori/*` proxy
  routes, injecting `X-Nori-JWT` from the Supabase session. Plus `auth/supabase.ts`
  (lazy client init from `/nori/config`) and `auth/session.ts` (token/sign-in/sign-out).
- [x] Created `lelab/nori_client.py` — `NoriClient` with `httpx`, JWT forwarding, and all
  typed methods (simple GET/POST wired for real; `download_policy`/`upload_dataset` stubbed
  with `NotImplementedError` + phase pointers). `NORI_BACKEND_URL` defaults to `:8001`.
- [x] Added env config to `lelab/utils/config.py`: `NORI_BACKEND_URL`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` + `nori_public_config()`; loads project-root `.env` via python-dotenv.
- [x] `server.py`: added `GET /nori/config` (browser-safe config bootstrap) + `nori_jwt()`
  header-extraction helper for Phase 2 proxy routes. Tagged `# NORI:`.
- [x] Registered `/nori/*` routes in `frontend/src/App.tsx` (additive; no upstream routes
  touched) under a `NoriProvider` + `NoriLayout`, plus `/nori/sign-in`.
- [x] Added deps to `pyproject.toml`: `httpx`, `python-dotenv` (were transitive). Added
  `@supabase/supabase-js` + `openapi-typescript` to `frontend/package.json`. Created
  `.env.example`.

**Note for the next session:** the frontend `client.ts` calls LeLab `/nori/*` *proxy*
routes (per the JWT-plumbing design) — those proxy endpoints don't exist yet. Phase 2's
first task is to add them in `server.py` (e.g. `POST /nori/customers/me/provision` →
`NoriClient(nori_jwt(req)).provision_customer()`).

---

## 2. Phase 2 — Auth + provisioning ✅ DONE (2026-06-21)

> Verified: `ruff` clean, backend imports OK, frontend tsc clean for Nori files (two
> pre-existing upstream tsc errors in `meshLoaders.ts`/`vite.config.ts` from the vite-8
> merge are unrelated), `npm run build` clean. Live: JWT forwarding confirmed end-to-end —
> no header → backend "Missing Authorization header"; dummy token → backend "Invalid token"
> (reached the JWKS validator). **Not auto-tested:** the actual browser sign-in + successful
> provision — needs a real Supabase user login; verify in-browser at `/nori/sign-in`.

- [x] **Backend proxy routes** in `server.py` (`# NORI:`): `POST /nori/customers/me/provision`
  and `GET /nori/customers/me`, via `_nori_client(request)` + `_nori_proxy()` (translates
  `NoriBackendError` → `HTTPException`, passing status + detail through unchanged).
- [x] **Sign-in screen** (`pages/sign-in.tsx`): email/password via Supabase JS SDK (shadcn
  Card/Input/Label/Button). On success the SDK stores+refreshes the JWT; redirects to
  `/nori/account` via the session effect.
- [x] **JWT plumbing** (two hops): browser attaches `X-Nori-JWT` (in `api/client.ts` via
  `getAccessToken()`); LeLab `nori_jwt()` reads it; `NoriClient` forwards as `Bearer`.
- [x] **Provisioning on sign-in**: `NoriContext` calls `provisionCustomer()` whenever a
  session appears (keyed on user id; idempotent), stores the `CustomerProfile`.
- [x] **Account page** (`pages/account.tsx`): renders profile / billing tier / compute
  allowance / pairing state from context; sign-out; "Pair a robot" link when unpaired.
- [x] **Auth guard**: `NoriLayout` redirects signed-out visitors to `/nori/sign-in` once
  bootstrap completes.

---

## 3. Phase 3 — Marketplace browse + install ✅ DONE (2026-06-23)

> Verified: `ruff` clean, backend imports OK, Nori files tsc-clean, `npm run build` clean.
> Live: all four proxy routes exist (return 502, not 404). Full forwarding couldn't be
> end-to-end tested because **Nori-Backend on :8001 was down** at test time — but the
> graceful 502 ("can't reach backend") path is itself confirmed, and Phase 2 proved
> forwarding works when the backend is up. Restart the backend to exercise live browse.
>
> **Schema note:** the live `GET /marketplace/policies` has **no `source` query param** —
> filtering is client-side (4 tabs: All/Own/First-party/Community), as the plan anticipated.

- [x] **Backend proxies** in `server.py` (`# NORI:`): `GET /nori/marketplace/policies`,
  `GET /nori/marketplace/datasets/public`, `POST /nori/marketplace/policies/{id}/acquire`,
  `POST /nori/marketplace/policies/{ref}/download`.
- [x] **Streaming download** in `nori_client.download_policy()` — streams safetensors bytes
  to `~/.cache/huggingface/lerobot/nori_policies/<ref>/model.safetensors` atomically (via
  `.part` temp + `os.replace`); returns `{ref, path, size_bytes}`. Cache path helpers
  (`NORI_POLICY_CACHE`, `nori_policy_dir`) added to `utils/config.py`.
- [x] **Browse page** (`pages/marketplace.tsx`): policy cards (title, description, source
  badge, class, price), source-filter tabs + client-side search.
- [x] **Install flow**: first-party → `acquire` then `download`; own-trained → direct
  download. Per-card install status ("Installing…" → "Cached N KB locally" / error).
- [x] **Entry link**: added a "Nori" button to `LandingTopBar` → `/nori/account` (`# NORI:`,
  the one sanctioned modification to an existing LeLab screen).
- [ ] 🔴 **Robot push** via `rollout` against the downloaded policy — blocked on the Pi.
  Bytes are cached locally; wiring the cached `model.safetensors` into a rollout needs a
  reachable robot to test, so deferred with Phase 5.

---

## 4. Phase 4 — Reroute Python HF calls ✅ DONE (client + API plumbing) (2026-06-23)

Honor the invariant: **no HF token ever on the laptop.** All HF access via Nori-Backend.

> Verified: `ruff` clean, Nori files tsc-clean, `npm run build` clean. Manifest
> builder/validator **unit-tested** (valid dataset + 5 rejection cases). Live: training
> proxies forward → 401 with dummy token; upload route → 404 for missing dataset (local
> precondition runs before the backend call). Full S3 round-trip not exercised (needs a real
> dataset + backend S3), but the orchestration + error paths are in place.

- [x] **`nori_client.upload_dataset()` — full 4-step presigned-S3 flow**: build+validate
  manifest → `start` → PUT each file (`x-amz-server-side-encryption: AES256`) → `finalize`
  (retries the 422 HEAD-miss `missing` set once) → poll `GET …/{id}` until terminal
  (`PROMOTED` success; else raises). Fixed the stub's `{files:}` → `{manifest:}` body.
- [x] **Manifest rules** enforced client-side via module-level `build_manifest()` /
  `validate_manifest()` (unit-testable, no client needed): non-empty; relative paths only;
  extension allowlist; ≤5 GB/file; ≤20 GB total; must contain `info.json`. `ManifestError`.
- [x] **Upload route** `POST /nori/datasets/upload {repo_id, commit_message?}` — resolves the
  LeRobot cache path, 404s if not a dataset dir, else runs `upload_dataset` (synchronous,
  mirrors existing `/upload-dataset`; background later if long uploads hurt UX).
- [x] **Training dispatch + polling proxies** in `server.py` + typed client methods:
  `POST /nori/training/dispatch {timeout_seconds}`, `GET /nori/training/jobs`,
  `GET …/{id}`, `GET …/{id}/logs?since=`. (These also back the Phase 6 history UI.)
- [x] **`server.py` config + JWT pass-through** — done in Phase 1/2.
- [x] 🟢 **Deep integration — option (a) DONE (2026-06-23):** added
  `runners/nori_cloud.py` `NoriCloudJobRunner` implementing the `JobRunner` Protocol
  (`isinstance(r, JobRunner)` verified). Wired into `jobs.py`: `JobTarget`/`JobRecord` gain
  a `nori_cloud` runner + `timeout_seconds`/`nori_job_uuid`; `job_registry.start(...,
  nori_jwt=)` branches to it; `create_training_job` forwards `X-Nori-JWT` and maps
  `NoriBackendError` → HTTP status. A Nori training therefore appears in the **existing** job
  list + watch UI with no frontend changes (LeLab's own `/jobs/{id}/logs` calls the runner's
  `stream_log_lines`). Live: no session → 400; bad/expired token → 401.
  - **Two documented constraints** (forced by the architecture, see file header): dispatch is
    config-less (`{timeout_seconds}` only — backend decides what to train); the Python poll
    thread can't refresh the Supabase JWT, so on expiry it stops streaming gracefully and the
    frontend training-history page (refreshing token) becomes the source of truth. After a
    LeLab restart a `nori_cloud` record is marked `interrupted` (no reattach without a JWT).
- [ ] **Frontend trigger** for a `nori_cloud` job (POST `/jobs/training` with
  `target.runner="nori_cloud"`) — lands naturally on the Phase 6 training-history page.
- [ ] **Upload trigger UI** (small): a "Push to Nori" action on a dataset → `uploadDataset()`.
- [ ] Reroute `record.py` `push_to_hub` (still HF-direct) once the upload trigger UI exists.
- [ ] 🔴 **Pi-blocked (the dataset-producing half):** pull the binary recording log from
  `xlerobot.local` + `tools/export_lerobot_dataset.py` to parse it into the Parquet/mp4
  LeRobotDataset that `upload_dataset()` consumes. Needs the daemon's wire format.

---

## 5. Phase 6 — Polish ✅ DONE (2026-06-23)

> Verified: `ruff` clean, backend imports OK + all routes registered, Nori files tsc-clean,
> `npm run build` clean. Live: pair / consents / consent-revoke / deletion routes all forward
> → 401 with a dummy token (schema-validated + reached backend). All pages reachable via the
> `NoriLayout` nav (Account / Marketplace / Training / Consents / Pairing).

- [x] **Backend proxies** (`server.py`, `# NORI:`): `POST /nori/customers/me/pair`,
  `GET /nori/consents`, `POST /nori/consents`, `POST /nori/consents/{id}/revoke`,
  `POST /nori/deletion-requests` (typed Pydantic bodies). Fixed `nori_client` consent methods
  to the real schema (`grant_consent(type, policy_version, scope?)`; was a wrong `granted` flag).
- [x] **Consent UI** (`pages/consents.tsx`): grant/revoke toggles for `train_self` /
  `publish_public` (resolves the active row from `GET /consents`). `CONSENT_POLICY_VERSION`
  constant ("v1") — bump when the consent text changes.
- [x] **Deletion UI**: data-only / full scope + request button on the consents page
  (`POST /deletion-requests`; backend purge sweeper ⚠️ not yet wired — status row only).
- [x] **Pairing screen** (`pages/pairing.tsx`): manual serial → `POST /customers/me/pair`,
  updates the cached profile via `NoriContext.setCustomer`; shows paired state if already
  paired. mDNS/QR discovery still 🔴 (needs daemon advertisement).
- [x] **Training history** (`pages/training-history.tsx`): lists `GET /nori/training/jobs`,
  per-job expand with live log polling (`…/{id}/logs?since=`, 2 s, stops on terminal), plus a
  **"Start training"** button — the frontend trigger for the Phase-4 `nori_cloud` runner
  (POSTs `/jobs/training` with `runner=nori_cloud`; also appears in LeLab's watch UI).

---

## 6. Partial — static / non-protocol slices only 🟡

- [ ] **`XLerobot2WheelsConfig` static descriptor** (Phase 5 declarative part): DOF count + names,
  motor mapping, kinematic profile, calibration interface, camera enumeration — following the
  `SO101LeaderConfig`/`SO101FollowerConfig` pattern. Keep it in its own module to minimize
  upstream-merge conflict surface. **Blocked part:** the constructor's LAN transport (TCP socket
  + WebRTC channel to `xlerobot.local`) — build the descriptor, leave `connect()` stubbed.
- [ ] **`nori-protocol` shared-contract scaffolding** (R8 resolution): stand up the repo, the
  `protocol_version` handshake convention, the golden-bytes fixture-test harness, and the
  git-submodule wiring into NoriLeLab. **Blocked part:** the concrete `binary_protocol.hpp`
  struct field layout is owned by the daemon — leave the struct definition as a versioned
  placeholder until the Pi team pins it.

---

## 🔴 Blocked by Pi code — do NOT start (reference only)

- All Phase 5 LAN transport: TCP binary control/state, WebRTC video sink + signaling host,
  E-STOP reset command on the control channel.
- `tools/export_lerobot_dataset.py` — parses the Pi's binary recording stream into Parquet +
  `.mp4`; schema owned by the daemon.
- The binary recording-log **pull** from `xlerobot.local` (Phase 4 pre-upload ingest step).
- WebRTC/OpenCV video sink feeding `rollout.py` inference + the React canvas mirror.
- mDNS/QR discovery pairing UX (needs the daemon's `xlerobot.local` advertisement).
- Robot push of a downloaded policy (`rollout` against live hardware).

---

## Suggested execution order

1. **Phase 0** (env: install Node, verify both servers + OpenAPI).
2. **Phase 1** (scaffolding + `nori_client.py` + generated types) — unblocks all of 2/3/4/6.
3. Then **Phases 2, 3, 4-(backend parts), 6 in parallel** — all independent of the robot.
4. **Section 6 partials** opportunistically, alongside the above.

This is a large, fully-unblocked block of work that does not depend on the robot existing.
