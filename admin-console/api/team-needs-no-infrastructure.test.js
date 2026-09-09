'use strict';

// Run: node --test admin-console/api/team-needs-no-infrastructure.test.js
//
// #2083 AC4 / #2041 AC11, and concept §5.2's stated consequence of D7:
//
//   "creating a team must not require configuring a repo, an SSH key, a token
//    and a model provider first. With the shared tier, a fresh team can select
//    an existing shared environment; combined with the repo-less path, a team
//    can be created with NO infrastructure of its own."
//
// The phase table (§10) asks P5 for "a create-a-team-with-no-infrastructure
// test". This is it, and it is deliberately a REACHABILITY proof over the real
// `scope.js` predicates rather than an HTTP test: `POST /api/teams` already
// supports the repo-less path (#1623 — a reused environment carrying zero
// repositories creates the team and its members with nothing cloned, no SSH
// key and no PAT), so the thing #2083 changes, and therefore the thing that has
// to be proven, is whether a brand-new team can SEE an environment to reuse.
//
// Before this ticket it could not: every environment carried one `teamId` and
// the list filter was `visibleTeam(scope, e.teamId)`, so a fresh team saw only
// environments its own scope already owned — i.e. it had to be given one, which
// is AC11's complaint restated as a data model.
//
// api.js boots two listeners on require (#651), so the route itself is covered
// by the wiring guard in `tiered-resource-routes.test.js`; what cannot be
// faked is the predicate answer, and that is what this file measures.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeScope, visibleTeam, visibleEnvironment, canManageEnvironment,
  visibleCredential, assistSelectableEndpoint,
} = require('./scope');

const ADMIN_USERNAME = 'admin';

// The installation on the day a new team is created: one operator, one shared
// environment, and one human who has just been made Team Admin of a team with
// nothing of its own.
const users = [
  { id: 'u-ops', subject: 'ops@corp.com', systemAdmin: true },
  // Option C (PR #2094): the env admin is a real seeded record once activated.
  { id: 'u-envadmin', subject: 'admin', systemAdmin: true },
  { id: 'u-new', subject: 'newbie@corp.com' },
];

// The fresh team, and an unrelated one that must not gain anything.
const memberships = [
  { userId: 'u-new', teamId: 'fresh-squad', role: 'team-admin' },
];

// The operator has provisioned exactly ONE shared environment, assigned to the
// new team. Repo-less on purpose: zero repositories is what makes the
// credential-free path legal (#1623), and it is the shape an LLM-only team uses.
const sharedEnv = {
  id: 'shared-infra',
  name: 'Shared infrastructure',
  scope: 'system',
  teamId: null,
  assignedTeamIds: ['fresh-squad'],
  repositories: [],
  githubTokenId: null,
  llmEndpointId: null,
};

// A shared MCP server, the other half of §5.2.
const sharedMcp = { id: 'wiki', scope: 'system', teamId: null, assignedTeamIds: ['fresh-squad'] };

// And the things the fresh team owns: nothing at all.
const ownedEnvironments = [];
const ownedCredentials = [];
const ownedProviders = [];

const scopeOf = (username) => computeScope({ username, adminUsername: ADMIN_USERNAME, users, memberships });

test('AC4: the fresh team owns no credential, environment or provider of its own', () => {
  const fresh = scopeOf('newbie@corp.com');
  assert.deepEqual([...fresh.teamIds], ['fresh-squad'], 'fixture premise: one team, nothing else');
  assert.equal(fresh.all, false, 'and no operator bypass doing the work for it');
  // Stated as assertions so the fixture cannot quietly acquire infrastructure
  // and make the rest of this file pass for the wrong reason.
  assert.equal(ownedEnvironments.length, 0);
  assert.equal(ownedCredentials.filter(c => visibleCredential(fresh, c)).length, 0);
  assert.equal(ownedProviders.filter(p => assistSelectableEndpoint(fresh, p)).length, 0);
});

test('AC4: it can nevertheless SEE and REUSE the shared environment — which is the whole point', () => {
  const fresh = scopeOf('newbie@corp.com');
  assert.equal(visibleEnvironment(fresh, sharedEnv), true,
    'GET /api/environments offers it, so the wizard can select it');
  assert.equal(canManageEnvironment(fresh, sharedEnv), true,
    'and its Team Admin can adjust it, rather than needing an operator for every change');
  assert.equal(visibleEnvironment(fresh, sharedMcp), true, 'the same for a shared MCP server');
});

test('AC4: and it could NOT before this ticket — the counterfactual, so the claim is measured', () => {
  const fresh = scopeOf('newbie@corp.com');
  // The literal pre-#2083 list filter. A shared record has no `teamId` at all,
  // so this is false for every one of them and a fresh team was left with an
  // empty environment picker until somebody gave it an environment.
  assert.equal(visibleTeam(fresh, sharedEnv.teamId), false);
  assert.equal(visibleTeam(fresh, sharedMcp.teamId), false);
});

test('AC4: the repo-less shape is what makes it credential-free, and it is intact', () => {
  // #1623's precondition, asserted here because AC4 is only true in conjunction
  // with it: a reused environment carrying zero repositories needs neither an
  // SSH key nor a PAT, so selecting the shared environment does not smuggle a
  // credential requirement back in through the repository.
  assert.deepEqual(sharedEnv.repositories, []);
  assert.equal(sharedEnv.githubTokenId, null);
  // No model provider either: an unset `llmEndpointId` falls back to the
  // stack's own .env binding, which is why "no provider configured" is a legal
  // starting state rather than a dead end.
  assert.equal(sharedEnv.llmEndpointId, null);
});

test('AC4: sharing is not leaking — an unassigned team gains nothing', () => {
  const other = computeScope({
    username: 'newbie@corp.com',
    adminUsername: ADMIN_USERNAME,
    users,
    memberships: [{ userId: 'u-new', teamId: 'some-other-squad', role: 'team-admin' }],
  });
  assert.equal(visibleEnvironment(other, sharedEnv), false);
  assert.equal(canManageEnvironment(other, sharedEnv), false);
  assert.equal(visibleEnvironment(other, sharedMcp), false);
  // The operator still sees everything (D5).
  assert.equal(visibleEnvironment(scopeOf(ADMIN_USERNAME), sharedEnv), true);
});

test('AC4: an operator with no teams at all can still provision the shared environment', () => {
  // The remaining ordering trap: the operator who creates the shared record on
  // a brand-new installation holds no membership either. `scope.all` is what
  // makes that work, and a shared create is System-Admin-only precisely so this
  // is the only principal who needs it.
  const ops = scopeOf('ops@corp.com');
  assert.equal(ops.all, true);
  assert.deepEqual([...ops.teamIds], [], 'a System Admin need not be a member of anything');
  assert.equal(canManageEnvironment(ops, sharedEnv), true);
});
