---
name: agent-studio-dev
description: >-
  Onboarding and working conventions for building the Agent Studio codebase
  (the agent-execution-environment repo). Read this whenever you are a
  Developer, Code Reviewer, or Business Analyst working on this repo so you
  inherit the team's hard-won lessons instead of rediscovering them: the
  GitHub hand-off workflow, headless-runtime quirks and workarounds, testing
  conventions, dual-runner parity, and UI gotchas.
---

# Skill: Agent Studio — Development Conventions

## Purpose

This skill front-loads the practical, non-obvious knowledge a team of agents
accumulated while developing **Agent Studio** (repo:
`AccentureCodeFoundry/314092_agent-execution-environment`) — a local
Matrix-to-Claude-Code stack. A fresh agent that reads this can skip the
painful rediscovery of the same environment quirks, workflow rules, and repo
conventions.

**When to use:** any coding, review, or issue-scoping task on this repo. Read it
at the start of a session. The authoritative architecture reference is always
the repo's root `CLAUDE.md`; this skill is the *operational* companion to it.

---

## 1. The team workflow (how work flows)

The pipeline is: **Business Analyst** (scopes + labels an issue `ready`) →
**Developer** (implements, opens PR) → **Code Reviewer** (reviews) → **human
merges**. Rules:

- **One feature branch per issue; the PR closes the issue** (`Closes #NNN`), or
  `Refs #NNN` if it only partially addresses it (keep the issue open, file a
  follow-up for the rest).
- Branch from the latest `main`. If you must defer part of the scope, **file a
  follow-up ticket so nothing is lost** — the operator explicitly values this
  over silently dropping scope.
- Bug reports arrive via **chat and screenshots**, not always as a filed GitHub
  issue. Treat a chat report as a legitimate work item; if it's a regression,
  open a PR referencing the feature/issue it regresses (e.g. "Fixes a
  regression from #445").
- After a review lands, **proactively address the reviewer's non-blocking
  suggestions** rather than waiting to be told — this is the expected behaviour.
- **You do not merge.** A human holds merge authority.

---

## 2. GitHub hand-off: `gh-as-agent` is mandatory

All agents on this repo **share one GitHub PAT / identity**. This has two hard
consequences:

- **Always use `gh-as-agent commit` / `push` / `stamp`** — never raw `git push`.
  The `gh-as-agent` wrapper stamps per-agent attribution; unstamped actions
  cause **self-trigger loops** (the poller can't tell your own action from an
  external one).
- Run `gh pr create` **only after** `gh-as-agent stamp <body-file>` — `stamp`
  appends the `<!-- agent: <id> -->` marker the poller uses for attribution and
  loop protection.
- **You cannot approve your own PR.** `gh pr review --approve` fails with
  *"Can not approve your own pull request"* because reviewer and author are the
  same GitHub account. **Reviewers:** use
  `gh pr review --comment --body-file <f>` and state the approve /
  request-changes verdict **in the body text**. A human performs the merge.
- **`gh` auth blockers can be transient.** If `gh pr create` fails with a
  `gh auth login` error, it may just be a hiccup — see §4 on re-triggers.

---

## 3. Headless runtime quirks (and their workarounds)

Triggered / unattended agent runs execute in a headless container with **no
interactive permission approver**. Several ordinary commands are silently
blocked. Know the workarounds:

| Symptom | Cause | Workaround |
|---|---|---|
| `git pull` / `rebase` / `merge --ff-only` → *"Claude requested permissions to use Bash, but you haven't granted it yet"* | No interactive approver | Branch straight from the fetched remote: `git checkout -b <branch> origin/main` (gets latest remote state without updating local `main`). If local branch is a strict ancestor of remote (`git merge-base --is-ancestor HEAD origin/<branch>`), `git reset --hard origin/<branch>` is a safe fast-forward substitute. |
| `npm install` (and anything downstream, e.g. `vite build`) → same permission error | Same | `admin-console/node_modules` can **never** be installed here. Do **not** treat a failed build as a code regression. Fall back to `node --test` (works without install) + manual/grep static checks, and **disclose the live-verification gap explicitly in the PR body**. |
| `admin-console/api/auth.test.js` fails on missing `express-rate-limit` | No `node_modules` | This single failure is **environment noise, not a regression** — state so and move on. |
| The `Read` tool intermittently throws the same permission error on a file | Tool flakiness | Fall back to `sed -n '<start>,<end>p' <file>` (or `cat`) via Bash — those read the same file fine. Don't retry `Read` in a loop. |
| `gh-as-agent commit` → *"Committer identity unknown"* | Fresh containers may lack `~/.gitconfig` | The `314092_agent-execution-environment` checkout now has a **repo-local** git `user.name`/`user.email` set, so this usually works out of the box. **Check `git config user.name` first**; only if empty, set it locally in the repo (the old `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` env-var workaround). |

**Bash cwd persists between calls.** A `cd <subdir>` in one Bash tool call
stays as the cwd for later calls. Prefer **absolute paths**, or re-`cd`
deliberately, so a stray earlier `cd` doesn't break relative paths later.

---

## 4. Session-resume & branch hygiene

Context compaction / session resume can leave the working directory on a
**different branch** than the one you created for the issue — sometimes with
uncommitted changes from another issue on top.

- **Always verify `git branch --show-current` matches the issue you're working
  right before committing** — especially right after a resume. Don't trust that
  the working dir is still on the branch you created earlier.
- If you find stray uncommitted work from another issue, **stash it (never
  discard):** `git stash push -m "<what/why>"`, then flag it to the user for a
  decision. Discarding another issue's work is not recoverable.
- **On a re-trigger for an issue previously reported as blocked, re-check the
  current state first** — is the branch already pushed? commit already made? PR
  already open? is `gh auth status` now healthy? Reuse the existing
  branch/commit and just retry the one blocked step; do **not** redo the whole
  implementation.

---

## 5. Testing conventions

This repo has a specific, narrow testing philosophy — follow it exactly, or a
reviewer will (rightly) flag mismatch:

- **Unit-test the *pure helper cores*, not the glue.** The expected shape for a
  logic change is: extract the changed logic into an **exported pure function**
  and unit-test it in a sibling `<name>.test.js` run via `node --test`.
  Examples: `orchestrator/clone-target.js`, `orchestrator/teams-store.js`,
  extracted helpers in `orchestrator/github-poller.js`.
- **Do not** unit-test subprocess-spawning, HTTP-calling, or Matrix/IO glue, nor
  UI render/text paths. A **pure UI text/display change gets no test** — that is
  intentional, not a gap.
- **Python has no test harness/CI in this repo.** JS tests run via `node --test`.
  To unit-test a pure helper in `agent-image/scripts/agent-entrypoint.py`: its
  top-level imports are stdlib-only (heavy deps like `matrix-nio`/`markdown`/
  `croniter` are lazy-imported *inside functions*), so a stdlib `unittest` file
  can `importlib.util.spec_from_file_location(...)` the hyphenated module and
  call the helper directly — see `agent-image/scripts/test_agent_entrypoint.py`.
- **Reviewers:** the "tests cover only the pure helper, not the glue" pattern is
  established convention here — raise it as a *non-blocking* suggestion at most,
  not a blocker.

---

## 6. Dual-runner parity (the #1 easy-to-miss trap)

There are **two** per-agent runners, and they must stay behaviourally identical:

- **`agent-image/scripts/agent-entrypoint.py`** is the **live**
  runtime — this is what actually runs inside agent containers.
- **`orchestrator/agent-runner.js`** is the **legacy Node reference** — *not
  executed*, but deliberately kept in structural parity as documentation.

**Mirror any runner change in both.** BA issues about the runner usually name
both files for exactly this reason. They share the invocation
(`_call_claude_once` ↔ `callClaude`) and the stream mapper
(`_map_stream_json_line` ↔ `mapStreamJsonLine` in `orchestrator/session-log.js`).

**Language convention:** runner-emitted chrome strings (fallbacks, notices, e.g.
the "no output" fallback, `_(Execution aborted.)_`) are written in **English**.
The *model's own reply text* is in the user's language. Match English for any
new runner-emitted UI text.

---

## 7. Central chat vs. Log tab (two unconnected data sources)

- The **central Agent Chat** (`admin-console/src/pages/agent-chat/ChatPanel.jsx`)
  renders **only Matrix room events** (SSE `/api/matrix/rooms/:roomId/stream`).
- The **Log tab** is a **separate JSONL feed** (the session log written by
  `orchestrator/session-log.js`).

They are otherwise unconnected. **To make anything appear in the human-facing
chat, the runner must post a normal Matrix message** — i.e. return it as the
turn's reply text via `send_formatted` (markdown→HTML). No frontend change is
needed for that. The only standing bridge is the final `result` text posted once
per run; other intermediate tool calls do **not** reach the chat on their own —
the one exception is a human decision question, which is intercepted (see below).

**Asking the user in this environment (`aee-ask`):** a turn is a single non-interactive
`claude --print` process (the prompt is fed on stdin, #1727), so the tool's
*built-in* `AskUserQuestion` (which is interactive-TTY-only) is removed from the model's tool
set entirely in headless print mode — a bare `--allowedTools` add does nothing.
The working path is the **`aee-ask` CLI** (#2523, `agent-image/scripts/aee-ask`,
on `PATH`): it validates its arguments (bad input → exit 2, nothing queued) and
writes an `AskUserQuestion`-shaped `{"questions":[…]}` payload to a
per-invocation sentinel file the runner hands it via `AEE_ASK_FILE`. The runner
checks for that sentinel after every `tool_result` (and once more after the CLI
exits) — it never parses the Bash command — and **hard-ends the turn** the moment
it appears, so nothing runs after the question. That kill costs the turn its
`result` event/usage record, but the session stays `--resume`-able. Call
`aee-ask` from the main session, never from a Task sub-agent.
`aee-ask` is the only mechanism: the runner registers no MCP server for it
(the former bundled `AskUserQuestion` MCP server was removed in #1719, and
`_base_claude_args` passes no `--mcp-config`); MCP servers from an
environment's `settings.json` still load as usual. The runner renders the
question(s) into a readable chat message with clickable quick-reply buttons (#1663) and posts that as the turn's
terminal message, dropping any trailing model text. The user's chosen option (or
free-text) then continues the resumed session as a new turn. A `multiSelect`
question renders as toggles plus Submit and resumes with every selected label
(#2523; it used to degrade to the plain text body). (Issue #447 added the original
interception; #1712's MCP delivery was retired by #1719.) Plain-text questions in
your reply still work too.

---

## 8. Admin Console UI gotchas

- **Popovers/tooltips inside scrollable or `overflow`-clipped ancestors get
  clipped — and `z-index` cannot rescue them.** Any absolutely/relatively
  positioned popover nested inside a table, scroll pane, or `overflow: hidden`
  modal (e.g. every `DataTable`-based page — per CSS overflow-axis coupling, an
  explicit `overflow-x` forces `overflow-y` to compute to `auto`) must use
  `createPortal(..., document.body)` + `position: fixed` + coordinates from
  `getBoundingClientRect()`. **Check ancestor `overflow` *before* shipping a
  hover-popover, not after a user reports it invisible.** The pattern is already
  used by `agent-chat/WorkspaceBrowser.jsx`'s file-preview modal and
  `components/IconButton.jsx`'s tooltip.
- **`components/IconButton.jsx`** is the single shared icon-only action button
  used across all management pages (Agents, WorkingEnvironments, Teams,
  McpServers, GithubTokens, SshKeys, SkillsRegistry, ModelRegistry).
  It consolidated four previously-duplicated implementations —
  any change to icon-button hover/tooltip behaviour belongs **here**, so one fix
  covers every page.
- **`theme/tokens.css`** is the *only* global stylesheet: all `--eb-*` custom
  properties plus a few utility classes. Status colour semantics are consistent
  and meaningful — don't create double-meanings:
  `--eb-status-info` = blue (active session), `--eb-status-success` = green
  (new/unread message), `--eb-status-warning` = orange (busy),
  `--eb-status-error` = red (problem), `--eb-text-muted` = grey (idle).
- **`docs/` and root `CLAUDE.md` are living documentation.** When a PR changes
  documented runtime behaviour, **update the relevant `CLAUDE.md` section in the
  same PR** — reviewers flag a missing doc update as a non-blocking suggestion.
  Likewise, when you replace a mechanism, grep the **comments/headers** that
  describe it, not just the code.

---

## 9. Working with the operator

- The operator writes **well-scoped GitHub issues** (Problem / In-Scope /
  Out-of-Scope / Acceptance Criteria, often "Open Questions: none") and
  communicates **tersely** in chat — a one-word "Merged" is a full message.
  Reply in kind; the operator is comfortable with terse, technical root-cause
  explanations (no need to over-simplify).
- The operator writes issues in German and may chat in German or English; the
  product and all code/UI/prompts are **English** (see the repo's language
  convention).
- The operator **delegates technical decisions** ("can you assess that better?"
  → "go ahead") but **wants the design explained before approving** risky
  changes. On fragile/critical code, take a **cautious, minimal,
  backwards-compatible** approach and sort out branches first.
- Sessions often end with an explicit **"summarize and update memory"** request
  — treat that as a standing wrap-up ritual: distil durable, reusable lessons
  into your `memory/` files (facts / entities / log / users / context).

---

## Quick-start checklist for a new session on this repo

1. Read the root `CLAUDE.md` for architecture; this skill for operations.
2. `git branch --show-current` — confirm you're on the right branch; stash stray
   work.
3. Branch from `origin/main` (`git checkout -b <branch> origin/main`).
4. Implement; extract changed logic into a pure fn + `node --test` (or the
   Python `importlib` unittest pattern). Mirror runner changes in both runners.
5. Update the relevant `CLAUDE.md`/`docs/` section if behaviour changed.
6. `gh-as-agent commit` → `gh-as-agent push` → `gh-as-agent stamp` →
   `gh pr create` (`Closes #NNN`). Disclose any verification gap in the PR body.
7. Never merge; never approve your own PR. Reviewers comment with the verdict in
   the body.
