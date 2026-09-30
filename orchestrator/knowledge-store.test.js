'use strict';

// Unit tests for the knowledge-store pure core (Knowledge Flow, Phase 0).
// Run: node --test orchestrator/knowledge-store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  KINDS,
  SCHEMA_VERSION,
  DEFAULT_KB_PATH,
  makeKnowledgeEntry,
  validateKnowledgeEntry,
  serializeEntry,
  parseEntry,
  buildDefaultManifest,
  validateManifest,
  kindFilePath,
  normalizeKnowledgeStore,
  knowledgeAutonomyLevel,
  knowledgeReviewEnabled,
  knowledgeConvergenceConfig,
  resolvePromotionGates,
  resolveSkillResyncMode,
  knowledgeCurationConfig,
  normalizeDomainSkillThreshold,
  DEFAULT_DOMAIN_SKILL_THRESHOLD,
  buildHarvestHint,
  TEAM_KNOWLEDGE_KEYS,
  mergeTeamKnowledgeConfig,
} = require('./knowledge-store');

// Deterministic injections.
const fixedId = () => 'a1b2c3d4e5f6';
const fixedNow = () => '2026-07-08T12:00:00Z';
const inject = { idGen: fixedId, now: fixedNow };

const baseInput = {
  kind: 'fact',
  text: 'npm install is blocked by the permission wall',
  originAgent: 'dev-1',
  teamId: 'payments',
  correlationId: 'evt:42',
};

// --- makeKnowledgeEntry -----------------------------------------------------

test('makeKnowledgeEntry fills defaults with injected id/now', () => {
  const e = makeKnowledgeEntry(baseInput, inject);
  assert.equal(e.v, SCHEMA_VERSION);
  assert.equal(e.id, 'a1b2c3d4e5f6');
  assert.equal(e.createdAt, '2026-07-08T12:00:00Z');
  assert.equal(e.status, 'active');
  assert.deepEqual(e.convergence, ['dev-1']);
  assert.equal(validateKnowledgeEntry(e).ok, true);
});

test('makeKnowledgeEntry rejects an unknown kind', () => {
  assert.throws(() => makeKnowledgeEntry({ ...baseInput, kind: 'nonsense' }, inject), /kind must be one of/);
});

test('makeKnowledgeEntry rejects empty text', () => {
  assert.throws(() => makeKnowledgeEntry({ ...baseInput, text: '   ' }, inject), /text must be a non-empty string/);
});

test('makeKnowledgeEntry enforces mandatory provenance link', () => {
  const { correlationId, ...noLink } = baseInput;
  assert.throws(() => makeKnowledgeEntry(noLink, inject), /provenance/);
  // sessionId alone satisfies it.
  assert.doesNotThrow(() => makeKnowledgeEntry({ ...noLink, sessionId: 'sess-9' }, inject));
  // a sourceRef alone satisfies it.
  assert.doesNotThrow(() =>
    makeKnowledgeEntry({ ...noLink, sourceRefs: [{ kind: 'pr', ref: '#7' }] }, inject));
});

test('makeKnowledgeEntry requires originAgent and teamId', () => {
  assert.throws(() => makeKnowledgeEntry({ ...baseInput, originAgent: '' }, inject), /originAgent/);
  assert.throws(() => makeKnowledgeEntry({ ...baseInput, teamId: '' }, inject), /teamId/);
});

test('makeKnowledgeEntry seeds convergence with originAgent and dedups', () => {
  const e = makeKnowledgeEntry({ ...baseInput, convergence: ['dev-1', 'dev-2', 'dev-1'] }, inject);
  assert.deepEqual(e.convergence, ['dev-1', 'dev-2']);
});

test('makeKnowledgeEntry normalizes sourceRefs and drops invalid ones', () => {
  const e = makeKnowledgeEntry({
    ...baseInput,
    sourceRefs: [
      { kind: 'pr', ref: '#7' },
      { kind: 'bogus', ref: 'x' },
      { kind: 'commit', ref: '' },
      { kind: 'url', ref: ' https://x ' },
    ],
  }, inject);
  assert.deepEqual(e.sourceRefs, [
    { kind: 'pr', ref: '#7' },
    { kind: 'url', ref: 'https://x' },
  ]);
});

test('makeKnowledgeEntry accepts a supplied valid id, rejects a bad one by regenerating', () => {
  assert.equal(makeKnowledgeEntry({ ...baseInput, id: 'deadbeef0000' }, inject).id, 'deadbeef0000');
  assert.equal(makeKnowledgeEntry({ ...baseInput, id: 'NOThex' }, inject).id, 'a1b2c3d4e5f6');
});

// --- validateKnowledgeEntry -------------------------------------------------

test('validateKnowledgeEntry flags a wrong schema version', () => {
  const e = makeKnowledgeEntry(baseInput, inject);
  const bad = { ...e, v: 999 };
  const r = validateKnowledgeEntry(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes('v must be')));
});

// --- serialize / parse ------------------------------------------------------

test('serialize -> parse round-trips an entry', () => {
  const e = makeKnowledgeEntry({ ...baseInput, tags: ['env', 'ci'] }, inject);
  const line = serializeEntry(e);
  assert.equal(line.indexOf('\n'), -1, 'a serialized entry is a single line');
  assert.deepEqual(parseEntry(line), e);
});

test('serializeEntry uses a stable leading key order', () => {
  const line = serializeEntry(makeKnowledgeEntry(baseInput, inject));
  assert.ok(line.startsWith('{"v":1,"id":"a1b2c3d4e5f6","kind":"fact","text":'));
});

test('summary is an optional field: absent unless supplied, round-trips, byte-identical when omitted (#635)', () => {
  // No summary on input → the key is not present at all (byte-identical to pre-#635 output).
  const bare = makeKnowledgeEntry(baseInput, inject);
  assert.equal('summary' in bare, false);
  const bareLine = serializeEntry(bare);
  assert.equal(bareLine.includes('"summary"'), false);

  // Supplied → trimmed, validated, and it round-trips.
  const withSummary = makeKnowledgeEntry({ ...baseInput, summary: '  A readable rewrite.  ' }, inject);
  assert.equal(withSummary.summary, 'A readable rewrite.');
  assert.equal(validateKnowledgeEntry(withSummary).ok, true);
  assert.deepEqual(parseEntry(serializeEntry(withSummary)), withSummary);

  // Blank/whitespace-only summary is dropped, not stored.
  assert.equal('summary' in makeKnowledgeEntry({ ...baseInput, summary: '   ' }, inject), false);

  // A non-string summary on a hand-built entry is a soft validation error.
  assert.equal(validateKnowledgeEntry({ ...bare, summary: 42 }).ok, false);
});

test('parseEntry tolerates blank and mangled lines', () => {
  assert.equal(parseEntry(''), null);
  assert.equal(parseEntry('   '), null);
  assert.equal(parseEntry('{not json'), null);
  assert.equal(parseEntry('[1,2,3]'), null);
  assert.equal(parseEntry(null), null);
});

// --- manifest ---------------------------------------------------------------

test('buildDefaultManifest is valid and covers every kind', () => {
  const m = buildDefaultManifest();
  assert.equal(validateManifest(m).ok, true);
  for (const k of KINDS) assert.ok(m.kinds[k]);
});

test('shipped knowledge.manifest.json byte-matches buildDefaultManifest()', () => {
  const shipped = fs.readFileSync(
    path.join(__dirname, 'knowledge-template', 'knowledge.manifest.json'),
    'utf8',
  );
  const expected = JSON.stringify(buildDefaultManifest(), null, 2) + '\n';
  assert.equal(shipped, expected);
});

test('validateManifest rejects a manifest missing a kind', () => {
  const m = buildDefaultManifest();
  delete m.kinds.entity;
  assert.equal(validateManifest(m).ok, false);
});

test('kindFilePath resolves the JSONL path for a kind', () => {
  const m = buildDefaultManifest();
  assert.equal(kindFilePath(m, 'fact'), 'facts/facts.jsonl');
  assert.equal(kindFilePath(m, 'convention'), 'conventions/conventions.jsonl');
  assert.throws(() => kindFilePath(m, 'nope'), /no entry for kind/);
});

// --- normalizeKnowledgeStore ------------------------------------------------

test('normalizeKnowledgeStore defaults for a legacy env (no knowledgeStore)', () => {
  const { store, warnings } = normalizeKnowledgeStore({ repositories: [] });
  assert.deepEqual(store, { mode: 'in-repo', path: DEFAULT_KB_PATH, repoRef: null, sources: [] });
  assert.deepEqual(warnings, []);
});

test('normalizeKnowledgeStore ensures a trailing slash on a custom path', () => {
  const { store } = normalizeKnowledgeStore({ knowledgeStore: { path: 'kb/team' }, repositories: [] });
  assert.equal(store.path, 'kb/team/');
});

test('normalizeKnowledgeStore in-repo single repo adopts that repo but NOT its code branch', () => {
  // #558 AC-6: the adopted repoRef must carry only url + credentials, never the
  // repo's own code branch (main) — the KB lives on the separate default branch.
  const env = { repositories: [{ url: 'git@x:acme/app.git', branch: 'main', sshKeyId: 'k1' }] };
  const { store, warnings } = normalizeKnowledgeStore(env);
  assert.equal(store.repoRef.url, 'git@x:acme/app.git');
  assert.equal(store.repoRef.branch, undefined);
  assert.equal(store.repoRef.sshKeyId, 'k1');
  assert.deepEqual(warnings, []);
});

test('normalizeKnowledgeStore in-repo keeps a configured branch when repoRef.url matches an env repo', () => {
  // Regression (#558): the UI omits the url for a single-repo in-repo store, so
  // writeTeamKnowledgeStore pins it to the env repo before calling here. The
  // configured KB branch rides on that repoRef and must survive normalization —
  // otherwise it would be silently replaced by the repo's default branch.
  const env = {
    knowledgeStore: { mode: 'in-repo', repoRef: { url: 'git@x:acme/app.git', branch: 'agent-knowledge' } },
    repositories: [{ url: 'git@x:acme/app.git', branch: 'main' }],
  };
  const { store, warnings } = normalizeKnowledgeStore(env);
  assert.equal(store.repoRef.url, 'git@x:acme/app.git');
  assert.equal(store.repoRef.branch, 'agent-knowledge');
  assert.deepEqual(warnings, []);
});

test('normalizeKnowledgeStore in-repo multi-repo without repoRef warns + picks first', () => {
  const env = {
    repositories: [{ url: 'git@x:acme/a.git' }, { url: 'git@x:acme/b.git' }],
  };
  const { store, warnings } = normalizeKnowledgeStore(env);
  assert.equal(store.repoRef.url, 'git@x:acme/a.git');
  assert.ok(warnings.some((w) => w.includes('multiple repositories')));
});

test('normalizeKnowledgeStore in-repo repoRef not among repos warns', () => {
  const env = {
    knowledgeStore: { repoRef: { url: 'git@x:acme/missing.git' } },
    repositories: [{ url: 'git@x:acme/a.git' }],
  };
  const { warnings } = normalizeKnowledgeStore(env);
  assert.ok(warnings.some((w) => w.includes('not among')));
});

test('normalizeKnowledgeStore own-repo requires a repoRef', () => {
  const missing = normalizeKnowledgeStore({ knowledgeStore: { mode: 'own-repo' }, repositories: [] });
  assert.ok(missing.warnings.some((w) => w.includes('requires a repoRef')));
  const ok = normalizeKnowledgeStore({
    knowledgeStore: { mode: 'own-repo', repoRef: { url: 'git@x:acme/kb.git', branch: 'main' } },
    repositories: [],
  });
  assert.equal(ok.store.mode, 'own-repo');
  assert.equal(ok.store.repoRef.url, 'git@x:acme/kb.git');
  assert.deepEqual(ok.warnings, []);
});

// --- knowledgeAutonomyLevel -------------------------------------------------

test('knowledgeAutonomyLevel defaults to 1 and clamps to 0..3', () => {
  assert.equal(knowledgeAutonomyLevel(undefined), 1);
  assert.equal(knowledgeAutonomyLevel({}), 1);
  assert.equal(knowledgeAutonomyLevel({ knowledgeAutonomy: 0 }), 0);
  assert.equal(knowledgeAutonomyLevel({ knowledgeAutonomy: 3 }), 3);
  assert.equal(knowledgeAutonomyLevel({ knowledgeAutonomy: 9 }), 3);
  assert.equal(knowledgeAutonomyLevel({ knowledgeAutonomy: -5 }), 0);
  assert.equal(knowledgeAutonomyLevel({ knowledgeAutonomy: 'nope' }), 1);
});

// --- knowledgeReviewEnabled -------------------------------------------------

test('knowledgeReviewEnabled defaults off and is tolerant', () => {
  assert.equal(knowledgeReviewEnabled(undefined), false);
  assert.equal(knowledgeReviewEnabled({}), false);
  assert.equal(knowledgeReviewEnabled({ knowledgeReview: false }), false);
  assert.equal(knowledgeReviewEnabled({ knowledgeReview: true }), true);
  assert.equal(knowledgeReviewEnabled({ knowledgeReview: 'true' }), true);
  assert.equal(knowledgeReviewEnabled({ knowledgeReview: '1' }), true);
  assert.equal(knowledgeReviewEnabled({ knowledgeReview: 'no' }), false);
  assert.equal(knowledgeReviewEnabled({ knowledgeReview: 1 }), false); // number 1 is not the string "1"
});

// --- knowledgeConvergenceConfig ---------------------------------------------

test('knowledgeConvergenceConfig defaults for legacy env', () => {
  assert.deepEqual(knowledgeConvergenceConfig(undefined), { simThreshold: 0.6, convergenceThreshold: 2, relatedThreshold: 0.3, cosineThreshold: 0.8 });
  assert.deepEqual(knowledgeConvergenceConfig({}), { simThreshold: 0.6, convergenceThreshold: 2, relatedThreshold: 0.3, cosineThreshold: 0.8 });
});

test('knowledgeConvergenceConfig honours + clamps overrides', () => {
  assert.deepEqual(
    knowledgeConvergenceConfig({ knowledgeConvergence: { simThreshold: 0.8, convergenceThreshold: 3, relatedThreshold: 0.4, cosineThreshold: 0.8 } }),
    { simThreshold: 0.8, convergenceThreshold: 3, relatedThreshold: 0.4, cosineThreshold: 0.8 },
  );
  // clamp: sim out of range, threshold below 2 / non-int
  assert.deepEqual(
    knowledgeConvergenceConfig({ knowledgeConvergence: { simThreshold: 5, convergenceThreshold: 1, relatedThreshold: 5 } }),
    { simThreshold: 1, convergenceThreshold: 2, relatedThreshold: 1, cosineThreshold: 0.8 },
  );
  assert.deepEqual(
    knowledgeConvergenceConfig({ knowledgeConvergence: { simThreshold: -1, convergenceThreshold: 2.5, relatedThreshold: -1 } }),
    { simThreshold: 0, convergenceThreshold: 2, relatedThreshold: 0, cosineThreshold: 0.8 },
  );
});

// --- buildHarvestHint -------------------------------------------------------

test('buildHarvestHint returns empty at level 0 (today) and non-int', () => {
  assert.equal(buildHarvestHint(0), '');
  assert.equal(buildHarvestHint(-1), '');
  assert.equal(buildHarvestHint('1'), '');
  assert.equal(buildHarvestHint(undefined), '');
});

test('buildHarvestHint mentions the CLI at level >= 1', () => {
  for (const lvl of [1, 2, 3]) {
    const out = buildHarvestHint(lvl);
    assert.ok(out.includes('knowledge add'));
    assert.ok(out.includes('knowledge search'));
  }
});

// --- Cross-runtime serialization guard --------------------------------------
// This EXACT string must also be produced by the Python core's serialize_entry
// (agent-image/scripts/test_knowledge.py GOLDEN). If either side reorders keys
// or changes JSON spacing, the shared KB files diverge between runtimes.
test('serializeEntry byte-matches the shared cross-runtime golden line', () => {
  const entry = makeKnowledgeEntry({
    kind: 'fact',
    text: 'Branch from origin/main',
    originAgent: 'cobol-agent',
    teamId: 'team-x',
    correlationId: 'evt-123',
    sourceRefs: [{ kind: 'pr', ref: '459' }],
    tags: ['git', 'workflow'],
    id: '0123456789ab',
    createdAt: '2026-07-08T10:00:00Z',
  });
  const GOLDEN =
    '{"v":1,"id":"0123456789ab","kind":"fact","text":"Branch from origin/main",' +
    '"originAgent":"cobol-agent","teamId":"team-x","createdAt":"2026-07-08T10:00:00Z",' +
    '"correlationId":"evt-123","sourceRefs":[{"kind":"pr","ref":"459"}],' +
    '"convergence":["cobol-agent"],"tags":["git","workflow"],"status":"active"}';
  assert.equal(serializeEntry(entry), GOLDEN);
});

// ─── Phase 4: promotion gates + curation config + archived status ───────────────

test('validateKnowledgeEntry accepts status "archived" (Phase 4 non-destructive curation)', () => {
  const entry = makeKnowledgeEntry({
    kind: 'fact', text: 'superseded lesson', originAgent: 'a1', teamId: 't', correlationId: 'e1',
  });
  entry.status = 'archived';
  assert.equal(validateKnowledgeEntry(entry).ok, true);
});

test('resolvePromotionGates: defaults + team>global forced review + fail-safe clamp', () => {
  assert.deepEqual(resolvePromotionGates(null), {
    'team>team': 'auto', 'team>global': 'review', 'agent>team': 'review',
  });
  // present-but-invalid → review; team>global can never be auto
  const g = resolvePromotionGates({ knowledgePromotionGates: { 'team>team': 'nope', 'team>global': 'auto' } });
  assert.equal(g['team>team'], 'review');
  assert.equal(g['team>global'], 'review');
});

test('knowledgeCurationConfig: clamp + legacy default', () => {
  // #779 added digest-routing + auto-extend knobs to the config shape (defaults:
  // routing on, graduate at 4 agents, auto-extend follows autonomy (null), floor 100).
  assert.deepEqual(knowledgeCurationConfig(null), {
    maxAutoPromotionsPerPass: 3, autoThemeMinLessons: 4,
    digestRouting: true, graduateAtAgents: 4, autoExtend: null, extendConfidenceFloor: 100,
    // #780: domain routing on by default, soft skill budget 12, synthesis opt-in.
    domainRouting: true, skillBudget: 12, synthesizeSkills: false,
    // #781: distillation cadence — X amendments before a distillation is due.
    distillAfterAmendments: 5,
    // #2592: a domain's FIRST skill needs >=3 converged lessons from >=2 agents.
    domainSkillThreshold: { minLessons: 3, minAgents: 2 },
  });
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { distillAfterAmendments: 8 } }).distillAfterAmendments, 8);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { distillAfterAmendments: 0 } }).distillAfterAmendments, 5);
  // #780 domain-routing + budget knobs clamp/pass-through.
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { domainRouting: false } }).domainRouting, false);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { skillBudget: 6 } }).skillBudget, 6);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { skillBudget: 0 } }).skillBudget, 12);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { maxAutoPromotionsPerPass: 10 } }).maxAutoPromotionsPerPass, 10);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { maxAutoPromotionsPerPass: -2 } }).maxAutoPromotionsPerPass, 3);
  // #604: autoThemeMinLessons default 4, clamps to int >= 1.
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoThemeMinLessons: 6 } }).autoThemeMinLessons, 6);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoThemeMinLessons: -2 } }).autoThemeMinLessons, 4);
});

test('domainSkillThreshold: normalised, and the team override wins over the global knob (#2592 AC12)', () => {
  assert.deepEqual(normalizeDomainSkillThreshold(undefined), { minLessons: 3, minAgents: 2 });
  assert.deepEqual(normalizeDomainSkillThreshold({ minLessons: 5, minAgents: 1 }), { minLessons: 5, minAgents: 1 });
  assert.deepEqual(normalizeDomainSkillThreshold({ minLessons: 0, minAgents: 2.5 }), { minLessons: 3, minAgents: 2 });
  assert.deepEqual(normalizeDomainSkillThreshold({ minLessons: '4', minAgents: 999 }), { minLessons: 4, minAgents: 2 });
  assert.deepEqual(
    knowledgeCurationConfig({ knowledgeCuration: { domainSkillThreshold: { minLessons: 6 } } }).domainSkillThreshold,
    { minLessons: 6, minAgents: 2 },
  );
  assert.deepEqual(
    knowledgeCurationConfig({
      knowledgeCuration: { domainSkillThreshold: { minLessons: 6 } },
      domainSkillThreshold: { minLessons: 2, minAgents: 3 },
    }).domainSkillThreshold,
    { minLessons: 2, minAgents: 3 },
  );
  assert.deepEqual(DEFAULT_DOMAIN_SKILL_THRESHOLD, { minLessons: 3, minAgents: 2 });
});

// --- mergeTeamKnowledgeConfig (#570) ----------------------------------------

test('TEAM_KNOWLEDGE_KEYS covers exactly the per-team groups', () => {
  assert.deepEqual(
    [...TEAM_KNOWLEDGE_KEYS].sort(),
    ['decayHorizonDays', 'domainSkillThreshold', 'knowledgeAutonomy', 'knowledgePromotionGates', 'knowledgeReview', 'knowledgeStore', 'skillResyncMode'],
  );
});

test('resolveSkillResyncMode: default review + valid pass-through + fail-safe clamp (#629 AC5)', () => {
  assert.equal(resolveSkillResyncMode(null), 'review');
  assert.equal(resolveSkillResyncMode({}), 'review');
  assert.equal(resolveSkillResyncMode({ skillResyncMode: 'auto' }), 'auto');
  assert.equal(resolveSkillResyncMode({ skillResyncMode: 'review' }), 'review');
  // present-but-invalid → conservative default (never silently auto-resyncs)
  assert.equal(resolveSkillResyncMode({ skillResyncMode: 'nope' }), 'review');
  assert.equal(resolveSkillResyncMode({ skillResyncMode: 42 }), 'review');
});

test('mergeTeamKnowledgeConfig: no overrides returns the base env unchanged (migration byte-identity)', () => {
  const env = { knowledgeAutonomy: 2, knowledgeReview: true, repositories: [{ url: 'x' }] };
  // absent overrides doc → same reference, so a read is byte-identical to before the upgrade
  assert.equal(mergeTeamKnowledgeConfig(env, undefined), env);
  assert.equal(mergeTeamKnowledgeConfig(env, {}), env);
  assert.equal(mergeTeamKnowledgeConfig(env, { unrelated: 1 }), env);
});

test('mergeTeamKnowledgeConfig: overlays only the four team keys, env fields pass through', () => {
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
  assert.equal(knowledgeAutonomyLevel(merged), 3);
  assert.deepEqual(merged.knowledgeStore, { mode: 'own-repo', path: 'team/' });
  // non-overridden team keys fall back to the env value
  assert.equal(knowledgeReviewEnabled(merged), false);
  assert.deepEqual(merged.knowledgePromotionGates, { 'team>team': 'auto' });
  // non-team env fields pass through untouched
  assert.deepEqual(merged.knowledgeConvergence, { convergenceThreshold: 3 });
  assert.deepEqual(merged.repositories, [{ url: 'repo-a' }]);
  // the base env is not mutated
  assert.equal(env.knowledgeAutonomy, 1);
});

test('mergeTeamKnowledgeConfig: two teams on one env resolve independently (AC-1)', () => {
  const sharedEnv = { knowledgeAutonomy: 1, knowledgeReview: false };
  const teamA = mergeTeamKnowledgeConfig(sharedEnv, { knowledgeAutonomy: 3 });
  const teamB = mergeTeamKnowledgeConfig(sharedEnv, { knowledgeReview: true });
  assert.equal(knowledgeAutonomyLevel(teamA), 3);
  assert.equal(knowledgeReviewEnabled(teamA), false); // A never touched review
  assert.equal(knowledgeAutonomyLevel(teamB), 1); // B never touched autonomy
  assert.equal(knowledgeReviewEnabled(teamB), true);
});

test('mergeTeamKnowledgeConfig: an override key set to a falsy value still wins over the env', () => {
  const env = { knowledgeAutonomy: 2 };
  // explicit 0 must override the env's 2 (hasOwnProperty, not truthiness)
  const merged = mergeTeamKnowledgeConfig(env, { knowledgeAutonomy: 0 });
  assert.equal(knowledgeAutonomyLevel(merged), 0);
});

// ── #916 bitemporal validity fields ─────────────────────────────────────────

test('#916 AC1: validFrom/validTo/supersededBy round-trip; absent ⇒ byte-identical legacy line', () => {
  const withValidity = makeKnowledgeEntry({
    ...baseInput,
    validFrom: '2026-07-01T00:00:00Z',
    validTo: '2026-09-01T00:00:00Z',
    supersededBy: 'dddddddddddd',
  }, inject);
  const line = serializeEntry(withValidity);
  assert.deepEqual(parseEntry(line), withValidity);
  // validity keys serialize after summary, in KEY_ORDER position
  const keys = Object.keys(JSON.parse(line));
  assert.deepEqual(keys.slice(-3), ['validFrom', 'validTo', 'supersededBy']);
  // a legacy entry (no validity input) emits no validity keys at all
  const legacy = makeKnowledgeEntry(baseInput, inject);
  assert.ok(!('validFrom' in legacy) && !('validTo' in legacy) && !('supersededBy' in legacy));
  const v = validateKnowledgeEntry(legacy);
  assert.equal(v.ok, true);
});

test('#916: validation rejects malformed validity fields, tolerates absent ones', () => {
  const good = makeKnowledgeEntry(baseInput, inject);
  assert.equal(validateKnowledgeEntry({ ...good, validTo: '' }).ok, false);
  assert.equal(validateKnowledgeEntry({ ...good, validFrom: 42 }).ok, false);
  assert.equal(validateKnowledgeEntry({ ...good, supersededBy: 'not-hex' }).ok, false);
  assert.equal(validateKnowledgeEntry({ ...good, supersededBy: 'dddddddddddd' }).ok, true);
  // a malformed supersededBy INPUT is dropped (never emitted), not thrown
  const dropped = makeKnowledgeEntry({ ...baseInput, supersededBy: 'nope' }, inject);
  assert.ok(!('supersededBy' in dropped));
});

// ── #917 auto-load triggers ─────────────────────────────────────────────────

test('#917: loadTriggers round-trip, validation, normalization', () => {
  const { normalizeLoadTriggers } = require('./knowledge-store');
  const withTriggers = makeKnowledgeEntry({
    ...baseInput,
    loadTriggers: [{ type: 'keyword', pattern: ' jcl ' }, { type: 'path', pattern: 'src/*.jcl' }, { type: 'keyword', pattern: 'JCL' }],
  }, inject);
  // normalized: trimmed + case-insensitively deduped
  assert.deepEqual(withTriggers.loadTriggers, [{ type: 'keyword', pattern: 'jcl' }, { type: 'path', pattern: 'src/*.jcl' }]);
  const line = serializeEntry(withTriggers);
  assert.deepEqual(parseEntry(line), withTriggers);
  assert.equal(Object.keys(JSON.parse(line)).at(-1), 'loadTriggers'); // KEY_ORDER tail
  // absent input ⇒ no field; invalid shapes rejected by the validator
  assert.ok(!('loadTriggers' in makeKnowledgeEntry(baseInput, inject)));
  const good = makeKnowledgeEntry(baseInput, inject);
  assert.equal(validateKnowledgeEntry({ ...good, loadTriggers: 'nope' }).ok, false);
  assert.equal(validateKnowledgeEntry({ ...good, loadTriggers: [{ type: 'regex', pattern: 'x' }] }).ok, false);
  assert.equal(validateKnowledgeEntry({ ...good, loadTriggers: [{ type: 'keyword', pattern: '' }] }).ok, false);
  assert.equal(validateKnowledgeEntry({ ...good, loadTriggers: [{ type: 'path', pattern: '*.jcl' }] }).ok, true);
  // normalizeLoadTriggers: nothing valid ⇒ null (the sidecar clears)
  assert.equal(normalizeLoadTriggers([]), null);
  assert.equal(normalizeLoadTriggers([{ type: 'bad', pattern: 'x' }]), null);
  assert.equal(normalizeLoadTriggers('junk'), null);
});

test('#918: cosineThreshold joins the convergence config with the same clamp posture', () => {
  const { knowledgeConvergenceConfig } = require('./knowledge-store');
  assert.equal(knowledgeConvergenceConfig(null).cosineThreshold, 0.8); // default
  assert.equal(knowledgeConvergenceConfig({ knowledgeConvergence: { cosineThreshold: 0.9 } }).cosineThreshold, 0.9);
  assert.equal(knowledgeConvergenceConfig({ knowledgeConvergence: { cosineThreshold: 7 } }).cosineThreshold, 1);
  assert.equal(knowledgeConvergenceConfig({ knowledgeConvergence: { cosineThreshold: -1 } }).cosineThreshold, 0);
  assert.equal(knowledgeConvergenceConfig({ knowledgeConvergence: { cosineThreshold: 'x' } }).cosineThreshold, 0.8);
});
