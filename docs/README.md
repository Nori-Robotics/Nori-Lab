# Nori docs site

The public documentation and troubleshooting site. [VitePress](https://vitepress.dev) — you write
markdown, it builds a static site with a sidebar, local search, and dark mode.

## Why this is a separate site

The desktop app freezes `frontend/dist` into the Tauri bundle at build time. **Anything that lives
in the app is only as fresh as the user's installed version** — so a docs page shipped inside the
app cannot be corrected without cutting a release, which is exactly backwards for the pages people
read when something is broken.

So the docs are never bundled. They're deployed independently, and the app links out to them:
`openDocs()` in `frontend/src/lib/docs.ts` opens this site in the user's real browser (via
`tauri-plugin-opener` on desktop, a new tab on web).

Practical consequence: **you can fix a troubleshooting page and have it live in a minute, for every
user, including ones running an old build of the app.** That's the whole point.

## Write

```bash
cd docs
npm install
npm run dev      # http://localhost:5173
```

Add a page: drop a `.md` file in `guide/`, `sdk/`, or `troubleshooting/`, then add it to the
sidebar in `.vitepress/config.ts`. A page not in the sidebar is reachable by URL but invisible —
the sidebar is the table of contents.

Build locally exactly as Vercel will:

```bash
npm run build && npm run preview
```

`ignoreDeadLinks` is **off**, so a broken internal link fails the build rather than shipping. That
is deliberate.

## Conventions

**Unwritten sections are marked, not omitted.** A stub with a `::: info 🚧 To write` block telling
the next person what belongs there is worth more than a missing page — it's a queue.

```md
::: info 🚧 To write
What still needs writing here, specifically.
:::
```

Grep for `🚧` to see everything outstanding.

**They're currently hidden from the live site, not deleted.** Every one of those blocks is wrapped
in an HTML comment so visitors don't read a page full of scaffolding while the queue is worked
through:

```md
<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
…
:::
-->
```

To publish one, delete the two sentinel lines. To add a new stub, wrap it the same way — grep for
`TODO-DOCS` to find them all. The `🚧` grep still works either way, since the text is only
commented, never removed.

**Say when the software is ahead of the hardware.** Several SDK surfaces are implemented but not
yet verified on a real robot. Those carry a `::: warning Verification status` block. Readers trust
them over the surrounding prose, so keep them accurate — and delete them the moment they stop being
true.

**Troubleshooting is symptom-first.** People arrive with a symptom, not a subsystem. The heading
should be the thing they'd type into search ("Stuck at `connecting`"), not the mechanism.

## Deploy

Its own Vercel project — **not** the same one as the app.

| Setting | Value |
|---|---|
| Root directory | `docs` |
| Framework preset | VitePress (or Other) |
| Build command | `npm run build` |
| Output directory | `.vitepress/dist` |
| Domain | `docs.norirobotics.com` (matching the `app.` / `vr.` subdomain pattern) |

Then point the app at it by setting `VITE_DOCS_URL` in the **frontend** Vercel project and in
`frontend/vercel.json`. It falls back to `https://docs.norirobotics.com` if unset.

## Source of truth

The SDK pages in `sdk/` were split out of `frontend/packages/nori-sdk/README.md`, which still ships
inside the SDK tarball for developers reading it offline.

**These two can drift.** When you change SDK behavior, update both — or decide the README should
shrink to a pointer at this site and do that deliberately.
