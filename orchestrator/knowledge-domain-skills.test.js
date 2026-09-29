'use strict';

const test = require('node:test');
const assert = require('node:assert');

const S = require('./knowledge-domain-skills');
const { makeDomain } = require('./knowledge-domains');

const NOW = '2026-09-30T00:00:00Z';
const DEV = makeDomain({ name: 'Dev workflow', now: NOW });
const REVIEW = makeDomain({ name: 'Review practice', now: NOW });

function lesson(id, { entryIds = [`e-${id}`], agents = ['a1', 'a2'], text = `lesson ${id}`, kind = 'convention' } = {}) {
  return {
    id,
    teamId: 't1',
    kind,
    canonicalId: entryIds[0],
    entryIds,
    convergence: agents,
    convergenceCount: agents.length,
    text,
    members: entryIds.map((e, i) => ({ id: e, text: `${text} (${i})`, originAgent: agents[i % agents.length] })),
    status: 'open',
  };
}

function queued(id, domainId, opts) {
  return S.queuedRow(lesson(id, opts), { domainId, via: 'llm', now: NOW });
}

// --- routing inputs -----------------------------------------------------------

test('planRoutingInputs: new clusters are classified; settled + current rows are not', () => {
  const cands = [lesson('new'), lesson('done'), lesson('q'), lesson('gone'), lesson('u-cur'), lesson('u-old'), lesson('card')];
  const rows = [
    { id: 'done', status: 'promoted' },
    { id: 'q', status: 'domain-queued', domainId: DEV.id },
    { id: 'gone', status: 'domain-queued', domainId: 'removed-domain' },
    { id: 'u-cur', status: 'unrouted', routedAgainst: 'v2' },
    { id: 'u-old', status: 'unrouted', routedAgainst: 'v1' },
    { id: 'card', status: 'open', extendMode: true, domainId: DEV.id },
  ];
  const out = S.planRoutingInputs(cands, rows, { domainIds: [DEV.id, REVIEW.id], domainsVersion: 'v2' });
  assert.deepEqual(out.toClassify.map((c) => c.id), ['new', 'gone', 'u-old']);
  assert.deepEqual(out.migrate.map((c) => c.id), ['card']);
  assert.equal(out.claimedCanonicalIds.size, 7);
});

test('planRoutingInputs: a legacy digest-only row is classified like a new lesson (review B1)', () => {
  const out = S.planRoutingInputs([lesson('dig')], [{ id: 'dig', status: 'digest-only' }], { domainIds: [DEV.id], domainsVersion: 'v1' });
  assert.deepEqual(out.toClassify.map((c) => c.id), ['dig']);
});

test('planRoutingInputs: a grown cluster replaces its older row and stays in its domain (review B2)', () => {
  const old = queued('old', DEV.id, { entryIds: ['e1', 'e2'] });
  const grown = { ...lesson('grown', { entryIds: ['e1', 'e2', 'e3'] }) };
  const out = S.planRoutingInputs([grown], [old], { domainIds: [DEV.id], domainsVersion: 'v1' });
  assert.deepEqual(out.toClassify, [], 'no second LLM classification for the same lesson');
  assert.deepEqual(out.regrown.map((g) => [g.candidate.id, g.domainId, g.via]), [['grown', DEV.id, 'llm']]);
  assert.deepEqual(out.supersede, [{ id: 'old', supersededBy: 'grown' }]);
  // Its domain was removed → classify afresh, still superseding the older row.
  const gone = S.planRoutingInputs([grown], [old], { domainIds: [REVIEW.id], domainsVersion: 'v1' });
  assert.deepEqual(gone.toClassify.map((c) => c.id), ['grown']);
  assert.deepEqual(gone.regrown, []);
  assert.deepEqual(gone.supersede, [{ id: 'old', supersededBy: 'grown' }]);
  // A settled row of the same canonicalId is left alone.
  const done = S.planRoutingInputs([grown], [{ ...old, status: 'promoted' }], { domainIds: [DEV.id], domainsVersion: 'v1' });
  assert.deepEqual(done.supersede, []);
  assert.deepEqual(done.toClassify.map((c) => c.id), ['grown']);
});

test('bundleLessons: a grown cluster (same canonicalId, superset entryIds) counts as ONE lesson (review B2)', () => {
  const rows = [
    queued('old', DEV.id, { entryIds: ['e1', 'e2'] }),
    queued('grown', DEV.id, { entryIds: ['e1', 'e2', 'e3'] }),
    queued('other', DEV.id, { entryIds: ['f1', 'f2'] }),
  ];
  const b = S.bundleLessons(DEV, rows);
  assert.equal(b.lessonCount, 2);
  assert.deepEqual(b.lessonIds, ['old', 'grown', 'other'], 'every row is still settled by provenance');
  const plan = S.planDomainSkillWork(rows.slice(0, 2).concat(queued('x', DEV.id, { entryIds: ['e1', 'e4'] })), [DEV], {
    existingSkillNames: [], autoApply: true,
  });
  assert.equal(plan.waiting[0].reason, 'below-threshold', 'three rows of ONE lesson do not meet the 3-lesson bar');
});

test('queuedRow strips per-lesson card fields; unroutedRow records the taxonomy version', () => {
  const q = S.queuedRow({ ...lesson('x'), matchedSkill: { name: 'lesson-x' }, extendMode: true, autoDrafted: true }, { domainId: DEV.id, via: 'vocab', now: NOW });
  assert.equal(q.status, 'domain-queued');
  assert.equal(q.domainId, DEV.id);
  assert.equal(q.routedVia, 'vocab');
  assert.equal(q.matchedSkill, undefined);
  assert.equal(q.extendMode, undefined);
  const u = S.unroutedRow(lesson('y'), { via: 'llm', domainsVersion: 'v9', now: NOW });
  assert.equal(u.status, 'unrouted');
  assert.equal(u.routedAgainst, 'v9');
  assert.equal(u.routedVia, 'llm');
});

// --- planning (D1/D2) -----------------------------------------------------------

test('planDomainSkillWork: first skill waits below the threshold (>=3 lessons, >=2 agents)', () => {
  const rows = [queued('l1', DEV.id), queued('l2', DEV.id)];
  const p = S.planDomainSkillWork(rows, [DEV], { existingSkillNames: [], autoApply: true });
  assert.equal(p.apply.length, 0);
  assert.equal(p.cards.length, 0);
  assert.equal(p.waiting[0].reason, 'below-threshold');

  // Three lessons, but all from ONE agent → still waiting.
  const solo = ['l1', 'l2', 'l3'].map((id) => queued(id, DEV.id, { agents: ['a1'] }));
  assert.equal(S.planDomainSkillWork(solo, [DEV], { autoApply: true }).waiting[0].reason, 'below-threshold');
});

test('planDomainSkillWork: threshold met + auto → ONE create item bundling every lesson (AC1)', () => {
  const rows = ['l1', 'l2', 'l3'].map((id) => queued(id, DEV.id));
  const p = S.planDomainSkillWork(rows, [DEV, REVIEW], { existingSkillNames: [], autoApply: true });
  assert.equal(p.apply.length, 1);
  const it = p.apply[0];
  assert.equal(it.mode, 'create');
  assert.equal(it.skillName, DEV.id, 'skill is named after the domain, never a lesson');
  assert.deepEqual(it.bundle.lessonIds, ['l1', 'l2', 'l3']);
  assert.deepEqual(it.bundle.entryIds, ['e-l1', 'e-l2', 'e-l3']);
  assert.equal(it.bundle.text, 'Dev workflow');
});

test('planDomainSkillWork: an existing domain skill is extended, even with one lesson (AC2)', () => {
  const p = S.planDomainSkillWork([queued('l9', DEV.id)], [DEV], { existingSkillNames: new Set([DEV.id]), autoApply: true });
  assert.equal(p.apply.length, 1);
  assert.equal(p.apply[0].mode, 'extend');
  assert.equal(p.apply[0].skillName, DEV.id);
});

test('planDomainSkillWork: the configured threshold is honoured (AC12)', () => {
  const rows = [queued('l1', DEV.id), queued('l2', DEV.id)];
  const p = S.planDomainSkillWork(rows, [DEV], { threshold: { minLessons: 2, minAgents: 2 }, autoApply: true });
  assert.equal(p.apply.length, 1);
});

test('planDomainSkillWork: without auto everything becomes a card; the per-pass cap defers the rest', () => {
  const rows = [
    ...['a', 'b', 'c'].map((id) => queued(id, DEV.id)),
    queued('r1', REVIEW.id),
  ];
  const names = new Set([REVIEW.id]);
  const review = S.planDomainSkillWork(rows, [DEV, REVIEW], { existingSkillNames: names, autoApply: false });
  assert.equal(review.apply.length, 0);
  assert.deepEqual(review.cards.map((c) => [c.domain.id, c.mode]), [[DEV.id, 'create'], [REVIEW.id, 'extend']]);

  const capped = S.planDomainSkillWork(rows, [DEV, REVIEW], { existingSkillNames: names, autoApply: true, cap: 1 });
  assert.equal(capped.apply.length, 1);
  assert.equal(capped.waiting.length, 1);
  assert.equal(capped.waiting[0].reason, 'over-cap');
});

// --- the one card per domain (AC3) ---------------------------------------------------

test('reconcileDomainCards: at most ONE open card per domain, listing every pending lesson', () => {
  const rows1 = ['a', 'b', 'c'].map((id) => queued(id, DEV.id));
  const p1 = S.planDomainSkillWork(rows1, [DEV], {});
  let store = S.reconcileDomainCards(rows1, p1.cards, { teamId: 't1', now: NOW, gateReason: 'gated' });
  let cards = store.filter(S.isDomainCard);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.id, 'ds-dev-workflow');
  assert.equal(card.status, 'open');
  assert.equal(card.domainName, 'Dev workflow');
  assert.equal(card.domainSkill, DEV.id);
  assert.equal(card.mode, 'create');
  assert.equal(card.matchedSkill, null);
  assert.equal(card.gateReason, 'gated');
  assert.deepEqual(card.lessonIds, ['a', 'b', 'c']);
  assert.match(card.text, /^Create skill Dev workflow — 3 pending lessons$/);

  // A fourth lesson upserts the SAME card.
  const rows2 = [...store, queued('d', DEV.id)];
  const p2 = S.planDomainSkillWork(rows2.filter((r) => r.status === 'domain-queued'), [DEV], {});
  store = S.reconcileDomainCards(rows2, p2.cards, { teamId: 't1', now: NOW });
  cards = store.filter(S.isDomainCard);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].lessonIds, ['a', 'b', 'c', 'd']);
});

test('reconcileDomainCards: a dismissed card stays dismissed until a NEW lesson joins', () => {
  const rows = ['a', 'b', 'c'].map((id) => queued(id, DEV.id));
  const items = S.planDomainSkillWork(rows, [DEV], {}).cards;
  const first = S.reconcileDomainCards(rows, items, { now: NOW });
  const dismissed = first.map((r) => (S.isDomainCard(r) ? { ...r, status: 'dismissed', dismissedAt: NOW } : r));
  const again = S.reconcileDomainCards(dismissed, items, { now: NOW });
  assert.equal(again.find(S.isDomainCard).status, 'dismissed');

  const grown = [...dismissed, queued('d', DEV.id)];
  const items2 = S.planDomainSkillWork(grown.filter((r) => r.status === 'domain-queued'), [DEV], {}).cards;
  const reopened = S.reconcileDomainCards(grown, items2, { now: NOW }).find(S.isDomainCard);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.dismissedAt, undefined);
});

test('reconcileDomainCards: an accepted card re-opens for lessons its skill did not cover (review S1)', () => {
  const rows = ['a', 'b', 'c'].map((id) => queued(id, DEV.id));
  const items = S.planDomainSkillWork(rows, [DEV], {}).cards;
  const first = S.reconcileDomainCards(rows, items, { now: NOW });
  // Accepted: a and b settled by provenance, c (added while the dialog was open) left queued.
  const accepted = first.map((r) => (S.isDomainCard(r) ? { ...r, status: 'promoted', resolvedAt: NOW }
    : r.id === 'c' ? r : { ...r, status: 'promoted' }));
  const left = accepted.filter((r) => r.status === 'domain-queued');
  const items2 = S.planDomainSkillWork(left, [DEV], { threshold: { minLessons: 1, minAgents: 1 } }).cards;
  const card = S.reconcileDomainCards(accepted, items2, { now: NOW }).find(S.isDomainCard);
  assert.equal(card.status, 'open');
  assert.deepEqual(card.lessonIds, ['c']);
  assert.equal(card.resolvedAt, undefined);
});

test('reconcileDomainCards: an open card with no work left is superseded', () => {
  const rows = ['a', 'b', 'c'].map((id) => queued(id, DEV.id));
  const store = S.reconcileDomainCards(rows, S.planDomainSkillWork(rows, [DEV], {}).cards, { now: NOW });
  const after = S.reconcileDomainCards(store, [], { now: NOW });
  assert.equal(after.find(S.isDomainCard).status, 'superseded');
});

test('an extend card targets the domain skill (matchedSkill = the domain skill)', () => {
  const rows = [queued('a', DEV.id)];
  const items = S.planDomainSkillWork(rows, [DEV], { existingSkillNames: [DEV.id] }).cards;
  const card = S.reconcileDomainCards(rows, items, { now: NOW }).find(S.isDomainCard);
  assert.equal(card.mode, 'extend');
  assert.equal(card.extendMode, true);
  assert.deepEqual(card.matchedSkill, { name: DEV.id, tier: 'team' });
  assert.match(card.text, /^Update skill Dev workflow — 1 pending lesson$/);
});

// --- drafts + provenance (AC1) + settlement (AC8) --------------------------------------

test('domainSkillDraft + provenance: domain-named skill, provenance lists every lesson entry id', () => {
  const rows = ['a', 'b', 'c'].map((id) => queued(id, DEV.id));
  const { bundle } = S.planDomainSkillWork(rows, [DEV], { autoApply: true }).apply[0];
  const draft = S.domainSkillDraft(DEV, bundle);
  assert.equal(draft.name, DEV.id);
  assert.match(draft.skillMd, /# Dev workflow/);
  const prov = S.domainSkillProvenance({ teamId: 't1', domain: DEV, bundle, now: NOW });
  assert.deepEqual(prov.entryIds, ['e-a', 'e-b', 'e-c']);
  assert.equal(prov.domainId, DEV.id);
});

test('settleCoveredRows: only lessons whose ids are in the skill provenance are marked promoted (AC8, G6)', () => {
  const rows = [queued('a', DEV.id), queued('b', DEV.id, { entryIds: ['e-b', 'e-b2'] }), queued('c', DEV.id)];
  const out = S.settleCoveredRows(rows, ['a', 'b', 'c'], ['e-a', 'e-b'], { promotedInto: DEV.id });
  assert.deepEqual(out.settled, ['a']);
  assert.deepEqual(out.uncovered, ['b', 'c']);
  assert.equal(out.rows[0].status, 'promoted');
  assert.equal(out.rows[0].promotedInto, DEV.id);
  assert.equal(out.rows[1].status, 'domain-queued', 'partially covered lesson is NOT marked promoted');
  assert.equal(out.rows[2].status, 'domain-queued');
});

test('settleCoveredRows: a row with no entry ids is never settled', () => {
  const out = S.settleCoveredRows([{ id: 'z', entryIds: [], status: 'domain-queued' }], ['z'], ['anything']);
  assert.deepEqual(out.settled, []);
  assert.equal(out.rows[0].status, 'domain-queued');
});

test('foldIntoSkill: provenance is unioned even when no new statement is added (G6)', () => {
  const bundle = S.bundleLessons(DEV, [queued('a', DEV.id, { text: 'run lint' })]);
  const existingMd = '---\nname: dev-workflow\ndescription: x\n---\n# Dev workflow\n\n- run lint (0)\n';
  const out = S.foldIntoSkill({
    existingMd, existingProv: { entryIds: ['old'], amendmentsSinceDistillation: 2 },
    candidate: bundle, name: DEV.id, domain: DEV, teamId: 't1', now: NOW,
  });
  assert.equal(out.added, 0);
  assert.deepEqual(out.provenance.entryIds, ['old', 'e-a']);
  assert.equal(out.provenance.amendmentsSinceDistillation, 2, 'no content → no amendment counted');

  const grown = S.foldIntoSkill({
    existingMd, existingProv: { entryIds: ['old'], amendmentsSinceDistillation: 2 },
    candidate: S.bundleLessons(DEV, [queued('b', DEV.id, { text: 'squash before merge' })]),
    name: DEV.id, domain: DEV, teamId: 't1', now: NOW,
  });
  assert.equal(grown.added, 1);
  assert.equal(grown.provenance.amendmentsSinceDistillation, 3);
  assert.match(grown.skillMd, /squash before merge/);
});

// --- end to end over the pure cores (review S4) ------------------------------

test('pipeline: 2-agent conventions the digest gate would park reach the domain threshold (review B1, S4)', () => {
  const C = require('./knowledge-convergence');
  const cluster = (key, n, agents = ['dev-1', 'rev-1']) => {
    const memberIds = Array.from({ length: n }, (_, i) => `${key}-${i}`);
    return {
      kind: 'convention', canonicalId: memberIds[0], memberIds,
      members: memberIds.map((id, i) => ({ id, originAgent: agents[i % agents.length], text: `${key} rule` })),
      convergence: agents, convergenceCount: agents.length, text: `${key} rule`,
    };
  };
  const clusters = [cluster('lint', 2), cluster('squash', 2), cluster('tests', 2)];
  // What the #779 gate does to them (why domain mode must not sit behind it):
  const routed = C.planDigestRouting(clusters, [], { threshold: 2, graduateAtAgents: 4, teamId: 't1', now: NOW });
  assert.equal(routed.candidateClusters.length, 0, 'every 2-agent convention is digest-only for the gate');
  // Domain mode routes the converged clusters themselves.
  const cands = clusters.filter((c) => C.crossesConvergence(c, 2)).map((c) => C.toCandidate(c, { teamId: 't1', now: NOW }));
  const inputs = S.planRoutingInputs(cands, routed.rows, { domainIds: [DEV.id], domainsVersion: 'v1' });
  assert.equal(inputs.toClassify.length, 3, 'legacy digest-only rows are re-classified');
  const rows = inputs.toClassify.map((c) => S.queuedRow(c, { domainId: DEV.id, via: 'llm', now: NOW }));
  assert.ok(rows.every((r) => r.status === 'domain-queued'));
  const plan = S.planDomainSkillWork(rows, [DEV], { existingSkillNames: [], autoApply: true });
  assert.equal(plan.apply.length, 1, '3 lessons from 2 agents create the domain skill');
  assert.equal(plan.apply[0].mode, 'create');
  assert.equal(plan.apply[0].bundle.lessonCount, 3);

  // The lint cluster grows (a third entry): one row replaces the other, count stays 3.
  const grownCluster = cluster('lint', 3);
  const grownCand = C.toCandidate(grownCluster, { teamId: 't1', now: NOW });
  assert.notEqual(grownCand.id, rows[0].id, 'growth changes the stable id');
  const again = S.planRoutingInputs([grownCand], rows, { domainIds: [DEV.id], domainsVersion: 'v1' });
  assert.deepEqual(again.supersede, [{ id: rows[0].id, supersededBy: grownCand.id }]);
  const next = rows.map((r) => (r.id === rows[0].id ? { ...r, status: 'superseded' } : r))
    .concat(again.regrown.map((g) => S.queuedRow(g.candidate, { domainId: g.domainId, via: g.via, now: NOW })));
  const queuedNow = next.filter((r) => r.status === S.QUEUED_STATUS);
  assert.equal(queuedNow.length, 3);
  assert.equal(S.bundleLessons(DEV, queuedNow).lessonCount, 3);
});
