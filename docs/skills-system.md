# Skills System

Skills are domain knowledge packages. Each skill is a `SKILL.md` file stored in the central skill pool. A skill granted to an agent (or its team) is copied into that agent's workspace at creation time — no code change required. You grant a skill to a team or an agent on the Agents page, in the Team-Setup wizard, or on the Knowledge page — Working Environments carry only infrastructure (repos, credentials, MCP servers, context) and never skills.

## Two tiers: global and team (#306)

Skills exist on two tiers, and an agent resolves a skill name **team-first, then global**:

| Tier | Location | Managed by | Who gets it |
|---|---|---|---|
| **Global** | `skills/<name>/SKILL.md` in the skill-pool volume (`/pool/skills` in the admin console, `/template-workspace/skills` in the orchestrator) | System Admin | every agent |
| **Team** | `/workspace/teams/<teamId>/skills/<name>/SKILL.md` (on the workspace volume) | Team Admin | only agents owned by that team |

At agent creation the orchestrator copies each granted skill from the owning team's pool when it has that name, otherwise from the global pool. A team with no own skills behaves exactly as a global-only setup — so this is fully backward compatible. This is how a team curates **private** domain skills without leaking them to other teams: the skill is only ever seeded into that team's agents.

**Two-stage promotion** (relates to skill propagation, #173): an agent-extracted skill is promoted to the **team** pool by a Team Admin, and optionally lifted to the **global** pool by a System Admin (*Promote to global* in the Skills Registry).

## Adding a new skill

Drop a `SKILL.md` into the skill-pool volume (global tier):

```
skills/<name>/SKILL.md
```

It immediately becomes available to grant to a team or an agent (the Agents page, the Team-Setup wizard, or the Knowledge page). To add a **team** skill, use the Skills Registry's **+ New Skill** form and pick the team as the target pool (or `POST /api/skills` with `source: "team", teamId`).

## How skills are used

Claude reads skill files at the start of each invocation via the agent's `CLAUDE.md`. A skill typically contains:

- Domain context (e.g. COBOL/DB2 patterns, Java migration rules)
- A table of data files or reference documents the agent can read
- Usage examples showing how to apply the knowledge
- Specific instructions for the agent's role

## Current domain focus

The default skill set covers mainframe migration: COBOL analysis, JCL conversion, DB2 schema mapping, IMS/VSAM patterns, and related topics. Skills can cover any domain — a skill is just a Markdown file.

## Skills Registry

The Admin Console's **Skills Registry** page (`/skills`) lists all available skills in the pool and lets you click through to read any skill's content without leaving the browser.

## Updating a skill

Editing a skill file in the pool affects new agents and future invocations by existing agents that already have the skill. Because the file is copied at agent creation, a new version of a skill is not automatically pushed to agents created before the update — re-create the agent or manually copy the updated file into its workspace.
