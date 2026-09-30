# 15 — Administration, maintenance mode, audit

**Scope:** `/users` (tabs Users / All Teams / Resources; alias `/teams`),
`/maintenance-mode`, audit log (`GET /api/audit`), session/role effects.

**Guardrail:** create only `uitest-` users/teams; never edit or delete existing
users. Maintenance mode only with explicit approval (locks every composer
system-wide).

## Probes

- Create `uitest-` users for each persona; assign roles; log in as each.
- Succession rule: try to demote/delete the last System Admin or last Team
  Admin of a `uitest-` team → refused with explanation.
- Deleting a `uitest-` user who owns agents/credentials (offboarding pauses
  agents, deletes personal credentials).
- Non-admin personas: `/users` and `/maintenance-mode` hidden/denied, also via
  URL and API.
- Maintenance mode (if approved): composers locked with a message, cron does not
  fire, exactly one catch-up afterwards.
- Audit: every mutation of the pass appears; denials logged; no secrets.

## Risk spots

- `team-admin-succession.js`, `offboardOwner`, `auditMutations`, `auth-mode.js`.

## Cleanup

Delete `uitest-` users/teams after their agents; switch maintenance off.
