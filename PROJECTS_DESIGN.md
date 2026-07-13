# Projects: record → collect → train — design (2026-07-13)

**Status: DESIGN ONLY — nothing below is implemented.**

The user-facing gap this closes: today, recording lives on the legacy LeLab
page (`/recording`) with a free-text dataset id, uploads are a detached step,
and the Nori training tab asks for a raw HF repo string. There is no concept
that ties "the thing I'm teaching the robot" to its recordings and its
training runs. This design introduces **Projects** as that concept.

## 1. The concept

**One project = one LeRobot dataset repo in the user's personal HF
namespace** (`{hf_user}/{project-slug}`), plus its local cache directory.

This mapping is deliberate — it means a project needs **no new backend
tables and no new storage system**:

- A LeRobot dataset is already an episode collection; a *recording session*
  is just `record(..., resume=True)` appending episodes to it
  (`lelab/record.py` already supports `resume`).
- "View my projects" is already answerable by `lelab/datasets.py:
  list_all_datasets()` (local cache + personal-Hub listing, merged with
  `source: local|hub|both`).
- "Back up to my HF" is the existing `handle_upload_dataset` →
  `dataset.push_to_hub()` with the user's own token (`hf-auth` flow).
- "Send to Nori for cloud training" is the existing backend-mediated 4-step
  S3 upload (`/nori/datasets/upload`, keyed by `repo_id`).

What's genuinely new is a small local metadata ledger + three UI surfaces.

### Local project ledger

`~/.cache/huggingface/lerobot/projects.json` (managed in
`lelab/utils/config.py`, same pattern as saved ports/configs):

```json
{
  "projects": [
    {
      "repo_id": "michealma/pick-place-mugs",
      "title": "Pick & place mugs",
      "task": "Pick up the mug and place it on the rack",
      "created_at": "2026-07-13T21:04:00Z",
      "sessions": [
        {"started_at": "…", "ended_at": "…", "episodes_added": 12}
      ],
      "last_hub_push_at": "…",
      "last_nori_upload": {"session_id": "…", "finalized_at": "…", "episode_count": 30}
    }
  ]
}
```

Why a ledger and not pure derivation: episode counts and repo listings are
derivable, but session history, the task prompt (recording needs
`single_task` anyway), and "what have I uploaded to Nori and when" are not.
The ledger is advisory — datasets on disk that aren't in it still show up
(as "unfiled datasets"), so nothing breaks if it's deleted.

## 2. Page placement — decision

**A new page: `/nori/projects` ("Projects"), plus a 4th card on the Nori
home page.** Rationale over the alternatives:

- *Extend `/nori/remote` (teleop)?* Recording is teleop-adjacent but the
  project lifecycle (create, browse, upload, train handoff) isn't — it
  would bury data management inside a live-driving screen.
- *Extend `/nori/training`?* Training is the consumer of projects, not the
  home of recording. It gets a **picker**, not the management UI.
- *Legacy `/recording` page?* Wrong visual language, no account context,
  and we want the home-page journey (01 Teleoperate → 02 Code → 03 Train)
  to gain its missing step: **collect data**.

Home page card order becomes: 01 Teleoperate · 02 Record & collect
(**new**, → `/nori/projects`) · 03 Code · 04 Train.

Hosted-app note: recording and local datasets require the LeLab process
(robot + disk), so in the Vercel/direct-backend app `/nori/projects`
renders the existing "needs the desktop app" pattern (same as other
`LELAB_ONLY_PREFIXES` surfaces). The page is desktop-first by nature.

## 3. UI flow (easy-to-follow path)

### 3a. `/nori/projects` — hub

- **Empty state**: one centered card — "Create your first project": fields
  *Project name* (slugified into `{hf_user}/{slug}`; shows the resulting
  repo id live) and *Task description* (becomes recording `single_task`).
  If HF auth is missing, the create form shows the paste-token step inline
  first (reuses `hf-auth/login`).
- **Project cards** (grid, marketplace visual language): title, repo id,
  episode count, last-recorded date, and up to three sync chips:
  `● local` / `↑ HF ✓` / `☁ Nori ✓ (30 ep)` — each chip greys out with
  "not yet" styling when that copy is stale or absent.
- "Unfiled datasets" section at the bottom: datasets found on disk/Hub that
  aren't in the ledger, with a one-click "adopt as project".

### 3b. Project detail (`/nori/projects/:slug`)

Header: title, task line, repo id, sync chips. Body:

- **Sessions table**: date, episodes added, duration. (From the ledger.)
- **Primary actions**, in journey order, left→right:
  1. **Record a session** → v1: navigate to the legacy `/recording` page
     with `?repo_id={repo}&task={task}&return=/nori/projects/{slug}`; the
     recording page pre-fills and **locks** the dataset field, sets
     `resume=true` when the dataset exists, and returns here on finish
     (writing a session entry to the ledger). v2 (later): a nori-styled
     record panel replaces the handoff.
  2. **Back up to my HF** — `push_to_hub` with the user's token
     (`private=true` default). Shows last-pushed time.
  3. **Send to Nori** — the existing `/nori/datasets/upload` 4-step flow,
     with progress; on finalize, stamps `last_nori_upload`.
  4. **Train on this →** — deep-links `/nori/training?project={slug}`.

### 3c. `/nori/training` — picker instead of free text

Replace the raw `dataset_repo_id` input with a **project picker**
(combobox listing ledger projects + unfiled datasets, newest first, with
episode counts and sync chips). Below it, one status line drives the CTA:

- Selected project already uploaded to Nori and unchanged since →
  **[Start training]**.
- Local episodes newer than `last_nori_upload` (or never uploaded) →
  "12 new episodes not yet on Nori" → **[Upload & start training]** (runs
  the 4-step upload, then dispatches — one click, sequential progress).
- Nothing recorded yet → disabled CTA + "Record a session first →" link.

An "advanced" disclosure keeps a raw repo-id input for power users
(current behavior, unchanged).

## 4. Implementation plan

### Phase A — no backend changes (ships alone)

Frontend (`frontend/src/nori/`):
- `pages/projects.tsx` (hub + detail via route param), route entries in
  `App.tsx` (`/nori/projects`, `/nori/projects/:slug`), home-page card,
  nav link in `NoriLayout`.
- `pages/training.tsx`: project picker + status-driven CTA (advanced raw
  input kept).
- Legacy `pages/Recording.tsx`: honor `repo_id`/`task`/`return` query
  params (prefill + lock + redirect back). Small, additive.

LeLab (`lelab/`):
- `utils/config.py`: `projects.json` read/write helpers.
- `server.py` endpoints: `GET /projects`, `POST /projects` (create ledger
  entry; repo created lazily on first push), `POST /projects/{slug}/adopt`,
  `POST /projects/{slug}/session` (called by the recording return-flow),
  plus stamping hooks in the existing upload/push handlers.
- Proxy passthroughs are NOT needed — these are LeLab-local endpoints.

### Phase B — backend deltas (aligns with the S3-input training pipeline)

1. `dataset_upload_sessions`: optional `project_label` column, accepted in
   `StartRequest` and echoed in `SessionRow` (migration 016).
2. `GET /datasets/uploads` — list the customer's finalized upload sessions
   (id, label, episode manifest summary, finalized_at) so hosted/tab UIs
   can select among uploaded datasets without local state.
3. Training dispatch accepts a dataset ref (finalized upload `session_id`)
   instead of implying "whatever is in the customer repo" — this is the
   natural join point with the S3-staged-input pipeline
   (`michael/real-training-s3-input-merged`), whose job input is exactly
   an S3 prefix. Sequence Phase B **after** that branch merges.

### Out of scope (recorded so they're not silently dropped)

- Nori-styled embedded recording panel (v2 of 3b.1).
- Multi-dataset browsing of the org-side `hf_dataset_repo` contents.
- Project sharing/collaboration; project deletion UX (v1: remove from
  ledger only, never deletes data).

## 5. Risks / verify-first items

- **`resume=true` on a dataset whose schema drifted** (cameras changed
  between sessions) — LeRobot will refuse; surface its error verbatim in
  the recording page rather than pre-validating in v1.
- **Slug collisions** with existing personal repos: create form checks the
  merged dataset listing and blocks duplicates.
- **HF token absent** (never logged in): create/backup actions gate on
  `hf-auth-status`; Nori upload and training do NOT need the personal
  token (backend-mediated), so a token-less user can still record → send
  to Nori → train. Personal-repo backup is the only token-gated action.
- **Hosted app**: everything on `/nori/projects` must fail soft to the
  "needs the desktop app" panel (existing pattern), not crash.
