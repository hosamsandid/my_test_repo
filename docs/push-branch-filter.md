# Push trigger branch filter

A `github-event` trigger that listens on `push` may carry an optional
`branchFilter` (#2570) so it only wakes for pushes to some branches. Set it in
Agent Chat → **Triggers** → the trigger form's **Branches** field, which appears
when the event is *Push*.

> Kept out of `docs/triggers.md` on purpose: that file is vendored into the
> helper-chat corpus, which is at its size budget. `triggers.md` links here.

## Format

- Stored on the trigger as an array of patterns: `"branchFilter": ["main", "feature/*"]`.
  An agent hand-editing its own `triggers.json` may also write a comma-separated
  string (`"main, feature/*"`); the poller splits it the same way.
- The form takes a comma-separated list. Entries are trimmed; empty entries and
  duplicates are dropped.
- **Absent, empty, or only commas/whitespace = every branch.** Every trigger
  created before this feature has no filter and is unchanged.

## Matching

A push fires the trigger if its branch matches **any** entry.

| Pattern | Matches | Does not match |
|---|---|---|
| `main` | `main` (exact, case-sensitive) | `Main`, `main-2` |
| `feature/*` | `feature/login` | `feature/login/v2`, `feature` |
| `feature/**` | `feature/login`, `feature/login/v2` | `feature` |
| `release-*` | `release-1.2`, `release-` | `release/1.2` |
| `*` | any branch without a `/` | `feature/x` |

- `*` matches any characters except `/`; `**` matches any characters including `/`.
- Every other character is literal, including `?`, `[` and `!`.
- Tag pushes (`refs/tags/…`) never match a non-empty filter.
- Branch deletes and force-pushes are matched by branch name like any push.
- The synthesized push derived from a same-repo `pull_request.opened` is
  matched on the PR's head branch.

## Where it applies

- Only to the `push` event. A (legacy) trigger that lists other events too keeps
  firing on those regardless of the filter.
- The poller checks it before the agent wakes and before the throttle and burst
  digest, so a non-matching push costs no run and a digest only contains
  matching pushes.
- A non-matching push is logged in the GitHub Event Log as dropped
  (`branch-filter`); the Agent Chat **Events** tab names the branch, e.g.
  "Branch 'agent-knowledge' is not in this trigger's branch filter".
- The trigger card reads e.g. *Push · branches: main, feature/\**.

## Validation

The console rejects (and the agent runtime flags as a one-time advisory on a
hand-edited `triggers.json`) entries that can never name a branch: whitespace
or control characters, a leading or trailing `/`, `//`, or `***`.

## Implementation

`orchestrator/branch-filter.js` holds the matching rule used by the poller and
the pending-queue reassign. Mirrors that must stay in sync:
`admin-console/api/branch-filter.js` (write validation and normalization),
`admin-console/src/pages/agent-chat/branch-filter.js` (form and card) and
`_branch_filter_error` in `agent-image/scripts/agent-entrypoint.py`.
