# Agent Roles

Each agent has a **role** that defines how it behaves and how it relates to other agents.

## Role Reference

| Role | Behavior |
|---|---|
| **agent** | A standalone agent that responds to direct messages from a human in its dedicated 1:1 Matrix room. With cron or GitHub triggers it can also run autonomously. |
| **team** | A reusable system-prompt template — does not run an agent itself. Use *Add Member* on the team card to spawn one or more `team-member` agents that share the same prompt and environment but each get their own workspace and chat room. |
| **team-member** | A single member spawned from a team. Inherits the team's system prompt, skills, and MCP servers. The **system prompt** offers three modes in the edit form — **Inherit from team** (template only), **Additional input** (the team template plus agent-specific text appended in a delimited section, kept in sync with team-prompt edits), and **Exclusive overriding input** (the member's own text fully replaces the template) — while **Skills** and **MCP servers** keep the two-way Inherit / **Custom** toggle. Role, environment, and parent team are fixed at creation and shown read-only. |
| **orchestrator** | Bound to a BriefingPack directory. Polls the directory every ~30 s, writes one `bp-instance` stub per pack, and suggests dispatching them via chat. |
| **bp-instance** | One per BriefingPack under an orchestrator. Lives as a stub until claimed or activated; when active it executes the pack's LoopScript via the ACE engineering skill. |

## Deleting a team takes its members with it

Deleting a `team` agent **cascades**: every `team-member` whose `parentTeamId`
names it is deleted first, then the team itself. This covers materialized
members and **stubs** (a member created with *Materialize now* switched off —
config and `triggers.json` only, no Matrix user, no container) alike, and it
also runs when the team's own config is unreadable, so a deletion that was
interrupted halfway finishes the job when it is repeated.

The cascade is what stops **orphans** being created — a member whose parent team
no longer exists. An orphan is not a working agent: a member's system prompt,
skills and plugin grant are all defined by inheritance from a team that is gone,
so what remains cannot run as intended. It also blocks the deterministic member
ids (`<teamId>-<roleId>`) that a same-named team would want to reuse.

**Partial failures are reported, not swallowed.** If a member cannot be removed
(its container is busy, its Matrix user cannot be deactivated), the delete
answers with a `cascadeWarnings` list in the same `{ id, kind, error }` shape the
team-creation fan-out uses for its rollback warnings, and the console shows which
members were left behind. A delete that could not finish is never reported as a
clean one.

### One-off cleanup for orphans that already exist

An installation upgraded from before the cascade covered every case — or one
with a hand-edited `parentTeamId` naming a team that never existed — may still
carry orphans. Two System-Admin-only endpoints clean them up:

| Call | Effect |
|---|---|
| `GET /api/agents/orphans` | **Dry run.** Lists every orphan with its id, whether it is materialized or a stub, and *why* it is orphaned — split into `removable` and `reportOnly`. Changes nothing. |
| `POST /api/agents/orphans/cleanup` | Removes the `removable` ones. Re-plans first and logs the same listing before deleting anything, then reports `planned`, `removable`, `reportOnly`, `deleted` and any `warnings`. |

```bash
# From a shell that can reach the Admin Console, with an admin session cookie:
curl -s --cookie "$COOKIE" http://localhost:4000/api/agents/orphans | jq
curl -s --cookie "$COOKIE" -X POST http://localhost:4000/api/agents/orphans/cleanup | jq
```

Four properties worth knowing:

- **It reports before it acts.** The dry run is a separate call, and the cleanup
  writes the identical listing to the orchestrator log *before* the first
  deletion — so an operator watching `podman logs -f orchestrator` sees the plan
  even if the run dies halfway.
- **It is idempotent.** Running it twice over the same workspace removes nothing
  the second time; a member that could not be removed is simply picked up by the
  next run, so an interrupted sweep needs no special handling.
- **It deletes rather than adopts.** Converting an orphan into a standalone agent
  was considered and rejected: the prompt, skills and grants that made it useful
  came from the team, so the honest outcome is to report it and remove it.
- **One class is reported but never deleted.** A member whose `parentTeamId`
  names an agent that *does* exist but is not a `team` (`parent-not-a-team` — a
  typo, or a hand-edited config) is listed under `reportOnly` and left alone. Its
  parent is still there to point at, so correcting the id is a human decision;
  deleting the member on that evidence would be over-reach. The two reasons that
  mean the parent is genuinely gone — `parent-missing` and `no-parent-id` — are
  the ones the sweep removes.

It is **operator-invoked, never automatic on startup** — this platform does not
take destructive actions without an explicit human decision.

Orphan detection is deliberately narrow: only `team-member` agents are
classified. A standalone agent has no parent, a `team` agent *is* one, and
orchestrator / bp-instance residue belongs to the separate BriefingPack removal.

## Migration Note

Earlier versions of the platform used the role names `expert`, `expert-group`, and `expert-instance`. The orchestrator silently rewrites these to `agent`, `team`, and `team-member` on startup (and renames `parentGroupId` → `parentTeamId`), so existing deployments upgrade automatically.

## Team Patterns

A **team** is the recommended pattern for work that benefits from parallel specialists: spawn multiple `team-member` agents with different prompts (e.g. COBOL analyst, Java migration writer, quality reviewer) inside the same environment so they share credentials, repositories, and skill sets while operating in isolated workspaces.

Each team member gets its own Matrix room, workspace directory, memory, and trigger schedule. Members do not communicate directly — coordination happens through shared repositories, GitHub issues, or triggers that reference shared state.
