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
    // acknowledgeNoToken: POST /api/teams re-runs the #2323 repo-backed-env
    // token guard even for a reused env, and the fixture env is token-less by
    // design (reference-only). Ignored when the env carries a token.
    data: { teamId, teamName: teamName || teamId, environmentId: envId, roles, acknowledgeNoToken: true },
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

// Materialise a team from a curated PROCESS TEMPLATE bundle (#711). Unlike
// `materializeTeam` (bare catalog `roles`), this feeds the whole bundle under
// `processTemplate`, so `POST /api/teams` runs `expandGithubChannels` and the
// members get the derived github-event channel triggers that wire the label
// chain (BA→issue, Developer reacts to `ready`, Reviewer reacts to
// `ready-for-review`). That wiring is what the IBAN-story journey exercises —
// bare roles would materialise the same agents WITHOUT the channels.

// Materialise a team from an INLINE process-template bundle (#1010) — for
// journeys that need a minimal live team (e.g. two roles) without shipping a
// registry template. Same POST /api/teams seam as materializeCoreSdlcTeam.
async function materializeBundleTeam(ctx, { teamId, teamName, envId, bundle }) {
  const res = await ctx.request.post('/api/teams', {
    timeout: 180_000,
    // acknowledgeNoToken: see materializeTeam — the #2323 guard re-fires on
    // POST /api/teams; the fixture env is reference-only. No-op with a token.
    data: { teamId, teamName: teamName || teamId, environmentId: envId, processTemplate: bundle, acknowledgeNoToken: true },
  });
  expect(
    res.ok(),
    `materializeBundleTeam(${teamId}) expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  return {
    teamId: body.teamId,
    memberIds: Array.isArray(body.created) ? body.created : [],
    dms: Array.isArray(body.dms) ? body.dms : [],
  };
}

async function materializeCoreSdlcTeam(ctx, { teamId, teamName, envId, templateId = 'core-sdlc' }) {
  const tmpl = await ctx.request.get(`/api/process-templates/${encodeURIComponent(templateId)}`);
  expect(
    tmpl.ok(),
    `fetch process template ${templateId} failed: HTTP ${tmpl.status()}: ${await tmpl.text()}`,
  ).toBeTruthy();
  const bundle = await tmpl.json();
  const res = await ctx.request.post('/api/teams', {
    timeout: 180_000,
    // acknowledgeNoToken: see materializeTeam — the #2323 guard re-fires on
    // POST /api/teams; the fixture env is reference-only. No-op with a token.
    data: { teamId, teamName: teamName || teamId, environmentId: envId, processTemplate: bundle, acknowledgeNoToken: true },
  });
  expect(
    res.ok(),
    `materializeCoreSdlcTeam(${teamId}) expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  return {
    teamId: body.teamId,
    memberIds: Array.isArray(body.created) ? body.created : [],
    dms: Array.isArray(body.dms) ? body.dms : [],
  };
}

module.exports = {
  materializeBundleTeam, materializeTeam, materializeCoreSdlcTeam };
