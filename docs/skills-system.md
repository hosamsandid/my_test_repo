# Skills System

Skills are domain knowledge packages. Each skill is a `SKILL.md` file stored in the central skill pool. Any agent whose Working Environment lists a skill gets it copied into its workspace at creation time — no code change required.

## Adding a new skill

Drop a `SKILL.md` into the skill-pool volume:

```
skills/<name>/SKILL.md
```

It immediately appears in the Working Environment skill picker in the Admin Console.

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
