# Flow Copilot — Studio wiring conventions

Curated addendum embedded into the Flow Copilot system prompt (#1068). The
bundle *format* is defined by the format reference above; this file distills the
Studio's wiring conventions — the rules a generated bundle must follow to be
idiomatic, not merely schema-valid. Keep it short: the server-side validator and
lint gate guarantee correctness; this text raises first-shot quality.

## How agents hand work to each other

Pick the mechanism that matches the hand-off — do not invent extra triggers:

- **GitHub channel** (`channels[]` on the *consumer*): "A opens a PR/issue that
  wakes B". Use for artifact hand-offs (an issue to implement, a PR to review).
  `label` restricts the wake to a labelled artifact; `gate: "human"` means a
  person applies that label (an inline approval gate). Never author the matching
  `github-event` trigger yourself — it is derived from the channel port.
- **Outcome → label listener**: the producer declares a structured `outcomes`
  port whose `setLabel` action names a label; the consumer carries a
  `github-event` trigger with that `labelFilter`. Use for routing decisions
  (accepted vs. revisions-required) and rework loops.
- **Direct hand-off** (a `wakeAgent` action on the producer's `outcomes` port):
  "A is done, B is next, here is a sentence of context". No label, no issue or
  PR, no GitHub trace — the platform's own event log is the audit. Use it for
  pure coordination with no natural home on a work item; prefer a label when a
  person should be able to read the state off the issue/PR. `to` must be
  another role in this same bundle (never the producer itself, never a
  `humans[]` entry — a person has no queue); `note` is optional and short.
  Never author the consumer's listener yourself — it is derived, like a
  channel's.
- **Data-flow ports** (`outputs[]`/`inputs[]` matched by logical artifact name,
  or bare `dependsOn`): use for file hand-offs between workspaces, not for
  GitHub-visible work items.
- **cron / once triggers**: recurring or one-shot schedules, self-loops on the
  agent — not a hand-off mechanism.

## Trigger rules (#1008 — enforced by the validator)

- A `github-event` trigger carries **exactly one** event. Two events = two
  triggers.
- Every label listener **claims** its wake label:
  `"claim": { "remove": "<labelFilter>", "add": "<labelFilter>:wip" }`. The
  `add` label MUST be `<labelFilter>:wip` — nothing else validates.
- Do not author triggers for channels or data-flow inputs — those listeners are
  derived from the ports at materialise time.
- Give each trigger a stable kebab-case `id` (`<role>-on-<what>`) and a
  `prompt`: the wake instruction telling the consumer what to do.

## Gates, brakes and labels are configuration, not names (#928)

- Register every label the flow uses in the top-level `labels[]` registry.
- A **human approval gate** is a label with `"humanGate": true`. Agents never
  set it — no `setLabel` action and no channel may emit it; only listeners and
  `humans[].emits` reference it. A gate needs a *named human* who emits it.
- A **brake** is a label with `"brake": true` — an agent *may* set it to pause
  the loop for a human decision (pair it with a human who `consumes` it).
- Label names carry no semantics: `human:*` prefixes or names like `hold` do
  nothing by themselves.

## Named humans (#987)

People in the flow are entries in the top-level `humans[]` registry — never
roles, never agents. A human's `emits` lists the gate labels they apply; their
`consumes` binds what lands with them: `{ "label": … }` a brake they decide,
`{ "artifact": "pr"|"issue", "from": <roleId> }` an artifact they review,
`{ "artifact": "file", "name": … }` an output they read. Wire every gate, brake
and human delivery to a named human, or the flow reports it unbound.

## Open ends

Every produced artifact either has an in-flow consumer or is a **declared** open
end: mark the flow-ending outcome option `"terminal": true` (the merged PR *is*
the product) or `"external": { "note": "…" }` (a system outside this flow picks
it up), or deliver it to a human (`humans[].consumes`).

## Never include

Repository URLs, branch names, tokens, SSH keys, credential or environment ids,
Matrix identities, or any secret. The bundle describes roles and wiring only —
infrastructure is bound later by a human at materialise time. There is no
envelope: output the bundle fields defined by the format reference and nothing
else.

## Few-shot excerpts

A claimed label listener with a wake instruction:

```json
{
  "id": "reworker-on-revisions-required",
  "type": "github-event",
  "enabled": true,
  "events": ["pull_request.labeled"],
  "labelFilter": "revisions-required",
  "claim": { "remove": "revisions-required", "add": "revisions-required:wip" },
  "prompt": "A reviewer requested changes on this pull request. Read every review comment, resolve each one, push the fixes, then set the `ready-for-review` label."
}
```

A reviewer's routing decision as a structured outcomes port:

```json
{
  "mode": "exactlyOne",
  "options": [
    { "id": "accepted", "title": "Accepted", "when": "All acceptance criteria met",
      "actions": [{ "type": "setLabel", "label": "ready-to-merge" }] },
    { "id": "revisions-required", "title": "Revisions required", "when": "Blocking findings",
      "actions": [{ "type": "setLabel", "label": "revisions-required" }] }
  ]
}
```

A direct hand-off — no label token anywhere, and no listener to author:

```json
{
  "mode": "anyOf",
  "options": [
    { "id": "handed-over", "title": "Handed over", "when": "The migration step is done and the next stage can start",
      "actions": [{ "type": "wakeAgent", "to": "test-designer", "note": "Schema migration is in, the new column is nullable — cover the backfill path." }] }
  ]
}
```

A named human gating a hand-off (the label is registered `humanGate: true`):

```json
{
  "id": "product-owner",
  "name": "Product Owner",
  "stage": "Requirements",
  "emits": ["ready"],
  "consumes": [{ "artifact": "issue", "from": "business-analyst" }]
}
```
