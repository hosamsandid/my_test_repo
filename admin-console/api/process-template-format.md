# Process Template bundle format

A **process template** is a portable, git-committable JSON description of a
modeled agent orchestration — the export/import format of the **Process Canvas**
(Admin Console → *Process Canvas*). It captures *what the roles are and how they
are wired*, deliberately **not** secrets, repos, or Matrix identities (those are
supplied when the bundle is materialised into a real team).

It is the machine-readable sibling of the `agent-studio/` reference concept: one
manifest holding every role's persona prompt, its structured **`outcomes`** port
(the labels it sets and the conditions under which it sets them — these draw the
hand-off edges), its triggers, the human gates, and the label registry.
(`outcomes` supersedes the old flat `emits` list, retired in #831; legacy bundles
that still carry `emits` are lifted transparently on read.)

## Producing / consuming

| Action | Where | Endpoint |
|---|---|---|
| Export | Process Canvas → **Export** | `GET /api/process/template?team=<id>` or `?templates=1` |
| Preview (render) | Process Canvas → **Import** | `POST /api/process/graph` `{ processTemplate }` |
| Materialise into a team | Process Canvas → **Materialize as team…** | `POST /api/teams` `{ teamId, teamName, repository, githubTokenId, processTemplate, labelSuffix?, materializeMembers? }` |

`POST /api/teams` accepts the bundle under `processTemplate` (or the equivalent
`customRoles` pseudo-template array). Inline roles are materialised by the same
env → team → members pipeline (with rollback) the Team-Setup wizard uses; each
role's `{{vars}}` and the target repositories are applied per member.

**`labelSuffix` (optional, 1–8 chars of `[a-z0-9]` with single inner hyphens — `k3f9`, `team-1`, `pre-prod`; a leading/trailing/doubled hyphen is rejected because it would yield `ready--x` / `ready-x-`).** When two or more teams share one GitHub repository, their label-based hand-offs would collide. Pass a short suffix (e.g. `"abc1"`) to stamp every label token — trigger `labelFilter`, channel `label`, `setLabel` outcome actions, bundle label registry, and prompt text — before any agents are created. `GET /api/teams/suggest-suffix` returns a random 4-char suggestion. In extend mode the suffix must match the stored one (400 on mismatch). Warnings are returned for any label mention in prompt text that could not be stamped automatically (`suffixWarnings` in the stream response). Omit when the team is the sole tenant on its repository.

**`materializeMembers` (optional, default `true`).** How far each new member is taken. `true` (or omitted) provisions every member immediately — Matrix user, workspace seed, repository clone, running container — and pre-creates its DM room. `false` creates each member as a **stub** instead: its config and `triggers.json` are written, but there is no Matrix user, no workspace and no clone, so it appears as *Not initialised* and is fully provisioned when it is enabled. Only the members are affected; the shared environment and the team agent are created either way, and label-suffix stamping plus custom-role resolution happen before the member loop, so they apply to stubs identically. In `mode: "extend"` the flag applies to the newly created members only. Read as `!== false`, so any other value means materialize-now. The same field is accepted by `POST /api/teams/stream`, which is the endpoint both launch surfaces actually submit to, and both echo the mode they ran in back as `materialized`.

## Schema (`processTemplateVersion: 1`)

```jsonc
{
  "processTemplateVersion": 1,
  "name": "Accessio Lifecycle",
  "level": "live" | "template",          // informational (source of the export)
  "roles": [
    {
      "id": "developer",                  // role key (team prefix stripped on export)
      "displayName": "Developer",
      "role": "team-member",
      "sessionPolicy": "persistent" | "per-invocation",
      "systemPrompt": "You implement issues…",
      "outcomes": {                          // structured successor to flat emits (#827/#831)
        "mode": "exactlyOne",                //   "exactlyOne" (switch) | "anyOf" (zero or more per run)
        "options": [
          { "id": "accepted", "title": "Accepted", "when": "Review clean",
            "actions": [ { "type": "setLabel", "label": "ready-to-merge" } ] },
          { "id": "revisions", "title": "Revisions required", "when": "Issues found",
            "actions": [ { "type": "setLabel", "label": "revisions-required" } ] }
        ]
      },
      "github": { "producesPr": true, "producesIssue": false },  // GitHub outputs (#380)
      "channels": [                          // PR/issue channels this role consumes (#380)
        { "artifact": "pr", "from": "developer", "label": "approved", "gate": "human",
          "wakePrompt": "…",               // optional authored wake-prompt override (#868)
          "autoClaim": false }             // opt out of auto-derived claim (#958); default ON for labelled channels
      ],
      "triggers": [
        {
          "id": "developer-assigned",
          "type": "github-event" | "cron" | "once" | "http",
          "enabled": true,
          "events": ["issues.labeled"],   // github-event
          "labelFilter": "assigned:{{agentId}}",
          "claim": { "remove": "assigned:{{agentId}}", "add": "assigned:{{agentId}}:wip" }, // optional; add MUST be <labelFilter>:wip (#958)
          "cron": "5 3 * * 1",            // cron
          "at": "2026-01-01T00:00:00Z",   // once
          "description": "…",
          "prompt": "…"                   // the trigger prompt (rendered per member)
        }
      ]
    }
  ],
  "gates":  [ { "label": "human:fdd-approved" } ],
  "labels": [ { "name": "stage:fdd", "humanGate": false, "brake": false } ],
  "humans": [                              // named human roles (#987) — optional
    {
      "id": "issue-reviewer",
      "name": "Issue Reviewer",
      "description": "Triages incoming issues",   // optional
      "stage": "triage",                           // optional — joins the layered layout
      "emits": ["dispatch"],                       // labels this person applies (implicitly gates)
      "consumes": [                                // what lands with the person
        { "artifact": "issue", "from": "business-analyst" }, // an issue they review
        { "label": "human-decision-required" },              // a brake they decide on (or a plain notification if not flagged brake)
        { "artifact": "file", "name": "risk-report" }        // a data-flow output they read
      ]
    }
  ],
  "hillClimb": {                          // OPTIONAL — hill-climb metrics collector + card config (#1222/#1224)
    "autonomy": 2,                        // 0–3, default 2; 0 = collector-only (no improvement cards) (#1224)
    "cron": "0 2 * * *",                  // override daily sweep schedule (default: daily)
    "windowDays": 7,                      // rolling window for ratio metrics (default 7)
    "minRunsPerWindow": 20,               // below this, snapshot is flagged `insufficientData` (default 20)
    "maxCardsPerPass": 5,                 // max improvement cards raised per pass (default 5) (#1224)
    "excludeAgents": ["agentId"]          // agent ids excluded from the metrics pass
  }
}
```

### Data-flow hand-offs (artifacts & dependencies)

Besides label choreography, a role may declare **data-flow ports** — the second
way two agents are wired in the Flow editor. These are optional arrays on a role:

```jsonc
{
  "id": "developer",
  "outputs": [ { "name": "Java sources", "hint": "src/**", "description": "…" } ],
  "inputs":  [ { "name": "Functional Design", "hint": "designs/**" } ],
  "dependsOn": [ "business-analyst" ]   // ordering only, no artifact
}
```

- **Artifacts are matched by logical `name`, not by path (#382).** A producer's
  `outputs` entry connects to a consumer's `inputs` entry when their **names**
  match. The `hint` is an informational path only — agent instances write to
  paths that vary per run, so the physical location is resolved at runtime from
  the git-committed **artifact manifest** (`.agent-studio/artifacts.jsonl`, written by the
  producer via `aee-artifact add "<name>" <path>` and read by the consumer via
  `aee-artifact path "<name>"`). A port with only a `path` (BriefingPack
  artifacts, legacy ports) still matches by path exactly.
- **`dependsOn`** is the degenerate case — an ordering edge with no artifact.
- **These ports are the single source of truth.** At materialise time
  (`expandDataFlowSteps`) and on every live edit (`reconcileTeamDataFlow`) each
  matched producer→consumer pair derives one `github-event`/`push` trigger
  `<consumer>-on-push-<upstream>` (`dataFlow: true`) that **wakes** the consumer
  when the upstream pushes. It is a notification, **not** a start-gate: nothing
  blocks the consumer from running before that. The derived trigger's prompt
  tells the consumer to `git pull` and resolve its inputs from the manifest.
- **Optional `wakePrompt` override (#868).** A `channels[]` entry and a data-flow
  `inputs[]` entry may each carry an optional `wakePrompt` string. When present
  (non-blank) it is carried verbatim into the regenerated derived trigger's
  `prompt`, replacing the auto-generated wake text; blank/absent keeps the
  generated default. On a consolidated listener (several channels, or several
  inputs from one upstream, collapse into one trigger) the first non-empty
  override in port order wins.
- In the Flow editor the *Dependency* and *Data flow* connect actions are unified
  into one "Data flow / hand-off" dialog: give it an artifact **name** for a data
  hand-off, or leave name+path empty for a plain dependency.

### Outcomes — structured successor to `emits` (#827)

A role may carry a first-class **`outcomes`** port — the structured successor to
the flat `emits` list (concept `docs/agent-outcomes-concept.md` §3/§5.1/§7). It
describes *which signals the agent sets and when*: a code reviewer's *accepted*
vs *revisions required*, a dispatcher's *route to Developer 1 / 2 / hold*.

```jsonc
{
  "outcomes": {
    "mode": "exactlyOne",              // switch — exactly one option per run | "anyOf" — zero or more
    "options": [
      {
        "id": "to-developer",          // stable slug, unique within the role
        "title": "Route to Developer", // display name (optional)
        "when": "Frontend task, or Dev 2 at capacity",  // human-readable condition (optional, {{var}}-substituted)
        "actions": [ { "type": "setLabel", "label": "ready-{{stagePrefix}}" } ],
        "notify": "dm"                 // optional: post a DM summary when this outcome is chosen
      },
      { "id": "hold", "title": "Hold", "when": "Ambiguous", "actions": [ { "type": "none" } ] }
    ]
  }
}
```

- **Action types.** `setLabel` (apply a GitHub label — `label` required),
  `openPr`, `openIssue` (absorb `github.producesPr/producesIssue`),
  `wakeAgent` (hand off directly to another role — see below), `none`
  (terminal, no outbound signal). An option may carry several actions.
- **Validation.** `mode` must be `exactlyOne` | `anyOf`; option `id`s are unique;
  action types must be known; a `setLabel` label may **not** be a label the
  bundle's `labels[]` registry flags `humanGate` (or that a channel gates with
  `gate: 'human'`) — same rule as `gate-violation`. A `brake` label *is* allowed:
  a brake pauses the loop and is agent-applied (#928).
  `exactlyOne` with fewer than two options is valid (a phase-5 lint, not an error).
- **`{{var}}` substitution** applies to `label`, `when` and a `wakeAgent`'s
  `note` at materialise time, exactly like trigger fields. A `wakeAgent`'s `to`
  is **not** substituted — it is a role reference, remapped instead (below).
- **Supersedes `emits` (#831).** The flat `emits` field is retired. All shipped
  templates carry `outcomes`; no `emits` field appears in newly exported bundles.
  Old bundles that carry `emits` still import correctly: `buildProcessTemplate`
  lifts them to a degenerate `anyOf` port on export, and the graph builder
  (`liftOutcomes`) derives byte-identical edges from them on read. `PUT /api/agents/:id`
  also lifts a legacy `emits` input to outcomes on write. The process editor no
  longer exposes a flat-emits surface.
- **Graph edges** are keyed by outcome: a `setLabel` action's label drives the
  same `emits ↔ labelFilter` edge (now tagged with the `outcome` id when
  authored); `openPr`/`openIssue` fold into the github produce flags.
- **Declarative only** (concept decision 4) — outcomes have no runtime effect in
  this phase; the agent still sets its own signals. Prompt synchronisation is a
  later phase.

### `wakeAgent` — direct agent-to-agent hand-off (#2030)

A `wakeAgent` action wakes a wired **same-team** role *inside the platform*: no
label to invent, no issue or PR to hang it on, no GitHub trace. Use it for pure
coordination that has no natural home on a work item; keep `setLabel` when a
human tracks the state on the issue/PR (concept
`docs/direct-agent-handoff-concept.md` §11). The two compose — they may sit in
the same option.

```jsonc
{
  "id": "hand-to-reviewer",
  "title": "Hand off to Code Reviewer",
  "when": "Implementation is complete and the tests are green",
  "actions": [
    { "type": "openPr" },
    { "type": "wakeAgent", "to": "code-reviewer",
      "note": "Look closely at the migration in step 3." }
  ]
}
```

- **`to`** (required, non-empty string) — a **role id in this bundle**. Remapped
  to a member id at materialise (`<teamId>-<roleId>`) and back to the role key on
  export, exactly like a channel's `from`, so a bundle stays portable. *Known
  limitation, shared with `parent` / `dependsOn` / `channels[].from`:* a role
  materialised with `count > 1` becomes `<teamId>-<roleId>-<i>`, so a `wakeAgent`
  naming it resolves to nothing and the hand-off answers `404 unknown-target` —
  do not target a multi-instance role until routing for it is defined.
- **`note`** (optional string) — one sentence of context for the peer. Capped at
  **1024 characters**; a longer note is **truncated with a marker, not rejected**.
  It reaches the consumer as **untrusted context** inside an
  `<external-agent-handoff>` envelope, never as its instruction — the consumer
  runs its own configured wake instruction.
- **Validation** (five rules): `to` present and non-empty; `to` names a role that
  exists in the bundle/team; `to` is not the producing role itself; `to` does not
  resolve outside the producer's team; `note`, when present, is a string.
- **It is not a label.** `to` is a role id, so the `labelSuffix` stamper never
  touches it — stamping it would break every hand-off in a suffixed team.
- **Delivery.** The producing agent runs `aee-wake --to <roleId> [--note "…"]`
  (projected into its generated `## Outcomes` block), which POSTs
  `/internal/wake-agent`; the orchestrator resolves + authorizes the target and
  enqueues a `kind: "wake-agent"` entry in its `pending-triggers.json`. Latency
  is ≤ 5 s (the target polls; there is no poke), the entry is durable while the
  target is disabled or in maintenance mode, and one `source: "internal"`
  event-log row is written per hand-off — that log is the audit trail, because
  nothing appears on GitHub.
- **Consumer side — derived, not authored (#2031).** The target needs a listener
  carrying the wake instruction: `{ "id": "…", "type": "wake-agent",
  "prompt": "…" }` in its `triggers.json`. Nothing schedules a trigger of this
  type and the poller never subscribes to it — it fires only from the queue.
  `expandWakeHandoffs` derives it from the producers' `wakeAgent` actions, the
  way `expandGithubChannels` derives a label listener: stamped
  `wakeHandoff: true` (the marker that makes it strippable and regenerable),
  `id` = `<consumerId>-on-handoff`, and `sources` recording which producers hand
  off to it — informational only, like a channel trigger's. It carries no
  `events`, `labelFilter`, `claim`, `transport` or `activatedAt`: there is no
  GitHub event behind it, no label to claim, it is internal by construction, and
  nothing polls it so there is no history horizon to preserve.
  **Exactly one per consumer**, not one per producer or per outcome — the
  producer cannot know the consumer's trigger id, so none is stamped on the queue
  entry and the target's runner takes the first enabled `wake-agent` trigger it
  finds; a second would be authored, materialised and never fire. A
  **hand-authored** listener (one without the `wakeHandoff` marker) is therefore
  left alone and suppresses the derivation for that role.
- **Same team only**, and stricter than the internal label channel (which has no
  team gate): a cross-team `to` is refused with `403 cross-team` at delivery. The
  check is an **integrity constraint on the flow graph, not authentication** —
  the `:4002` internal API is unauthenticated and the producer's identity is
  self-asserted (concept §6.1).

### Notes & invariants

- **Wiring is `outcomes` ↔ `labelFilter`.** An edge *A → label L → B* exists when
  a `setLabel` action in role `A`'s `outcomes` port names `L` (#831), and a
  trigger of role `B` filters on `L` (`labelFilter`). Raw events (no `labelFilter`)
  are external triggers, not hand-offs. Legacy bundles carrying a flat `emits`
  field still work — labels are lifted to a degenerate `anyOf` outcomes on read
  (`liftOutcomes`); a per-trigger `emits` variant (removed in #783) is also lifted.
- **GitHub channels (#380) are declarative ports.** `github.{producesPr,producesIssue}`
  marks what a role opens (drives the node badge/ports and appends the producer
  instruction block to its prompt at materialise). A consumer's `channels` entry
  `{artifact, from, label?, gate?, transport?}` declares *A opens a PR/issue that wakes B* —
  optionally only when `label` is present, and `gate: "human"` means a **human**
  applies that label (the inline approval gate on the edge). At materialise (and
  on live edits, via `reconcileTeamGithubChannels`) `expandGithubChannels` derives
  the consumer's github-event trigger (`<consumer>-on-<artifact>[-<label>]`,
  marked `channel: true`) from the port — the derived triggers are **not** stored
  in the portable bundle, only the ports. Channels from **several producers** that
  resolve to the same `(events, labelFilter)` collapse into **one** derived
  listener (#826) — the poller has no origin filter, so per-producer triggers were
  functionally identical; the contributing producers are recorded on the trigger's
  informational `sources: [producerId, …]` (no runtime meaning). Two triggers of
  one agent sharing `(events, labelFilter)` — e.g. a hand-authored trigger left
  beside a derived one — raise the advisory `duplicate-listener` lint. This
  supersedes the old `kind: "pr-review"` construct; legacy `pr-review` roles are
  normalised onto channels on import (`normalizeLegacyReview`).
  **`transport: 'internal'` (#1194):** a labelled, non-human channel port may carry
  `transport: 'internal'` to opt its derived `<artifact>.labeled` listener into direct
  delivery (poller-excluded, woken by `aee-emit`). Listeners over a consolidated
  `(artifact, label)` group go internal only when **every** contributing channel opted
  in — a lone poller producer keeps the whole listener on the poller. Unlabelled
  channels (`*.opened`) and `gate: 'human'` channels stay poller-delivered. Concept:
  `docs/internal-channels-concept.md` §4.6.
- **Gate-ness is configuration, not a naming convention (#928).** `labels[]` is
  the authoritative registry: `humanGate: true` makes a label a human approval
  gate, `brake: true` makes it pause the loop — whatever the label is *called*.
  A channel's `gate: 'human'` gates its routing label the same way. The retired
  `human:*` prefix and the hardcoded `hold`/`needs:human` brakes carry no meaning
  of their own; a label with no flag is a plain agent label. Consumers thread the
  registry into the graph builders (`buildProcessGraph(agents, { labels })`), so a
  bundle that drops a flag silently loses that gate.
- **Human gates are never emitted by agents.** A `humanGate` label only ever
  appears as a *listener* `labelFilter`; an agent that declares it in `emits` is
  flagged `gate-violation` (error), and in an `outcomes` `setLabel` action
  `human-label-as-outcome` (error). The materialiser/canvas wires it
  listener-only. A `brake` label is the deliberate exception — an agent may set it
  to pause the loop pending a human decision.
- **Named human roles are first-class flow nodes (#987).** The optional top-level
  `humans[]` declares people who act in the flow (an *Issue Reviewer*, a *Tech
  Lead*) as named `kind: 'human'` boxes — purely declarative, they never
  materialise into an agent and add no trigger (a `triggers.json` stays
  byte-identical when only `humans[]` changes). A label a human `emits` is
  *implicitly a gate* (an agent emitting it is a `gate-violation`); its `consumes`
  bind the generic-`@human` gate/brake/delivery touchpoints (#981) to the named
  node — `{ label }` a brake they decide on **or** (when the label is not flagged `brake`) a plain delivery — they are notified when the label is set (a touchpoint, no blocking); `{ artifact:'pr'|'issue', from }` an
  artifact they review; `{ artifact:'file', name }` a data-flow output they read.
  First matching human in `humans[]` order wins a binding; a label emitted by two
  humans draws both edges. The generic `@human` hub is GONE (#987 supersedes the
  #981 actor): a gate/brake/delivery with no human role wired stays UNBOUND — its
  edge endpoint is `null` (dropped by the renderer, no hub box) plus an advisory
  `unbound-gate`/`unbound-brake`/`unbound-delivery` info lint — while still listing
  as an unassigned touchpoint. Persisted on the team agent like `stages`/`labels`;
  round-trips through export → materialise and Edit-as-draft. Threaded into the
  graph builders as `buildProcessGraph(agents, { labels, humans })`.
- **Preset conventions are enforced (#1008).** Shipped presets (the registry
  bundles here and the agent-template catalog) carry the same wiring conventions
  the engine writes: every `github-event` trigger has exactly **one** event
  (`rawTriggerError` — the strict bundle validator now rejects multi-event
  triggers at materialise; drafts stay saveable for the migration flow), every
  label listener **claims** its wake label (`{ remove: <label>, add:
  "<label>:wip" }`), and every produced artifact either has an in-flow consumer
  or is a **declared** open end (`terminal: true` / `external: {note}` on the
  outcome, or a human delivery via `prAudience`/`issueAudience: 'human'` +
  `humans[].consumes`). The registry CI guard
  (`process-template-registry.test.js`) fails on violations: error/warning
  lints plus `raw-trigger-nonconformant`, `unclaimed-listener` and
  `producer-unconsumed`. Derived `channel:true`/`dataFlow:true` triggers are
  engine-owned and exempt from the raw-trigger lint — if a derivation deviates,
  the fix belongs in the expander, not per team. The Flow-Weaver emits
  conformant bundles by construction (single-event feedback listeners, claims
  at its choke point, open-end deliveries on compensated terminal roles, and —
  when the weave is given `options.humans` — reviewer bindings on its
  human-gated stage boundaries).
- **No team-specifics in the bundle.** `repo`, credentials and Matrix tokens are
  intentionally excluded; they are bound at materialise time.
- **Stability.** The format is versioned. Bumping shape ⇒ bump
  `processTemplateVersion` and keep the importer backwards-compatible.

Pure builders/validators live in `admin-console/api/process-template.js`
(`buildProcessTemplate`, `validateProcessTemplate`, `templateToCustomRoles`),
covered by `process-template.test.js`.

## Catalog v2 — typed integration ports on *agent* templates (#420)

Distinct from the process-template bundle above, the **agent-template catalog**
(`orchestrator/skill-pool/agent-templates/*.json`) carries additive,
backwards-compatible fields that make catalog roles composable by the
Flow-Weaver (#421) instead of being hard-wired to the dispatcher pattern:

```jsonc
{
  "patternRole": "author",              // scout | author | companion | intake | standalone
  "stageAffinity": ["Build"],           // grouping hint for the wizard's stage picker
  "ports": {
    "consumes": [ { "artifact": "pr", "fromSlot": "stage-author" } ],
    "produces": { "pr": true }          // defaults from the template's `github` flags
  },
  "triggers": [ { "id": "self-curation", "intrinsic": true, ... } ]
}
```

- **`patternRole`** places the role in the reduced per-stage pattern
  *Scout (gap + evidence) → Author → Companion (review, feedback, escalation)*;
  `intake` marks pipeline entry roles (Business Analyst, Issue Triage) and
  `standalone` (the default) everything else.
- **`ports.consumes`** uses abstract slots — `stage-entry` (the hand-over issue
  from the previous stage) and `stage-author` (the stage Author's PR) — never
  concrete role ids or label names. The weaver binds slots at composition time
  and generates the concrete labels (`<stagePrefix>:author-go`, …).
- **`intrinsic: true`** on a trigger marks it as part of the role's essence
  (Issue Triage's `issues.opened`, self-curation crons). The weaver keeps
  intrinsic triggers and **drops** everything else (dispatcher wiring like
  `assigned:{{agentId}}`); the legacy wizard path always uses all triggers.
- The generic pattern trio ships as catalog entries `scout`, `stage-author`,
  `stage-companion` (`category: "pattern"`, `defaultEnabled: false`) with
  `{{stageName}}` tokens the weaver resolves at weave time.

Normalisation (defaults, validation, slot filtering) lives in
`admin-console/api/catalog-ports.js` (`normalizeTemplatePorts`,
`intrinsicTriggers`), covered by `catalog-ports.test.js`;
`GET /api/agent-templates` returns the normalised surface.
