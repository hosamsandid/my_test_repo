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
  buildHarvestHint,
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

test('normalizeKnowledgeStore in-repo single repo adopts that repo', () => {
  const env = { repositories: [{ url: 'git@x:acme/app.git', branch: 'main' }] };
  const { store, warnings } = normalizeKnowledgeStore(env);
  assert.equal(store.repoRef.url, 'git@x:acme/app.git');
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
