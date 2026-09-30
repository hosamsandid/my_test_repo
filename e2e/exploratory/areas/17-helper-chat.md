# 17 — Helper Chat, page help, guided tour

**Scope:** app-level Helper Chat overlay, "This page" help face,
`PageHelpButton` deep links to chapters, guided tour, non-route contexts
(dialogs, wizard steps).

## Probes

- Every page: does a help topic exist, is it current (names match the UI)?
- Ask questions about the current page; answers grounded in the right topic?
- Overlay survives navigation; long answers; closing mid-answer.
- Tour: start, skip, finish, restart; tour on a small viewport.
- No model provider → helper explains instead of hanging.

## Cleanup

Nothing is created in this area.
