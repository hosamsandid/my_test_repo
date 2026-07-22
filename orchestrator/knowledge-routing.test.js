'use strict';

const test = require('node:test');
const assert = require('node:assert');

const R = require('./knowledge-routing');
const { makeDomain } = require('./knowledge-domains');

const NOW = '2026-07-22T00:00:00Z';

const DOMAINS = [
  makeDomain({ name: 'Dev workflow', roles: ['developer'], now: NOW }),
  makeDomain({ name: 'Review practice', roles: ['code-reviewer'], now: NOW }),
];

function cand(id, text, entryIds = [id], convergence = ['a', 'b']) {
  return { id, text, entryIds, convergence, kind: 'convention' };
}

test('domainVocabulary: tokens from name + scope + roles', () => {
  const v = R.domainVocabulary(makeDomain({ name: 'Dev workflow', roles: ['developer'], now: NOW }));
  assert.ok(v.has('workflow'));
  assert.ok(v.has('developer'));
});

test('classifyCandidateToDomain: vocab match routes to best domain', () => {
  const m = R.classifyCandidateToDomain(cand('c1', 'the code review practice for pull requests'), DOMAINS);
  assert.ok(m);
  assert.equal(m.domainId, 'review-practice');
  assert.equal(m.via, 'vocab');
});

test('classifyCandidateToDomain: lineage (entry-id overlap with a skill) dominates', () => {
  const m = R.classifyCandidateToDomain(
    cand('c1', 'totally unrelated words here', ['shared-1']),
    DOMAINS,
    { skillEntryIdsByDomain: { 'dev-workflow': ['shared-1'] } },
  );
  assert.ok(m);
  assert.equal(m.domainId, 'dev-workflow');
  assert.equal(m.via, 'lineage');
});

test('classifyCandidateToDomain: tags route when text does not', () => {
  const m = R.classifyCandidateToDomain(
    cand('c1', 'zzz qqq'),
    DOMAINS,
    { tagsByEntryId: { c1: ['workflow'] } },
  );
  assert.ok(m);
  assert.equal(m.domainId, 'dev-workflow');
  assert.equal(m.via, 'tag');
});

test('classifyCandidateToDomain: no signal → null; empty domains → null', () => {
  assert.equal(R.classifyCandidateToDomain(cand('c1', 'zzz qqq nothing matches'), DOMAINS), null);
  assert.equal(R.classifyCandidateToDomain(cand('c1', 'anything'), []), null);
});

test('newDomainQualifies: needs mass on all three axes', () => {
  // 5 lessons, 3 sub-topics, 2 agents → qualifies
  const pool = [
    cand('a', 'alpha topic one', ['e1'], ['x', 'y']),
    cand('b', 'alpha topic two', ['e2'], ['x']),
    cand('c', 'beta subject here', ['e3'], ['y']),
    cand('d', 'gamma matter now', ['e4'], ['x']),
    cand('e', 'gamma matter also', ['e5'], ['y']),
  ];
  assert.equal(R.newDomainQualifies(pool), true);
  // one lesson → never
  assert.equal(R.newDomainQualifies([cand('a', 'lonely', ['e1'], ['x', 'y', 'z'])]), false);
});

test('planDomainRouting: amendments vs unrouted + feed event', () => {
  const cands = [
    cand('c1', 'code review practice for pull requests'),
    cand('c2', 'zzz qqq nothing at all matches here'),
  ];
  const out = R.planDomainRouting(cands, DOMAINS, { teamId: 't', now: NOW });
  assert.equal(out.amendments.length, 1);
  assert.equal(out.amendments[0].skill, 'review-practice');
  assert.equal(out.unrouted.length, 1);
  assert.equal(out.batch.type, 'domain-routing');
  assert.equal(out.batch.amendmentCount, 1);
});

test('planDomainRouting: no domains → everything unrouted, no crash', () => {
  const out = R.planDomainRouting([cand('c1', 'anything')], [], { now: NOW });
  assert.equal(out.amendments.length, 0);
  assert.equal(out.unrouted.length, 1);
  assert.equal(out.newDomainProposal, null);
});

test('planDomainRouting: mass unrouted raises a new-domain proposal; budget blocks it', () => {
  const pool = [
    cand('a', 'alpha topic one', ['e1'], ['x', 'y']),
    cand('b', 'alpha topic two', ['e2'], ['x']),
    cand('c', 'beta subject here', ['e3'], ['y']),
    cand('d', 'gamma matter now', ['e4'], ['x']),
    cand('e', 'gamma matter also', ['e5'], ['y']),
  ];
  const free = R.planDomainRouting(pool, DOMAINS, { now: NOW });
  assert.ok(free.newDomainProposal);
  assert.equal(free.newDomainProposal.budgetBlocked, false);
  assert.equal(free.newDomainProposal.reason, 'mass-threshold');

  const blocked = R.planDomainRouting(pool, DOMAINS, { budgetOver: true, now: NOW });
  assert.ok(blocked.newDomainProposal);
  assert.equal(blocked.newDomainProposal.budgetBlocked, true);
  assert.equal(blocked.newDomainProposal.reason, 'over-budget');
});

// --- batched LLM classification ---------------------------------------------

test('buildBatchClassificationRequest: numbers domains + lessons', () => {
  const req = R.buildBatchClassificationRequest([cand('c1', 'lesson text')], DOMAINS);
  const c = req.messages[0].content;
  assert.ok(c.includes('id="dev-workflow"'));
  assert.ok(c.includes('1. lesson text'));
  assert.ok(c.includes('JSON array'));
});

test('applyBatchClassification: parses valid response, ignores bad domain ids', () => {
  const unrouted = [cand('c1', 'x'), cand('c2', 'y'), cand('c3', 'z')];
  const text = '[{"lesson":1,"domain":"dev-workflow"},{"lesson":2,"domain":null},{"lesson":3,"domain":"nope"}]';
  const out = R.applyBatchClassification(text, unrouted, DOMAINS);
  assert.ok(out);
  assert.equal(out.amendments.length, 1);
  assert.equal(out.amendments[0].candidate.id, 'c1');
  assert.equal(out.amendments[0].skill, 'dev-workflow');
  assert.equal(out.amendments[0].via, 'llm');
  assert.equal(out.stillUnrouted.length, 2); // c2 (null) + c3 (invalid id)
});

test('applyBatchClassification: unusable response → null (heuristic fallback signal)', () => {
  assert.equal(R.applyBatchClassification('not json at all', [cand('c1', 'x')], DOMAINS), null);
  assert.equal(R.applyBatchClassification(null, [cand('c1', 'x')], DOMAINS), null);
});
