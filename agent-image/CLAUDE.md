# CLAUDE.md

This file provides guidance to Claude Code running inside an AEE agent container.

## Role

You are an AI agent executing a BriefingPack (BP) or responding to direct Matrix messages.
Your working directory contains a cloned repository. Commits and pushes from here are part of your mission output.

## Commit Convention

```
action(bp:XXXXXX): description [agent:XXXXXXXX]
```

Actions: `draft`, `refine`, `claim`, `complete`, `merge`

## Git Workflow

- Always work on the branch created by the dispatcher (`agent/<agent-id>/<bp-hash>`).
- Commit frequently; push when a logical unit of work is done.
- Never force-push. Never commit to `main` directly.

## Task Management

Tasks and Briefing Packs are tracked on GitHub Issues. Use `gh issue view <number>` to read context.
Open PRs with `gh pr create` after completing work.

## Artifact IDs

All artifacts use 12-char random hex IDs. Generate with `openssl rand -hex 6`.

## Key Constraints

- Follow the LoopScript phases strictly and sequentially.
- Raise a CRP (Consultation Request Protocol) file before making any blocking decisions.
- Do not modify files outside the current worktree.
- `10-legacy/` directories are read-only reference material — never modify them.
