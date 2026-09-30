# 05 — Flow Control board

**Scope:** `/flow-control`: stages from the flow graph, "Working now", pools,
human blocks, per-role Pause/Drain/Resume, Force dispatch of held entries,
optional per-team column config.

**Preconditions:** a `uitest-` team; a pooled role and a `wipLimit` for the
held/force probes (no real GitHub writes → mostly empty-state and control probes).

## Probes

- Empty state, team with no flow graph, team switcher with many teams.
- Pause → Drain → Resume: state shown correctly after reload; drain settles to
  `off` when no instance runs; controls for another team's role not offered.
- Force dispatch: confirmation, effect, and what happens if the entry vanished.
- Refresh behaviour: stale data indicator, error when the sweep fails.
- Persona: Member vs Team Admin — who may pause/force? Outsider sees nothing of
  the team.

## Risk spots

- `orchestrator/flow-board.js` (single-flight cached sweep), `pool-control.json`,
  `admissionControl.forcePromoteHeld`.

## Cleanup

Resume every role paused in the pass; remove the pool/`wipLimit` config set.
