'use strict';

const test = require('node:test');
const assert = require('node:assert');

const D = require('./knowledge-domains');

const NOW = '2026-07-22T00:00:00Z';

test('slugifyDomainId: clean, skill-writable ids from short names', () => {
  assert.equal(D.slugifyDomainId('Dev workflow'), 'dev-workflow');
  assert.equal(D.slugifyDomainId('CI & build'), 'ci-and-build');
  assert.equal(D.slugifyDomainId('Review practice'), 'review-practice');
  assert.equal(D.slugifyDomainId(''), 'domain');
  // never emits a slug that fails the skill-name regex
  assert.ok(D.SKILL_NAME_RE.test(D.slugifyDomainId('!!!')));
});

test('domainSkillName: explicit skill wins, else id, else slug of name', () => {
  assert.equal(D.domainSkillName({ id: 'dev-workflow', name: 'Dev workflow' }), 'dev-workflow');
  assert.equal(D.domainSkillName({ id: 'x', skill: 'custom-skill' }), 'custom-skill');
  assert.equal(D.domainSkillName({ name: 'Repo conventions' }), 'repo-conventions');
});

test('makeDomain: derives id + defaults scope/roles', () => {
  const d = D.makeDomain({ name: 'CI & build', now: NOW });
  assert.equal(d.id, 'ci-and-build');
  assert.equal(d.scope, 'team');
  assert.deepEqual(d.roles, []);
  assert.equal(d.createdAt, NOW);
  const r = D.makeDomain({ name: 'Review', scope: 'nonsense', roles: ['x', 'x', ''], now: NOW });
  assert.equal(r.scope, 'team'); // invalid scope → default
  assert.deepEqual(r.roles, ['x']); // deduped, empties dropped
});

test('seedDomainsFromRoles: dev team gets the base + role-gated domains', () => {
  const seeded = D.seedDomainsFromRoles(['developer', 'code-reviewer', 'reworker', 'business-analyst'], { now: NOW });
  const ids = seeded.map((d) => d.id);
  assert.ok(ids.includes('dev-workflow'));
  assert.ok(ids.includes('ci-and-build'));
  assert.ok(ids.includes('repo-conventions'));
  assert.ok(ids.includes('review-practice')); // reviewer present
  assert.ok(ids.includes('requirements-and-refinement')); // BA present
});

test('seedDomainsFromRoles: no reviewer/BA → only base domains', () => {
  const seeded = D.seedDomainsFromRoles(['developer'], { now: NOW });
  const ids = seeded.map((d) => d.id);
  assert.ok(ids.includes('dev-workflow'));
  assert.ok(!ids.includes('review-practice'));
  assert.ok(!ids.includes('requirements-and-refinement'));
});

test('validateDomains: drops invalid, dedupes by id', () => {
  const out = D.validateDomains([
    { name: 'Dev workflow' },
    { name: 'Dev workflow' }, // dup id
    { name: '' }, // no name, unusable id
    null,
    { id: 'ci-build', name: 'CI' },
  ], { now: NOW });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((d) => d.id).sort(), ['ci-build', 'dev-workflow']);
});

test('normalizeDomainDoc: tolerates a bare array or partial doc', () => {
  const fromArray = D.normalizeDomainDoc([{ name: 'Dev workflow' }], NOW);
  assert.equal(fromArray.confirmed, false);
  assert.equal(fromArray.domains.length, 1);
  const fromDoc = D.normalizeDomainDoc({ confirmed: true, domains: [{ name: 'CI' }] }, NOW);
  assert.equal(fromDoc.confirmed, true);
});

// --- operator CRUD ----------------------------------------------------------

test('addDomain: appends + emits event, rejects duplicate', () => {
  let doc = D.emptyDomainDoc(NOW);
  const r1 = D.addDomain(doc, { name: 'Dev workflow' }, { teamId: 't', now: NOW });
  assert.ok(r1.ok);
  assert.equal(r1.doc.domains.length, 1);
  assert.equal(r1.event.type, 'domain');
  assert.equal(r1.event.action, 'added');
  const r2 = D.addDomain(r1.doc, { name: 'Dev workflow' }, { now: NOW });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'duplicate-id');
  const r3 = D.addDomain(r1.doc, { name: '' }, { now: NOW });
  assert.equal(r3.error, 'name-required');
});

test('renameDomain: keeps id/skill stable, changes name', () => {
  const base = D.addDomain(D.emptyDomainDoc(NOW), { name: 'Dev workflow' }, { now: NOW }).doc;
  const r = D.renameDomain(base, 'dev-workflow', 'Development flow', { teamId: 't', now: NOW });
  assert.ok(r.ok);
  assert.equal(r.doc.domains[0].id, 'dev-workflow'); // id stable
  assert.equal(r.doc.domains[0].name, 'Development flow');
  assert.equal(r.event.action, 'renamed');
  assert.equal(D.renameDomain(base, 'missing', 'X', {}).error, 'not-found');
});

test('mergeDomains: unions roles, keeps first id', () => {
  let doc = D.emptyDomainDoc(NOW);
  doc = D.addDomain(doc, { name: 'Dev workflow', roles: ['developer'] }, { now: NOW }).doc;
  doc = D.addDomain(doc, { name: 'Coding', roles: ['reworker'] }, { now: NOW }).doc;
  const r = D.mergeDomains(doc, ['dev-workflow', 'coding'], { name: 'Dev', teamId: 't', now: NOW });
  assert.ok(r.ok);
  assert.equal(r.doc.domains.length, 1);
  assert.equal(r.doc.domains[0].id, 'dev-workflow'); // first id kept
  assert.deepEqual(r.doc.domains[0].roles.sort(), ['developer', 'reworker']);
  assert.equal(r.event.action, 'merged');
  assert.equal(D.mergeDomains(doc, ['dev-workflow'], {}).error, 'need-two');
});

test('splitDomain: replaces one with >=2', () => {
  const doc = D.addDomain(D.emptyDomainDoc(NOW), { name: 'Everything' }, { now: NOW }).doc;
  const r = D.splitDomain(doc, 'everything', [{ name: 'Dev workflow' }, { name: 'CI build' }], { teamId: 't', now: NOW });
  assert.ok(r.ok);
  assert.deepEqual(r.doc.domains.map((d) => d.id).sort(), ['ci-build', 'dev-workflow']);
  assert.equal(r.event.action, 'split');
  assert.equal(D.splitDomain(doc, 'everything', [{ name: 'One' }], {}).error, 'need-two');
});

test('removeDomain + confirmDomains', () => {
  const doc = D.addDomain(D.emptyDomainDoc(NOW), { name: 'Dev workflow' }, { now: NOW }).doc;
  const rem = D.removeDomain(doc, 'dev-workflow', { now: NOW });
  assert.ok(rem.ok);
  assert.equal(rem.doc.domains.length, 0);
  const conf = D.confirmDomains(doc, { now: NOW });
  assert.equal(conf.doc.confirmed, true);
  assert.equal(conf.event.action, 'confirmed');
});

// --- bootstrap --------------------------------------------------------------

test('buildBootstrapRequest: numbered lessons + JSON contract', () => {
  const req = D.buildBootstrapRequest(['lesson one', { text: 'lesson two' }], { min: 5, max: 8, roles: ['developer'] });
  assert.ok(req.max_tokens > 0);
  const c = req.messages[0].content;
  assert.ok(c.includes('1. lesson one'));
  assert.ok(c.includes('2. lesson two'));
  assert.ok(c.includes('JSON array'));
  assert.ok(c.includes('developer'));
});

test('parseBootstrapResponse: extracts JSON, tolerant of surrounding prose', () => {
  const out = D.parseBootstrapResponse('Here you go:\n[{"name":"Dev workflow","scope":"team","roles":["developer"]}]\nDone.', { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'dev-workflow');
  assert.deepEqual(D.parseBootstrapResponse('not json', { now: NOW }), []);
  assert.deepEqual(D.parseBootstrapResponse(null, { now: NOW }), []);
});

// --- budget -----------------------------------------------------------------

test('skillBudgetState: over when used >= cap', () => {
  assert.deepEqual(D.skillBudgetState(['a', 'b'], { cap: 5 }), { cap: 5, used: 2, remaining: 3, over: false });
  assert.deepEqual(D.skillBudgetState(['a', 'b', 'c'], { cap: 3 }), { cap: 3, used: 3, remaining: 0, over: true });
  // accepts a count too
  assert.equal(D.skillBudgetState(20, { cap: 12 }).over, true);
  // default cap
  assert.equal(D.skillBudgetState([]).cap, D.DEFAULT_SKILL_BUDGET);
});

// --- #2592 AC10: growing the taxonomy at/over the skill budget needs confirmation ---

test('domainsAddedByOp: add → 1, split → extra parts, confirm → growth; others add nothing', () => {
  const doc = { domains: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(D.domainsAddedByOp(doc, 'add', { domain: { name: 'x' } }), 1);
  assert.equal(D.domainsAddedByOp(doc, 'split', { parts: [{ name: 'p' }, { name: 'q' }, { name: ' ' }] }), 1);
  assert.equal(D.domainsAddedByOp(doc, 'confirm', { domains: [{}, {}, {}, {}] }), 2);
  assert.equal(D.domainsAddedByOp(doc, 'confirm', { domains: [{}] }), 0);
  for (const op of ['rename', 'merge', 'remove', 'read', 'seed', 'bootstrap']) assert.equal(D.domainsAddedByOp(doc, op, {}), 0);
});

test('domainGrowthNeedsConfirmation: below budget passes; at/over budget (skills OR domains) needs confirmation', () => {
  const doc = { domains: [{ id: 'a' }, { id: 'b' }] };
  const roomy = D.skillBudgetState(['s1'], { cap: 5 });
  assert.equal(D.domainGrowthNeedsConfirmation(doc, 'add', {}, roomy).needed, false);
  // Skills at the cap.
  const full = D.skillBudgetState(['s1', 's2', 's3'], { cap: 3 });
  assert.deepEqual(D.domainGrowthNeedsConfirmation(doc, 'add', {}, full), { needed: true, added: 1 });
  // Domains (future skills) would exceed the cap even though few skills exist yet.
  const tight = D.skillBudgetState([], { cap: 2 });
  assert.equal(D.domainGrowthNeedsConfirmation(doc, 'add', {}, tight).needed, true);
  // Ops that add nothing never need confirmation.
  assert.equal(D.domainGrowthNeedsConfirmation(doc, 'remove', { id: 'a' }, full).needed, false);
  assert.equal(D.domainGrowthNeedsConfirmation(doc, 'rename', { id: 'a', name: 'z' }, full).needed, false);
});
