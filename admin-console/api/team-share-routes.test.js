'use strict';

// The server half of the team Share dialog (#2082, #2041 P4).
//
// #2041's P4 phase row asks for exactly this and says why: *"a server-side test
// that a Team Member's `POST /api/admin/memberships` is refused — **not** only
// that the button is disabled"*. Nothing tested those two routes as routes
// before this file; `scope.test.js` proved `canManageTeam` in isolation and the
// client guards proved the buttons.
//
// Two halves, because neither alone is enough:
//
//  * a **predicate cross-product** over the REAL `scope.js`, so "a Team Member
//    is refused" is a measured property of the shipped rule rather than a
//    fixture; and
//  * a **source read** of api.js, because the predicate being correct says
//    nothing about whether the route still calls it — and a gate that goes
//    missing is invisible: the route answers correctly for the caller who is
//    allowed and for everybody else too.
//
// api.js boots Express and cannot be required, so the second half reads its
// source — the `draft-routes-access.test.js` technique. Every anchor below is
// asserted to occur exactly once before it is used, so a match elsewhere in the
// 17k-line file can never stand in for the gate that is actually missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeScope, canManageTeam, canManageAgent, visibleTeam } = require('./scope');
const { userDirectory } = require('./draft-access');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  // Line comments FIRST: a `//` comment naming a route path contains a `/*`
  // that would otherwise pair with the next real `*/` hundreds of lines below
  // and swallow the code being asserted on (the #1457 lesson).
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** One route's body, sliced at the next top-level `app.` registration.
 *  Takes the source so the mutation proof at the foot of this file can run the
 *  very same checks over a sabotaged copy. */
function route(src, marker) {
  assert.equal(
    src.split(marker).length - 1, 1,
    `anchor ${marker} must occur exactly once — this guard needs re-pointing`,
  );
  const start = src.indexOf(marker);
  const end = src.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(src.slice(start, end));
}

const MARKERS = {
  list: "app.get('/api/admin/memberships',",
  upsert: "app.post('/api/admin/memberships',",
  remove: "app.delete('/api/admin/memberships',",
  directory: "app.get('/api/users/directory',",
  chatList: "app.get('/api/matrix/agents',",
};

/**
 * Every source-side check, as named functions over an arbitrary api.js source.
 * The tests below run them against the real file; the mutation proof runs them
 * against sabotaged copies and asserts the matching one throws — otherwise a
 * check that has only ever seen correct source may be quietly vacuous.
 */
const CHECKS = {
  'post-gate'(src) {
    const r = route(src, MARKERS.upsert);
    assert.match(r, /getScope\(req\)/);
    assert.match(r, /req\.body\s*&&\s*req\.body\.teamId/, 'POST carries teamId in the body');
    assert.match(r, /if \(!canManageTeam\(scope, teamId\)\) return denyAdmin\(/);
    // The gate must precede the proxy, or the write happens and is then refused.
    assert.ok(
      r.indexOf('canManageTeam') < r.indexOf('proxyAdmin'),
      'the refusal must come before the orchestrator call',
    );
  },
  'delete-gate'(src) {
    const r = route(src, MARKERS.remove);
    assert.match(r, /req\.query\s*&&\s*req\.query\.teamId/, 'DELETE carries teamId in the query');
    assert.match(r, /if \(!canManageTeam\(scope, teamId\)\) return denyAdmin\(/);
    assert.ok(r.indexOf('canManageTeam') < r.indexOf('proxyAdmin'));
    // `adminQuery` is what forwards the D4 `successorUserId` to the store,
    // which is the only place the last-admin rule is enforced (#2081).
    assert.match(r, /adminQuery\(req\)/);
  },
  'no-d4-copy'(src) {
    // The rule lives in `teams-store.js` because the orchestrator's own
    // internal API is a second membership writer; a copy here would drift.
    for (const key of ['upsert', 'remove']) {
      assert.doesNotMatch(route(src, MARKERS[key]), /last-team-admin|planAdminHandover|soleAdmin/i);
    }
  },
  'list-reads-not-manages'(src) {
    const r = route(src, MARKERS.list);
    assert.match(r, /visibleTeam\(scope, m\.teamId\)/);
    assert.doesNotMatch(r, /canManageTeam/, 'gating the read here would break AC9');
  },
  'directory-ungated'(src) {
    const r = route(src, MARKERS.directory);
    assert.match(r, /draftAccess\.userDirectory\(/);
    // Every user is findable (D2), so there is no scope filter here at all —
    // which is why the projection has to be the thing that is checked.
    assert.doesNotMatch(r, /callAdmin|proxyAdmin|denyAdmin|scope\.all|visibleUser/);
  },
  'chat-ships-canmanageteam'(src) {
    const r = route(src, MARKERS.chatList);
    assert.match(r, /canManage: canManageAgent\(scope, agentMetaForScope\(cfg\)\)/, 'unchanged');
    assert.match(
      r,
      /cfg\.role === 'team' \? \{ canManageTeam: canManageTeam\(scope, id\) \}/,
      'the member-list right must be its own field, computed with its own predicate',
    );
  },
};

/* ── The cast: one team, three roles, plus a stranger ─────────────────── */

const USERS = [
  { id: 'u-alice', subject: 'alice', displayName: 'Alice A', email: 'alice@corp', githubHandle: 'alice-gh' },
  { id: 'u-bob', subject: 'bob', displayName: 'Bob B', email: 'bob@corp', githubHandle: 'bob-gh' },
  { id: 'u-root', subject: 'root', displayName: 'Root R', email: 'root@corp', systemAdmin: true },
  { id: 'u-mallory', subject: 'mallory', displayName: 'Mallory M', email: 'mallory@corp' },
];
const MEMBERSHIPS = [
  { id: 'm1', userId: 'u-alice', teamId: 'squad-a', role: 'team-admin' },
  { id: 'm2', userId: 'u-bob', teamId: 'squad-a', role: 'team-member' },
  { id: 'm3', userId: 'u-mallory', teamId: 'squad-b', role: 'team-admin' },
];

const scopeFor = subject => computeScope({
  username: subject, adminUsername: '__env_admin__', users: USERS, memberships: MEMBERSHIPS,
  authEnabled: true,
});

/* ── AC9 / the ticket's edge case: a Team Member's write is refused ───── */

test('AC9 — only a Team Admin of THIS team may write its member list', () => {
  const expected = {
    alice: true, // Team Admin of squad-a
    bob: false, // Team Member of squad-a — D9: read and chat, nothing else
    mallory: false, // Team Admin, but of another team
    root: true, // System Admin (scope.all)
    // #2059 (Option C): the env admin is a PRE-SEED identity only. This fixture
    // already carries a seeded System Admin (u-root), so the env-admin power
    // grant is retired and `__env_admin__` resolves to the empty scope — the
    // single-operator admin is no longer a standing login once a real System
    // Admin record exists.
    __env_admin__: false,
  };
  for (const [subject, allowed] of Object.entries(expected)) {
    assert.equal(
      canManageTeam(scopeFor(subject), 'squad-a'), allowed,
      `${subject} should ${allowed ? '' : 'not '}be able to change squad-a's members`,
    );
  }
  // …and an unauthenticated caller resolves to the empty scope, not to a team.
  assert.equal(canManageTeam(scopeFor(''), 'squad-a'), false);
});

test('AC9 — a Team Member may still READ the list they cannot change', () => {
  // This is the asymmetry the whole panel is built on: `GET` is filtered by
  // `visibleTeam`, so the read-only list is a real capability (D9) and the UI
  // must gate its controls on `canManageTeam` rather than on the fetch.
  const bob = scopeFor('bob');
  assert.equal(visibleTeam(bob, 'squad-a'), true, 'reads his own team');
  assert.equal(canManageTeam(bob, 'squad-a'), false, 'but changes nothing');
  assert.equal(visibleTeam(bob, 'squad-b'), false, 'and cannot read a stranger team');
});

test('a team id the caller has no membership for is refused, never defaulted', () => {
  // The `|| "default"` fallback is gone since #2078: an unknown or missing team
  // must fail closed rather than collapsing into the default team.
  const alice = scopeFor('alice');
  for (const teamId of ['squad-b', 'nonexistent', '', null, undefined]) {
    assert.equal(canManageTeam(alice, teamId), false, `teamId=${String(teamId)}`);
  }
});

/* ── The two routes actually call it, on the right parameter ──────────── */

test('POST /api/admin/memberships gates on canManageTeam, reading teamId from the BODY', () => {
  CHECKS['post-gate'](API_SRC);
});

test('DELETE /api/admin/memberships gates on canManageTeam, reading teamId from the QUERY', () => {
  CHECKS['delete-gate'](API_SRC);
});

test('neither write route re-implements the D4 last-admin rule', () => {
  CHECKS['no-d4-copy'](API_SRC);
});

test('the list route filters on visibility, deliberately NOT on manage rights', () => {
  CHECKS['list-reads-not-manages'](API_SRC);
});

/* ── AC10 / D2 / D11: the open directory ──────────────────────────────── */

test('AC10 — the directory route is ungated and projects through the module', () => {
  CHECKS['directory-ungated'](API_SRC);
});

test('AC10 — the directory exposes display name and email ONLY', () => {
  // D2: never the systemAdmin flag. D11: never the GitHub handle.
  const rows = userDirectory(USERS);
  assert.equal(rows.length, USERS.length, 'everyone is findable, admins included');
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['displayName', 'email', 'id']);
  }
  const root = rows.find(r => r.id === 'u-root');
  assert.ok(root, 'a System Admin appears as an ordinary person');
  assert.equal(Object.prototype.hasOwnProperty.call(root, 'systemAdmin'), false);
  assert.equal(JSON.stringify(rows).includes('-gh'), false, 'no GitHub handle anywhere');
  assert.equal(JSON.stringify(rows).includes('"subject"'), false, 'nor the login identity');
});

/* ── The one real gap #2041 §7.1 named: the chat payload's predicate ──── */

test('the chat list ships an explicit canManageTeam on team rows', () => {
  CHECKS['chat-ships-canmanageteam'](API_SRC);
});

test('the explicit field is not merely canManage under another name', () => {
  // For a `role: "team"` row the two predicates resolve identically TODAY
  // (`agentMetaForScope().teamId === cfg.id`), which is the whole reason #2041
  // §7.1 asks for a separate field: a later change to the agent predicate must
  // not silently open the member list. Pin the coincidence so a successor that
  // breaks it fails here rather than in production.
  const teamCfg = { id: 'squad-a', role: 'team', teamId: 'squad-a', ownerId: 'u-alice' };
  for (const subject of ['alice', 'bob', 'mallory', 'root']) {
    const scope = scopeFor(subject);
    assert.equal(
      canManageAgent(scope, { teamId: teamCfg.teamId, ownerId: teamCfg.ownerId }),
      canManageTeam(scope, teamCfg.id),
      `the two predicates agree for ${subject} — if this fails, the Share entry is now the only correct one`,
    );
  }
  // A STANDALONE agent is where they legitimately differ: `canManageAgent`
  // falls through to ownership, `canManageTeam` has no team to check. That is
  // why the field is shipped on team rows only.
  const owner = scopeFor('bob');
  assert.equal(canManageAgent(owner, { teamId: null, ownerId: 'u-bob' }), true, 'owner may manage');
  assert.equal(canManageTeam(owner, null), false, 'and there is no member list to speak of');
});

/* ── The guard has teeth ──────────────────────────────────────────────── */

test('every source check above fails on a sabotaged api.js (mutation proof)', () => {
  // One entry per check: the smallest realistic regression, and the check that
  // must catch it. Each anchor is asserted to occur EXACTLY ONCE first — an
  // anchor that also matches inside a neighbouring function would mutate the
  // wrong code and let the guard pass for the wrong reason.
  const mutations = [
    ['post-gate', 'the POST gate goes missing entirely',
      "if (!canManageTeam(scope, teamId)) return denyAdmin(res, 'You may not manage members of this team');\n  return proxyAdmin(req, res, 'memberships');",
      "return proxyAdmin(req, res, 'memberships');"],
    ['delete-gate', 'the DELETE reads teamId from a body it will never have',
      'const teamId = req.query && req.query.teamId;',
      'const teamId = req.body && req.body.teamId;'],
    ['chat-ships-canmanageteam', 'the chat payload goes back to inferring the member-list right',
      "...(cfg.role === 'team' ? { canManageTeam: canManageTeam(scope, id) } : {}),",
      ''],
    ['list-reads-not-manages', 'the read is narrowed to Team Admins, breaking AC9',
      'res.json(scope.all ? data : data.filter(m => visibleTeam(scope, m.teamId)));',
      'res.json(scope.all ? data : data.filter(m => canManageTeam(scope, m.teamId)));'],
    ['no-d4-copy', 'the D4 rule is copied into the console',
      "const teamId = req.body && req.body.teamId;",
      "const teamId = req.body && req.body.teamId; if (soleAdmin(teamId)) return denyAdmin(res, 'last-team-admin');"],
  ];

  for (const [checkName, what, from, to] of mutations) {
    assert.equal(
      API_SRC.split(from).length - 1, 1,
      `mutation anchor must occur exactly once, else the wrong code is mutated (${what})`,
    );
    const mutated = API_SRC.replace(from, to);
    assert.notEqual(mutated, API_SRC, `the mutation must change something (${what})`);
    assert.throws(
      () => CHECKS[checkName](mutated),
      err => err instanceof assert.AssertionError,
      `${checkName} must reject: ${what}`,
    );
    // …and it must still pass on the real source, so the check is not simply
    // broken for both.
    CHECKS[checkName](API_SRC);
  }
});
