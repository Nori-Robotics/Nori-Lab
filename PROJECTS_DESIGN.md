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

Two surfaces, split by what the user is doing:

- **Recording happens on `/nori/remote` (the teleop page).** Good
  demonstrations require watching what the robot's cameras see while you
  drive — that live view already lives on the remote page, and recording
  is an act of teleoperation, not of file management. A **record bar**
  joins the teleop UI (see 3b).
- **Everything else — create/browse projects, session history, HF backup,
  Nori upload, train handoff — is a new page: `/nori/projects`.** The
  project lifecycle would bury a live-driving screen if crammed into
  remote, and the training page is the *consumer* of projects, not their
  home (it gets a **picker**, not management UI).

Rejected: reusing the legacy `/recording` page (wrong visual language, no
account context, and it drives the laptop-attached SO-101 path — not the
Nori L2 the remote page controls).

Home page card order becomes: 01 Teleoperate · 02 Record & collect
(**new**, → `/nori/projects`) · 03 Code · 04 Train.

Hosted-app note: the projects library requires the LeLab process (local
datasets + disk), so in the Vercel/direct-backend app `/nori/projects`
renders the existing "needs the desktop app" pattern, and the record bar
on `/nori/remote` is hidden (same `LELAB_ONLY_PREFIXES` posture).

### 2a. Recording data path (why this needs care)

What the remote page *displays* is the WebRTC composite — compressed,
latest-wins, sized for human eyes. Training data must instead come from
the raw sources, and there is already a proven pattern for this:
`NoriTelop/examples/xlerobot/9_phase2_vr_record.py` builds a
`LeRobotDataset` by subscribing to the robot's **per-camera ZMQ JPEG
feeds** plus joint state over LAN (`Nori-Protocol/CLIENTS.md` documents
the sockets; "the robot's own compositor and recorder are two of them").

v1 capture engine: a `lelab/` module (LeLab already ships `lerobot`) that,
on "start episode", subscribes the ZMQ cameras + telemetry and appends
frames to the project's local dataset at the camera FPS — the browser
record bar only sends start/stop/save/discard commands to LeLab endpoints.
Actions: recorded from the same command stream driving the robot; the
exact action source (leader positions vs. commanded targets from the
bridge) is a confirm-during-implementation item against the protocol.

Consequence to state honestly in the UI: **v1 recording requires the
laptop to be on the robot's LAN** (the ZMQ feeds are LAN-scoped by
design). Driving over WAN still works; the record button shows
"recording needs the same network as your robot" when the feeds aren't
reachable. Robot-side recording (Pi records locally, dataset ships up
afterwards) removes that constraint and is the v2 path.

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
  1. **Record a session** → navigates to `/nori/remote?project={slug}`,
     which arms the record bar there (see 3b-bis). Returning here after
     the session shows the new episodes in the table.
  2. **Back up to my HF** — `push_to_hub` with the user's token
     (`private=true` default). Shows last-pushed time.
  3. **Send to Nori** — the existing `/nori/datasets/upload` 4-step flow,
     with progress; on finalize, stamps `last_nori_upload`.
  4. **Train on this →** — deep-links `/nori/training?project={slug}`.

### 3b-bis. Record bar on `/nori/remote`

A slim bar docked under the live video (visible only when LeLab is local
and the ZMQ feeds are reachable; otherwise a quiet "recording needs the
same network as your robot" hint):

```
[ project: pick-place-mugs ▾ ]  task: "Pick up the mug…"   ● REC 00:12  ep 13
[⏺ Start episode] [✔ Save episode] [✖ Discard] [Skip →]        [End session]
```

- Arriving via `?project=slug` pre-selects the project; the dropdown also
  allows picking/creating one in place, so a user who starts driving and
  *then* decides to record never has to leave the page.
- Start/save/discard mirror the episode controls recording users already
  know from LeRobot (`exit_early` / `rerecord_episode` semantics).
- The episode counter and elapsed time render next to the live video so
  the demonstrator's eyes never leave what the robot sees.
- **End session** writes the ledger entry (episodes added, duration) and
  offers a one-click "Back to project →".

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
- `pages/remote.tsx`: the record bar (3b-bis) — renders only when the
  LeLab capture endpoints report the feeds reachable; honors `?project=`.
- `pages/training.tsx`: project picker + status-driven CTA (advanced raw
  input kept).

LeLab (`lelab/`):
- **`capture.py` (new)** — the recording engine: ZMQ camera + telemetry
  subscriber building a `LeRobotDataset` in the local cache (ported from
  the `9_phase2_vr_record.py` pattern; same module style as `record.py`:
  module globals + `handle_*` functions). Endpoints: reachability probe,
  start/end session, start/save/discard episode.
- `utils/config.py`: `projects.json` read/write helpers.
- `server.py` endpoints: `GET /projects`, `POST /projects` (create ledger
  entry; repo created lazily on first push), `POST /projects/{slug}/adopt`,
  session stamping via capture's end-session handler, plus stamping hooks
  in the existing upload/push handlers.
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

- Robot-side (Pi) recording for WAN sessions — v2 of 2a; needs a protocol
  command + a dataset-shipping path off the Pi.
- Multi-dataset browsing of the org-side `hf_dataset_repo` contents.
- Project sharing/collaboration; project deletion UX (v1: remove from
  ledger only, never deletes data).

## 5. Risks / verify-first items

- **Action source for captured episodes**: leader positions vs. commanded
  targets from the bridge — confirm against the protocol before building
  `capture.py`; a dataset with wrong/laggy actions trains garbage.
- **Capture FPS vs. ZMQ latest-wins semantics**: the feeds drop frames for
  slow consumers by design; the engine must timestamp what it actually
  received, not assume a fixed FPS.
- **Appending to a dataset whose schema drifted** (cameras changed between
  sessions) — LeRobot will refuse; surface its error verbatim in the
  record bar rather than pre-validating in v1.
- **Slug collisions** with existing personal repos: create form checks the
  merged dataset listing and blocks duplicates.
- **HF token absent** (never logged in): create/backup actions gate on
  `hf-auth-status`; Nori upload and training do NOT need the personal
  token (backend-mediated), so a token-less user can still record → send
  to Nori → train. Personal-repo backup is the only token-gated action.
- **Hosted app**: everything on `/nori/projects` must fail soft to the
  "needs the desktop app" panel (existing pattern), not crash.
