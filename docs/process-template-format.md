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
      "triggers": [
        {
          "id": "developer-assigned",
          "type": "github-event" | "cron" | "once" | "http",
          "enabled": true,
          "events": ["issues.labeled"],   // github-event
          "labelFilter": "assigned:{{agentId}}",
          "from": "any-except-self",
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

### Notes & invariants

- **Wiring is `emits` ↔ `labelFilter`.** An edge *A → label L → B* exists when a
  trigger of role `A` lists `L` in `emits` and a trigger of role `B` filters on
  `L` (`labelFilter`). Raw events (no `labelFilter`) are external triggers, not
  hand-offs.
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
