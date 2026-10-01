# 07 — Agent Chat right rail (Sessions, Session log, Workspace, Outcomes, Knowledge, Settings)

**Scope:** all right-rail tabs except Triggers (see `08-triggers.md`).

**Preconditions:** a `uitest-` agent with a repo, a few runs, some workspace files
(incl. an image and a >512 KB file), a context-folder mount if available.

## Probes

- **Sessions / Session log:** list of runs, active-run indicator, live TODOs,
  tool renders (Edit/Write diffs, task events, rate-limit events), very long
  runs (windowing), hover cross-highlight with the chat, jump from a message.
- **Workspace:** browse, large file (512 KB cap message), binary, image inline,
  deep folder, path with spaces/unicode, file deleted while open.
- **Context folders:** read-only vs read-write mount, write attempt on RO,
  agent container stopped → browse error message.
- **Outcomes:** empty state, links to GitHub artifacts, stale entries.
- **Knowledge tab:** search, entry detail, promote suggestions — what may a
  Member do vs Team Admin?
- **Settings tab:** every field of the agent edit form — validation, save,
  reload; prompt mode switch; model selection; enable/disable; environment
  edits (repository propagation dialog).
- Persona: Member opens Settings — read-only or editable? Outsider via URL.

## Risk spots

- `context-browse.js` / `context-write.js` (run inside the container),
  `repo-sync.js` (never prunes dirty clones), `SessionLogPanel`.

## Cleanup

Revert settings changed on shared objects (only `uitest-` objects may be edited).
