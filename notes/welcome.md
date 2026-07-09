# Welcome to your vault

This folder — `notes/` — is **yours**. Everything here is hand-written, canonical, and
never touched by the build. Everything *outside* it under `views/` is generated from the
capture tool's data: read it, link to it, but never edit it (edits are wiped on the next
build).

How your notes join the knowledge graph on every `node os.mjs build`:

- Hashtags anywhere become topic nodes — the same tags you use in the capture tool, so
  a tag connects a note to loops, wins, and events that share it.
- Wikilinks resolve automatically: `[[Anna]]` links to the person page of anyone you've
  ever been *waiting on*; `[[Buy the apartment]]` links a note to that goal;
  `[[another-note]]` links notes to each other. (Links written inside backticks, like
  the examples above, stay plain text — same as in Obsidian.)
- Mentioning a known person by name in plain text links the note to them too.

Your notes then show up in `dashboard.html` search and its graph, alongside everything
from the capture tool. Run `node os.mjs doctor` to catch misspelled wikilinks.

Start anywhere — a [[wins]] link works today, and this note can be edited or deleted
freely. It's just a note.
