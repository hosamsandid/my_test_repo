'use strict';

// Run: node --test admin-console/api/self-service-team-creation.test.js
//
// Wiring guard for #2081 (epic #2076 P3). `api.js` binds two ports and starts a
// background poller on require (#651), so its source is read — the technique
// `team-stream-materialize.test.js`, `ownership-create-stamp.test.js` and
// `tiered-resource-routes.test.js` all use.
//
// What makes this file worth having is the SHAPE of the thing it guards: the
// two team-create handlers (`POST /api/teams` and its NDJSON twin) duplicate
// their whole variable shape inline, so every property here has to hold TWICE
// and the usual failure mode is a change landing in one of them. Every
// assertion is therefore stated as a count over both handlers, and every one is
// re-run over a deliberately sabotaged copy of the source so it cannot pass
// vacuously.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

// Line comments only. A `/* … */` pass over a file this size swallows real code
// (the sequence occurs inside string literals and regexes), which would make
// the negative assertions vacuous — and the comments below deliberately quote
// the very identifiers being asserted on.
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = stripComments(SRC);

// The body of one route handler, from its `app.<verb>('<route>'` to the next
// top-level `app.` registration. Slicing matters: a match anywhere else in an
// 18k-line file would otherwise stand in for the handler under test.
function handler(code, route) {
  const start = code.indexOf(`app.post('${route}'`);
  assert.notEqual(start, -1, `route ${route} not found`);
  const next = code.indexOf('\napp.', start + 1);
  return code.slice(start, next === -1 ? code.length : next);
}

// The brace-matched body of the block whose `{` follows `from`, or null.
function blockAt(src, from) {
  if (from === -1) return null;
  const open = src.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

function occurrences(src, needle) {
  return src.split(needle).length - 1;
}

// The two twins, always checked as a pair.
function bothHandlers(code) {
  return [
    ['POST /api/teams', handler(code, '/api/teams')],
    ['POST /api/teams/stream', handler(code, '/api/teams/stream')],
  ];
}

// Every assertion in this file, as a named predicate over a source string, so
// each can be re-run against sabotaged input below.
const CHECKS = {
  // AC1 — the creator's membership, in both handlers, planned by the shared module.
  membershipPlanned(code) {
    for (const [name, body] of bothHandlers(code)) {
      assert.match(body, /planCreatorMembership\(\{/, `${name} must plan the creator membership`);
      assert.match(body, /teamCreated:\s*true/, `${name} must plan it only on a real create`);
      assert.match(
        body, /userId:\s*getScope\(req\)\.userId/,
        `${name} must take the creator from the SESSION, never from req.body`,
      );
      assert.match(
        body, /callAdmin\('POST',\s*'memberships',\s*creatorMembership\)/,
        `${name} must actually write the planned membership`,
      );
    }
  },

  // The write is fatal, so a team whose creator cannot see it never survives.
  membershipFatal(code) {
    for (const [name, body] of bothHandlers(code)) {
      const at = body.indexOf('creatorMembership)');
      assert.notEqual(at, -1, `${name}: membership write not found`);
      const after = body.slice(at, at + 400);
      assert.match(after, /status\s*>=\s*400/, `${name} must check the membership write's status`);
      assert.match(after, /throw new Error\(/, `${name} must fail the create, not warn`);
    }
  },

  // It is written only inside the `if (!teamExists)` block that mints the team,
  // so an extend re-runs nothing (the idempotence half of AC1).
  membershipInsideCreateBranch(code) {
    for (const [name, body] of bothHandlers(code)) {
      const branch = blockAt(body, body.indexOf('if (!teamExists) {'));
      assert.ok(branch, `${name}: team-create branch not found`);
      // Brace-matched rather than "between two markers": the streaming handler
      // has a second `for (const p of toCreate)` in its plan-building phase, so
      // an index comparison would anchor on the wrong one.
      assert.equal(
        occurrences(branch, 'planCreatorMembership'), 1,
        `${name}: the membership must be planned exactly once, inside the create branch`,
      );
      assert.equal(
        occurrences(body, 'planCreatorMembership'), 1,
        `${name}: and nowhere else in the handler`,
      );
    }
  },

  // AC2 — the auto-created environment carries the new team's ownership.
  environmentStamped(code) {
    for (const [name, body] of bothHandlers(code)) {
      assert.match(
        body, /\.\.\.creatorEnvironmentOwnership\(teamAgentId\)/,
        `${name} must stamp the auto-created environment with the Agent Team`,
      );
    }
  },

  // Extending an existing team is Team-Admin-only, on the same predicate pair
  // the rest of api.js gates team mutations with.
  extendGated(code) {
    for (const [name, body] of bothHandlers(code)) {
      const at = body.indexOf("if (mode === 'extend') {");
      assert.notEqual(at, -1, `${name}: extend branch not found`);
      const head = body.slice(at, at + 700);
      assert.match(
        head, /canManageAgent\(getScope\(req\),\s*agentMetaForScope\(existingTeamCfg\)\)/,
        `${name} must gate extend on canManageAgent over the existing team config`,
      );
      // Before the first thing extend does, so no work precedes the refusal.
      const gate = head.indexOf('canManageAgent');
      const suffix = head.indexOf('storedSuffix');
      assert.ok(gate < suffix, `${name}: the extend gate must precede the suffix check`);
    }
  },

  // AC6 — no environment and no repository is a legal create.
  noInfrastructureCreate(code) {
    for (const [name, body] of bothHandlers(code)) {
      assert.match(
        body, /\}\s*else if \(!repository \|\| !repository\.url\) \{[\s\S]{0,900}?repoLess = true;/,
        `${name} must treat "no environmentId and no repository" as repo-less`,
      );
      assert.match(
        body, /if \(!environmentId && !repoLess\) \{/,
        `${name} must not require a GitHub token for a repo-less team`,
      );
      assert.doesNotMatch(
        body, /\n\s*if \(!environmentId\) \{\n\s*if \(typeof githubTokenId/,
        `${name} must not keep the unconditional token requirement`,
      );
    }
  },

  // AC3 — the access-scope create route is gone, and says where it went.
  adminTeamCreateRetired(code) {
    const body = handler(code, '/api/admin/teams');
    assert.match(body, /res\.status\(410\)/, 'POST /api/admin/teams must answer 410 Gone');
    assert.match(body, /team-create-retired/, 'it must carry a stable code');
    assert.match(body, /POST \/api\/teams/, 'it must name its successor route');
    assert.doesNotMatch(body, /proxyAdmin/, 'it must not still reach the orchestrator');
    assert.doesNotMatch(body, /denyAdmin/, 'a retired route is not an authorization failure');
  },

  // The remaining scope verbs survive: `teams/index.json` still backs the
  // Access page and the team dropdowns until the P5 successor retires it
  // (concept A3.3), so only MINTING new scopes is closed.
  adminTeamReadsSurvive(code) {
    for (const decl of [
      "app.get('/api/admin/teams'",
      "app.get('/api/admin/teams/:id'",
      "app.put('/api/admin/teams/:id'",
      "app.delete('/api/admin/teams/:id'",
    ]) {
      assert.ok(code.includes(decl), `${decl} must still be registered`);
    }
  },
};

for (const [name, check] of Object.entries(CHECKS)) {
  test(`api.js wiring: ${name}`, () => check(CODE));
}

// ── Non-vacuity ────────────────────────────────────────────────────────────
//
// A source-reading assertion that has only ever run against a correct file can
// be silently vacuous — a mistyped identifier, a slice that lands on the wrong
// handler, a regex that never matches anything. Break each property in turn and
// require its own check to notice.

const SABOTAGE = {
  // Both handlers lose the plan; a check that only looked at the first passes.
  membershipPlanned: (c) => c.replace(/planCreatorMembership/g, 'noSuchPlanner'),
  // Present, but written from the request body rather than the session.
  membershipPlannedFromBody: (c) => c.replace(/userId: getScope\(req\)\.userId/g, 'userId: req.body.userId'),
  membershipFatal: (c) => c.replace(
    /if \(status >= 400\) \{\n\s*throw new Error\(`Team admin membership[\s\S]*?\n\s*\}/g,
    'if (status >= 400) { console.warn("membership failed"); }',
  ),
  environmentStamped: (c) => c.replace(/\.\.\.creatorEnvironmentOwnership\(teamAgentId\),/g, ''),
  extendGated: (c) => c.replace(
    /if \(!canManageAgent\(getScope\(req\), agentMetaForScope\(existingTeamCfg\)\)\) \{/g,
    'if (false) {',
  ),
  noInfrastructureCreate: (c) => c.replace(/if \(!environmentId && !repoLess\) \{/g, 'if (!environmentId) {'),
  adminTeamCreateRetired: (c) => c.replace(/res\.status\(410\)/g, 'res.status(403)'),
  adminTeamReadsSurvive: (c) => c.replace("app.put('/api/admin/teams/:id'", "app.patch('/api/admin/teams/:id'"),
};

function fails(check, code) {
  try {
    check(code);
    return false;
  } catch {
    return true;
  }
}

test('every wiring assertion fails on a source that breaks its property', () => {
  for (const [key, breakIt] of Object.entries(SABOTAGE)) {
    // `membershipPlannedFromBody` breaks a property the `membershipPlanned`
    // check owns; everything else is named after its own check.
    const checkName = key === 'membershipPlannedFromBody' ? 'membershipPlanned' : key;
    const broken = breakIt(CODE);
    assert.notEqual(broken, CODE, `sabotage '${key}' changed nothing — the pattern is stale`);
    assert.ok(fails(CHECKS[checkName], broken), `check '${checkName}' did not notice sabotage '${key}'`);
  }
});

test('the twin-handler assertions are not satisfied by one handler alone', () => {
  // The failure mode this whole file exists for: a change landing in
  // `POST /api/teams` and not in its streaming twin. Break only the second one.
  const streamAt = CODE.indexOf("app.post('/api/teams/stream'");
  assert.notEqual(streamAt, -1);
  const head = CODE.slice(0, streamAt);
  const tail = CODE.slice(streamAt)
    .replace(/planCreatorMembership/g, 'noSuchPlanner')
    .replace(/\.\.\.creatorEnvironmentOwnership\(teamAgentId\),/g, '')
    .replace(/if \(!canManageAgent\(getScope\(req\), agentMetaForScope\(existingTeamCfg\)\)\) \{/g, 'if (false) {');
  const oneSided = head + tail;
  for (const name of ['membershipPlanned', 'environmentStamped', 'extendGated']) {
    assert.ok(fails(CHECKS[name], oneSided), `check '${name}' passed with the streaming handler broken`);
  }
});
