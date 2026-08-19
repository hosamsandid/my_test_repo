'use strict';

// Golden-fixture + behavioural tests for the authored-prompt version history
// (#990, docs/prompt-version-history-concept.md). Console-only module — no
// orchestrator mirror, so no two-sided identity guard (cf. skill-manifest.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('./prompt-history');
const FIXTURE = require('./prompt-history.fixture.json');

for (const c of FIXTURE.hashCases) {
  test(`golden hash: ${c.name}`, () => {
    assert.equal(m.hashContent(c.content), c.expectedHash);
  });
}

for (const c of FIXTURE.stampCases) {
  test(`golden stamp: ${c.name}`, () => {
    assert.deepEqual(m.stampPromptHistory(c.existing, c.opts), c.expected);
  });
}

test('first edit seeds a baseline from the pre-edit content', () => {
  const out = m.stampPromptHistory(null, {
    field: 'systemPrompt', oldContent: 'OLD', newContent: 'NEW',
    at: '2026-01-01T00:00:00Z', by: 'operator:x', action: 'edited',
  });
  assert.equal(out.history.length, 2);
  assert.equal(out.history[0].version, 2);
  assert.equal(out.history[0].content, 'NEW');
  assert.equal(out.history[1].version, 1);
  assert.equal(out.history[1].action, 'baseline');
  assert.equal(out.history[1].content, 'OLD');
});

test('re-saving identical content is a no-op (no version bump)', () => {
  const first = m.stampPromptHistory(null, {
    oldContent: 'OLD', newContent: 'NEW', at: 'a', by: 'x', action: 'edited',
  });
  const again = m.stampPromptHistory(first, {
    newContent: 'NEW', at: 'b', by: 'y', action: 'edited',
  });
  assert.deepEqual(again.history, first.history);
});

test('history is newest-first and bounded to the limit', () => {
  let h = null;
  for (let i = 0; i < 30; i++) {
    h = m.stampPromptHistory(h, { oldContent: 'seed', newContent: `v${i}`, at: `t${i}`, by: 'x', limit: 5 });
  }
  assert.equal(h.history.length, 5);
  // newest-first: the head is the most recent write
  assert.equal(h.history[0].content, 'v29');
  assert.ok(h.history[0].version > h.history[1].version);
});

test('inherit-clear records an inherited entry with empty content', () => {
  const first = m.stampPromptHistory(null, { oldContent: 'x', newContent: 'override', at: 'a', by: 'x', action: 'edited' });
  const cleared = m.stampPromptHistory(first, { newContent: '', at: 'b', by: 'y', action: 'inherited' });
  assert.equal(cleared.history[0].action, 'inherited');
  assert.equal(cleared.history[0].content, '');
});

test('an unknown action falls back to "edited"', () => {
  const out = m.stampPromptHistory(null, { oldContent: 'o', newContent: 'n', at: 'a', by: 'x', action: 'bogus' });
  assert.equal(out.history[0].action, 'edited');
});

test('findVersion returns the stored entry or null', () => {
  const h = m.stampPromptHistory(null, { oldContent: 'OLD', newContent: 'NEW', at: 'a', by: 'x', action: 'edited' });
  assert.equal(m.findVersion(h, 1).content, 'OLD');
  assert.equal(m.findVersion(h, 2).content, 'NEW');
  assert.equal(m.findVersion(h, 99), null);
});

test('summarize drops full content and adds a preview', () => {
  const long = 'A'.repeat(500);
  const h = m.stampPromptHistory(null, { oldContent: 'o', newContent: long, at: 'a', by: 'x', action: 'edited' });
  const s = m.summarize(h, 160);
  assert.equal(s.currentVersion, 2);
  assert.equal(s.history[0].contentPreview.length, 160);
  assert.equal(s.history[0].contentLength, 500);
  assert.equal(s.history[0].content, undefined);
});

test('IO round-trip through the .agent-studio sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthist-'));
  try {
    assert.equal(m.readPromptHistory(dir), null);
    const obj = m.stampPromptHistory(null, { oldContent: 'o', newContent: 'n', at: 'a', by: 'x', action: 'edited' });
    m.writePromptHistory(dir, obj);
    assert.ok(fs.existsSync(path.join(dir, '.agent-studio', 'prompt-history.json')));
    assert.deepEqual(m.readPromptHistory(dir), obj);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy .aee/ sidecar is migrated to .agent-studio/ on first touch (#1549)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthist-mig-'));
  try {
    // An upgraded agent whose history still lives under the legacy name.
    const obj = m.stampPromptHistory(null, { oldContent: 'o', newContent: 'n', at: 'a', by: 'x', action: 'edited' });
    fs.mkdirSync(path.join(dir, '.aee'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.aee', 'prompt-history.json'), JSON.stringify(obj));

    // First read migrates the dir and returns the existing state — no data loss.
    assert.deepEqual(m.readPromptHistory(dir), obj);
    assert.ok(fs.existsSync(path.join(dir, '.agent-studio', 'prompt-history.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.aee')));

    // A subsequent write lands under the new name.
    const next = m.stampPromptHistory(obj, { newContent: 'n2', at: 'b', by: 'y', action: 'edited' });
    m.writePromptHistory(dir, next);
    assert.deepEqual(m.readPromptHistory(dir), next);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
