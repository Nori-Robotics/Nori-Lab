# Nori Plan — LeLab Fork Implementation

This document is the concrete plan for adapting upstream LeLab (huggingface/leLab) into Nori's laptop application. It lives in the fork (`NoriLeLab`) and tracks decisions, open questions, and the implementation sequence.

**Read alongside:**
- [`CLAUDE.md`](CLAUDE.md) — upstream's architecture (still mostly valid; inherited)
- [`../Nori-Backend/LAPTOP_APP.md`](../Nori-Backend/LAPTOP_APP.md) — full design rationale + open-question discussion
- [`../Nori-Backend/plan.md`](../Nori-Backend/plan.md) — broader Nori architecture (Items 0, 3, 3.5)

---

## TL;DR

- **Web-tech stack inherited from upstream** (React + Vite + shadcn/Tailwind frontend; Python + FastAPI backend; localhost web app pattern).
- **Frontend changes are additive-only** in `frontend/src/nori/`. No modifications to existing LeLab screens.
- **Python changes are in-place, narrowly-scoped, tagged `# NORI:`** in `lelab/datasets.py`, `lelab/jobs.py`, `lelab/train.py`. Plus one new file `lelab/nori_client.py`.
- **No HF tokens on the customer's laptop, ever.** All HF access mediated by Nori-Backend (per `plan.md` 3d.i).
- **Hardware extension** (XLerobot2Wheels — bimanual + mobile base + Z-lift) is a parallel track owned by the robotics engineer.

---

## High-level architecture

```
┌─────────────────── Customer's laptop ─────────────────────┐
│                                                            │
│  ┌─ Browser ──────────────────────────────────────────┐    │
│  │   React frontend (LeLab + Nori additions)          │    │
│  │   • Sign-in / account / pairing screens (NEW)      │    │
│  │   • Marketplace browse + install (NEW)             │    │
│  │   • Consent management (NEW)                       │    │
│  │   • Calibrate / record / teleop / inference        │    │
│  │     (FROM LELAB, unchanged)                        │    │
│  └─────────────────┬──────────────────────────────────┘    │
│                    │ localhost HTTP + JWT in header         │
│  ┌─────────────────▼──────────────────────────────────┐    │
│  │   FastAPI server (LeLab Python, modified)          │    │
│  │   • Hardware bridge (LeRobot Robot class) ─────────┼────┼─→ Robot (Pi) over LAN
│  │   • Local LeRobot inference (rollout)              │    │
│  │   • Nori-routed: datasets/jobs/train via HTTP      │    │
│  └─────────────────┬──────────────────────────────────┘    │
│                    │ HTTPS + JWT                            │
└────────────────────┼───────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────┐
        │     Nori-Backend           │  Supabase / HF / AWS
        │   /api/v1/*                │  (see ../Nori-Backend/plan.md)
        └────────────────────────────┘
```

**Key invariant**: the laptop never talks to HF directly for anything Nori-mediated (datasets, training, policies). HF access always goes through Nori-Backend.

---

## What LeLab gives you out of the box

Worth scanning before deciding what to keep vs. replace:

- **Frontend stack**: React + TypeScript + Vite + shadcn/ui (Radix primitives) + Tailwind. Modern and designer-friendly.
- **Hardware integration**: `lelab/calibrate.py`, `lelab/teleoperate.py`, `lelab/record.py`, `lelab/rollout.py` — connection to the LeRobot Robot class, motor control, camera capture.
- **Recording → LeRobotDataset pipeline**: full local recording flow, video chunking, dataset assembly.
- **Local inference**: `lelab/rollout.py` runs a downloaded policy against a connected robot.
- **Live log streaming UI**: `lelab/jobs.py` already has the streaming-logs frontend hooks (we'll just point them at Nori-Backend's polling endpoint).
- **Dataset upload to HF**: `lelab/datasets.py` (today: direct HF upload using customer's HF token — must be replaced).
- **Training dispatch**: `lelab/train.py` (today: dispatches via HF Jobs with the user's own token — must be replaced).

The hardware integration alone is months of work that you're getting for free.

**[NEW] Caveat (realigned against the C++ Pi daemon, 2026-06-16):** three of the "free" pieces above are *partly superseded* because the Pi now runs a native C++ daemon with its own binary protocol (see `onboard_pi_plan.md`):
- **Hardware integration** — the Robot class no longer drives motors over serial/ZMQ; it's a LAN thin-client (TCP + WebRTC to `xlerobot.local`). See Phase 5.
- **Recording → LeRobotDataset pipeline** — frames are recorded as a binary stream on the Pi's flash, pulled to the laptop, and parsed by a new `tools/export_lerobot_dataset.py`. See Phase 4.
- **Camera capture** — replaced by a WebRTC/OpenCV video sink in the FastAPI layer. See Phase 5.

The dataset *assembly format* (Parquet + mp4 LeRobotDataset) and the *local inference* path (`rollout.py`) are still reused — they just consume laptop-parsed / WebRTC-decoded inputs instead of locally-captured ones.

---

## Decisions made

### Customer provisioning split into provision + pair (decided 2026-06-10)

Provisioning happens on first sign-in; robot pairing is a separate later step.

- **`POST /api/v1/customers/me/provision`** — called by the laptop on first Supabase Auth sign-in. Creates `customers` row + `usage` row + `retention_policies` row + the customer's private HF dataset repo. **No robot serial required.** Idempotent.
- **`POST /api/v1/customers/me/pair`** — called later, when the customer's robot arrives. Attaches `robot_serial_number` to the existing customer row.

**Schema change required**: `customers.robot_serial_number` becomes nullable (Nori-Backend migration 006).

**Rationale**: beta customers paid before their robots shipped. They need account access (sign in, browse marketplace, manage consents) before they can pair a robot. Forcing pair-at-signup locks pre-shipment customers out. Splitting the endpoints keeps the explicit single-provisioning-point design (atomic with HF repo creation, testable, debuggable) while supporting the browse-before-pair UX.

### Live training log streaming via polling (decided 2026-06-10)

- **`GET /api/v1/training/jobs/{id}/logs?since=<offset>`** returns log lines from offset onward.
- Client polls every ~2s, accumulates.
- ~4s end-to-end latency to log delivery; acceptable for v1.
- Backend implementation is a normal HTTP route (no long-lived connections to manage).
- Upgrade path to SSE is available later if latency becomes painful — same `StreamingResponse` pattern the marketplace download uses today.

### Auth: Supabase Auth JWT (decided earlier)

- Frontend uses the Supabase JS SDK for login. Stores JWT in browser localStorage.
- Every Nori-Backend call carries `Authorization: Bearer <jwt>`.
- LeLab Python side forwards the JWT on outbound calls; never validates it itself (Nori-Backend does, via JWKS).
- No HF token, no Supabase service-role key on the laptop.

### Frontend strategy: additive-only

- All new code lives under `frontend/src/nori/`.
- No modifications to existing LeLab screens.
- Use upstream's shadcn/Tailwind component library — do not introduce a parallel UI kit.

### Python strategy: in-place rerouting, narrowly-scoped

- Existing files (`lelab/datasets.py`, `lelab/jobs.py`, `lelab/train.py`) get modified at the specific lines that call HF directly.
- All modified lines/blocks tagged with `# NORI:` comments for easy spotting during upstream merges.
- New file `lelab/nori_client.py` wraps `httpx`/`requests` with JWT auth and exposes helper methods (`upload_dataset`, `dispatch_training`, etc.).

### Robot pairing UX (decided 2026-06-10)

- **Primary**: LAN mDNS discovery — the Pi advertises itself; laptop sees it; user clicks "Pair" and confirms with a short serial code (last 6 chars on a sticker or QR).
- **Fallback**: manual full-serial entry — for cases where the Pi can't be discovered (different subnet, mDNS blocked by router, robot not online yet).

Both paths submit the same `POST /api/v1/customers/me/pair {robot_serial_number}` call to Nori-Backend. The UX wiring is purely client-side.

### Hardware extension scope (decided 2026-06-10)

**Rule of thumb**: "must it run to stay safe if the laptop dies?" → keep on the Pi. Everything else can live in LeLab's Robot class.

- **Lift into the LeLab fork** (declarative `XLerobot2Wheels` class): DOF count + names, motor mapping, kinematic profile, calibration interface, camera enumeration. This is the static descriptor that LeLab's existing flows (calibrate, teleop, record, rollout) need to function.
- **Stays on the Pi**: real-time control loop (50 Hz motor commands), the full local safety stack (dead-man, stall-soften, current/torque limits, E-STOP), camera capture, the thin-client LAN protocol.

The fork's Robot class is a thin wrapper that *describes* the robot and connects over LAN; it does not own real-time control or safety.

**[NEW] Thin-client transport (realigned against the C++ Pi daemon, 2026-06-16):** the Pi now runs a native C++20 `NoriCoreAgent` daemon (see `onboard_pi_plan.md`) that owns the 50 Hz control loop, the safety stack, and camera capture, and exposes a binary network protocol — **not** the legacy Python `scservo_sdk` serial path or custom ZMQ-over-Wi-Fi ports. Consequences for the fork's Robot class:

- The `XLerobot2Wheels` constructor does **not** open low-level serial connections (`scservo_sdk`) or ZMQ sockets. Instead it opens **a single low-latency TCP socket** (for control/state, the binary C-struct protocol the daemon speaks) **plus an optimized WebRTC/UDP client channel** (for video) directly to the Pi's fixed address `xlerobot.local`.
- The class is therefore purely a *network client + static descriptor*: DOF/names, motor mapping, kinematic profile, calibration interface, and camera enumeration, talking to the daemon over LAN. All real-time and safety behavior lives in the C++ daemon on the Pi.

### Distribution (deferred decision)

Likely PyPI to mirror what upstream LeLab does (`pip install nori-lab` → bundled frontend + Python backend, single `lelab`-style CLI launcher). GitHub Releases / native installers come later if end-users aren't dev-comfortable. Apple Silicon Mac is the primary target per backend `plan.md` Item 0.c. **Action**: defer until first customer ships.

### Designer involvement (deferred)

shadcn's default theme is fine for v1. Real design work can land later without rework as long as we stay disciplined about using shadcn primitives and Tailwind tokens (no custom CSS that locks in v1 styling). **Action**: defer until first customer-facing release.

---

---

## Auth model

- **Supabase Auth** is the identity provider. The fork's frontend uses the Supabase JS SDK to log in (email/password initially; OAuth providers later) and receives a JWT.
- **JWT is ES256-signed**. Nori-Backend verifies it via Supabase's JWKS endpoint — no shared secret to ship to clients.
- **Token storage in the laptop app**: the frontend stores the JWT in browser localStorage (browser runs on localhost; same-origin OK) and includes it as `Authorization: Bearer <jwt>` on every Nori-Backend call.
- **LeLab Python layer** receives the JWT from the frontend on internal HTTP calls (e.g. via an `X-Nori-JWT` header) and forwards it on outbound calls to Nori-Backend. The LeLab Python doesn't validate the JWT itself — Nori-Backend does.
- **No long-lived secret on the laptop.** Tokens expire (Supabase default 1h) and the SDK refreshes them automatically.

---

## The invariant: backend-mediated HF access

This is the most important non-negotiable architectural property. Documented in `../Nori-Backend/plan.md` Task 3d.i. Restated here for the fork's authors:

**The customer's laptop never holds, sees, or uses a Hugging Face access token.**

This means:
- `lelab/datasets.py` cannot have `HfApi(token=...).upload_folder(...)` calls in its production code path
- `lelab/jobs.py` and `lelab/train.py` cannot call `huggingface_hub.run_job(...)` directly
- The downloaded policies for installation come from Nori-Backend's streaming endpoint, never from a `hf_hub_download(token=customer_token, ...)` call
- The laptop's `.env` (if any) does NOT contain `HF_TOKEN` or equivalent

**Why:**
- Per-customer HF tokens require per-customer HF accounts/seats → cost scales linearly with customers
- HF doesn't expose programmatic per-repo scoped tokens → no way to limit blast radius per customer
- Nori-Backend HOLDS one org-admin token (in its secret manager) and is the only entity that uses it for HF writes

This applies to first-party policy installations too — the fork shouldn't reach into HF to download a policy even though the location is technically known. Always go through `/api/v1/marketplace/policies/{ref}/download`.

The hardware integration code (`calibrate.py`, `teleoperate.py`, `record.py`, `rollout.py`) doesn't touch HF and can stay as-is.

---

## Implementation phases

Phases 1-2 are sequential; 3 and 4 can run in parallel after 2; 5 (hardware) is gated on Q4 and runs in parallel with everything once unblocked.

### Phase 0 — Setup (likely already done)

- [x] Fork upstream `huggingface/leLab` → `NoriLeLab`
- [x] `git remote add upstream https://github.com/huggingface/leLab.git`
- [ ] `pip install -e .` in a fresh venv; verify `lelab --dev` boots
- [ ] Connect a test robot (SO-101 supported by default); confirm calibrate/teleop/record work end-to-end
- [ ] Run Nori-Backend locally (`cd ../Nori-Backend/src && uvicorn main:app`); confirm OpenAPI at `http://localhost:8000/openapi.json`

### Phase 1 — Foundation: Nori scaffolding

Goal: structure ready for additive work; no functionality yet.

- [ ] Create `frontend/src/nori/` directory structure:
  ```
  frontend/src/nori/
  ├── api/
  │   ├── client.ts        # typed HTTP client for Nori-Backend
  │   └── types.ts         # auto-generated from openapi.json
  ├── auth/
  │   ├── supabase.ts      # Supabase JS SDK init
  │   └── session.ts       # JWT storage + refresh
  ├── pages/
  │   ├── sign-in.tsx
  │   ├── account.tsx
  │   ├── pairing.tsx
  │   ├── marketplace.tsx
  │   ├── consents.tsx
  │   └── training-history.tsx
  └── components/          # Nori-specific composite components (shadcn primitives stay shared)
  ```
- [ ] Generate the typed API client from Nori-Backend's openapi spec:
  ```bash
  npx openapi-typescript http://localhost:8000/openapi.json -o frontend/src/nori/api/types.ts
  ```
  Add this to the build pipeline so types stay in sync.
- [ ] Create `lelab/nori_client.py`:
  - Reads `NORI_BACKEND_URL` from env (default `http://localhost:8000`)
  - Reads JWT from a configurable source (initially: a request header forwarded from the frontend)
  - Exposes typed methods: `provision_customer()`, `pair_robot()`, `upload_dataset()`, `dispatch_training()`, `get_job_status()`, `get_job_logs()`, etc.
  - Uses `httpx` (already a transitive dep via huggingface_hub) for HTTP
- [ ] Add env var configuration to `lelab/utils/config.py` (or wherever feels natural in the existing structure):
  - `NORI_BACKEND_URL`
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the anon key — NOT service-role; safe to ship in the React bundle)
- [ ] Add route registration in `frontend/src/App.tsx` for the new `/nori/*` paths (one-line addition, not a modification of existing routes)

### Phase 2 — Auth + provisioning

Goal: a customer can sign in, get provisioned, see their account.

- [ ] **Sign-in screen** (`frontend/src/nori/pages/sign-in.tsx`):
  - Email/password form using Supabase JS SDK
  - On success, store JWT in localStorage; redirect to `/account`
- [ ] **JWT plumbing**: every authenticated frontend → backend call includes the JWT. Two layers:
  - Frontend → LeLab Python: include JWT in request header (e.g. `X-Nori-JWT`)
  - LeLab Python → Nori-Backend: read header, forward as `Authorization: Bearer ...`
- [ ] **Customer provisioning on first sign-in**:
  - After successful sign-in, the laptop calls `POST /api/v1/customers/me/provision` (via LeLab Python via `nori_client.provision_customer()`)
  - Idempotent — safe to call on every sign-in
  - Backend returns the provisioned context (id, email, allowance, paired status, etc.)
- [ ] **Account page** (`frontend/src/nori/pages/account.tsx`):
  - Calls `GET /api/v1/customers/me` (also via nori_client)
  - Displays profile, billing tier, compute allowance, paired robot serial (or "not paired yet")
  - Route to `/pairing` if not paired and the user wants to pair

### Phase 3 — Marketplace (browse + install)

Goal: customer can browse policies and install them onto a paired robot.

- [ ] **Marketplace browse** (`frontend/src/nori/pages/marketplace.tsx`):
  - Calls `GET /api/v1/marketplace/policies` (EXISTS in Nori-Backend)
  - Renders a list of policy cards: title, description, source badge (own/first-party/acquired)
  - Filter / search client-side initially (server-side filtering is v2)
- [ ] **Install flow**:
  - For first-party listings without acquisition: prompt "Install this policy?", then POST acquire + start download
  - For own-trained: direct download
  - Download via `GET /api/v1/marketplace/policies/{ref}/download` (EXISTS)
  - LeLab Python receives the bytes and writes to a local cache (matches LeLab's existing rollout flow that loads policies from local disk)
- [ ] **Robot push**: after download lands locally, the user can run `lelab rollout` against the downloaded policy. This uses LeLab's existing inference path unchanged.

### Phase 4 — Reroute Python HF calls

Goal: existing LeLab features (record/upload, dispatch training) route through Nori-Backend instead of HF directly.

For each change, tag the modified block with `# NORI:` comments.

- [ ] **`lelab/datasets.py`** — dataset upload:
  - Find the `HfApi(token=...).upload_folder(...)` (or equivalent) call.
  - Replace with a `nori_client.upload_dataset(local_path)` helper that drives the backend's **4-step presigned-S3 flow** (the backend no longer accepts a single path upload — see the dependency matrix + `../Nori-Backend/DATASET_UPLOAD_DESIGN.md`):
    1. Build the manifest from the assembled dataset dir; `POST /datasets/upload/start`.
    2. PUT each file to its presigned S3 URL with header `x-amz-server-side-encryption: AES256`.
    3. `POST .../finalize`; on 422 HEAD-miss, retry the `missing` PUTs and re-finalize.
    4. Poll `GET .../{session_id}` until terminal (`PROMOTED` = success).
  - ✅ Backend endpoints now exist (re-verified 2026-06-16) — this is no longer blocked; it's fork-side client work.
- [ ] **[NEW] `lelab/datasets.py` — post-session binary log pull + local export (realigned 2026-06-16):** with the C++ Pi daemon, recording frames are no longer assembled into a LeRobotDataset on the Pi. The daemon writes a **compact, sequential binary stream to the Pi's local flash buffer** during a run. The laptop must ingest and parse that stream before any cloud upload. New flow:
  1. On recording finish, the React frontend fires a completion event to the FastAPI backend.
  2. `lelab/datasets.py` **pulls the raw binary log block from the Pi over the network** (a quick HTTP `GET` endpoint or basic file transfer from `xlerobot.local`).
  3. The backend runs **`tools/export_lerobot_dataset.py` locally on the laptop CPU** to parse the binary chunks into high-fidelity **Apache Parquet** files + synchronized **`.mp4`** video frames (i.e. assemble a standard LeRobotDataset on the laptop).
  4. Only then does the assembled dataset get routed to Supabase/HF via `nori_client.upload_dataset(...)` (backend-mediated, per the HF-token invariant).
  - **New file required:** `tools/export_lerobot_dataset.py` (laptop-side binary → Parquet/mp4 parser). This replaces the assumption that LeLab's in-process recording pipeline produces the dataset directly.
- [ ] **`lelab/jobs.py`** / **`lelab/train.py`** — training dispatch:
  - Replace `huggingface_hub.run_job(...)` with `nori_client.dispatch_training(timeout_seconds=...)`.
  - Backend returns `{internal_job_uuid, hf_job_id, ...}` (the existing dispatch response shape).
- [ ] **Training-log polling**:
  - Replace `huggingface_hub.fetch_job_logs(...)` (the LeLab-side streaming hook) with periodic `nori_client.get_job_logs(job_uuid, since=offset)` calls every ~2s.
  - Surface live logs in the existing LeLab "watch training" UI.
- [ ] **`lelab/server.py`** — config bootstrap:
  - Add NORI_BACKEND_URL + JWT-forwarding configuration.
  - Wire the JWT header pass-through from frontend → LeLab Python → Nori-Backend.

### Phase 5 — Hardware extension (parallel; gated on Q4)

Goal: LeLab knows about XLerobot2Wheels and can drive it.

- [ ] Define `XLerobot2WheelsConfig` (or equivalent) following LeLab's existing config-class pattern (see `SO101LeaderConfig`/`SO101FollowerConfig` in upstream).
- [ ] Add hardware bridge for bimanual SO-101 + differential-drive base + Z-axis lift.
- [ ] Extend calibration flow for the additional joints (Z-lift, base wheel encoders if needed).
- [ ] Extend teleop UI to cover the additional DOF.
- [ ] Update record flow so all joint streams + cameras are captured.
- [ ] **[NEW] Implement the LAN thin-client transport (realigned 2026-06-16):** the `XLerobot2Wheels` constructor opens **one TCP socket** (binary control/state protocol to the C++ daemon) + **one WebRTC/UDP channel** (video) to `xlerobot.local`. No `scservo_sdk`, no ZMQ. When LeLab's calibrate/teleop/record/rollout flows "spin up" the robot instance, this is all the constructor does — connect, don't drive. Pack/unpack the daemon's binary C-structs on the TCP side.

#### [NEW] Real-time video capture via WebRTC / OpenCV (realigned 2026-06-16)

The C++ Pi daemon bypasses the legacy `image_server.py` entirely and streams hardware MJPEG frames over low-overhead **UDP / WebRTC DataChannels**. The laptop needs an explicit path to receive, decode, and render this feed for both teleop and inference. The FastAPI layer in `lelab/` owns this:

- [ ] **WebRTC signaling / video sink:** the FastAPI server hosts the WebRTC signaling exchange with the Pi daemon (or acts as the native sink, decoding frames via optimized OpenCV `cv2.VideoCapture` loops).
- [ ] **Inference tap:** the decoded raw frame array is passed directly into the local model inference loops (ACT / Diffusion Policy vectors in `lelab/rollout.py`) — the same frames feed the policy.
- [ ] **Live view mirror:** the live frame matrix is mirrored straight to the React frontend canvas component **without lagging the execution engine** (keep decode/inference and UI mirroring decoupled so neither stalls the other).
- [ ] **Supersedes:** the plan's earlier assumption that teleop/inference visuals are inherited unchanged from upstream LeLab. Upstream's camera-capture path is replaced by this WebRTC/OpenCV sink.

Tag any changes to existing LeLab files with `# NORI:`. Where possible, isolate the new robot class as its own module so upstream merges don't touch it.

### Phase 6 — Polish (smaller items, parallel-runnable)

- [ ] **Consent management UI** (`frontend/src/nori/pages/consents.tsx`):
  - Calls `POST /api/v1/consents` and revoke variant
  - Toggle UI for `train_self` and `publish_public` consents
- [ ] **Training history** (`frontend/src/nori/pages/training-history.tsx`):
  - Calls `GET /api/v1/training/jobs` + `{id}`
  - Per-job detail view with logs polling
- [ ] **Deletion request UI**:
  - Calls `POST /api/v1/deletion-requests`
- [ ] **Pairing screen** (`frontend/src/nori/pages/pairing.tsx`):
  - Manual serial entry text input
  - Submits to `POST /api/v1/customers/me/pair`
- [ ] **QR / mDNS pairing** (future): post-MVP polish for pairing UX

---

## Backend endpoint dependency matrix

Phase work depends on Nori-Backend endpoints. **Status re-verified against `../Nori-Backend/README.md` on 2026-06-16 — all required endpoints now exist.** The remaining work is fork-side integration, not backend gaps.

| Endpoint | Phase | Status |
|---|---|---|
| `GET /health` | 0 | ✅ exists — **note: mounted at `/health`, NOT `/api/v1/health`** |
| `GET /api/v1/marketplace/policies` (`?source=own\|first_party\|community`) | 3 | ✅ exists |
| `POST /api/v1/marketplace/policies/{listing_id}/acquire` | 3 | ✅ exists |
| `GET /api/v1/marketplace/policies/{ref}/download` | 3 | ✅ exists — `ref` = `jobs.id` (own) or `marketplace_listings.id` |
| `GET /api/v1/marketplace/datasets/public` | 3 | ✅ exists — auth-optional |
| `POST /api/v1/training/dispatch` | 4 | ✅ exists — body `{timeout_seconds: 60..3600}` |
| `POST /api/v1/customers/me/provision` | 2 | ✅ exists |
| `POST /api/v1/customers/me/pair` | 6 | ✅ exists — 409 on re-pair to a different serial |
| `GET /api/v1/customers/me` | 2 | ✅ exists — returns `{provisioned: false, ...}` if not provisioned |
| `POST /api/v1/consents` + `/consents/{id}/revoke` + `GET /consents` | 6 | ✅ exists |
| `GET /api/v1/training/jobs` + `{job_id}` | 6 | ✅ exists |
| `GET /api/v1/training/jobs/{job_id}/logs?since=<offset>` | 4 | ✅ exists — returns `{lines, next_offset, job_status, is_terminal}` |
| **Dataset upload (4-step S3 flow — replaces the assumed single `POST .../upload`)** | 4 | ✅ exists — see note below |
| ↳ `POST /api/v1/datasets/upload/start` | 4 | ✅ exists |
| ↳ `POST /api/v1/datasets/upload/{session_id}/finalize` | 4 | ✅ exists |
| ↳ `GET /api/v1/datasets/upload/{session_id}` | 4 | ✅ exists — poll during finalize |
| ↳ `POST /api/v1/datasets/upload/{session_id}/cancel` | 4 | ✅ exists |
| `POST /api/v1/deletion-requests` | 6 | ⚠️ exists — but the purge sweeper is **not yet wired** (status row only) |

**⚠️ Dataset upload shape changed.** The plan originally assumed a single `POST /api/v1/datasets/{customer_id}/upload` that takes a local path. The backend instead implements a **presigned-S3 multi-file flow** (full design in `../Nori-Backend/DATASET_UPLOAD_DESIGN.md`):

1. `POST /datasets/upload/start` with a manifest `[{path, size}, ...]` → returns `{session_id, uploads: [{path, put_url}], expires_at}` (URLs live 1 h).
2. Laptop **PUTs each file directly to S3**, each with header `x-amz-server-side-encryption: AES256` (S3 rejects otherwise).
3. `POST /datasets/upload/{session_id}/finalize` → backend validates + commits to the customer's HF repo. On HEAD-miss it returns 422 `{reason, missing: [paths]}` → retry the listed PUTs, re-finalize.
4. Poll `GET /datasets/upload/{session_id}` (~5 s) while `status=FINALIZING`; terminal states: `PROMOTED` / `FAILED` / `PROMOTION_FAILED` / `CANCELLED`.

Manifest rules to enforce client-side before calling `/start`: non-empty; relative paths only (no `..`/absolute); extension allowlist `{.parquet, .json, .mp4, .mkv, .txt, .md, .png, .jpg}`; ≤ 5 GB/file; ≤ 20 GB total; must contain `info.json`. This dovetails with the `[NEW]` `tools/export_lerobot_dataset.py` step (Phase 4) — that parser must emit exactly this file set.

See `../Nori-Backend/README.md` (API reference) and `../Nori-Backend/todos.md` for the backend team's build order.

---

## [NEW] Pi daemon LAN contract matrix

These are the **robot-side** dependencies — channels the C++ `NoriCoreAgent` daemon (see `onboard_pi_plan.md`) must expose over LAN for the fork to function. Distinct from the Nori-Backend matrix above: these are spoken directly to `xlerobot.local`, never through the cloud. Status as of 2026-06-16 (daemon is a parallel track owned by the robotics/systems engineer).

| Channel | Transport | Used by (fork side) | Phase | Status |
|---|---|---|---|---|
| Control / state stream | TCP socket, binary C-structs (timestamped) | `XLerobot2Wheels` constructor + calibrate/teleop/record/rollout | 5 | ❌ depends on daemon |
| Live video feed | WebRTC DataChannel / UDP (MJPEG) | WebRTC video sink → `rollout.py` inference + React canvas | 5 | ❌ depends on daemon |
| WebRTC signaling exchange | HTTP/WS handshake (SDP/ICE) | FastAPI signaling host in `lelab/` | 5 | ❌ depends on daemon |
| Binary recording-log pull | HTTP `GET` (or basic file transfer) from flash buffer | `lelab/datasets.py` post-session ingest → `tools/export_lerobot_dataset.py` | 4 | ❌ depends on daemon |
| mDNS presence advertisement | mDNS (`xlerobot.local`) | LAN discovery for pairing UX | 6 | ⚠️ specified in `onboard_pi_plan.md` 2c |
| Pairing handshake / token auth | HTTP over the captive-portal/LAN path | Pairing flow (`POST /api/v1/customers/me/pair`) | 6 | ⚠️ specified in `onboard_pi_plan.md` 2c |
| Safety E-STOP reset | TCP control command (clears the C++ `e_stop_latched` hard latch) | UI "reset" action after an obstruction latch | 5 | ❌ depends on daemon |

**Notes:**
- The exact binary protocol schema (struct layout, byte order, timestamp units) is owned by the daemon and must be mirrored by the fork's pack/unpack code. Pin a version field.
- The watchdog/dead-man threshold (~100 ms proposed, 500 ms baseline) lives on the Pi — the fork just needs to keep the control stream fed; see `onboard_pi_plan.md` 2b.
- These channels are **not** in the Nori-Backend matrix because they bypass the cloud entirely; the only cloud touchpoint in the recording path is the final dataset upload.

---

## Maintenance pattern (tracking upstream)

The fork must keep pulling upstream LeLab changes — LeRobot moves fast and LeLab gains features.

**Setup (done):**
```bash
git remote add upstream https://github.com/huggingface/leLab.git
```

**Periodic merge:**
```bash
git fetch upstream
git merge upstream/main
```
Cadence: weekly during early dev, monthly once stable.

**Conflict-handling rules:**
1. **`# NORI:`-tagged in-place changes**: when conflicts hit those lines, the marker makes the Nori-specific edit easy to identify. Re-apply by hand if upstream rewrote the surrounding code.
2. **Additive files (`frontend/src/nori/`, `lelab/nori_client.py`)**: merge cleanly forever; no conflict possible.
3. **Hardware extension**: keep `XLerobot2Wheels` in its own module/file if possible; minimizes conflict surface with upstream changes to LeLab's robot abstractions.
4. **Drift threshold**: if upstream rewrites a file you've edited 3+ times across recent merges, that file may have meaningfully diverged. Consider whether to hard-fork it (own that file entirely; stop merging upstream changes for it).

**Contributing back:**
- Hardware extension (XLerobot2Wheels) may be generally useful — consider upstream PR.
- UI improvements that aren't Nori-branding may upstream cleanly.
- Anything that calls Nori-Backend (`lelab/nori_client.py`, the `# NORI:` reroutes, account/pairing/marketplace UI) stays in our fork.

---

## File map: where new code lives

### Top-level

- `NORI_PLAN.md` — this file
- `CLAUDE.md` — upstream's; leave alone

### Frontend additions (under `frontend/src/nori/`)

- `api/client.ts`, `api/types.ts` — typed Nori-Backend client (types auto-generated from openapi.json)
- `auth/supabase.ts`, `auth/session.ts` — Supabase Auth integration
- `pages/sign-in.tsx`, `pages/account.tsx`, `pages/pairing.tsx`, `pages/marketplace.tsx`, `pages/consents.tsx`, `pages/training-history.tsx`
- `components/` — Nori-specific composite components (use shadcn primitives from `frontend/src/components/ui/`)

### Backend additions (under `lelab/`)

- `lelab/nori_client.py` — HTTP client for Nori-Backend with JWT auth
- **[NEW]** Robot class file for `XLerobot2Wheels` — lives **inside this `NoriLeLab` repo as an integrated submodule / extension of the underlying `lerobot` Python package** (no longer "TBD"). It is a LAN thin-client: TCP socket + WebRTC/UDP to `xlerobot.local`, not a serial/ZMQ driver.
- **[NEW]** `tools/export_lerobot_dataset.py` — laptop-side parser that turns the Pi's raw binary recording stream into Parquet + `.mp4` (LeRobotDataset) before upload.
- **[NEW]** WebRTC video-sink module under `lelab/` — hosts signaling / decodes the Pi daemon's MJPEG-over-WebRTC feed via OpenCV, feeds both `rollout.py` inference and the React canvas.

### Backend in-place modifications (existing files; tagged `# NORI:`)

- `lelab/datasets.py` — upload reroute
- `lelab/jobs.py`, `lelab/train.py` — training dispatch reroute + log polling
- `lelab/server.py` — config + JWT forwarding
- `frontend/src/App.tsx` — register Nori routes

---

## Env vars needed (for the laptop runtime)

Add to a `.env` or environment configuration (do not commit secrets):

| Var | Purpose | Where to find |
|---|---|---|
| `NORI_BACKEND_URL` | Base URL for Nori-Backend API | `http://localhost:8000` for local; `https://api.nori.com` for prod (TBD) |
| `SUPABASE_URL` | Supabase project URL | Supabase dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY` | Anon key (safe to ship in client bundle) | Supabase dashboard → Project Settings → API → anon |

**Do NOT** add to this laptop app:
- `HF_TOKEN` / `HF_ORG_ADMIN_TOKEN` — never; backend handles all HF access
- `SUPABASE_SERVICE_ROLE_KEY` — never on the client; backend-only

---

## What's NOT in this plan (intentional)

- **NoriScreen** (the on-robot kiosk UI on the Pi's DSI screen) — separate surface; not part of the laptop app
- **Pi agent** — runs on the robot, not the laptop
- **The website at nori.com** — separate future surface; share components from this fork later
- **B2B operator dashboard / fleet telemetry view** — Item 6 + 3.1 in the broader plan; later

---

## Glossary

- **LeLab**: official Hugging Face LeRobot GUI. The thing being forked.
- **LeRobot**: the underlying robot-learning library. LeLab is a UI over LeRobot.
- **Nori-Backend**: the cloud service (separate repo, `Nori-Backend`).
- **NoriLeLab / this fork**: the laptop app — what this doc is about.
- **Pi agent**: the Raspberry Pi software running on the robot itself. Separate from the laptop app; communicates over LAN. Not in scope for this doc.
- **NoriScreen**: existing on-robot kiosk UI (face + E-STOP on the Pi's DSI screen). Distinct from the laptop app. May coexist.
- **3d.i / 3d.ii**: trust boundaries described in `Nori-Backend/plan.md`. 3d.i = customer↔backend (no HF tokens on laptop); 3d.ii = backend↔training-container (no HF tokens in HF Jobs container).
- **XLerobot2Wheels**: the LeRobot Robot class for Nori's hardware — bimanual SO-101 arms + differential-drive mobile base + Z-axis lift.
