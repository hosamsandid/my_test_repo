'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugifySkillName,
  buildHeuristicSkillDraft,
  validatePromotion,
  buildSkillProvenance,
  validateShareToTeam,
  buildShareProvenance,
  promotionSuggestionView,
  resolvePromotionGates,
} = require('./knowledge-suggestions');

const NOW = '2026-07-08T12:00:00Z';

function candidate(over = {}) {
  return {
    id: '9f3a12bc7de0',
    teamId: 'acme',
    kind: 'fact',
    canonicalId: 'aaaaaaaaaaaa',
    entryIds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
    convergence: ['acme-dev-1', 'acme-dev-2'],
    convergenceCount: 2,
    text: 'This repo unit-tests pure helper cores only',
    members: [
      { id: 'aaaaaaaaaaaa', originAgent: 'acme-dev-1', text: 'This repo unit-tests pure helper cores only', createdAt: '2026-07-08T08:00:00Z', correlationId: '$evt1', sourceRefs: [{ kind: 'pr', ref: '459' }] },
      { id: 'bbbbbbbbbbbb', originAgent: 'acme-dev-2', text: 'Repo tests pure cores only; IO verified manually', createdAt: '2026-07-08T09:00:00Z', correlationId: '$evt2' },
    ],
    source: 'convergence',
    status: 'open',
    raisedAt: NOW,
    ...over,
  };
}

// ── slug ──────────────────────────────────────────────────────────────────

test('slugifySkillName: safe slug, fallback on empty', () => {
  assert.equal(slugifySkillName('This repo unit-tests pure helper cores only'), 'this-repo-unit-tests-pure-helper');
  assert.equal(slugifySkillName('', 'entity'), 'entity-skill');
  assert.equal(slugifySkillName('!!!', 'convention'), 'convention-skill');
});

// ── heuristic draft ─────────────────────────────────────────────────────────

test('buildHeuristicSkillDraft: contains texts + provenance, no secrets', () => {
  const d = buildHeuristicSkillDraft(candidate());
  assert.match(d.name, /^[a-z0-9-]+$/);
  assert.equal(d.llmDrafted, false);
  assert.ok(d.skillMd.startsWith('# '));
  assert.ok(d.skillMd.includes('This repo unit-tests pure helper cores only'));
  assert.ok(d.skillMd.includes('IO verified manually'));
  assert.ok(d.skillMd.includes('acme-dev-1'));
  assert.ok(d.skillMd.includes('aaaaaaaaaaaa')); // entry id in provenance section
  // no correlationId / event ids leak into the body
  assert.ok(!d.skillMd.includes('$evt1'));
});

// ── validatePromotion ───────────────────────────────────────────────────────

test('validatePromotion: allowed transitions (team→team, team→global, agent→team)', () => {
  const base = { name: 'my-skill', skillMd: '# x', entryIds: ['aaaaaaaaaaaa'] };
  assert.equal(validatePromotion({ ...base, from: 'team', to: 'team' }).ok, true);
  assert.equal(validatePromotion({ ...base, from: 'team', to: 'global' }).ok, true);
  assert.equal(validatePromotion({ ...base, from: 'agent', to: 'team' }).ok, true); // Phase 4 agent rung
});

test('validatePromotion: rejects bad transitions + missing provenance + bad name', () => {
  const base = { name: 'my-skill', skillMd: '# x', entryIds: ['aaaaaaaaaaaa'] };
  assert.equal(validatePromotion({ ...base, from: 'agent', to: 'global' }).ok, false); // agent→global not allowed
  assert.equal(validatePromotion({ ...base, from: 'global', to: 'team' }).ok, false);
  assert.equal(validatePromotion({ ...base, from: 'team', to: 'agent' }).ok, false);
  assert.equal(validatePromotion({ from: 'team', to: 'global', name: 'my-skill', skillMd: '# x', entryIds: [] }).ok, false);
  assert.equal(validatePromotion({ from: 'team', to: 'global', name: 'my-skill', skillMd: '# x' }).ok, false);
  assert.equal(validatePromotion({ from: 'team', to: 'global', name: 'bad name!', skillMd: '# x', entryIds: ['aaaaaaaaaaaa'] }).ok, false);
  assert.equal(validatePromotion({ from: 'team', to: 'global', name: 'x', skillMd: '', entryIds: ['aaaaaaaaaaaa'] }).ok, false);
  // non-hex entry id filtered → empty → rejected
  assert.equal(validatePromotion({ ...base, from: 'team', to: 'global', entryIds: ['not-hex'] }).ok, false);
});

// ── provenance ──────────────────────────────────────────────────────────────

test('buildSkillProvenance: carries the full trace', () => {
  const p = buildSkillProvenance({
    from: 'team', to: 'global', teamId: 'acme',
    entryIds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
    candidate: candidate(), promotedBy: 'thorsten', now: NOW,
  });
  assert.equal(p.fromTier, 'team');
  assert.equal(p.toTier, 'global');
  assert.equal(p.teamId, 'acme');
  assert.equal(p.originTeamId, 'acme');
  assert.deepEqual(p.entryIds, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.deepEqual(p.originAgents, ['acme-dev-1', 'acme-dev-2']);
  assert.deepEqual(p.convergence, ['acme-dev-1', 'acme-dev-2']);
  assert.deepEqual(p.sourceRefs, [{ kind: 'pr', ref: '459' }]);
  assert.equal(p.sessions.length, 2);
  assert.equal(p.promotedBy, 'thorsten');
  assert.equal(p.promotedAt, NOW);
});

test('buildSkillProvenance: defaults promotedBy to operator', () => {
  const p = buildSkillProvenance({ from: 'agent', to: 'team', teamId: 'acme', entryIds: ['aaaaaaaaaaaa'], candidate: candidate() });
  assert.equal(p.promotedBy, 'operator');
});

// ── view ────────────────────────────────────────────────────────────────────

test('promotionSuggestionView: merges candidate + draft; defaults draft when absent', () => {
  const v = promotionSuggestionView(candidate());
  assert.equal(v.id, '9f3a12bc7de0');
  assert.equal(v.convergenceCount, 2);
  assert.ok(v.draft.name);
  assert.ok(v.draft.skillMd.startsWith('# '));
  assert.equal(v.draft.llmDrafted, false);

  const withDraft = promotionSuggestionView(candidate(), { name: 'custom', skillMd: '# custom', llmDrafted: true });
  assert.equal(withDraft.draft.name, 'custom');
  assert.equal(withDraft.draft.llmDrafted, true);
});

// ── resolvePromotionGates (Phase 4, mirrors orchestrator/knowledge-store.js) ────

test('resolvePromotionGates: defaults + team>global forced review + fail-safe clamp', () => {
  assert.deepEqual(resolvePromotionGates(null), {
    'team>team': 'auto', 'team>global': 'review', 'agent>team': 'review',
  });
  const g = resolvePromotionGates({ knowledgePromotionGates: { 'team>team': 'bogus', 'team>global': 'auto', 'agent>team': 'auto' } });
  assert.equal(g['team>team'], 'review'); // invalid → review
  assert.equal(g['team>global'], 'review'); // forced
  assert.equal(g['agent>team'], 'auto');
});

// ── validateShareToTeam / buildShareProvenance (directed cross-team sharing) ────

test('validateShareToTeam: from team requires distinct source + target', () => {
  const ok = validateShareToTeam({ from: 'team', name: 'poller', sourceTeamId: 'acme', targetTeamId: 'beta' });
  assert.equal(ok.ok, true);
  assert.equal(ok.sourceTeamId, 'acme');
  assert.equal(ok.targetTeamId, 'beta');

  assert.equal(validateShareToTeam({ from: 'team', name: 'x', sourceTeamId: 'acme', targetTeamId: 'acme' }).ok, false);
  assert.equal(validateShareToTeam({ from: 'team', name: 'x', targetTeamId: 'beta' }).ok, false); // no source
});

test('validateShareToTeam: from global needs only a target (source is the global pool)', () => {
  const ok = validateShareToTeam({ from: 'global', name: 'cobol-analysis', targetTeamId: 'beta' });
  assert.equal(ok.ok, true);
  assert.equal(ok.sourceTeamId, null);
});

test('validateShareToTeam: rejects bad source, name, target', () => {
  assert.equal(validateShareToTeam({ from: 'agent', name: 'x', targetTeamId: 'beta' }).ok, false);
  assert.equal(validateShareToTeam({ from: 'global', name: 'bad name!', targetTeamId: 'beta' }).ok, false);
  assert.equal(validateShareToTeam({ from: 'global', name: 'x', targetTeamId: '' }).ok, false);
});

test('buildShareProvenance: preserves origin, records the lateral share', () => {
  const src = { entryIds: ['9f3a12bc7de0'], originTeamId: 'acme', originAgents: ['acme-dev-1'], promotedBy: 'operator' };
  const p = buildShareProvenance({
    from: 'team', sourceTeamId: 'acme', targetTeamId: 'beta', name: 'poller',
    sourceProvenance: src, sharedBy: 'alice', now: NOW,
  });
  assert.deepEqual(p.entryIds, ['9f3a12bc7de0']); // provenance link survives the copy
  assert.equal(p.teamId, 'beta');
  assert.equal(p.originTeamId, 'acme'); // born in acme
  assert.deepEqual(p.sharedFrom, { tier: 'team', teamId: 'acme', name: 'poller' });
  assert.equal(p.sharedBy, 'alice');
  assert.equal(p.sharedAt, NOW);
});
