# PersonalOS

One system for everything circling in your head: open loops, goals, habits, journal, wins,
manifestations, client pipeline, events, library, groceries — captured on any device,
merged into one record, connected into a searchable knowledge graph.

```
 phone / laptop                      this repo (system of record)
┌────────────────────┐   export    ┌──────────────────────────────────────┐
│ tools/             │  ─────────▶ │ inbox/  →  node os.mjs ingest        │
│  openloops.html    │             │              │                       │
│ (capture, offline, │             │              ▼                       │
│  localStorage)     │   import    │        data/store.json  (canonical)  │
│                    │ ◀─────────  │              │                       │
└────────────────────┘  writeback  │              ▼  node os.mjs build    │
                                   │  views/*.md · graph/graph.json ·     │
                                   │  dashboard.html (search + graph)     │
                                   └──────────────────────────────────────┘
```

## The weekly loop

1. **Capture** all week in `tools/openloops.html` (keep a copy on your phone/laptop —
   it's a single file, works offline, data lives in the browser).
2. **Export JSON** from the tool's footer.
3. **Get it in** — either way works:
   - **From a phone (no terminal needed):** upload the export into `inbox/` via the
     GitHub app or github.com ("Add file → Upload files"). A GitHub Action ingests it,
     rebuilds everything, and commits the result within a minute or two. If the Action
     shows a red ✗, the export was refused (usually: older than the last ingested one,
     or an unknown schema version) and stays in `inbox/` untouched — nothing is corrupted.
   - **From a laptop:** drop the file in `inbox/` and run `node os.mjs sync` — one
     command for ingest + rebuild + commit + push.
4. **Find things**: open `dashboard.html` for full-text search and the interactive
   knowledge graph, browse `views/` right on GitHub, or ask Claude Code — `CLAUDE.md`
   teaches it the data contract. (The dashboard is deliberately **not** published
   anywhere — it contains your journal. It's a local file; keep it that way.)
5. **Write back** (optional): `node os.mjs writeback` produces an import-ready file;
   import it in the tool and choose **MERGE**. Ids are stable, so edits made on the OS
   side update the matching records on the device instead of duplicating them.

## Obsidian (desktop)

The repo is also an **Obsidian vault**: clone it, then in Obsidian choose *Open folder
as vault* and pick the repo folder. Shared settings are committed (`.obsidian/` — only
the config; your workspace stays local).

- **Read** the generated `views/` — every person and goal has its own page, everything
  is linked, and Obsidian's graph view shows your whole record.
- **Write** in `notes/` — yours alone, never generated, never wiped. Use `#tags` and
  `[[wikilinks]]` (`[[Anna]]`, `[[Buy the apartment]]`, `[[some-note]]`); on the next
  `node os.mjs build` your notes join the knowledge graph and dashboard search.
  `node os.mjs doctor` flags misspelled wikilinks.
- **Never edit `views/`** — those files are regenerated from the store and your edits
  would be wiped. Obsidian makes editing easy; the do-not-edit header in each file is
  your reminder.
- Pull before you write, commit after (or just run `node os.mjs sync`). Desktop-only
  by design — your phone keeps the capture-tool + GitHub-upload flow.

## Connecting things (the graph)

- Put **#hashtags** in any text — loop, note, habit name, event, library item, win —
  and they become topic nodes linking everything that shares them.
- The **"waiting on"** field on a loop creates a person node; every loop involving the
  same person clusters around them.
- Link loops and habits to **goals** in the tool; the graph shows what actually
  supports what, and the stats show where cleared effort went.
- Closed and dropped loops are **never lost**: the OS archives what the tool deletes,
  flagged as archived, still searchable, still in the graph.

## Commands

```
node os.mjs ingest        # merge everything in inbox/, rebuild all outputs
node os.mjs sync          # ingest + rebuild + commit + push, one command
node os.mjs build         # rebuild views/graph/dashboard from the store
node os.mjs writeback     # produce a merge-ready import file for the tool
node os.mjs status        # quick summary
node os.mjs search <q>    # search from the terminal
node os.mjs doctor        # integrity check: duplicate ids, dangling links, bad dates
node os.mjs selftest      # verify the data contract (ids stable, version guard, merge)
```

Node 18+, zero dependencies, nothing to install.

## Try it

A realistic sample export lives in `examples/sample-export.json`:

```
node os.mjs ingest examples/sample-export.json
open dashboard.html
```

To start fresh afterwards: `rm data/store.json data/exports/*.json && node os.mjs build`.

## Data contract (the short version)

- Record **ids are stable** and never regenerated — the merge in both directions matches
  by id. See `CLAUDE.md` for the full contract.
- Exports carry `_meta.schemaVersion` (currently **4**); the ingest refuses versions it
  doesn't recognize rather than guessing.
- `data/store.json` is canonical; `views/`, `graph/`, `dashboard.html` are generated.
