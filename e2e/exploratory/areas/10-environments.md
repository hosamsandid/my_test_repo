# 10 — Working Environments and templates

**Scope:** team environment editing (Agent Chat → Settings), `/environment-templates`
(System Admin), repositories list, read-only repos, MCP servers on the env,
additional context, toolchain, repository propagation dialog, agent-scoped
repositories, context mounts; redirect `/environments` → `/chats`.

## Probes

- Repository list: add/remove/reorder, invalid URL, SSH vs HTTPS without PAT
  (clone refused — message?), duplicate repo, `readOnly` flag.
- Save → propagation dialog: which agents are offered, dirty clones are never
  pruned, "agents not up to date" badge.
- Additional context: very long text (is it shown to the agent?), Markdown.
- Toolchain: select, unknown/removed toolchain.
- Templates: create/copy/delete as System Admin; a template is never bindable;
  Member/Team Admin access to `/environment-templates`.
- Persona: Member edits the team env? Outsider sees names in dropdowns?

## Risk spots

- `repo-sync.js`, `agent-repositories.js`, `toolchain-registry.js`,
  `resource-tier.js` for env ownership.

## Cleanup

Delete `uitest-` environments/templates; revert env edits on the `uitest-` team.
