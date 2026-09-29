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
