# 02 — Credentials

**Scope:** `/ssh-keys`, `/github-tokens`, `/plugin-tokens`, redirect
`/my-credentials` → `/ssh-keys`, credential selection in the team's Working
Environment, rotation.

**Preconditions:** a `uitest-` team. No real GitHub PAT is needed for most
probes; use obviously fake values (`uitest-fake-…`). A real token only via env
var and only for read probes.

## Persona matrix

| Action | Member | Team Admin | Outsider | System Admin |
|---|---|---|---|---|
| Create personal key/token | yes | yes | yes | yes |
| See another user's personal credential | never | never | never | **never** (no break-glass) |
| Create team-tier credential | no | own team | no | yes |
| Create system-tier credential | no | no | no | yes |
| Rotate | own | own + team | own | all non-personal |

## Probes

- Create SSH key: generated vs pasted; malformed key; duplicate name; is only the
  fingerprint returned (check API response too)?
- GitHub token: empty, whitespace, invalid format, revoked token — what is
  validated when, and how is failure shown?
- Plugin tokens: add/edit/delete a personal Jira token; warning when the team
  site is not set; token for a plugin not granted to any of the user's teams.
- Scope/tier: switch tier in the form, check list filtering per persona, check
  dropdowns in the environment form only offer usable credentials.
- Rotation: rotate a credential in use by a running `uitest-` agent — agent
  respawns and keeps working; what does the UI say during it?
- Delete a credential that an environment still references — blocked, warned,
  or silently dangling?
- Secrets never appear in: page source, API list responses, audit log, error
  messages, browser console.

## Risk spots

- `orchestrator/resource-tier.js`, `credential-resolution.js`
  (attributed-write refusal HTTP 424), rotation endpoints
  `POST /api/{ssh-keys,github-tokens}/:id/rotate`.

## Cleanup

Delete every `uitest-` key/token; verify the environment no longer references it.
