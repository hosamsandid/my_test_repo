# 09 — Agent lifecycle

**Scope:** New/Import Agent (page header), `/create`, disable/enable, restart,
delete (fast + background cascade), convert to team, stubs, orphans; redirects
`/agents`, `/blueprints` → `/chats`.

## Probes

- Create with minimal and maximal input; id collisions (suggested free id);
  invalid ids (spaces, unicode, very long).
- Import: valid bundle, invalid JSON, bundle with ids that exist, bundle
  referencing missing envs/credentials.
- Disable/enable: status in rail updates; chat composer state; triggers stop.
- Delete: confirmation text, a team with members (cascade), agent with running
  session, delete while another tab shows the agent (redirect + notice).
- Persona: may a Member create agents? delete a teammate's agent? Outsider
  sees nothing.

## Risk spots

- `agent-delete-plan.js`, `agent-orphans.js`, `team-conversion.js`,
  `agent-id-resolution.js`.

## Cleanup

Delete all `uitest-` agents; check no orphan warnings remain for them.
