# Working Environments

A **Working Environment** is a reusable workspace recipe applied when an agent is created. It bundles everything the agent needs to operate: credentials, repositories, skills, and a model provider.

## Fields

| Field | Purpose |
|---|---|
| **Skills** | Names of skills (from the central pool) to copy into the agent workspace at creation |
| **Repositories** | Zero or more Git repos to clone, each with an optional SSH key binding; an empty array is valid for LLM-only agents with no code context |
| **GitHub Token** | PAT used by the GitHub poller for event-driven triggers; also authenticates HTTPS GitHub repository cloning and the real-time repo-check probe |
| **Model Provider** | Optional override — the agent inherits `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from this provider rather than the global default |
| **Additional Context** | Markdown appended to the agent's `CLAUDE.md` after the environment section |

## What happens at agent creation

When a new agent is created with a Working Environment, the orchestrator:

1. Seeds `.claude/` and `memory/` from the skill-pool volume
2. Copies the selected skills into the agent workspace
3. Clones the configured repositories — SSH repos use the bound SSH key; HTTPS GitHub repos use the environment's GitHub token
4. Assembles a merged `CLAUDE.md` from the base template, the environment section, and the agent's own prompt

This means all agents in the same Working Environment share the same starting skill set and repository access — but each gets an independent workspace and memory that evolves separately from that point on.

## Editing a Working Environment

Changes to a Working Environment affect newly created agents only. Existing agents retain the workspace state from when they were created. To update an existing agent's skills or repositories, use the Workspace Browser in the Agent Chat right rail.
