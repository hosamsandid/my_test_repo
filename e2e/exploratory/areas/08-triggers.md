# 08 — Triggers

**Scope:** Agent Chat → Triggers tab: list, Add/Edit drawer, delete, enable
toggle; types `cron`, `once`, `http`, `github-event`, `wake-agent`, `loop`,
`plugin-event`; firing behaviour on the agent. The Flow editor reuses the form.

**Preconditions:** a `uitest-` agent that answers quickly (short prompts). Never
fire triggers of agents the tester does not own. `github-event` only against a
sandbox repo, if one is provided.

## Probes

- **Cron builder:** every preset mode; Custom expression (select, type char by
  char, invalid, 4/6 fields, ranges/lists/steps, names `MON-FRI`, macros);
  boundaries 0/59/60/75/-1/2.5, day 0/31/32, cleared time; compare saved cron
  with the input.
- **Firing:** a cron set 1–2 min ahead fires once, on time; every-minute cron
  fires repeatedly; disable stops it; edit **only the prompt** → next run uses
  the new prompt; edit the expression → reschedules.
- **once:** past time, time in 1 min, time zone of the input, auto-removal.
- **http:** secret shown/regenerable? call with wrong/missing secret (local
  webhook only), body ignored.
- **loop:** `maxIterations` required, verify gate, stop a running loop, chat
  while the loop holds the workspace (queued, explained?).
- **wake-agent / plugin-event / github-event:** form validation, filters
  (`labelFilter`, `payloadFilter`), no repo available → explained.
- Duplicate trigger ids (UI and API); delete one of two.
- Save errors (force 4xx/5xx) are shown.
- Transparency: time zone, next/last run, error state of an invalid trigger,
  which trigger fired (chat notice), accessible toggle.

## Risk spots

- `TriggersPanel.jsx` (`CronBuilder`), `cron-format.js`,
  `api.js` trigger routes (no cron/id validation as of 2026-09),
  `agent-entrypoint.py` `TriggerScheduler._sync` (snapshot per task, fixed
  `Europe/Berlin` time zone).

## Cleanup

Delete all `uitest-*` triggers; verify the list is empty and nothing fires.
