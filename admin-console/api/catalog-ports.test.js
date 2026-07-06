'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { normalizeTemplatePorts, intrinsicTriggers } = require('./catalog-ports');

test('templates without catalog-v2 fields normalise to standalone with empty ports', () => {
  const n = normalizeTemplatePorts({ id: 'legacy', triggers: [] });
  assert.deepEqual(n, {
    patternRole: 'standalone',
    stageAffinity: [],
    ports: { consumes: [], produces: { pr: false, issue: false } },
  });
});

test('produces defaults from the github flags, explicit ports.produces wins', () => {
  assert.deepEqual(
    normalizeTemplatePorts({ github: { producesPr: true } }).ports.produces,
    { pr: true, issue: false },
  );
  assert.deepEqual(
    normalizeTemplatePorts({ github: { producesPr: true }, ports: { produces: { issue: true } } }).ports.produces,
    { pr: false, issue: true },
  );
});

test('invalid patternRole / slots / affinity entries are dropped, not thrown', () => {
  const n = normalizeTemplatePorts({
    patternRole: 'wizard',
    stageAffinity: ['Build', 42, ''],
    ports: { consumes: [
      { artifact: 'pr', fromSlot: 'stage-author' },
      { artifact: 'tarball', fromSlot: 'stage-author' },
      { artifact: 'issue', fromSlot: 'somewhere' },
      null,
    ] },
  });
  assert.equal(n.patternRole, 'standalone');
  assert.deepEqual(n.stageAffinity, ['Build']);
  assert.deepEqual(n.ports.consumes, [{ artifact: 'pr', fromSlot: 'stage-author' }]);
  assert.equal(normalizeTemplatePorts(null).patternRole, 'standalone');
});

test('intrinsicTriggers keeps only intrinsic-flagged triggers', () => {
  const t = { triggers: [
    { id: 'wiring', type: 'github-event' },
    { id: 'essence', type: 'github-event', intrinsic: true },
    { id: 'curate', type: 'cron', intrinsic: true },
  ] };
  assert.deepEqual(intrinsicTriggers(t).map(x => x.id), ['essence', 'curate']);
  assert.deepEqual(intrinsicTriggers({}), []);
});

// ── Repo catalog guards: the SDLC core roles + generic pattern roles carry the
// declarations the Flow-Weaver depends on. ──────────────────────────────────
const CATALOG = path.join(__dirname, '..', '..', 'orchestrator', 'skill-pool', 'agent-templates');
const readTpl = (id) => JSON.parse(fs.readFileSync(path.join(CATALOG, id + '.json'), 'utf8'));

test('SDLC core roles are tagged with patternRole + stageAffinity', () => {
  const expectations = {
    'business-analyst': { patternRole: 'intake', stage: 'Requirements', produces: { pr: false, issue: true } },
    'issue-triage': { patternRole: 'intake', stage: 'Requirements', produces: { pr: false, issue: false } },
    'developer': { patternRole: 'author', stage: 'Build', produces: { pr: true, issue: false } },
    'code-reviewer': { patternRole: 'companion', stage: 'Build', produces: { pr: false, issue: false } },
    'documentation-sync': { patternRole: 'standalone', stage: 'Release', produces: { pr: true, issue: false } },
    'release-notes-writer': { patternRole: 'standalone', stage: 'Release', produces: { pr: false, issue: false } },
  };
  for (const [id, exp] of Object.entries(expectations)) {
    const n = normalizeTemplatePorts(readTpl(id));
    assert.equal(n.patternRole, exp.patternRole, `${id} patternRole`);
    assert.ok(n.stageAffinity.includes(exp.stage), `${id} stageAffinity should include ${exp.stage}`);
    assert.deepEqual(n.ports.produces, exp.produces, `${id} produces`);
  }
});

test('generic pattern templates exist with the pattern-trio roles and ports', () => {
  const scout = readTpl('scout');
  assert.equal(normalizeTemplatePorts(scout).patternRole, 'scout');
  assert.deepEqual(normalizeTemplatePorts(scout).ports.consumes, [{ artifact: 'issue', fromSlot: 'stage-entry' }]);
  assert.equal(scout.sessionPolicy, 'per-invocation');

  const author = readTpl('stage-author');
  assert.equal(normalizeTemplatePorts(author).patternRole, 'author');
  assert.deepEqual(normalizeTemplatePorts(author).ports.produces, { pr: true, issue: false });

  const companion = readTpl('stage-companion');
  assert.equal(normalizeTemplatePorts(companion).patternRole, 'companion');
  assert.deepEqual(normalizeTemplatePorts(companion).ports.consumes, [{ artifact: 'pr', fromSlot: 'stage-author' }]);
  assert.deepEqual(normalizeTemplatePorts(companion).ports.produces, { pr: false, issue: true });
  assert.equal(companion.sessionPolicy, 'persistent');
});

test('dispatcher wiring on developer is NOT intrinsic; curation and triage essence are', () => {
  const dev = readTpl('developer');
  assert.deepEqual(intrinsicTriggers(dev).map(t => t.id), ['self-curation']);
  const triage = readTpl('issue-triage');
  const ids = intrinsicTriggers(triage).map(t => t.id);
  assert.ok(ids.includes('triage-issue-opened'));
  const opened = triage.triggers.find(t => t.id === 'triage-issue-opened');
  assert.deepEqual(opened.emits, ['req:refine']);
  const ba = readTpl('business-analyst');
  const refine = ba.triggers.find(t => t.id === 'ba-on-refine');
  assert.equal(refine.labelFilter, 'req:refine');
  assert.equal(refine.intrinsic, true);
});
