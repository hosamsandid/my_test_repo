'use strict';

// Source-reading wiring guard for #2718: the team-create handlers stamp the
// humans registry, and every live-edit route applies the team's stored label
// suffix before it validates or persists. api.js cannot be `require`d in a unit
// test (it boots Express and reaches for the orchestrator), so this reads the
// route source (#651). The stamping itself is unit-tested in
// label-suffix-gaps.test.js.

const test = require('node:test');
const { describe, it } = test;
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
  const stamp = r.search(/if \(liveSuffix\) req\.body = stampLiveLabels\(req\.body \|\| \{\}, liveSuffix, \{ keep: teamForeignLabelsFor\(id, cfg\) \}\);/);
  const destructure = r.indexOf('} = req.body;');
  const validate = r.indexOf('validateOutcomes(outcomes');
  assert.ok(stamp > 0, 'the agent PUT must stamp its body with the team suffix');
  assert.match(r, /const liveSuffix = teamLabelSuffixFor\(cfg\);/);
  assert.ok(stamp < destructure && destructure < validate, 'stamping must precede the destructure and the outcomes validation');
});

test('trigger POST and PUT stamp the request trigger', () => {
  for (const sig of ["app.post('/api/agents/:id/triggers'", "app.put('/api/agents/:id/triggers/:triggerId'"]) {
    const r = route(sig);
    assert.match(r, /const agentCfg = readJsonFile\(path\.join\(agentDir, 'config\.json'\), null\);\s+const liveSuffix = teamLabelSuffixFor\(agentCfg\);/, sig);
    assert.match(r, /const reqTrigger = liveSuffix\s+\? stampLiveLabels\(req\.body \|\| \{\}, liveSuffix, \{ trigger: true, keep: teamForeignLabelsFor\(id, agentCfg\) \}\)\s+: req\.body;/, sig);
    assert.match(r, /stripTriggerAnnotations\(\{.*\.\.\.reqTrigger\b/, `${sig} must build the trigger from the stamped body`);
    assert.doesNotMatch(r, /stripTriggerAnnotations\(\{.*\.\.\.req\.body/, `${sig} must not use the raw body`);
  }
});

test('adding a member to a team stamps the member body before it is forwarded', () => {
  const r = route("app.post('/api/agents/:teamId/members'");
  const stamp = r.search(/if \(liveSuffix\) outBody = stampLiveLabels\(outBody, liveSuffix, \{ keep: teamForeignLabelsFor\(teamId, teamCfg\) \}\);/);
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

// #2858: the team's foreign labels (never stamped) travel with every live write.
test('teamForeignLabelsFor resolves the agent\'s team and lists its foreign labels', () => {
  const start = API_SRC.indexOf('function teamForeignLabelsFor(agentId, cfg)');
  assert.ok(start > 0);
  const body = code(API_SRC.slice(start, API_SRC.indexOf('\n}\n', start)));
  assert.match(body, /cfg\.role === 'team' \? agentId : cfg\.parentTeamId/);
  assert.match(body, /teamForeignLabels\(loadSuffixTeamAgents\(teamId\), teamId\)/);
});

test('team creation records the labels that already ended in the suffix', () => {
  const src = code(API_SRC);
  assert.equal((src.match(/suffixExempt = stamped\.skipped\.filter\(t => !stamped\.tokenSet\.has\(t\)\);/g) || []).length, 2);
  assert.equal((src.match(/\.\.\.\(suffixExempt\.length \? \{ labelSuffixExempt: suffixExempt \} : \{\}\)/g) || []).length, 2);
});

describe('POST /api/agents/:teamId/label-suffix (#2858)', () => {
  const r = route("app.post('/api/agents/:teamId/label-suffix'");

  it('is gated on team management rights and validates like creation', () => {
    assert.match(r, /if \(denyUnlessCanManageAgent\(req, res, teamCfg\)\) return;/);
    assert.match(r, /const sv = validateSuffix\(suffix\);/);
    assert.match(r, /teamCfg\.role !== 'team'/);
  });

  it('rejects collisions with a 409 before anything is written (AC10)', () => {
    const collide = r.indexOf('if (plan.collisions.length)');
    const write = r.indexOf('writeJsonAtomic(path.join(AGENTS_DIR, a.id');
    assert.ok(collide > 0 && collide < write);
    assert.match(r, /res\.status\(409\)/);
    assert.match(r, /otherTeamLabels: otherTeamLabelsOnRepo\(teamId, memberRepoFullName\(teamCfg\)\)/);
  });

  it('answers a dry run with the preview and writes nothing (AC9)', () => {
    const dry = r.indexOf('if (body.dryRun === true) return res.json(preview);');
    assert.ok(dry > 0 && dry < r.indexOf('putTriggers('));
  });

  it('writes the team, re-derives prompts and wiring, then renames on GitHub (AC7/AC8)', () => {
    const write = r.indexOf('writeJsonAtomic(path.join(AGENTS_DIR, a.id');
    const outcomes = r.indexOf('await reconcileTeamOutcomes(teamId);');
    const channels = r.indexOf('await reconcileTeamGithubChannels(teamId);');
    const rename = r.lastIndexOf('await renameGithubLabels(');
    assert.ok(write > 0 && write < channels && channels < outcomes && outcomes < rename);
    assert.match(r, /putTriggers\(a\.id, a\.triggers\)/);
  });

  it('records failed GitHub renames for a retry', () => {
    assert.match(r, /fresh\.labelSuffixPendingRenames = github\.failed;/);
    assert.match(r, /if \(body\.retry === true\)/);
  });
});

test('the console renames GitHub labels via the orchestrator rename route', () => {
  const start = API_SRC.indexOf('async function renameGithubLabels(');
  assert.ok(start > 0);
  const body = code(API_SRC.slice(start, API_SRC.indexOf('\n}\n', start)));
  assert.match(body, /\/github-labels\/rename`/);
});
