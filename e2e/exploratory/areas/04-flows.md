# 04 — Flows (process canvas, drafts, copilot)

**Scope:** `/flows` (aliases `/process`, `/process/:teamId`, `/briefings`), the
Teams/Drafts list, graph editor (`ProcessGraphPanel`), ports and edges, labels,
gates, human nodes, Parallelism panel (`wipLimit`, pools), template export /
"Edit as draft", Flow Copilot, anomaly and improvement panels.

**Preconditions:** a `uitest-` team with ≥2 members; drafts created by the tester.

## Persona matrix

| Action | Member | Team Admin | Outsider | System Admin |
|---|---|---|---|---|
| See own team's live graph | read | edit | 404 | edit |
| Edit ports/edges on live team | ? (document) | yes | no | yes |
| Drafts | own + shared | own + shared | own | own + shared |

## Probes

- Create/rename/delete a draft; share it; open as the other persona.
- Draw every edge type; delete nodes with edges; undo/redo if offered; self-loop;
  duplicate edge; cycle.
- Edit a live team's ports → derived triggers change on the members (check each
  member's Triggers tab); revert.
- Schedule/timer edge uses the shared trigger form → repeat the cron probes from
  `08-triggers.md` here.
- `wipLimit`: empty, 0, negative, huge; pool enable/disable; auto-dispatch
  preconditions (requires `wipLimit` + pooled role) — explained when missing?
- Export template → re-import via wizard; "Edit as draft" of a live team.
- Flow Copilot: long running turn, navigate away and back (turn survives),
  concurrent turns, provider missing.
- Lints and anomalies: are they understandable, do links go somewhere?
- Large graph (many nodes): layout, zoom, pan, performance.

## Risk spots

- `process-graph.js`, `unified-graph.js`, `flow-layout.js`,
  `admin-console/api/draft-access.js`, `process-template.js`.

## Cleanup

Delete `uitest-` drafts; revert port edits on the `uitest-` team (or delete it).
