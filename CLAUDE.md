# PersonalOS

Personal knowledge system. The capture tool (`tools/openloops.html`, runs entirely in the
browser) is the **input layer**; this repo is the **system of record**. Exports flow in
through `inbox/`, everything is merged into one canonical store, and searchable views plus a
knowledge graph are generated from it.

## ⚠️ THE CONTRACT — read before touching any data

**1. IDs are sacred. Never regenerate, rewrite, or reassign an `id`. Ever.**

Every record (`items`, `goals`, `habits`, `wins`, `manifest`, `pipeline`, `grocery`,
`library`, `events`) carries an opaque stable string id minted by the capture tool. The
whole bidirectional merge contract hangs on these: the tool's import matches records **by
id** — imported records win on field conflicts, records absent from an import are kept. If
any script writes back records with fresh ids, the tool's merge will **duplicate instead of
update**. This is the single most likely mistake for an ingest/writeback script to make.
Copy ids verbatim, always. When creating a *genuinely new* record from the OS side, mint an
id in the tool's format (`Date.now().toString(36) + random base36 suffix`) — and then never
change it again.

**2. Check `_meta.schemaVersion` and refuse what you don't recognize.**

Exports carry `_meta: {app:"open-loops", schemaVersion:4, exported:ISO}`. `os.mjs` accepts
only versions listed in `KNOWN_SCHEMA_VERSIONS` (currently `[4]`) and hard-refuses anything
else — missing `_meta`, foreign `app`, unknown version. Never "guess" at an unknown schema.
If the tool bumps its schema, read the tool's header comment, update the parsing
deliberately, add the new version to `KNOWN_SCHEMA_VERSIONS`, and extend `node os.mjs
selftest` to cover it.

**3. `data/store.json` is canonical. Everything else is generated.**

`views/`, `graph/graph.json`, and `dashboard.html` are build artifacts — never hand-edit
them; they are wiped and rewritten by `node os.mjs build`. To change data from the OS side,
edit records inside `data/store.json` (`live.*` — keep ids!), then run `build`, and round-
trip the change to the device with `writeback`.

**4. Ingest is one-way-per-export and ordered.**

An export is the *full* live state of the device at a moment. Ingest replaces live
collections with the export's records and moves anything that disappeared (closed, dropped,
deleted on the device) into `store.archive` with an `archivedAt` stamp — the OS remembers
what the tool forgets. Ingesting an export **older** than the last ingested one is refused
(it would wrongly archive newer records); `--force` overrides deliberately. Journal days
merge with the device winning (the device is the source of truth for journaling); habit
checks are unioned; `log[]` is concatenated, deduped, and kept chronological.

## Commands

```
node os.mjs ingest [file...]   # merge exports from inbox/ (or given paths); auto-runs build
node os.mjs sync               # ingest + build + git commit + push in one go
node os.mjs build              # regenerate views/, graph/graph.json, dashboard.html
node os.mjs writeback [out]    # produce import-ready JSON for the capture tool (choose MERGE there)
node os.mjs status             # one-line store summary
node os.mjs search <query>     # quick full-text search, live + archived
node os.mjs doctor             # store integrity check (duplicate ids, dangling links, bad dates)
node os.mjs selftest           # contract tests — run after ANY change to os.mjs
```

Zero dependencies, Node 18+. After changing `os.mjs`, always run `node os.mjs selftest`.

**Automation:** `.github/workflows/ingest.yml` auto-ingests any JSON pushed to `inbox/`
(selftest → ingest → doctor → commit). Keep the selftest green — CI runs it before every
automated ingest, so a broken contract blocks ingestion rather than corrupting the store.

**Determinism:** builds carry no volatile timestamps — rebuilding an unchanged store
produces zero git diff. Don't add `new Date()` / `now()` calls to anything that lands in
generated files (relative ages like "3d open" are the only date-dependent content).

**Privacy:** the dashboard contains journal entries. It stays a local file by explicit
user choice — never publish it (GitHub Pages, artifacts to shared audiences, etc.)
without asking first.

## Layout

```
tools/openloops.html    input layer — the capture tool (open in any browser, works offline)
inbox/                  drop JSON exports here, then run ingest (files are moved on ingest)
data/store.json         CANONICAL store: _meta + live (current state) + archive (what disappeared)
data/exports/           every raw export ever ingested, timestamped (audit trail)
views/                  generated Markdown — browsable on GitHub, greppable, linked
graph/graph.json        generated knowledge graph (nodes + typed edges)
dashboard.html          generated self-contained search + graph UI (open locally, no server)
templates/dashboard.html  the dashboard source template (edit this, not dashboard.html)
```

## Knowledge graph conventions

- `#hashtags` anywhere in loop text/notes, habit names, event/library titles and notes,
  manifest text, or win text become **topic** nodes — this is the user's main cross-linking
  tool, mention it when they ask how to connect things.
- A loop's `who` field ("waiting on") creates a **person** node; people are also matched as
  mentions inside loop notes.
- `goalId` on loops and habits creates `supports` edges to **goal** nodes.
- Wins minted by the tool (`"New client: X"`, `"Realized: X"`, `"Organized: X"`) are linked
  back to their pipeline entry / manifestation / event with `celebrates` edges.
- Archived records stay in the graph flagged `archived: true` — closed history is part of
  the knowledge, never dropped.

## Answering questions over the data

Prefer reading `data/store.json` (canonical, includes archive) over `views/`. For "what do I
know about X" questions, `node os.mjs search X` first, then follow ids into the store and
`graph/graph.json` for connections. Dates are `YYYY-MM-DD`, timestamps ISO 8601, weeks
`YYYY-Www` (ISO weeks).
