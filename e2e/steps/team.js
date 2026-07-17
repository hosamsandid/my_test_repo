// Team fixture step library (#668, docs/journey-spec-concept.md §2.2).
//
// API-level team materialisation used as a PRECONDITION by specs that are not
// testing the wizard itself — F2 (chat round-trip) needs one agent to talk to,
// F4 (skill activation) needs a team with members carrying activation state.
// F1 already covers the wizard UI end-to-end; re-driving it here would be slow
// and redundant, so this takes the fast path: POST /api/teams with a reused
// fixture Working Environment, exactly the `fixtures:` resolution the journey
// format describes.
//
// POST /api/teams is synchronous — it returns 201 only after every member is
// materialised (Matrix user + login + container spawn) and DM rooms are
// pre-created, so there is nothing to poll here for the members to exist.
const { expect } = require('@playwright/test');

// Materialise a team on an existing fixture env. `roles` are catalog template
// ids (e.g. 'business-analyst', 'developer'); member id = `<teamId>-<roleId>`.
// Kept minimal by the caller (one role for chat, two for member-level badges)
// so the full suite stays within the concept's runtime budget.
async function materializeTeam(ctx, { teamId, teamName, envId, roles }) {
  const res = await ctx.request.post('/api/teams', {
    // The materialisation (clone + Matrix provisioning + container spawn per
    // member) legitimately takes longer than the default request timeout on a
    // cold stack; the per-test timeout remains the real ceiling.
    timeout: 120_000,
    data: { teamId, teamName: teamName || teamId, environmentId: envId, roles },
  });
  expect(
    res.ok(),
    `materializeTeam(${teamId}) expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  // `created` is the list of materialised member ids; mirror the wizard's
  // `<teamId>-<roleId>` convention so callers can assert on known ids.
  return {
    teamId: body.teamId,
    memberIds: Array.isArray(body.created) ? body.created : roles.map((r) => `${teamId}-${r}`),
    dms: Array.isArray(body.dms) ? body.dms : [],
  };
}

module.exports = { materializeTeam };
