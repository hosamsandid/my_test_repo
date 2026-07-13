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
  // 5 distinct ids, one hidden (merged) → 4 visible
  assert.equal(folded.length, 4);
  assert.deepEqual(folded.map((e) => e.id), [
    'ddd000000004', 'aaa000000001', 'bbb000000002', 'ccc000000003',
  ]);
  // The canonical copy (updatedAt newer, convergence grown to 3) won the fold.
  const conv = folded.find((e) => e.id === 'aaa000000001');
  assert.equal(convergenceCount(conv), 3);
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
