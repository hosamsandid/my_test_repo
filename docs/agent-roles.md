# Agent Roles

Each agent has a **role** that defines how it behaves and how it relates to other agents.

## Role Reference

| Role | Behavior |
|---|---|
| **agent** | A standalone agent that responds to direct messages from a human in its dedicated 1:1 Matrix room. With cron or GitHub triggers it can also run autonomously. |
| **team** | A reusable system-prompt template — does not run an agent itself. Use *Add Member* on the team card to spawn one or more `team-member` agents that share the same prompt and Working Environment but each get their own workspace and chat room. |
| **team-member** | A single member spawned from a team. Inherits the team's system prompt, skills, and MCP servers. The **system prompt** offers three modes in the edit form — **Inherit from team** (template only), **Additional input** (the team template plus agent-specific text appended in a delimited section, kept in sync with team-prompt edits), and **Exclusive overriding input** (the member's own text fully replaces the template) — while **Skills** and **MCP servers** keep the two-way Inherit / **Custom** toggle. Role, Working Environment, and parent team are fixed at creation and shown read-only. |
| **orchestrator** | Bound to a BriefingPack directory. Polls the directory every ~30 s, writes one `bp-instance` stub per pack, and suggests dispatching them via chat. |
| **bp-instance** | One per BriefingPack under an orchestrator. Lives as a stub until claimed or activated; when active it executes the pack's LoopScript via the ACE engineering skill. |

## Migration Note

Earlier versions of the platform used the role names `expert`, `expert-group`, and `expert-instance`. The orchestrator silently rewrites these to `agent`, `team`, and `team-member` on startup (and renames `parentGroupId` → `parentTeamId`), so existing deployments upgrade automatically.

## Team Patterns

A **team** is the recommended pattern for work that benefits from parallel specialists: spawn multiple `team-member` agents with different prompts (e.g. COBOL analyst, Java migration writer, quality reviewer) inside the same Working Environment so they share credentials, repositories, and skill sets while operating in isolated workspaces.

Each team member gets its own Matrix room, workspace directory, memory, and trigger schedule. Members do not communicate directly — coordination happens through shared repositories, GitHub issues, or triggers that reference shared state.
