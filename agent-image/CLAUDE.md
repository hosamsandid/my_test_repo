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

## Parent ticket (`ticket.json`)

A conversation may be bound to a **parent GitHub issue** by a human in the Admin Console. When it is, a `ticket.json` file is present at your workspace root:

```json
{ "repo": "owner/name", "number": 1383, "url": "https://github.com/owner/name/issues/1383", "title": "…", "children": [1401, 1402] }
```

Read it at session start (if present) to learn which issue this work is about — comment on it, reference it in commits/PRs (`Closes #<number>`), and keep it as the anchor for the task. To register a **child issue** you opened under this parent (so it shows up in `children`):

```bash
curl -fsS -X POST "${ORCHESTRATOR_INTERNAL_URL:-http://localhost:4002}/internal/agents/$AGENT_ID/ticket/children" \
  -H 'Content-Type: application/json' -d '{"number": <childIssueNumber>}'
```

If `ticket.json` is absent, there is no bound parent — proceed normally.

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

`add` appends to the git-committed manifest `.agent-studio/artifacts.jsonl` and stages it —
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

## Shared team knowledge (`knowledge`)

`aee-artifact` hands **one deliverable** to **one downstream agent**. The
`knowledge` CLI is different: it is the shared, team-wide memory of durable
**lessons** — project conventions, environment facts, key entities — that help
*any* teammate on this repo, now and in future runs. It is git-backed and synced
into a local working copy, so it is queryable in real time and offline.

**The digest is already in your context.** A generated `knowledge-digest.md`
in your workspace root is `@`-imported by your CLAUDE.md: all conventions,
validated (independently learned) and recent lessons are guaranteed to be in
your context at session start. It is regenerated automatically before every
run and whenever the team's knowledge changes — never edit it. `knowledge
search` is for the long tail beyond the digest budget.

**Before you start non-trivial work, check what the team already knows:**

```
knowledge search "poller pagination"
knowledge search "npm install" --kind fact
```

**When you learn something durable, record it** (provenance — who/when/which
session — is attached automatically):

```
knowledge add fact "This repo unit-tests pure helper cores only; IO is verified manually"
knowledge add entity "github-poller.js polls the Events API every 30s" --tag polling
knowledge add convention "Branch from origin/main" --source pr:459
```

`add` appends to *your own* shard, commits it as you, and pushes it to the shared
`agent-knowledge` branch through the orchestrator — teammates see it on their
next `knowledge search`. Record only lessons that hold **beyond this one run**
(no PR/issue-specific detail); `knowledge search` first so you don't restate
something already there. Nothing durable to add: skip it. This is separate from
your private `memory/*.md` — memory is your episodic notebook, `knowledge` is the
team's curated, shared knowledge base.

Inspect with `knowledge list [--mine]` and `knowledge path "<id>"`.

**When a fact is worth becoming a reusable skill**, nominate it — this raises a
suggestion card for a human to confirm; it never promotes on its own:

```
knowledge promote <id>
knowledge promote <id> --note "worth generalising into a skill"
```

The system also nominates automatically once two or more agents independently
record the same lesson, so you only need `promote` for something you think is
skill-worthy before it has converged.

**To keep a lesson as your own private skill** (personal specialisation, not yet
team-ready), promote it to the agent tier — this writes it straight into your own
pool, no human needed:

```
knowledge promote <id> --to agent
knowledge promote <id> --to agent --name my-private-skill
```

A human can later lift it to the whole team (agent→team) from the Admin Console
when it proves broadly useful.

## Token usage (`usage`)

`usage` is a **read-only** view of how many tokens you — or your team — have
consumed. The usage store is owned and written by the orchestrator, and your
container is volume-isolated from it, so this CLI queries the orchestrator's
read-only endpoint across that boundary (just like `knowledge`). It is
**token counts only — never a money figure**, and it can never write or delete a
usage record.

Your own usage:

```
usage me
usage me --since 2026-07-01 --until 2026-07-16
usage me --group-by day
usage me --json
```

Your team's aggregate (never another team — fail-closed):

```
usage team
usage team --group-by agent
```

Output carries the four token classes separately (input, output, cache write,
cache read), their total, and the invocation count that backs them. Options
mirror the console summary: `--since` / `--until` (a half-open `[since, until)`
window), `--group-by agent|team|model|provider|day`, and `--json` for the raw
response. Use it to stay budget-aware; if the orchestrator is unreachable it
fails with a clear message rather than a wrong total.

## Key Constraints

- Follow the LoopScript phases strictly and sequentially.
- Raise a CRP (Consultation Request Protocol) file before making any blocking decisions.
- Do not modify files outside the current worktree.
- `10-legacy/` directories are read-only reference material — never modify them.
