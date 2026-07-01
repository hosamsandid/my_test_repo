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

## Artifact hand-offs (`aee-artifact`)

When your work is an **input to another agent** (a data-flow / dependency edge in
the process model), the durable bridge between you is git — and the other agent
finds your output by its **logical name**, not a fixed path. Paths vary per run,
so you *report* what you actually produced instead of writing to a hard-coded
location:

```
aee-artifact add "Functional Design" designs/acct/fd.md
aee-artifact add "Java sources" src/main/java --desc "generated transfer service"
```

`add` appends to the git-committed manifest `.aee/artifacts.jsonl` and stages it —
**commit and push it together with your work** so downstream agents are woken by
the push and can resolve the path.

When you are the **consumer** and were woken by an upstream's push, resolve its
output by name rather than guessing a path:

```
aee-artifact path "Functional Design"     # newest registered path
aee-artifact list "Functional Design"      # all matching entries
```

If the upstream pushed but never registered an artifact you expect, do not guess
a path — tell the user it is missing and stop.

## Key Constraints

- Follow the LoopScript phases strictly and sequentially.
- Raise a CRP (Consultation Request Protocol) file before making any blocking decisions.
- Do not modify files outside the current worktree.
- `10-legacy/` directories are read-only reference material — never modify them.
