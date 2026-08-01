'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DIGEST_FILENAME,
  DEFAULT_DIGEST_TOKEN_BUDGET,
  foldVisibleEntries,
  convergenceCount,
  buildKnowledgeDigest,
} = require('./knowledge-digest');

// The shared golden fixture is the two-sided contract with the Python port
// (build_knowledge_digest in agent-image/scripts/agent-entrypoint.py): both
// test suites read the SAME file and assert byte-identical markdown, so the
// two implementations cannot drift apart without a test failing.
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'knowledge-digest.fixture.json'), 'utf8'),
);

test('constants', () => {
  assert.equal(DIGEST_FILENAME, 'knowledge-digest.md');
  assert.equal(DEFAULT_DIGEST_TOKEN_BUDGET, 3000);
});

test('foldVisibleEntries: last writer wins, hidden statuses dropped, stable sort', () => {
  const folded = foldVisibleEntries(FIXTURE.entries);
  // 7 distinct ids, one hidden (merged) → 6 visible (no clock ⇒ nothing expires)
  assert.equal(folded.length, 6);
  assert.deepEqual(folded.map((e) => e.id), [
    'ddd000000004', 'aaa000000001', 'bbb000000002', 'ccc000000003',
    'fff000000006', 'abc000000007',
  ]);
  // The canonical copy (updatedAt newer, convergence grown to 3) won the fold.
  const conv = folded.find((e) => e.id === 'aaa000000001');
  assert.equal(convergenceCount(conv), 3);
});

test('foldVisibleEntries: expired entries fold out with the injected clock (#916)', () => {
  // fff…6 has validTo 2026-07-10 — before the fixture cases' generatedAt — so it
  // expires; abc…7's future validTo keeps it visible. Same rule in all four
  // fold mirrors (CLI, graph, digest JS+Py, canonical readers).
  const folded = foldVisibleEntries(FIXTURE.entries, '2026-07-13T09:00:00Z');
  assert.equal(folded.length, 5);
  assert.ok(!folded.some((e) => e.id === 'fff000000006'));
  assert.ok(folded.some((e) => e.id === 'abc000000007'));
  // exactly on the boundary: validTo === now is NOT yet expired
  const boundary = foldVisibleEntries(FIXTURE.entries, '2026-07-10T00:00:00Z');
  assert.ok(boundary.some((e) => e.id === 'fff000000006'));
});

test('foldVisibleEntries: entries without id are skipped', () => {
  assert.deepEqual(foldVisibleEntries([{ text: 'no id' }, null, 'junk']), []);
  assert.deepEqual(foldVisibleEntries(undefined), []);
});

for (const c of FIXTURE.cases) {
  test(`golden fixture: ${c.name}`, () => {
    const res = buildKnowledgeDigest({
      teamId: c.teamId,
      generatedAt: c.generatedAt,
      entries: c.useEntries ? FIXTURE.entries : [],
      ...(c.budgetTokens != null ? { budgetTokens: c.budgetTokens } : {}),
    });
    assert.equal(res.markdown, c.expectedMarkdown);
    assert.equal(res.includedCount, c.expectedIncluded);
    assert.equal(res.totalCount, c.expectedTotal);
    assert.equal(res.omittedCount, c.expectedOmitted);
    assert.equal(res.tokensUsed, c.expectedTokensUsed);
  });
}

test('includedIds lists the selected entries in render order', () => {
  const res = buildKnowledgeDigest({
    teamId: 'demo-team',
    generatedAt: '2026-07-13T09:00:00Z',
    entries: FIXTURE.entries,
  });
  // Conventions first, then converged, then recent (newest first). The expired
  // fff…6 entry (#916) is folded out by generatedAt; still-valid abc…7 is in.
  assert.deepEqual(res.includedIds, [
    'aaa000000001', 'bbb000000002', 'abc000000007', 'ccc000000003', 'ddd000000004',
  ]);
});

test('conventions are ordered by confirmation count desc, then newest first (not oldest-first)', () => {
  // Four conventions, ids chosen so alphabetical order (a,b,c,d) is NOT the
  // expected result — proving the sort is count/date driven. Expected render
  // order: count 3 newest→oldest (c, b), then count 1 newest→oldest (d, a).
  const entries = [
    { id: 'c0nv00000a01', kind: 'convention', text: 'A', createdAt: '2026-01-01T00:00:00Z', convergence: ['x'], status: 'active' },
    { id: 'c0nv00000b01', kind: 'convention', text: 'B', createdAt: '2026-02-01T00:00:00Z', convergence: ['x', 'y', 'z'], status: 'active' },
    { id: 'c0nv00000c01', kind: 'convention', text: 'C', createdAt: '2026-03-01T00:00:00Z', convergence: ['x', 'y', 'z'], status: 'active' },
    { id: 'c0nv00000d01', kind: 'convention', text: 'D', createdAt: '2026-04-01T00:00:00Z', convergence: ['x'], status: 'active' },
  ];
  const res = buildKnowledgeDigest({ teamId: 't', generatedAt: '2026-07-13T09:00:00Z', entries });
  assert.deepEqual(res.includedIds, ['c0nv00000c01', 'c0nv00000b01', 'c0nv00000d01', 'c0nv00000a01']);
  // Under a tight budget the most-confirmed + freshest convention survives, not the oldest.
  const tight = buildKnowledgeDigest({ teamId: 't', generatedAt: '2026-07-13T09:00:00Z', entries, budgetTokens: 8 });
  assert.deepEqual(tight.includedIds, ['c0nv00000c01']);
});

test('budget: conventions fill first, cutoff is deterministic and reported', () => {
  const small = FIXTURE.cases.find((c) => c.name === 'small-budget');
  assert.ok(small.expectedIncluded < small.expectedTotal);
  assert.ok(small.expectedMarkdown.includes('## Conventions'));
  assert.ok(!small.expectedMarkdown.includes('## Recent lessons'));
  assert.ok(small.expectedMarkdown.includes('more entries beyond the digest budget'));
});

test('empty KB renders a self-explanatory placeholder (import never dangles)', () => {
  const empty = FIXTURE.cases.find((c) => c.name === 'empty-kb');
  assert.ok(empty.expectedMarkdown.includes('No team knowledge recorded yet'));
});

test('multi-line text is flattened to one list line', () => {
  const res = buildKnowledgeDigest({
    teamId: 't',
    generatedAt: '2026-07-13T09:00:00Z',
    entries: [{
      id: 'abc000000001', kind: 'fact', text: 'line one\nline two',
      createdAt: '2026-07-01T00:00:00Z', convergence: ['a'], status: 'active',
    }],
  });
  assert.ok(res.markdown.includes('- fact: line one line two (2026-07-01)'));
});

test('banner always names the generation contract', () => {
  const res = buildKnowledgeDigest({ teamId: 'x', generatedAt: 'now', entries: [] });
  assert.ok(res.markdown.startsWith('# Team Knowledge Digest'));
  assert.ok(res.markdown.includes('GENERATED — do not edit'));
  assert.ok(res.markdown.includes('knowledge add fact|entity|convention'));
  assert.ok(res.markdown.includes('knowledge search'));
});

// ---- cross-language drift guard (source scan, same pattern as the memory
// hint): the Python port must carry the same distinctive literals. The golden
// fixture is the strong guarantee; this catches a missing port early.
test('Python runtime source carries the digest literals', () => {
  const py = fs.readFileSync(
    path.join(__dirname, '..', 'agent-image', 'scripts', 'agent-entrypoint.py'), 'utf8',
  );
  for (const frag of [
    '# Team Knowledge Digest',
    'GENERATED — do not edit. Auto-built from the team knowledge base',
    '## Conventions — how we do things here',
    '## Validated lessons — independently learned by several agents',
    '## Recent lessons',
    'No team knowledge recorded yet',
    'more entries beyond the digest budget',
  ]) {
    assert.ok(py.includes(frag), `Python runtime should contain: ${frag}`);
  }
});
