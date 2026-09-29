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

test('domainVocabulary: meaningful name tokens only — no role/scope/generic words (#2592 G4)', () => {
  const v = R.domainVocabulary(makeDomain({ name: 'Dev workflow', roles: ['developer'], now: NOW }));
  assert.ok(v.has('workflow'));
  assert.ok(!v.has('developer'), 'role words must not route lessons');
  assert.ok(!v.has('team'));
  const g = R.domainVocabulary(makeDomain({ name: 'Team practice notes', now: NOW }));
  assert.equal(g.size, 0, 'generic words never count as a topic');
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

// ── reconcileDomainProposal (FIX-A: singleton new-domain proposal) ────────────

const proposal = (canonicalIds) => ({
  unrouted: canonicalIds.map((id) => ({ canonicalId: id, entryIds: [id] })),
  budgetBlocked: false,
  reason: 'mass-threshold',
});

test('domainProposalId is a stable per-team id', () => {
  assert.equal(R.domainProposalId('payments'), 'dp-payments');
  assert.equal(R.domainProposalId(''), 'dp-team');
  assert.equal(R.domainProposalId(undefined), 'dp-team');
});

test('reconcileDomainProposal creates exactly one open proposal card', () => {
  const rows = R.reconcileDomainProposal([], {
    proposal: proposal(['a', 'b', 'c']), teamId: 'payments', teamSegment: 'payments', now: NOW,
  });
  const props = rows.filter((r) => r.source === 'domain-proposal');
  assert.equal(props.length, 1);
  assert.equal(props[0].id, 'dp-payments');
  assert.equal(props[0].status, 'open');
  assert.deepEqual(props[0].unroutedIds, ['a', 'b', 'c']);
});

test('reconcileDomainProposal: shifting unrouted set upserts the SAME card, never a second', () => {
  let rows = R.reconcileDomainProposal([], {
    proposal: proposal(['a', 'b']), teamId: 't', teamSegment: 't', now: '2026-07-20T00:00:00Z',
  });
  rows = R.reconcileDomainProposal(rows, {
    proposal: proposal(['a', 'b', 'c']), teamId: 't', teamSegment: 't', now: NOW,
  });
  const props = rows.filter((r) => r.source === 'domain-proposal');
  assert.equal(props.length, 1);
  assert.deepEqual(props[0].unroutedIds, ['a', 'b', 'c']);
  assert.equal(props[0].raisedAt, NOW); // bumped
});

test('reconcileDomainProposal respects a dismissed singleton (raises nothing)', () => {
  const existing = [{ id: 'dp-t', source: 'domain-proposal', status: 'dismissed', teamId: 't' }];
  const rows = R.reconcileDomainProposal(existing, {
    proposal: proposal(['a', 'b', 'c']), teamId: 't', teamSegment: 't', now: NOW,
  });
  const props = rows.filter((r) => r.source === 'domain-proposal');
  assert.equal(props.length, 1);
  assert.equal(props[0].status, 'dismissed');
});

test('reconcileDomainProposal collapses a legacy dp-<hash> pile to one open card', () => {
  const legacy = [
    { id: 'dp-1111', source: 'domain-proposal', status: 'open', raisedAt: '2026-07-01T00:00:00Z' },
    { id: 'dp-2222', source: 'domain-proposal', status: 'open', raisedAt: '2026-07-10T00:00:00Z' },
    { id: 'dp-3333', source: 'domain-proposal', status: 'open', raisedAt: '2026-07-05T00:00:00Z' },
    { id: 'x', source: 'convergence', status: 'open' },
  ];
  const rows = R.reconcileDomainProposal(legacy, { teamId: 't', teamSegment: 't', now: NOW }); // no new proposal this pass
  const props = rows.filter((r) => r.source === 'domain-proposal' && r.status === 'open');
  assert.equal(props.length, 1);
  assert.equal(props[0].id, 'dp-2222'); // newest raisedAt kept
  assert.ok(rows.some((r) => r.id === 'x')); // non-proposal rows untouched
});

test('reconcileDomainProposal leaves non-proposal rows untouched', () => {
  const rows = R.reconcileDomainProposal(
    [{ id: 'c1', source: 'convergence', status: 'open' }, { id: 'c2', source: 'related', status: 'open' }],
    { proposal: proposal(['a', 'b']), teamId: 't', teamSegment: 't', now: NOW },
  );
  assert.ok(rows.find((r) => r.id === 'c1'));
  assert.ok(rows.find((r) => r.id === 'c2'));
});

// --- #2592: ties + one batched LLM call per pass with heuristic fallback -------

test('classifyCandidateToDomain: a tie between two domains routes nowhere (#2592 G4)', () => {
  const doms = [
    makeDomain({ name: 'Build pipeline', now: NOW }),
    makeDomain({ name: 'Release pipeline', now: NOW }),
  ];
  assert.equal(R.classifyCandidateToDomain(cand('c1', 'keep the pipeline green'), doms), null);
  // A clear winner still routes.
  const m = R.classifyCandidateToDomain(cand('c2', 'the release pipeline must tag'), doms);
  assert.equal(m.domainId, 'release-pipeline');
});

test('classifyCandidateToDomain: a role word in the lesson no longer routes it (#2592 G4)', () => {
  assert.equal(R.classifyCandidateToDomain(cand('c1', 'the developer should run tests first'), DOMAINS), null);
});

test('classifyClustersToDomains: ONE batched LLM call routes every cluster, method recorded (AC6)', async () => {
  const calls = [];
  const classify = async (req) => {
    calls.push(req);
    return '[{"lesson":1,"domain":"review-practice"},{"lesson":2,"domain":null}]';
  };
  const out = await R.classifyClustersToDomains(
    [cand('c1', 'approve only after CI'), cand('c2', 'unrelated lesson text')],
    DOMAINS,
    { classify },
  );
  assert.equal(calls.length, 1, 'exactly one call per pass');
  assert.equal(out.llmCalls, 1);
  assert.equal(out.method, 'llm');
  assert.deepEqual(out.routed.map((r) => [r.candidate.id, r.domainId, r.via]), [['c1', 'review-practice', 'llm']]);
  assert.deepEqual(out.unrouted.map((u) => [u.candidate.id, u.via]), [['c2', 'llm']]);
});

test('classifyClustersToDomains: LLM failure / garbage / no transport → keyword heuristic (AC6)', async () => {
  const lessons = [cand('c1', 'code review for pull requests'), cand('c2', 'nothing matching here')];
  for (const classify of [
    async () => { throw new Error('down'); },
    async () => 'I cannot help with that',
    async () => null,
    undefined,
  ]) {
    const out = await R.classifyClustersToDomains(lessons, DOMAINS, { classify });
    assert.equal(out.method, 'heuristic');
    assert.equal(out.llmCalls, classify ? 1 : 0);
    assert.deepEqual(out.routed.map((r) => [r.candidate.id, r.domainId, r.via]), [['c1', 'review-practice', 'vocab']]);
    assert.deepEqual(out.unrouted.map((u) => [u.candidate.id, u.via]), [['c2', 'heuristic']]);
  }
});

test('classifyClustersToDomains: lineage first, no LLM call when everything is lineage-routed', async () => {
  let n = 0;
  const out = await R.classifyClustersToDomains(
    [cand('c1', 'anything', ['e1'])],
    DOMAINS,
    { classify: async () => { n += 1; return '[]'; }, skillEntryIdsByDomain: { 'dev-workflow': ['e1'] } },
  );
  assert.equal(n, 0);
  assert.equal(out.method, 'lineage');
  assert.deepEqual(out.routed.map((r) => [r.domainId, r.via]), [['dev-workflow', 'lineage']]);
});

test('classifyClustersToDomains: no domains → everything unrouted, no call', async () => {
  let n = 0;
  const out = await R.classifyClustersToDomains([cand('c1', 'x')], [], { classify: async () => { n += 1; } });
  assert.equal(n, 0);
  assert.equal(out.method, 'none');
  assert.deepEqual(out.unrouted.map((u) => u.via), ['none']);
});
