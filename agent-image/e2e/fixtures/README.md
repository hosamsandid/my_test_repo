# fake-claude fixtures & playbooks (E2E)

Reply fixtures and **playbooks** for the scriptable fake `claude` shim
(`agent-image/e2e/claude`), used by the IBAN-story journey
(`e2e/journeys/iban-story.yaml`, issue #711, `docs/journey-spec-concept.md`
§6.2). Baked into the agent image at `/opt/ace/e2e/fixtures/` (Dockerfile
`COPY e2e/ /opt/ace/e2e/`).

## What a playbook is

The F-phase shim replays canned stream-json text. The IBAN story needs role
*behaviour*: the Developer must actually branch/commit and open a PR, the
Reviewer must comment and label. So a fixtures rule may name a `playbook`:

```json
{ "match": "<prompt substring>", "reply": "<canned reply>", "playbook": "developer-implement.sh" }
```

When the rule matches, the shim runs `$AEE_FAKE_CLAUDE_PLAYBOOKS/<playbook>`
**before** emitting the reply — inside the agent container, as the agent user,
against the real workspace clone and the fake GitHub API. The matched prompt is
passed to the script via `$AEE_FAKE_CLAUDE_PROMPT` (so it can extract the
issue/PR number). The script's stdout is routed to stderr so the shim's own
stdout stays a clean stream-json stream; a non-zero exit is logged but never
aborts the reply. With no `playbook`, or `$AEE_FAKE_CLAUDE_PLAYBOOKS` unset,
behaviour is byte-identical to the F-phase shim.

## Why this location (not repo-root `e2e/fixtures/`)

`docs/journey-spec-concept.md` §5 sketches `e2e/fixtures/`. Playbooks run
**inside the spawned agent container**, whose only baked-in assets come from the
agent-image build context (`make agent-image` builds with context `agent-image/`
→ `COPY e2e/ /opt/ace/e2e/`). Repo-root `e2e/` is not in that context, so a
script placed there would never ship into the container. They therefore live
under `agent-image/e2e/fixtures/`, preserving the concept's relative
`fixtures/playbooks/` structure at `/opt/ace/e2e/fixtures/`.

## Decision: curl, not `gh` (issue #711, point 2)

Playbooks call the fake GitHub REST API **directly with `curl`**, not the `gh`
CLI. `gh` against a non-github.com host expects the GitHub-Enterprise path shape
(`https://<host>/api/v3/...`) and a configured `GH_HOST`; the in-stack
fake-github (§6.1) serves the plain github.com shape (`/repos/:owner/:repo/…`)
with no auth. curl against `$GITHUB_API_BASE` is the smallest honest thing that
works. Deps: `curl` + `python3` only (both in the agent image; `jq` is not
installed). Shared helpers live in `_lib.sh`.

## The read-only git-remote (the one deviation)

`developer-implement.sh` does a **real** branch + commit in the workspace clone,
but the **push is best-effort / skipped**: the #667 in-stack git-remote is
read-only dumb-HTTP by design (`docker-compose.e2e.yml` mounts it `ro`, served
by `python -m http.server`), so an anonymous push cannot succeed there today.
No label-chain assertion depends on a shared push — the branch/commit are real,
and the PR + labels + events (the asserted hops) live in fake-github. Making the
remote writable (smart-HTTP or git-daemon + a writable mount) is a separable
infra follow-up.

## Files

| File | Role |
|---|---|
| `_lib.sh` | Shared helpers (repo resolution, event-field extraction, curl wrappers). Sourced, not executed. |
| `ba-create-issue.sh` | BA: create the IBAN issue on fake-github (woken by the human DM). |
| `developer-implement.sh` | Developer: branch/commit + open PR + `ready-for-review` (woken by `ready`). |
| `reviewer-approve.sh` | Code Reviewer: comment + `ready-to-merge` (woken by `ready-for-review`). |
| `iban-story.fixtures.json` | The rule set wiring prompt markers → replies + playbooks. |

`$AEE_FAKE_CLAUDE_FIXTURES` and `$AEE_FAKE_CLAUDE_PLAYBOOKS` are set stack-wide on
the orchestrator in `docker-compose.e2e.yml` (spread into every agent
container). The rule `match` strings are specific to the derived channel-trigger
prompts, so non-IBAN agents/tests fall through to the default reply unchanged.
