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
  validateExtension,
  buildSkillExtensionRequest,
  buildHeuristicSkillExtension,
  extendSkillProvenance,
  matchExistingSkill,
  TEAM_KNOWLEDGE_KEYS,
  mergeTeamKnowledgeConfig,
  normalizeWizardKnowledgeConfig,
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

// ─── aggregation: candidateFromEntries + synthesis drafts ────────────────────

const { candidateFromEntries, buildSkillDraftRequest } = require('./knowledge-suggestions');

function kbEntry(over = {}) {
  return {
    v: 1,
    id: over.id || 'aaaaaaaaaaaa',
    kind: over.kind || 'fact',
    text: over.text || 'a durable statement',
    originAgent: over.originAgent || 'acme-dev-1',
    teamId: over.teamId || 'acme',
    createdAt: over.createdAt || '2026-07-08T09:00:00Z',
    correlationId: over.correlationId || '$evt1',
    convergence: over.convergence || [over.originAgent || 'acme-dev-1'],
    status: over.status || 'active',
    ...over,
  };
}

test('candidateFromEntries: builds an ad-hoc manual candidate with full provenance', () => {
  const cand = candidateFromEntries([
    kbEntry({ id: 'aaaaaaaaaaaa', originAgent: 'dev-1', kind: 'fact', text: 'labels drive the review flow', sourceRefs: [{ kind: 'pr', ref: '42' }] }),
    kbEntry({ id: 'bbbbbbbbbbbb', originAgent: 'dev-2', kind: 'convention', text: 'set ready-for-review after opening a PR', createdAt: '2026-07-08T10:00:00Z' }),
    kbEntry({ id: 'aaaaaaaaaaaa', originAgent: 'dev-1', text: 'duplicate id must be ignored' }),
  ], { teamId: 'acme', now: NOW });

  assert.equal(cand.id, null); // ad-hoc, not a stored candidate
  assert.equal(cand.source, 'manual');
  assert.equal(cand.teamId, 'acme');
  assert.deepEqual(cand.entryIds, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']); // deduped
  assert.equal(cand.lessonCount, 2);
  assert.deepEqual(cand.convergence, ['dev-1', 'dev-2']);
  assert.equal(cand.kind, 'fact'); // dominant on tie → lexicographic-stable pick, 1 fact vs 1 convention: first sorted kind with max count
  assert.deepEqual(cand.kinds, ['convention', 'fact']);
  assert.equal(cand.text, 'labels drive the review flow'); // lead entry
  assert.deepEqual(cand.members[0].id, 'aaaaaaaaaaaa');
  assert.ok(cand.members[0].sourceRefs); // provenance carried for buildSkillProvenance
});

test('buildHeuristicSkillDraft: aggregated candidates get the synthesis rationale', () => {
  const agg = buildHeuristicSkillDraft(candidate({ source: 'related', lessonCount: 2 }));
  assert.match(agg.skillMd, /Combines 2 related lesson/);
  const manual = buildHeuristicSkillDraft(candidate({ source: 'manual', lessonCount: 2 }));
  assert.match(manual.skillMd, /Combined by the operator/);
  const single = buildHeuristicSkillDraft(candidate());
  assert.match(single.skillMd, /recorded this independently/);
});

test('buildSkillDraftRequest: aggregated candidates ask for a synthesis, not a listing', () => {
  const agg = buildSkillDraftRequest(candidate({ source: 'related' }));
  assert.match(agg.messages[0].content, /Synthesise them into ONE coherent/);
  const single = buildSkillDraftRequest(candidate());
  assert.match(single.messages[0].content, /same durable lesson/);
});

test('promotionSuggestionView: passes kinds + lessonCount through', () => {
  const view = promotionSuggestionView(candidate({ source: 'related', kinds: ['convention', 'fact'], lessonCount: 3 }));
  assert.deepEqual(view.kinds, ['convention', 'fact']);
  assert.equal(view.lessonCount, 3);
  assert.equal(view.source, 'related');
  const plain = promotionSuggestionView(candidate());
  assert.deepEqual(plain.kinds, ['fact']);
  assert.equal(plain.lessonCount, null);
});

// ─── extend an existing skill (issue #553) ───────────────────────────────────

test('validateExtension: allows team→team / team→global, rejects the rest', () => {
  const base = { targetName: 'poller', skillMd: '# x', entryIds: ['aaaaaaaaaaaa'] };
  assert.equal(validateExtension({ ...base, from: 'team', to: 'team' }).ok, true);
  assert.equal(validateExtension({ ...base, from: 'team', to: 'global' }).ok, true);
  assert.equal(validateExtension({ ...base, from: 'agent', to: 'team' }).ok, false); // lift stays create-only
  assert.equal(validateExtension({ ...base, from: 'team', to: 'agent' }).ok, false);
});

test('validateExtension: requires target name, provenance, non-empty skillMd', () => {
  assert.equal(validateExtension({ from: 'team', to: 'team', targetName: 'bad name!', skillMd: '# x', entryIds: ['aaaaaaaaaaaa'] }).ok, false);
  assert.equal(validateExtension({ from: 'team', to: 'team', targetName: 'poller', skillMd: '# x', entryIds: [] }).ok, false);
  assert.equal(validateExtension({ from: 'team', to: 'team', targetName: 'poller', skillMd: '', entryIds: ['aaaaaaaaaaaa'] }).ok, false);
  const ok = validateExtension({ from: 'team', to: 'team', targetName: 'poller', skillMd: '# x', entryIds: ['aaaaaaaaaaaa', 'not-hex'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.entryIds, ['aaaaaaaaaaaa']); // non-hex filtered out
});

test('buildSkillExtensionRequest: keeps existing content authoritative, folds new lessons', () => {
  const req = buildSkillExtensionRequest('# Poller\n\nExisting durable knowledge.', candidate());
  assert.match(req.messages[0].content, /EXISTING SKILL\.md/);
  assert.match(req.messages[0].content, /Existing durable knowledge\./);
  assert.match(req.messages[0].content, /Preserve all durable knowledge already in the existing document/);
  assert.match(req.messages[0].content, /This repo unit-tests pure helper cores only/);
});

test('buildHeuristicSkillExtension: appends only genuinely-new lessons, dedupes against prior', () => {
  const prior = '# Poller\n\n- This repo unit-tests pure helper cores only\n';
  const ext = buildHeuristicSkillExtension(prior, candidate());
  assert.equal(ext.llmDrafted, false);
  assert.equal(ext.added, 1); // the first member already appears in prior → only the second is new
  assert.ok(ext.skillMd.includes('## Added knowledge'));
  assert.ok(ext.skillMd.includes('IO verified manually'));
  // no-op when every member text is already covered verbatim (E3/E5)
  const noop = buildHeuristicSkillExtension(
    'This repo unit-tests pure helper cores only\nRepo tests pure cores only; IO verified manually',
    candidate(),
  );
  assert.equal(noop.added, 0);
});

test('extendSkillProvenance: unions new ids onto existing, preserves origin, records extension', () => {
  const existing = buildSkillProvenance({
    from: 'team', to: 'team', teamId: 'acme',
    entryIds: ['aaaaaaaaaaaa'],
    candidate: candidate({ members: [{ id: 'aaaaaaaaaaaa', originAgent: 'acme-dev-1', text: 'x', createdAt: NOW }] }),
    promotedBy: 'thorsten', now: '2026-07-01T00:00:00Z',
  });
  const merged = extendSkillProvenance({
    existingProv: existing, from: 'team', to: 'team', teamId: 'acme',
    entryIds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], // aaaa already present
    candidate: candidate(), extendedBy: 'alice', now: NOW,
  });
  assert.deepEqual(merged.entryIds, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']); // union, no dup
  assert.equal(merged.promotedAt, '2026-07-01T00:00:00Z'); // original promotion preserved
  assert.equal(merged.promotedBy, 'thorsten');
  assert.equal(merged.lastExtendedBy, 'alice');
  assert.equal(merged.lastExtendedAt, NOW);
  assert.equal(merged.extensions.length, 1);
  assert.deepEqual(merged.extensions[0].entryIds, ['bbbbbbbbbbbb']); // only the newly-added id
  assert.equal(merged.extensions[0].extendedBy, 'alice');
  assert.ok(merged.originAgents.includes('acme-dev-1'));
  assert.ok(merged.originAgents.includes('acme-dev-2'));
});

test('matchExistingSkill: entry-id lineage beats name overlap; null when no signal', () => {
  const skills = [
    { name: 'unrelated', tier: 'team', entryIds: ['cccccccccccc'] },
    { name: 'pure-helper-cores', tier: 'team', entryIds: [] }, // name-token overlap only
    { name: 'lineage-hit', tier: 'team', entryIds: ['bbbbbbbbbbbb'] }, // shares an entry id
  ];
  const m = matchExistingSkill(candidate(), skills);
  assert.equal(m.name, 'lineage-hit'); // id overlap wins
  assert.equal(m.idOverlap, 1);

  // name-only match when no id overlap exists
  const nameOnly = matchExistingSkill(candidate(), [{ name: 'pure-helper-cores', tier: 'team', entryIds: [] }]);
  assert.equal(nameOnly.name, 'pure-helper-cores');
  assert.ok(nameOnly.nameOverlap > 0);

  assert.equal(matchExistingSkill(candidate(), []), null);
  assert.equal(matchExistingSkill(candidate(), [{ name: 'totally-different', entryIds: ['zzzzzzzzzzzz'] }]), null);
});

// --- mergeTeamKnowledgeConfig (#570) ----------------------------------------
// Verbatim mirror of orchestrator/knowledge-store.js's overlay (the two runtimes
// never cross-require). These assertions mirror knowledge-store.test.js so the
// two copies can't silently drift — the read path (api.js) consumes THIS one.

test('TEAM_KNOWLEDGE_KEYS covers exactly the four per-team groups', () => {
  assert.deepEqual(
    [...TEAM_KNOWLEDGE_KEYS].sort(),
    ['knowledgeAutonomy', 'knowledgePromotionGates', 'knowledgeReview', 'knowledgeStore'],
  );
});

test('mergeTeamKnowledgeConfig: no overrides returns the base env unchanged (migration byte-identity, AC-2)', () => {
  const env = { knowledgeAutonomy: 2, knowledgeReview: true, repositories: [{ url: 'x' }] };
  // absent/empty overrides doc → same reference, so a read is byte-identical to before the upgrade
  assert.equal(mergeTeamKnowledgeConfig(env, undefined), env);
  assert.equal(mergeTeamKnowledgeConfig(env, {}), env);
  assert.equal(mergeTeamKnowledgeConfig(env, { unrelated: 1 }), env);
});

test('mergeTeamKnowledgeConfig: overlays only the four team keys, other env fields pass through', () => {
  const env = {
    knowledgeAutonomy: 1,
    knowledgeReview: false,
    knowledgePromotionGates: { 'team>team': 'auto' },
    knowledgeStore: { mode: 'in-repo', path: 'env/' },
    knowledgeConvergence: { convergenceThreshold: 3 },
    repositories: [{ url: 'repo-a' }],
  };
  const merged = mergeTeamKnowledgeConfig(env, {
    knowledgeAutonomy: 3,
    knowledgeStore: { mode: 'own-repo', path: 'team/' },
  });
  // overridden keys take the team value
  assert.equal(merged.knowledgeAutonomy, 3);
  assert.deepEqual(merged.knowledgeStore, { mode: 'own-repo', path: 'team/' });
  // non-overridden team keys fall back to the env value
  assert.equal(merged.knowledgeReview, false);
  assert.deepEqual(merged.knowledgePromotionGates, { 'team>team': 'auto' });
  // non-team env fields pass through untouched, base env not mutated
  assert.deepEqual(merged.knowledgeConvergence, { convergenceThreshold: 3 });
  assert.deepEqual(merged.repositories, [{ url: 'repo-a' }]);
  assert.equal(env.knowledgeAutonomy, 1);
});

test('mergeTeamKnowledgeConfig: two teams on one env resolve independently (AC-1)', () => {
  const sharedEnv = { knowledgeAutonomy: 1, knowledgeReview: false };
  const teamA = mergeTeamKnowledgeConfig(sharedEnv, { knowledgeAutonomy: 3 });
  const teamB = mergeTeamKnowledgeConfig(sharedEnv, { knowledgeReview: true });
  assert.equal(teamA.knowledgeAutonomy, 3);
  assert.equal(teamA.knowledgeReview, false); // A never touched review
  assert.equal(teamB.knowledgeAutonomy, 1); // B never touched autonomy
  assert.equal(teamB.knowledgeReview, true);
});

test('mergeTeamKnowledgeConfig: an override key set to a falsy value still wins over the env', () => {
  // explicit 0 must override the env's 2 (hasOwnProperty, not truthiness)
  const merged = mergeTeamKnowledgeConfig({ knowledgeAutonomy: 2 }, { knowledgeAutonomy: 0 });
  assert.equal(merged.knowledgeAutonomy, 0);
});

// --- normalizeWizardKnowledgeConfig (#567) ----------------------------------

test('normalizeWizardKnowledgeConfig: defaults collapse to null (AC-4 no override written)', () => {
  // Every shape that means "left on the defaults" must yield null so the wizard
  // writes no override file and the team reads byte-identically to pre-#567.
  assert.equal(normalizeWizardKnowledgeConfig(null), null);
  assert.equal(normalizeWizardKnowledgeConfig(undefined), null);
  assert.equal(normalizeWizardKnowledgeConfig({}), null);
  assert.equal(normalizeWizardKnowledgeConfig({ autonomy: 1, review: false }), null);
  assert.equal(normalizeWizardKnowledgeConfig({
    autonomy: 1,
    review: false,
    gates: { 'team>team': 'auto', 'agent>team': 'review', 'team>global': 'review' },
  }), null);
});

test('normalizeWizardKnowledgeConfig: only differing keys land in the patch', () => {
  assert.deepEqual(normalizeWizardKnowledgeConfig({ autonomy: 3 }), { knowledgeAutonomy: 3 });
  assert.deepEqual(normalizeWizardKnowledgeConfig({ review: true }), { knowledgeReview: true });
});

test('normalizeWizardKnowledgeConfig: a changed gate carries the full resolved gate map', () => {
  const patch = normalizeWizardKnowledgeConfig({
    gates: { 'team>team': 'review', 'agent>team': 'auto' },
  });
  assert.deepEqual(patch, {
    knowledgePromotionGates: { 'team>team': 'review', 'agent>team': 'auto', 'team>global': 'review' },
  });
});

test('normalizeWizardKnowledgeConfig: team>global is forced to review even if the caller sends auto', () => {
  const patch = normalizeWizardKnowledgeConfig({
    gates: { 'team>team': 'review', 'team>global': 'auto' },
  });
  assert.equal(patch.knowledgePromotionGates['team>global'], 'review');
});

test('normalizeWizardKnowledgeConfig: autonomy is coerced to an integer and clamped to 0..3', () => {
  assert.deepEqual(normalizeWizardKnowledgeConfig({ autonomy: 9 }), { knowledgeAutonomy: 3 });
  assert.deepEqual(normalizeWizardKnowledgeConfig({ autonomy: -2 }), { knowledgeAutonomy: 0 });
  assert.deepEqual(normalizeWizardKnowledgeConfig({ autonomy: '2' }), { knowledgeAutonomy: 2 });
  assert.equal(normalizeWizardKnowledgeConfig({ autonomy: 'bogus' }), null); // → default 1 → null
});

test('normalizeWizardKnowledgeConfig: review accepts string/number truthy forms', () => {
  assert.deepEqual(normalizeWizardKnowledgeConfig({ review: 'true' }), { knowledgeReview: true });
  assert.deepEqual(normalizeWizardKnowledgeConfig({ review: '1' }), { knowledgeReview: true });
  assert.equal(normalizeWizardKnowledgeConfig({ review: 'false' }), null); // not a truthy form → default false
});

test('normalizeWizardKnowledgeConfig: bogus gate modes fall back to the per-transition default', () => {
  // 'team>team' default is 'auto' → a bogus value collapses back to it → no diff → null
  assert.equal(normalizeWizardKnowledgeConfig({ gates: { 'team>team': 'nonsense' } }), null);
});

test('normalizeWizardKnowledgeConfig: all three groups combined', () => {
  const patch = normalizeWizardKnowledgeConfig({
    autonomy: 3,
    review: true,
    gates: { 'team>team': 'review', 'agent>team': 'auto' },
  });
  assert.deepEqual(patch, {
    knowledgeAutonomy: 3,
    knowledgeReview: true,
    knowledgePromotionGates: { 'team>team': 'review', 'agent>team': 'auto', 'team>global': 'review' },
  });
});
