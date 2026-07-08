# Process Template bundle format

A **process template** is a portable, git-committable JSON description of a
modeled agent orchestration — the export/import format of the **Process Canvas**
(Admin Console → *Process Canvas*). It captures *what the roles are and how they
are wired*, deliberately **not** secrets, repos, or Matrix identities (those are
supplied when the bundle is materialised into a real team).

It is the machine-readable sibling of the `agent-studio/` reference concept: one
manifest holding every role's persona prompt, its triggers (with the declarative
`emits` that draw the hand-off edges), the human gates, and the label registry.

## Producing / consuming

| Action | Where | Endpoint |
|---|---|---|
| Export | Process Canvas → **Export** | `GET /api/process/template?team=<id>` or `?templates=1` |
| Preview (render) | Process Canvas → **Import** | `POST /api/process/graph` `{ processTemplate }` |
| Materialise into a team | Process Canvas → **Materialize as team…** | `POST /api/teams` `{ teamId, teamName, repository, githubTokenId, processTemplate }` |

`POST /api/teams` accepts the bundle under `processTemplate` (or the equivalent
`customRoles` pseudo-template array). Inline roles are materialised by the same
env → team → members pipeline (with rollback) the Team-Setup wizard uses; each
role's `{{vars}}` and the target repo are applied per member.

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
      "github": { "producesPr": true, "producesIssue": false },  // GitHub outputs (#380)
      "channels": [                          // PR/issue channels this role consumes (#380)
        { "artifact": "pr", "from": "developer", "label": "approved", "gate": "human" }
      ],
      "triggers": [
        {
          "id": "developer-assigned",
          "type": "github-event" | "cron" | "once" | "http",
          "enabled": true,
          "events": ["issues.labeled"],   // github-event
          "labelFilter": "assigned:{{agentId}}",
          "cron": "5 3 * * 1",            // cron
          "at": "2026-01-01T00:00:00Z",   // once
          "emits": ["started:{{agentId}}"],  // labels this run sets → outbound edges
          "description": "…",
          "prompt": "…"                   // the trigger prompt (rendered per member)
        }
      ]
    }
  ],
  "gates":  [ { "label": "human:fdd-approved" } ],
  "labels": [ { "name": "stage:fdd", "humanGate": false, "brake": false } ]
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
  the git-committed **artifact manifest** (`.aee/artifacts.jsonl`, written by the
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
- In the Flow editor the *Dependency* and *Data flow* connect actions are unified
  into one "Data flow / hand-off" dialog: give it an artifact **name** for a data
  hand-off, or leave name+path empty for a plain dependency.

### Notes & invariants

- **Wiring is `emits` ↔ `labelFilter`.** An edge *A → label L → B* exists when a
  trigger of role `A` lists `L` in `emits` and a trigger of role `B` filters on
  `L` (`labelFilter`). Raw events (no `labelFilter`) are external triggers, not
  hand-offs.
- **GitHub channels (#380) are declarative ports.** `github.{producesPr,producesIssue}`
  marks what a role opens (drives the node badge/ports and appends the producer
  instruction block to its prompt at materialise). A consumer's `channels` entry
  `{artifact, from, label?, gate?}` declares *A opens a PR/issue that wakes B* —
  optionally only when `label` is present, and `gate: "human"` means a **human**
  applies that label (the inline approval gate on the edge). At materialise (and
  on live edits, via `reconcileTeamGithubChannels`) `expandGithubChannels` derives
  the consumer's github-event trigger (`<consumer>-on-<artifact>-<producer>`,
  marked `channel: true`) from the port — the derived triggers are **not** stored
  in the portable bundle, only the ports. This supersedes the old
  `kind: "pr-review"` construct; legacy `pr-review` roles are normalised onto
  channels on import (`normalizeLegacyReview`).
- **Gates & brakes are never emitted by agents.** `human:*` gate labels and the
  brakes (`hold`, `needs:human`) only ever appear as a *listener* `labelFilter`;
  an agent that declares them in `emits` is flagged `gate-violation` by the lint
  layer. The materialiser/canvas wires them listener-only.
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
