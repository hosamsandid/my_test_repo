# Internal channels — retired

> Status: **retired by #2578.** This concept (epic #1172, phases #1173–#1175)
> described an opt-in `transport: 'internal'` delivery for label hand-offs:
> the producer ran `aee-emit`, `POST /internal/flow-emit` queued the consumer
> directly, the GitHub poller ignored that listener, and the label on GitHub was
> only mirrored as decoration. The whole path — `aee-emit`, `/internal/flow-emit`,
> `orchestrator/flow-emit.js`, the channel/trigger `transport` field, the edge
> dialog's *Delivery* choice and the dotted internal-edge style — has been
> removed. The original text is in git history.

## Why it was retired

Two delivery models for one visible artifact (the label) cost more than they
saved:

- An internal listener was **deaf to GitHub**. A human re-applying the hand-off
  label by hand — the obvious, intuitive action — woke nobody, even though the
  trigger's `labelFilter` clearly matched.
- Internal wakes **diverged from what GitHub showed** and were missing from the
  GitHub Event Log's fan-out, so nobody could tell from the config or the log why
  a matching agent never fired.

## What replaces it

Every labelled hand-off is an ordinary poller-delivered `github-event` trigger:

- The producing agent applies the label on GitHub (`gh issue edit --add-label` /
  `gh pr edit --add-label`); the GitHub poller delivers it to every matching
  listener and records it in the GitHub Event Log.
- Latency is **up to one poll interval (~30 s)**.
- The label on GitHub is the **single source of truth**: a label a human applies
  or re-applies on GitHub wakes the listener exactly like an agent-applied one.
- Loop protection, the self-claim-label dedup, wake-edge dedup, throttle and
  burst digest apply unchanged.

Unaffected features that merely share the word "internal": the #1858 label
fast-path (`POST /internal/github-label-applied`, used by the GitHub Issues
plugin and the Flow Supervisor, with its `internal-dedup` drop reason) and direct
agent hand-offs (`aee-wake`, `POST /internal/wake-agent` — see
`docs/direct-agent-handoff-concept.md`).

## Migration

A legacy `transport` key on a channel port, trigger, bundle or template is
ignored on import (dropped, not rejected). On startup the admin API sweeps every
agent once, drops `transport` from its `channels[]` and `triggers.json`, and
re-renders the affected teams' derived listeners and `## Outcomes` prompt
blocks, so no agent is still told to run `aee-emit`.
