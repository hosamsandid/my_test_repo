# Skills System

Skills are domain knowledge packages. Each skill is a `SKILL.md` file stored in the central skill pool. A skill granted to an agent (or its team) is copied into that agent's workspace at creation time — no code change required. You grant a skill to a team or an agent from the **Settings** tab of Agent Chat's right rail (`/chats`; the Agents page that used to host this form was removed in #1930), in the Team-Setup wizard, or on the Knowledge page — environments carry only infrastructure (repos, credentials, MCP servers, context) and never skills.

## Two tiers: global and team (#306)

Skills exist on two tiers, and an agent resolves a skill name **team-first, then global**:

| Tier | Location | Managed by | Who gets it |
|---|---|---|---|
| **Global** | `skills/<name>/SKILL.md` in the skill-pool volume (`/pool/skills` in the `admin-console` container, `/template-workspace/skills` in the orchestrator) | Team Admin (any team) or System Admin | every agent |
| **Team** | `/workspace/teams/<teamId>/skills/<name>/SKILL.md` (on the workspace volume) | Team Admin | only agents owned by that team |

The `<teamId>` of a team pool is the **Agent Team** id: a team's agents and its members all read the pool of that Agent Team (a member uses its parent team), and only a standalone agent falls back to its legacy team id. Creating, importing, adopting and deleting team skills on the Skills page use the same key (#2689).

At agent creation the orchestrator copies each granted skill from the owning team's pool when it has that name, otherwise from the global pool. A team with no own skills behaves exactly as a global-only setup — so this is fully backward compatible. This is how a team curates **private** domain skills without leaking them to other teams: the skill is only ever seeded into that team's agents.

**Writing into the global pool is a Team-Admin act, not System-Admin-only — one rule, every entry path** (relates to skill propagation, #173; refined by #2180, unified by #2307): an agent-extracted skill is lifted to the **team** pool by a Team Admin, and that same Team Admin may promote their own team's skill on to the **global** pool directly (*Promote to global* in the Skills Registry) — no System Admin needed. **Publish** (#2180) additionally lets an agent's edited skill — including an edited copy of a skill it was granted — go straight from the agent's own workspace to the team and/or global pool in one action, skipping the team-pool stage entirely; the real owning team is always resolved server-side from the agent's own config, never taken from the client. **Import** (a `.zip`/`.skill` archive), **Merge**, **+ New Skill**, and editing an existing skill's content all apply the SAME floor for a global target: System Admin, or Team Admin of *any* team — an external archive or a hand-authored skill has no single "owning team" to name, so any team a caller administers clears the bar (#2307). Writing into a specific **team** pool always needs Team Admin of that exact team, on every one of these paths, unchanged. What stays **System-Admin-only** is moving content *out* of the global pool (or out of an agent's own workspace) — retiring someone else's content is a governance-level act regardless of who is adding to global.

## Adding a new skill

Drop a `SKILL.md` into the skill-pool volume (global tier):

```
skills/<name>/SKILL.md
```

It immediately becomes available to grant to a team or an agent (Agent Chat's **Settings** tab, the Team-Setup wizard, or the Knowledge page). To add a **team** skill, use the Skills Registry's **+ New Skill** form and pick the team as the target pool (or `POST /api/skills` with `source: "team", teamId`).

## How skills are used

Claude reads skill files at the start of each invocation via the agent's `CLAUDE.md`. A skill typically contains:

- Domain context (e.g. COBOL/DB2 patterns, Java migration rules)
- A table of data files or reference documents the agent can read
- Usage examples showing how to apply the knowledge
- Specific instructions for the agent's role

## Current domain focus

The default skill set covers mainframe migration: COBOL analysis, JCL conversion, DB2 schema mapping, IMS/VSAM patterns, and related topics. Skills can cover any domain — a skill is just a Markdown file.

## Skills Registry

Agent Studio's **Skills Registry** page (`/skills`) lists all available skills in the pool and lets you click through to read any skill's content without leaving the browser.

## Updating a skill

Editing a skill file in the pool affects new agents and future invocations by existing agents that already have the skill. Because the file is copied at agent creation, a new version of a skill is not automatically pushed to agents created before the update — re-create the agent or manually copy the updated file into its workspace.
