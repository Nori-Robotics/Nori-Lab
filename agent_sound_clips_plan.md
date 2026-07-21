# Agent sound clips — user-uploaded audio the agent plays on cue — design (2026-07-20)

**Status: DESIGN ONLY — nothing below is implemented.**

> **Where this fits:** there is no existing doc to fold this into. The published
> VitePress site (`docs/`) is operator/SDK-facing and documents neither the
> Agent nor the LLM/Coding pages; the design docs the code cites
> (`docs/agentic_vision_loop.md`, `docs/llm_codegen_design.md`) live in
> Nori-Backend, not this repo. So this is a new root-level plan doc alongside
> `full_nori_plan.md` / `PROJECTS_DESIGN.md`. The **user-facing** slice (a short
> "Sound clips" section) lands in `docs/sdk/audio.md` at build time — see §7.

The user-facing gap this closes: on the Agent page (`frontend/src/nori/pages/agent.tsx`)
the model already *has* a `play_audio` tool, but it can only play audio from a
URL it has no way to obtain. A user cannot hand it "my success chime" and say
"play it when you finish." This design adds a **per-machine clip library** (upload
+ describe) and wires the descriptions into the agent's prompt so it can choose
**which** clip to play and **when**, from the words the user wrote.

---

## 0. What already exists (reused unchanged)

This feature is mostly *wiring*, not new machinery. The audio path is already
shipped and verified:

- **Transport** — `frontend/src/nori/remote/audioClip.ts` `playAudioUrl()` fetches
  bytes, decodes via Web Audio (NOT an `<audio>` element, so the operator's own
  laptop stays silent), `captureStream()`s a `MediaStreamTrack`, and hands it to
  the robot's voice downlink via `teleop.sendClipAudio(track)`. Output level is
  hard-capped **on the robot** (`NORI_SPEAKER_GAIN`, default 0.7) so no client can
  overdrive it into the P10S brownout.
- **Driver op** — `ScriptDriver.playAudio` (`ScriptDriver.ts:415`) runs **outside**
  the serial motion queue on purpose (`ScriptDriver.ts:191` + the comment at `:411`),
  because audio rides a separate transceiver. **Motion and audio already compose
  at the transport layer** — this is the fact that makes "play, then keep driving"
  achievable.
- **Agent tool** — `play_audio` already exists end-to-end: manifest entry
  (`robot-ops.ts:280`), generated server schema (`robot-tools.json` →
  `NORI_AGENT_TOOLS`), and browser dispatch (`AgentSession.ts:292`).
- **Cleanup on stop** — `ScriptDriver.stop()` (`ScriptDriver.ts:140`–`155`) already
  stops `activeClip`, and `AgentSession.finish()` calls `driver.stop()`. A clip still
  playing when the run ends or E-STOP fires is already silenced. **No new teardown
  work.**
- **Manual precedent** — `frontend/src/nori/pages/remote.tsx:631` already has a
  working `<input type="file" accept="audio/*">` that decodes locally and streams a
  user-picked file to the speaker. We persist that File instead of discarding it.

### The three real gaps

1. `play_audio` takes a raw `url` the model cannot invent.
2. Playback **blocks the agent loop** until the clip ends (`ScriptDriver.ts:424`
   `await clip.done`) — so today the robot plays, *then* acts; it never acts *during*.
3. No upload / description / storage for a user's own clips.

Everything below closes exactly those three.

---

## 1. Storage: a browser-side clip library (no backend)

**Decision: store clips in the browser (IndexedDB), not on a server.** There is no
generic multipart-upload endpoint anywhere in `lelab/` and no blob-storage
precedent — every existing "upload" (`/nori/datasets/upload`, `/upload-dataset`) is
a JSON HuggingFace repo-id pointer, not a byte sink. Building a real upload
endpoint + storage path is a large lift with zero reuse. The proven pattern
(`remote.tsx:631`) is client-side File → decode → WebRTC, which needs **no CORS and
no network** (a `blob:` URL from `URL.createObjectURL(file)`).

Consequences of per-machine storage (call them out to the user, don't hide them):
- Clips live on the operator's machine/browser profile. They do **not** sync across
  machines and are **not** visible to other users. That is acceptable for "my sound
  effects" and keeps the whole feature hardware- and backend-free.
- Clearing browser storage loses them. Fine for v1.

### New file: `frontend/src/nori/remote/clipLibrary.ts`

An `IndexedDB` object store `clips`, each record:

```
{ id: string, name: string, description: string, mime: string, bytes: Blob, createdAt: number }
```

API:

| fn | purpose |
|---|---|
| `listClips(): Promise<ClipMeta[]>` | all clips (no bytes) for the UI list |
| `addClip(file, name, description): Promise<ClipMeta>` | validate + store |
| `updateClip(id, {name?, description?}): Promise<void>` | edit metadata |
| `deleteClip(id): Promise<void>` | remove |
| `getClipBlobUrl(id): Promise<{url, revoke}>` | fresh `blob:` URL + revoke fn, for playback |
| `getClipCatalog(): Promise<{id, description}[]>` | the list handed to the model (§4) |

Guardrails (all rejected loudly): non-`audio/*` MIME; per-clip size cap (**5 MB** —
it all rides one WebRTC uplink); a total count cap (e.g. 20). `id` is a stable
slug derived from the name + a disambiguating suffix; `id` is what the model
references, so keep it short and human-readable (`success-chime`, not a UUID) so
the transcript reads well.

> `id` generation must not use `Math.random()`/`Date.now()` in any code path that a
> workflow/test could replay — but this is app runtime, so a counter or
> `crypto.randomUUID()` slug suffix is fine here.

---

## 2. Upload / manage UI on the Agent page

A new **"Sound clips"** panel in `agent.tsx`, in the left column beneath the goal
box (`agent.tsx:207`–`251`), styled to match the existing cream cards.

Per clip row: **name**, a **required one-line description**, a **Preview** button,
and **delete**. Adding a clip: a file picker (`<input type="file" accept="audio/*">`,
same as `remote.tsx:631`) + name + description fields.

**The description is the entire interface between the user and the model** — it is
what the agent reads to decide *when* to play the clip. The field's placeholder must
coach that: e.g. *"describe when to play this — 'a cheerful chime when a task
succeeds'"*, not *"description"*.

**Preview** plays the clip on the **robot** (not the laptop) by calling the existing
`playAudioFile(teleop, file)` / `playAudioUrl(teleop, blobUrl)` directly against the
live `teleop` from `useTeleopSession()`. This reuses the shipped path and lets the
user hear it exactly as the agent would trigger it. Preview is only enabled when
`connected`.

The panel is purely local state + `clipLibrary` calls; it does not touch the loop.

---

## 3. Manifest: `play_audio` gains `clip` + `await_end` (single source of truth)

**Edit only the manifest, then regenerate.** Do **not** hand-edit `robot-tools.json`
or `server.py` — the drift guard (`frontend/src/nori/remote/robot-ops.drift.test.ts`)
fails CI if manifest ↔ JSON ↔ dispatch diverge.

Edit `frontend/packages/nori-sdk/src/robot-ops.ts:280` so `play_audio`'s
`input_schema` accepts **either**:

- `clip` — a clip **id** from the run's catalog (§4). **Preferred for the agent.**
- `url` — an `https://` (CORS) or `data:` URL. Retained for programmatic/data clips.

…plus a new optional `await_end` (boolean, **default `false`**). Update the tool
`summary` to tell the model, in prose:

- pass `clip` with an id from the "Available sound clips" list;
- playback is **fire-and-forget** — it can keep issuing tool calls (including motion)
  while the clip plays;
- pass `await_end: true` **only** if it needs the sound to finish before the next
  action.

Then regenerate + verify drift in one step:

```bash
cd frontend && npm run gen:robot-tools   # runs UPDATE_ROBOT_TOOLS=1 vitest run robot-ops.drift
```

This flows the new schema into `robot-tools.json` → `NORI_AGENT_TOOLS`
(`server.py:736`) with **no server-side edit**.

---

## 4. Prompt: inject the clip catalog as a system-prompt suffix (server)

`nori_llm_agent` (`server.py:778`) already folds run grounding (`camera_layout`,
`robot_state`) into a **system-prompt suffix** rather than mutating the browser's
`messages[]` (`server.py:796`–`805`). Clips ride the same seam — cacheable, stateless,
conversation untouched.

Changes in `lelab/server.py`:

1. `NoriLlmAgentBody` (`server.py:739`) gains `clips: list[dict] | None = None`, each
   `{"id": str, "description": str}`.
2. In the grounding block, when `body.clips` is non-empty, append:

   ```
   Available sound clips (play one with play_audio {"clip": "<id>"}):
     success-chime — a cheerful chime when a task succeeds
     uh-oh         — a warning buzz when something is about to be dropped
   ```

   Empty/absent → omit the block entirely (no clips, no mention).
3. Add one `play_audio` line to the hand-written `NORI_AGENT_SYSTEM` prose
   (`server.py:691`) noting clip ids come from the "Available sound clips" context
   and playback is fire-and-forget.

The browser supplies the catalog. Thread it through:

- `AgentSession.PostTurn` (`AgentSession.ts:64`) gains a `clips` argument alongside
  `cameraLayout`; the loop passes `this.clips()` at the call site (`AgentSession.ts:204`).
  The session reads the catalog once at `run()` (or via an injected getter) so it
  reflects what the user uploaded for this run.
- The page's `postTurn` (`agent.tsx:89`–`105`) adds `clips` to the POST body; it
  calls `getClipCatalog()` when starting the run and passes it in.

---

## 5. Fire-and-forget playback + overlap handling (driver)

This is the one piece of genuinely new behavior. `ScriptDriver.playAudio`
(`ScriptDriver.ts:415`) currently `await clip.done` — resolves only when the clip
ends. Since `execTool` awaits `driver.exec` and the agent loop is strictly serial,
a 5 s clip means the model sits blind for 5 s and only *then* gets a result. It
drives **after**, never **during**.

Extend the op to `playAudio(url, opts?)` with `opts.awaitEnd` (**default `true`**, so
the hand-written script API `await nori.playAudio(url)` keeps its nice
resolve-when-done semantics) and optional `opts.gain`:

- **Overlap guard (new):** before starting, if `activeClip` is set, `stop()` it first.
  One clip at a time, **last call wins**. Today the serial `await` hid this; once we
  stop awaiting, a second `play_audio` would orphan the first `ClipHandle` and yank
  the single audio uplink out from under it. Stopping the prior clip is the fix.
- **`awaitEnd === false`:** `playAudioUrl(...)`, stash `activeClip`, **return
  immediately** without awaiting `done`. Return a useful string — e.g.
  `"playing ~3.2s"` — so the model knows how long the clip runs and can reason about
  overlapping actions. (Surface `buffer.duration` from `audioClip.ts` onto
  `ClipHandle` to produce that number.)
- **`awaitEnd === true`:** exactly today's behavior (`await clip.done`).

`ScriptDriver.exec` `case "playAudio"` (`ScriptDriver.ts:191`) forwards the new
`opts` arg. Cleanup is unchanged — `stop()`/E-STOP already kill `activeClip` (§0).

### `audioClip.ts` touch
Add `duration: number` (seconds, from `buffer.duration`) to the returned
`ClipHandle` so the driver can report it. No behavior change.

---

## 6. Dispatch (`AgentSession.ts:292`)

Rewrite the `play_audio` case in `execTool`:

- **`input.clip` present:** resolve via `getClipBlobUrl(id)`. Unknown id →
  `errorResult(b, 'no clip "<id>"; available: <ids>')` (the loop feeds this back as a
  tool_result, so the model self-corrects). On success call
  `driver.exec("playAudio", [blobUrl, { awaitEnd: !!input.await_end }])`, then revoke
  the blob URL after the handle settles (or on session stop). Return the driver's
  `"playing ~Xs"` / `"ok"` string.
- **`input.url` present:** keep the existing `https:`/`data:` scheme guard
  (`AgentSession.ts:297`) — the agent must not fetch arbitrary hosts, and it can't
  produce `blob:` itself; only the clip path yields a `blob:` URL, and it does so from
  a user-uploaded file. Pass through with the same `await_end` handling.
- `play_audio` stays **`motion: false`** → it bypasses the confirm-before-first-motion
  gate (`AgentSession.ts:88`, `MOTION_TOOLS`). Correct: sound is harmless and
  gain-capped on the robot.

---

## 7. Tests & docs

- **Unit** — extend `frontend/src/nori/remote/AgentSession.test.ts` (mock the clip
  library): (a) a known clip id resolves and dispatches with `awaitEnd:false`;
  (b) unknown id → `is_error` tool_result naming available ids; (c) a second
  `play_audio` stops the prior clip (overlap). Add a `ScriptDriver` test for the
  non-blocking return path.
- **Drift** — `npm run gen:robot-tools` regenerates and runs `robot-ops.drift`; CI
  guard must stay green.
- **Docs (user-facing slice)** — add a short **"Sound clips"** section to
  `docs/sdk/audio.md` (it already documents the clip/downlink path): how to upload,
  that the description drives *when* the agent plays it, and the per-machine/5 MB
  limits. Add the `await_end` parameter to the `playAudio` script-API reference in
  the same file. No new nav entry needed — it lives under the existing
  Media & sensing → Audio page (`docs/.vitepress/config.ts`).

---

## 8. Touch list

| File | Change | New? |
|---|---|---|
| `frontend/src/nori/remote/clipLibrary.ts` | IndexedDB clip store + catalog | **new** |
| `frontend/src/nori/pages/agent.tsx` | Sound-clips panel; thread `clips` into `postTurn` | edit |
| `frontend/packages/nori-sdk/src/robot-ops.ts` | `play_audio` gains `clip` + `await_end`; then regen | edit |
| `frontend/packages/nori-sdk/robot-tools.json` | regenerated — **do not hand-edit** | generated |
| `frontend/src/nori/remote/AgentSession.ts` | `PostTurn` gains `clips`; clip resolution + `await_end` in dispatch | edit |
| `frontend/src/nori/remote/ScriptDriver.ts` | `playAudio(url, opts)` non-blocking path + overlap stop | edit |
| `frontend/src/nori/remote/audioClip.ts` | expose `duration` on `ClipHandle` | edit |
| `lelab/server.py` | `clips` in body + system-suffix catalog + one prompt line | edit |
| `AgentSession.test.ts`, `ScriptDriver` test | clip dispatch + overlap + non-blocking coverage | edit |
| `docs/sdk/audio.md` | user "Sound clips" section + `await_end` param | edit |

Tagging: in-place edits to existing (upstream-LeLab) files get a `# NORI:` /
`// NORI:` comment per `todos.md:22`; the additive `clipLibrary.ts` under
`frontend/src/nori/` needs no tag.

---

## 9. Locked decisions (do not reopen without cause)

1. **Storage is browser IndexedDB, per-machine.** No server upload endpoint — none
   exists and there is no blob-storage precedent to reuse. Cross-machine sync is
   explicitly out of scope for v1.
2. **`await_end` defaults to `false` for the agent.** This is what makes "start a
   clip, then keep driving while it plays" work — the answer to the original
   question. The script API keeps `true` so `await nori.playAudio()` still reads
   correctly.
3. **The clip's text description is the whole steering interface.** No tags, no
   trigger-condition DSL — the model reads the description and decides. Situational
   play ("when you succeed"), **not** scheduled wall-clock play. A time-of-day
   scheduler is a different feature (the agent loop is a bounded run with a
   wall-clock cap, not a cron) and is out of scope here.
4. **One clip at a time, last call wins.** Overlap stops the prior clip rather than
   mixing — a single WebRTC audio uplink, and mixing is not worth the complexity.
```
