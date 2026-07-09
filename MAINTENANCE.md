# Maintenance playbook

Instructions for whoever changes this system next — Claude (Sonnet, Opus, or any future
model) or a human. `CLAUDE.md` defines the data contract; this file is **how to change
things without breaking it**. Read both before touching `os.mjs`, `templates/`, or
anything under `data/`.

## The invariants — never break these

1. **Ids are copied verbatim, everywhere, forever.** Ingest, store edits, writeback —
   a regenerated id makes the tool's merge duplicate instead of update, and the damage
   is silent and permanent. This is the #1 historical risk in this codebase.
2. **Unknown `_meta.schemaVersion` is refused, never guessed.** `KNOWN_SCHEMA_VERSIONS`
   in `os.mjs` is the only gate. Widen it only after deliberately updating the parser
   (see playbook below).
3. **`data/store.json` is canonical; `views/`, `graph/`, `dashboard.html` are generated.**
   Never hand-edit generated files; never generate `data/store.json`.
4. **Archive, don't delete.** Records that disappear from an export move to
   `store.archive` — ingest must never simply drop them.
5. **Builds are deterministic.** No `now()` / `new Date()` output may land in generated
   files. Rebuilding an unchanged store must produce zero git diff.
6. **Zero dependencies.** `os.mjs` and both HTML files use only Node/browser built-ins.
   No npm packages, no CDN scripts, no build step. This is a feature: nothing to
   update, nothing to break, works offline.
6b. **`notes/` is user-canonical.** Build and ingest read it (graph enrichment,
   dashboard search) but must never create, modify, or delete anything under it —
   it is the user's hand-written Obsidian content, on par with the store itself.
7. **Privacy.** The dashboard and store contain journal entries. Never publish them
   (GitHub Pages, public artifacts, pastes into issues) without the owner explicitly
   agreeing in that conversation.

## The verification loop — run after ANY change

```bash
node os.mjs selftest        # all contract checks must pass (20+ green)
node os.mjs doctor          # store integrity: must be clean
node os.mjs build && git add -A && node os.mjs build && git diff --exit-code
                            # determinism: the second build must change nothing
```

If you touched `templates/dashboard.html` or graph building, also do a browser check
**in a throwaway worktree** so the real store is never polluted with test data:

```bash
git worktree add /tmp/os-test
cd /tmp/os-test
node os.mjs ingest examples/sample-export.json
# open /tmp/os-test/dashboard.html in a browser (or headless chromium):
# - no console errors; search returns results; graph tab renders, nodes clickable
cd - && git worktree remove --force /tmp/os-test
```

**Never ingest `examples/sample-export.json` into the real store** — ingested data
merges into the permanent record and its removal would leave archive traces.

CI (`.github/workflows/ingest.yml`) runs selftest before every automated ingest, so a
red selftest on the default branch blocks the owner's phone-upload workflow. Do not
push with a failing selftest.

## Playbooks

### The capture tool bumped its schemaVersion (the most likely future change)

1. Read the header comment of the **new** `tools/openloops.html` — the tool documents
   its own state shape there. Diff it against the old header.
2. Update `os.mjs` to parse the new shape: `normalizeItem` / `normalizeLive`, and
   `ID_COLLECTIONS` / `SCALARS` if collections were added or renamed.
3. Only then add the new version to `KNOWN_SCHEMA_VERSIONS`. Keep the old version in
   the list if old exports should still ingest (they usually should).
4. Extend `cmdSelftest` with a fixture export of the new version, covering the new or
   changed fields.
5. Run the full verification loop. Update `CLAUDE.md` if the contract wording changed.

Never "temporarily" accept an unknown version to unblock an ingest — that is exactly
the failure the gate exists to prevent.

### The tool grew a new collection (a new tab)

Adding the collection key to `ID_COLLECTIONS` gives you ingest, archiving, writeback,
doctor id-checks and CLI search automatically. Then wire the visible layers:
a `md*` renderer in the views section, nodes/edges in `buildGraph` if it should appear
in the knowledge graph, a `push(...)` line in the dashboard's doc builder plus entries
in `KIND_LABEL`/`TYPE_COLORS`, and a selftest fixture record.

### Changing views or the dashboard

Edit `templates/dashboard.html` (never `dashboard.html` — it's overwritten) and the
`md*` functions in `os.mjs`. Keep the `GEN_HEADER` warning on every view. No volatile
timestamps (invariant 5). Rebuild and browser-check.

### Changing merge semantics — danger zone

`mergeExport` encodes promises the owner relies on: export wins on live records,
disappeared records are archived not deleted, journal merges with the device winning,
habit checks are unioned, older exports are refused. Any change here needs a selftest
check proving each of those still holds, added *before* you change the code. When in
doubt, don't — ask the owner.

### Changing graph conventions

`buildGraph` in `os.mjs` is the single source. If you add a node type or edge kind,
update: the conventions section in `CLAUDE.md`, `TYPE_COLORS` + legend in the dashboard
template, and a selftest assertion.

## Recovery procedures

Everything is in git, so almost nothing is truly lost:

- **A bad ingest was committed:** `git revert` the ingest commit (store and generated
  files travel together in one commit), or restore just the store from the previous
  commit: `git checkout <good-sha> -- data/store.json && node os.mjs build`. The raw
  export remains in `data/exports/` either way.
- **Store corrupted beyond git history:** rebuild it from the audit trail — delete
  `data/store.json`, then ingest every file in `data/exports/` oldest-first (their
  filename timestamps sort chronologically): `node os.mjs ingest data/exports/*.json`.
- **The phone/browser lost its data:** `node os.mjs writeback`, put the file on the
  device, Import JSON in the tool, choose MERGE. Live state is restored with ids intact.
- **CI run is red:** read the Action log. Usual causes: export older than the last
  ingested one (protects against archiving newer records) or unknown schemaVersion.
  The uploaded file sits in `inbox/` untouched; fix the cause and re-run, or ingest
  locally with `--force` only if you are certain the older export should win.

## Definition of done

- selftest green, doctor clean, deterministic double-build
- dashboard opens without console errors (if UI/graph touched)
- `CLAUDE.md` / `README.md` updated if behavior or contract wording changed
- commit message states whether the data contract was affected and how
