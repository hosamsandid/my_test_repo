# 13 — GitHub Event Log

**Scope:** `/github-events`: Processed events and Pending queue tabs, filters,
drop reasons, held dispatches, supervisor entries.

## Probes

- Filters and search with no result, many results, long repo/agent names.
- Column layout at three viewports (truncation + tooltip).
- Every drop reason has a readable explanation (`knowledge-branch`,
  branch filter, throttle, digest, no-subscriber).
- Pending queue: held dispatches visible, refresh, empty state.
- Persona: Member/Outsider see only events of their teams' repos.

## Risk spots

- `github-event-log.js`, `aggregateHeldDispatches`, `/api/pending-queue`.

## Cleanup

Nothing is created in this area.
