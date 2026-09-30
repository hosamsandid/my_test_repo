# 06 — Agent Chat: rail, transcript, composer

**Scope:** `/chats`, `/chats/:agentId`, left rail (grouping, search/filter,
drag-reorder, pool-instance sub-groups, unread markers, context menu), transcript
(backfill, pagination, `?msg=` deep links, message actions), composer (drafts,
slash commands, file/image upload, Send/Stop, quick-reply cards from `aee-ask`).

**Preconditions:** a `uitest-` agent with a longer history (≥100 messages for
pagination), an agent that asks via `aee-ask`.

## Persona matrix

| Action | Member | Team Admin | Outsider | System Admin |
|---|---|---|---|---|
| See team agents in rail | yes | yes | **no** | yes |
| Chat with team agent | yes (as themselves) | yes | 404 via URL | yes |
| Lifecycle context menu | limited? | yes | — | yes |

## Probes

- Send: plain, very long, Markdown/code/table, only whitespace, emoji; Enter vs
  Shift+Enter per keybinding preset; Stop during a run.
- Drafts survive agent switch and reload; per-agent.
- Slash palette: filtering, keyboard selection, unknown command.
- Upload: image, large file, disallowed type, several files.
- Quick-reply card: single/multi select, answer twice, answer after reload.
- Scroll: pagination to the very first message, stick-to-bottom while a reply
  streams, jump-to-latest.
- Deep link `?msg=` to existing, unknown and very old messages.
- Message actions (Copy link, Show in session log) over plain HTTP.
- Unread markers across agents; mark as unread.
- Rail: search, filters (disabled/stubs), grouping for teams and pool instances,
  live refresh when an agent is created/removed elsewhere (~5 s).
- Two humans in one agent room: whose name shows, who does the agent answer?

## Risk spots

- `ChatPanel.jsx` (message objects built in four places), `agent-list-model.js`,
  `virtual-window.js`, `session-jump.js`; insecure-context APIs
  (`crypto.randomUUID`, clipboard).

## Cleanup

Delete `uitest-` agents created for the pass.
