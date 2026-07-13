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

### Pushing & opening PRs — use `gh-as-agent`, not `git push` / `gh pr create`

Depending on how this agent is configured, `git push` and `gh pr create` may be
**blocked by the organisation's managed Claude Code policy** (it requires
interactive human approval, which does not exist in an unattended triggered or
scheduled run). `git commit` is **not** blocked.

So the workflow is: **commit locally, then hand the push/PR to the platform** —
all through the one `gh-as-agent` wrapper:

```bash
# 1. Commit your work locally (stamps your agent identity as author):
gh-as-agent commit -m "feat: implement the thing"

# 2. Push via the orchestrator (uses the environment's own credentials):
gh-as-agent push

# 3. Or push + open a PR in one step (body is stamped with your agent marker):
gh-as-agent pr --title "Implement the thing" --body-file /tmp/pr-body.md --base main
```

`gh-as-agent push` / `pr` run the network step **outside** the policy-gated
Claude CLI, so they work in unattended runs. On a multi-repo environment add
`--repo <clone-dir-name>`. If it reports a failure (e.g. non-fast-forward, auth),
surface it to the user — do not retry with a raw `git push`, which will just hit
the policy block.

### `gh-as-agent commit` is self-sufficient — no git identity setup needed

`commit` sets **both** the author and the committer inline
(`git -c user.name="agent-<AGENT_ID>" -c user.email="agent-<AGENT_ID>@ace.local"
commit --author="<AGENT_ID> <<AGENT_ID>@agents.local>"`). It therefore works in
a fresh context with no configured git identity (a manual shell, the Claude Code
harness) — you do **not** need to set `GIT_COMMITTER_*` or run `git config`. The
author email keeps the `@agents.local` marker the poller reads for loop
protection; the committer mirrors the orchestrator's own identity.

### `gh-as-agent pr` when the environment has no GitHub token

Opening a PR needs a GitHub PAT. If this environment has none, `gh-as-agent pr`
first **pushes your branch over SSH** (that part still succeeds with only an SSH
key), then fails the PR step with a **distinct** error prefixed `no-github-token:`
(orchestrator HTTP `424`), naming the environment — it is *not* a git conflict.
When you see it, the branch is already on the remote: surface the message to the
user (the environment needs a PAT attached) or open the PR yourself with plain
`gh pr create --head <branch>`. Do **not** retry with a raw `git push`.

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
