# 03 — Agent Team wizard

**Scope:** `/team-setup` (alias `/wizard/team`), steps Process → Working
Environment → Team → Knowledge → Review, streamed creation progress, rollback on
failure; `/quickstart`; **Add member** on an existing team.

**Preconditions:** at least one model provider; an environment/template with a
repository the tester may clone (team creation requires a repo).

## Persona matrix

| Action | Member | Team Admin | Outsider | System Admin |
|---|---|---|---|---|
| Start wizard (self-service) | yes | yes | yes | yes |
| Pick an existing env | only envs visible to them | own team's | own | all |
| Becomes Team Admin of the new team | yes | yes | yes | yes |

## Probes

- Walk every step forward and backward; does data survive back navigation and a
  page reload mid-wizard?
- Each gallery (templates/drafts) with zero, one, many entries; long names.
- Env step: repo-less env (must be non-selectable, explained), invalid repo URL,
  unreachable repo, credential missing → error at which step?
- Team step: duplicate team id, id collision with an existing agent,
  `labelSuffix`, zero roles, many roles, very long role names/prompts.
- Knowledge step: grant skills/plugins; verify they arrive on every member.
- Submit and **force a failure** mid-stream (e.g. unreachable repo): is the
  rollback complete (no orphan agents/rooms/containers) and is the error readable?
- Double-click submit; close the tab during the stream and come back.
- No model provider configured → wizard blocked with an explanation.
- `/quickstart`: same probes in the short form.
- Add member to an existing team: prompt modes (Inherit/Additional/Exclusive),
  skill/MCP overrides.

## Risk spots

- `POST /api/teams`, `/api/teams/stream`, `resolveTeamMemberVars` in
  `admin-console/api/api.js` (three mirrored repo-requirement sites).
- `team-provider-check.js`, `agent-id-resolution.js`.

## Cleanup

Delete the `uitest-` team (cascades to members); verify no orphan containers,
environments or rooms remain.
