# Team-wide enable/disable

**Date:** 2026-07-31
**Status:** Approved for implementation

## Problem

Agents can be individually enabled/disabled from `/agents` (`AgentRow`'s `ToggleSwitch`, backed by `Orchestrator.enableAgent`/`disableAgent`). There is no way to disable an entire team (all `team-member` agents under a given `role: team` agent) in one action — an operator has to toggle each member one at a time, and there's no way to remember which members were already off on their own versus off only because the whole team was taken down, which matters when the team comes back.

## Scope

- **In scope:** a team-wide disable/enable action in `Orchestrator`, exposed via new internal + public API routes, driven from a new control in `TeamCard` (`admin-console/src/pages/Agents.jsx`). While a team is disabled, its members' individual enable/disable toggle is inert (backend-rejected and UI-greyed).
- **Not in scope:** the team agent (`role: team`) itself has no running process (per architecture docs) — disabling a team never touches a container for the team agent itself, only its members. The member's separate "Deactivate" (reset-to-stub) action is untouched by this feature.

## Data model

- Team agent `config.json` (`role: team`) gains a real `enabled` field, default `true` (absent = enabled, matching the existing convention for other roles). This is the source of truth for "is this team currently disabled".
- Team-member `config.json` gains an optional `disabledByTeam: true` field. Present only on members that the team-disable action itself turned off. Absent on members that were already `enabled: false` before the team was disabled (manual/independent disables, or never-activated stubs).

## Behavior

### Disable team

**`GET /internal/teams/:id/members`** (extend existing member listing, or add if none returns this shape)
Returns each member: `{ id, displayName, enabled, running, busy, activeTriggers }`, so the confirm UI can show what's about to happen and flag anything mid-work.

**`POST /internal/teams/:id/disable`** — body `{ mode: 'drain' | 'abort' }`
1. Set the team config's `enabled: false`.
2. For every member with `enabled !== false`: call the existing `disableAgent(id, { mode })`, then set `disabledByTeam: true` on that member's config.
3. Members already `enabled: false` are left completely alone (no tag written) and recorded in `skipped`.
4. Returns `{ disabled: [ids...], skipped: [ids...], failed: [{ id, error }] }` — same partial-failure shape as `respawnAgentsForEnvironment`, surfaced in the UI per the pattern from `f2063708`.

No busy-agent warning loop per member: the preview step already showed which members are busy, and the operator picked one mode (`drain` or `abort`) up front, applied uniformly — mirroring the `bound-agents` → `respawn-agents` two-step flow from the credential-rotation feature.

### Enable team

**`POST /internal/teams/:id/enable`**
1. Set the team config's `enabled: true`.
2. For every member with `disabledByTeam === true`: call the existing `enableAgent(id)` (handles both simple respawn and full stub re-materialization, whichever applies) and clear `disabledByTeam`.
3. Members without that tag (independently disabled before, or never activated) are left exactly as they are.
4. Returns `{ enabled: [ids...], skipped: [ids...], failed: [{ id, error }] }`.

### New members created while the team is disabled

Member creation (Add Member wizard, and any other path that materializes a `team-member` under a `parentTeamId`) checks the parent team's `enabled` flag at creation time. If the team is disabled, the new member is created and immediately disabled with `disabledByTeam: true` — it activates automatically the next time the team is enabled, consistent with "the team is off."

### Member toggle lockout while team is disabled

- **Backend:** `Orchestrator.enableAgent(id)` / `disableAgent(id, opts)` resolve the member's `parentTeamId` (existing `resolveAgentTeamId` helper) and, if that team's config has `enabled: false`, reject with a clear error (e.g. `409 { error: 'team-disabled', teamId }`) instead of performing the action. This covers `PUT /api/agents/:id` and the internal `/enable`/`/disable` routes — any caller, not just the Agents page.
- **Frontend:** `AgentRow`'s `ToggleSwitch` is disabled/greyed for a member whose parent team is disabled, with a tooltip ("Team is disabled — enable the team first"). The "Deactivate" (reset-to-stub) icon button is **not** gated — it remains available regardless of team state.

## UI

- `TeamCard` header (`Agents.jsx`, currently: chevron, "Team" pill, name/id, member-count pill, Open in Flow Editor, Add Member, Edit, Export, Delete): add a `ToggleSwitch` (same component/style used on member rows) immediately after the "Team" pill, labeled "Disable team" / "Enable team" based on the team config's `enabled` state.
- Clicking it opens a confirm dialog (modeled on the `ModelRegistry.jsx` bound-agents flow):
  - Lists affected members (from `GET /internal/teams/:id/members`), flags any that are busy/have active triggers.
  - On disable: a mode picker (`drain` / `abort`) applied to all affected members.
  - On enable: no mode picker needed — just a confirm.
  - Confirm calls the bulk endpoint; partial failures are surfaced after the call completes (per-id errors listed, not swallowed).
- Member rows inside a disabled `TeamCard` render their `ToggleSwitch` disabled/greyed per the lockout above.

## Error handling

- Preview fetch failure → dialog shows an inline error, disable confirm until retried (nothing destructive has happened yet).
- Bulk disable/enable partial failures → dialog (or a follow-up toast) lists `failed[]` by id/error; `disabled`/`enabled`/`skipped` counts shown as a summary, not treated as a hard error for the whole action.
- A member's individual enable/disable API call while its team is disabled → `409 team-disabled`, surfaced as a toast if somehow triggered outside the greyed-out UI (e.g. stale tab).

## Out of scope

- Disabling the team agent's own "process" — it has none.
- Locking the "Deactivate" (reset-to-stub) action on members while the team is disabled.
- Any change to how a lone team-member is manually disabled/enabled when its team is enabled — that path is unchanged.
- Bulk actions beyond enable/disable (e.g. bulk delete, bulk export) for teams.
