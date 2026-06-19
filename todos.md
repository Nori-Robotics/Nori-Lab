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

## 2. Phase 2 — Auth + provisioning ✅ (backend exists)

- [ ] **Sign-in screen** (`frontend/src/nori/pages/sign-in.tsx`): email/password via Supabase JS
  SDK; on success store JWT in localStorage; redirect to `/account`.
- [ ] **JWT plumbing** (two hops):
  - Frontend → LeLab Python: include JWT in `X-Nori-JWT` header.
  - LeLab Python → Nori-Backend: read header, forward as `Authorization: Bearer <jwt>`.
    LeLab Python never validates the JWT itself.
- [ ] **Provisioning on first sign-in**: call `POST /api/v1/customers/me/provision` via
  `nori_client.provision_customer()`. Idempotent — safe on every sign-in.
- [ ] **Account page** (`frontend/src/nori/pages/account.tsx`): `GET /api/v1/customers/me`
  (returns `{provisioned: false, ...}` if not yet provisioned). Show profile, billing tier,
  compute allowance, paired robot serial (or "not paired yet"); link to `/pairing`.

---

## 3. Phase 3 — Marketplace browse + install ✅ (backend exists)

- [ ] **Browse** (`frontend/src/nori/pages/marketplace.tsx`): `GET /api/v1/marketplace/policies`
  (`?source=own|first_party|community`). Policy cards: title, description, source badge.
  Client-side filter/search for v1.
- [ ] **Acquire + download flow**:
  - First-party w/o acquisition → prompt, then `POST /marketplace/policies/{listing_id}/acquire`.
  - Download via `GET /api/v1/marketplace/policies/{ref}/download` (`ref` = `jobs.id` for own,
    `marketplace_listings.id` otherwise). LeLab Python receives bytes, writes to local cache
    (matches the existing rollout local-disk load path).
- [ ] *(Browse + download + cache only.* **Robot push** via `rollout` against hardware is 🔴
  blocked — needs the Pi. Build everything up to "policy cached locally" now.)

---

## 4. Phase 4 — Reroute Python HF calls ✅ (the non-Pi slice; backend exists)

Honor the invariant: **no HF token ever on the laptop.** All HF access via Nori-Backend.

- [ ] **`lelab/datasets.py` — upload client (4-step presigned-S3 flow)** `# NORI:`
  Replace any direct `HfApi(token=...).upload_folder(...)` with
  `nori_client.upload_dataset(local_path)` driving:
  1. Build manifest `[{path, size}, ...]` from the assembled dataset dir; `POST /datasets/upload/start`.
  2. PUT each file to its presigned S3 URL with header `x-amz-server-side-encryption: AES256`.
  3. `POST /datasets/upload/{session_id}/finalize`; on 422 HEAD-miss, retry the listed `missing`
     PUTs and re-finalize.
  4. Poll `GET /datasets/upload/{session_id}` (~5 s) until terminal (`PROMOTED` = success;
     `FAILED`/`PROMOTION_FAILED`/`CANCELLED`).
  - Enforce manifest rules client-side before `/start`: non-empty; relative paths only
    (no `..`/absolute); extension allowlist `{.parquet,.json,.mp4,.mkv,.txt,.md,.png,.jpg}`;
    ≤5 GB/file; ≤20 GB total; must contain `info.json`.
  - *(This is the upload-to-backend client only. The pre-step that **pulls the binary recording
    log from the Pi** is 🔴 blocked.)*
- [ ] **`lelab/jobs.py` / `lelab/train.py` — training dispatch** `# NORI:`
  Replace `huggingface_hub.run_job(...)` with `nori_client.dispatch_training(timeout_seconds=...)`
  (`POST /api/v1/training/dispatch`, body `{timeout_seconds: 60..3600}`). Returns
  `{internal_job_uuid, hf_job_id, ...}`.
- [ ] **Training-log polling** `# NORI:` Replace `huggingface_hub.fetch_job_logs(...)` with
  `nori_client.get_job_logs(job_uuid, since=offset)` every ~2 s
  (`GET /api/v1/training/jobs/{id}/logs?since=<offset>` → `{lines, next_offset, job_status,
  is_terminal}`). Surface in the existing "watch training" UI.
- [ ] **`lelab/server.py` — config bootstrap** `# NORI:` add `NORI_BACKEND_URL` + JWT
  pass-through wiring (frontend → LeLab Python → Nori-Backend).

---

## 5. Phase 6 — Polish ✅ (backend exists; pull forward while Pi is in flight)

- [ ] **Consent management UI** (`frontend/src/nori/pages/consents.tsx`): toggles for
  `train_self` and `publish_public` via `POST /api/v1/consents`, `/consents/{id}/revoke`,
  `GET /consents`.
- [ ] **Training history** (`frontend/src/nori/pages/training-history.tsx`):
  `GET /api/v1/training/jobs` + `{job_id}`; per-job detail with logs polling.
- [ ] **Deletion request UI**: `POST /api/v1/deletion-requests`. (Backend purge sweeper is
  ⚠️ not yet wired — writes a status row only; UI is fine to build.)
- [ ] **Pairing screen — manual serial entry only** (`frontend/src/nori/pages/pairing.tsx`):
  text input → `POST /api/v1/customers/me/pair {robot_serial_number}` (409 on re-pair to a
  different serial). The mDNS/QR discovery path is 🟡/🔴 (needs daemon advertisement).

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
