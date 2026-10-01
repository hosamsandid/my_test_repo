'use strict';

// Source-reading wiring guard for #2718: the team-create handlers stamp the
// humans registry, and every live-edit route applies the team's stored label
// suffix before it validates or persists. api.js cannot be `require`d in a unit
// test (it boots Express and reaches for the orchestrator), so this reads the
// route source (#651). The stamping itself is unit-tested in
// label-suffix-gaps.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** Source with comments stripped, so prose can't make an assertion pass vacuously. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The body of one route, so a match elsewhere in api.js can't fool us. */
function route(signature) {
  const start = API_SRC.indexOf(signature);
  assert.ok(start > 0, `${signature} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, 'could not find the end of the route');
  return code(API_SRC.slice(start, end));
}

test('both team-create handlers stamp the humans registry with the bundle', () => {
  const src = code(API_SRC);
  const calls = src.match(/applyLabelSuffix\(customRolesRaw, bundleLabels, labelSuffix, bundleHumans\)/g) || [];
  assert.equal(calls.length, 2, 'POST /api/teams and POST /api/teams/stream must pass bundleHumans');
  const assigns = src.match(/bundleHumans = stamped\.humans;/g) || [];
  assert.equal(assigns.length, 2, 'both handlers must store the stamped humans');
});

test('PUT /api/agents/:id stamps the body before it is destructured and validated', () => {
  const r = route("app.put('/api/agents/:id'");
  const stamp = r.search(/if \(liveSuffix\) req\.body = stampLiveLabels\(req\.body \|\| \{\}, liveSuffix\);/);
  const destructure = r.indexOf('} = req.body;');
  const validate = r.indexOf('validateOutcomes(outcomes');
  assert.ok(stamp > 0, 'the agent PUT must stamp its body with the team suffix');
  assert.match(r, /const liveSuffix = teamLabelSuffixFor\(cfg\);/);
  assert.ok(stamp < destructure && destructure < validate, 'stamping must precede the destructure and the outcomes validation');
});

test('trigger POST and PUT stamp the request trigger', () => {
  for (const sig of ["app.post('/api/agents/:id/triggers'", "app.put('/api/agents/:id/triggers/:triggerId'"]) {
    const r = route(sig);
    assert.match(r, /const liveSuffix = teamLabelSuffixFor\(readJsonFile\(path\.join\(agentDir, 'config\.json'\), null\)\);/, sig);
    assert.match(r, /const reqTrigger = liveSuffix \? stampLiveLabels\(req\.body \|\| \{\}, liveSuffix, \{ trigger: true \}\) : req\.body;/, sig);
    assert.match(r, /stripTriggerAnnotations\(\{.*\.\.\.reqTrigger\b/, `${sig} must build the trigger from the stamped body`);
    assert.doesNotMatch(r, /stripTriggerAnnotations\(\{.*\.\.\.req\.body/, `${sig} must not use the raw body`);
  }
});

test('adding a member to a team stamps the member body before it is forwarded', () => {
  const r = route("app.post('/api/agents/:teamId/members'");
  const stamp = r.search(/if \(liveSuffix\) outBody = stampLiveLabels\(outBody, liveSuffix\);/);
  const forward = r.indexOf('body: JSON.stringify(outBody)');
  assert.match(r, /const liveSuffix = teamLabelSuffixFor\(teamCfg\);/);
  assert.ok(stamp > 0 && stamp < forward, 'the member body must be stamped before the orchestrator call');
});

test('teamLabelSuffixFor reads a team\'s own suffix or a member\'s parent team\'s', () => {
  const start = API_SRC.indexOf('function teamLabelSuffixFor(cfg)');
  assert.ok(start > 0);
  const body = code(API_SRC.slice(start, API_SRC.indexOf('\n}\n', start)));
  assert.match(body, /cfg\.role === 'team'\) teamCfg = cfg/);
  assert.match(body, /cfg\.parentTeamId/);
  assert.match(body, /validateSuffix\(suffix\)\.ok/);
});
