# Dataset Picker — Merging Record & Replay Entry Points

**Date:** 2026-05-05
**Status:** Approved (pending implementation plan)

## Goal

Replace the two separate landing-page actions ("Record Dataset" and "Replay Dataset") with a single **Dataset** action whose button opens a popover combobox. The popover lists existing datasets (current Replay behavior) and supports typing a new name to start recording (mirroring the Robot creation flow).

## Motivation

The current landing page exposes Record and Replay as two parallel red/purple buttons. They share the same conceptual subject — a dataset — but split user attention and require navigating to a separate `/replay-dataset` page just to pick from a list. The Robot picker already demonstrates the desired pattern (popover + combobox + create-on-type) and users have validated it. Unifying the dataset entry-points keeps the landing page focused and reuses an established interaction model.

## Scope

### In scope

- New `DatasetPicker` component on the landing page.
- Removal of the `/replay-dataset` route and its page-only components.
- Wiring the popover into the existing `RecordingModal` flow with a pre-seeded `datasetName`.

### Out of scope

- Backend changes. `GET /datasets` already returns what is needed.
- Hugging Face authentication flow. Existing private-repo redirect to `huggingface.co/login?next=…` is preserved unchanged.
- Modifications to `RecordingModal` itself. We only seed `datasetName` before opening it.

## User-facing behavior

### Landing action list

Three actions (was four):

| Action   | Color  | Behavior                          |
|----------|--------|-----------------------------------|
| Dataset  | purple | Opens `DatasetPicker` popover     |
| Training | green  | Navigates to `/training`          |
| Inference| blue   | Navigates to `/inference`         |

`isWorkInProgress` flags are unchanged for the surviving actions.

### Dataset popover behavior

The popover anchors to the Dataset action button. The combobox uses Radix `Popover` + `Command` (same primitives as `RobotSelector`).

Behavior driven by what the user types into the search input:

| Typed input                                         | Item shown                       | Action on select                                                                 |
|-----------------------------------------------------|----------------------------------|----------------------------------------------------------------------------------|
| (empty, or matches an existing dataset)             | Existing datasets list           | Open HF viewer in a new tab (preserves current `ReplayDataset` behavior)         |
| Single word, no slash, sanitized, no existing match | "Create *name*"                  | Close popover, set `datasetName` to the typed value, open `RecordingModal`       |
| Matches `^[\w.\-]+/[\w.\-]+$`, no existing match    | "Open *org/name* in viewer"      | Open HF viewer in a new tab (replaces the current `Use custom repo ID…` sub-mode) |
| Anything else (e.g. trailing slash, spaces)         | No selectable item               | (No-op — Enter is ignored)                                                       |

Sanitization for the "Create" path mirrors `RecordingModal`'s existing rule: replace any character outside `[A-Za-z0-9._-]` with `_`. The popover input itself is not pre-sanitized so the user can type `org/name` for the viewer-open path; the rule is applied only when entering the "Create" branch.

### Open-in-viewer behavior (preserved)

For both "select existing" and "open custom repo ID":
- If the dataset is in the fetched list and is **public**, navigate the new tab directly to `https://huggingface.co/spaces/lerobot/visualize_dataset?path=/<repo_id>`.
- Otherwise (unknown or `private: true`), bounce through `https://huggingface.co/login?next=…` so the user has a session before the Space tries to fetch it.
- After opening the new tab, the popover closes. The landing page does not navigate.

This is identical to the current `ReplayDataset.handleDatasetChange` logic; we relocate it.

## Architecture

### New files

- `frontend/src/components/landing/DatasetPicker.tsx` — popover + combobox component. Owns the input query state and decides which item to surface based on the rules above. Receives the dataset list, loading state, and three callbacks (`onPickExisting`, `onCreateNew`, `onOpenCustom`) — or a single `onSelect` callback that accepts a tagged union, at the implementer's discretion. Pure presentational state; no data fetching.
- `frontend/src/hooks/useDatasets.ts` — small hook wrapping `listDatasets`, exposing `{ datasets, loading, refresh }`. Symmetric with `useRobots`. Refresh is called once on mount.

### Modified files

- `frontend/src/pages/Landing.tsx` — removes the `handleReplayDatasetClick` handler and the Record/Replay action entries. Adds a single `Dataset` action; renders `DatasetPicker` either inline next to the action button (anchored via the Popover trigger) or as a sibling that the action button toggles. Hosts the `useDatasets` hook. Implements:
  - `handlePickExisting(repoId)` — open HF viewer (logic moved from `ReplayDataset`).
  - `handleCreateNew(typed)` — `setDatasetName(sanitized(typed))` and call existing `handleRecordingClick()`.
  - `handleOpenCustom(repoId)` — same as `handlePickExisting` but for typed `org/name`.
- `frontend/src/components/landing/ActionList.tsx` — needs to support an action that renders a popover trigger instead of a plain button click handler. Two options:
  1. Add an optional `renderTrigger` field to the `Action` type that, when present, replaces the default arrow button.
  2. Keep `ActionList` unchanged and place `DatasetPicker` outside it, alongside the action grid.

  The first option keeps the visual grid consistent and is preferred unless it complicates `ActionList` more than expected.
- `frontend/src/App.tsx` — remove the `<Route path="/replay-dataset" element={<ReplayDataset />} />` line and the `ReplayDataset` import.

### Deleted files

- `frontend/src/pages/ReplayDataset.tsx`
- `frontend/src/components/replay/ReplayHeader.tsx`
- `frontend/src/components/replay/DatasetCombobox.tsx`
- `frontend/src/components/replay/` directory (after the above are removed).

### Retained

- `frontend/src/lib/replayApi.ts` (the `listDatasets` fetcher and `DatasetItem` type) — still used by `useDatasets`. The filename is now slightly inaccurate ("replay") but renaming is out of scope; addressing it would expand the diff for no functional gain.

## Data flow

```
Landing mounts
   └─> useDatasets() ─ GET /datasets ─> { datasets, loading }
                                          │
                                          ▼
   ActionList row "Dataset" ──click──> DatasetPicker popover
                                          │
                ┌─────────────────────────┼─────────────────────────┐
                ▼                         ▼                         ▼
       pick existing               type new name             type org/name
                │                         │                         │
                ▼                         ▼                         ▼
      open HF viewer          setDatasetName(typed)        open HF viewer
      (new tab)               + handleRecordingClick()     (new tab)
                                          │
                                          ▼
                                RecordingModal opens
                                with datasetName seeded
```

## Edge cases

- **Empty input + empty dataset list:** popover shows "No datasets yet. Type a name to create one." (matches `RobotSelector`'s empty state copy.)
- **Typed name matches an existing dataset (case-insensitive):** treat as a pick, not a create. Same rule as `RobotSelector`.
- **User opens popover, types a name, then clicks outside:** popover closes, no recording started, typed value is discarded. Next open starts fresh.
- **Camera streams from previous landing session:** unaffected — the popover does not touch cameras. Only the existing `handleRecordingClick` releases streams when it runs.
- **`GET /datasets` fails:** `useDatasets` resolves with `datasets: []`, `loading: false`. The popover still allows typing a new name (Create) or a custom `org/name` (Open in viewer). No error toast — matches the silent-failure behavior of the current `ReplayDataset` page.

## Testing

There is no test suite in this repo (per CLAUDE.md). Validation is manual:

1. `lelab --dev`, open `http://localhost:8080`.
2. Verify the action list shows three rows: Dataset, Training, Inference.
3. Click Dataset → popover opens with the existing dataset list.
4. Pick an existing dataset → new tab opens at the HF viewer (or login page for private/unknown).
5. Type a new name (e.g. `pickup_v1`) → "Create" item appears → select it → `RecordingModal` opens with `datasetName` pre-filled with `pickup_v1`.
6. Type `someorg/some-dataset` (with slash) → "Open in viewer" item appears → select it → new tab opens at the HF viewer login bounce (since unknown repo).
7. Verify `/replay-dataset` URL now serves the `NotFound` page.
8. Confirm robot selection, calibration, teleop, training, inference flows are unchanged.

## Risks

- **`ActionList` reuse:** if accommodating a popover trigger inside the existing grid item makes the component ugly, falling back to placing `DatasetPicker` outside `ActionList` is acceptable. The visual grid is the only thing at stake.
- **Stale dataset list:** the picker reads the list once on Landing mount. If the user just created a dataset elsewhere and returns, they may not see it until refresh. This already matches the current `ReplayDataset` behavior — accepted.
