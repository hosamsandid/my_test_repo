'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_DISTILL_AFTER_AMENDMENTS,
  amendmentsSince,
  noteAmendment,
  shouldDistill,
  distillationMode,
  buildDistillationRequest,
  applyDistillation,
  buildDistillationEvent,
} = require('./knowledge-distillation');

const OK_MD = '# Dev workflow\n\n## The flow\n\n- Branch, commit small, open a PR.\n';

test('amendmentsSince: legacy/garbage → 0', () => {
  assert.equal(amendmentsSince(null), 0);
  assert.equal(amendmentsSince({}), 0);
  assert.equal(amendmentsSince({ amendmentsSinceDistillation: 3 }), 3);
  assert.equal(amendmentsSince({ amendmentsSinceDistillation: -1 }), 0);
  assert.equal(amendmentsSince({ amendmentsSinceDistillation: 'x' }), 0);
});

test('noteAmendment: pure increment, never mutates', () => {
  const p = { entryIds: ['a'], amendmentsSinceDistillation: 2 };
  const next = noteAmendment(p);
  assert.equal(next.amendmentsSinceDistillation, 3);
  assert.equal(p.amendmentsSinceDistillation, 2, 'input untouched');
  assert.deepEqual(next.entryIds, ['a']);
  assert.equal(noteAmendment({}).amendmentsSinceDistillation, 1);
  assert.equal(noteAmendment({ amendmentsSinceDistillation: 1 }, { count: 4 }).amendmentsSinceDistillation, 5);
});

test('shouldDistill: threshold (default 5, clamps)', () => {
  assert.equal(DEFAULT_DISTILL_AFTER_AMENDMENTS, 5);
  assert.equal(shouldDistill({ amendmentsSinceDistillation: 4 }), false);
  assert.equal(shouldDistill({ amendmentsSinceDistillation: 5 }), true);
  assert.equal(shouldDistill({ amendmentsSinceDistillation: 9 }), true);
  assert.equal(shouldDistill({ amendmentsSinceDistillation: 2 }, { threshold: 2 }), true);
  // garbage threshold falls back to the default
  assert.equal(shouldDistill({ amendmentsSinceDistillation: 5 }, { threshold: 0 }), true);
});

test('distillationMode: auto only at autonomy 3 + team>team auto', () => {
  const gAuto = { 'team>team': 'auto' };
  const gReview = { 'team>team': 'review' };
  assert.equal(distillationMode(gAuto, { autonomyLevel: 3 }), 'auto');
  assert.equal(distillationMode(gAuto, { autonomyLevel: 2 }), 'review');
  assert.equal(distillationMode(gReview, { autonomyLevel: 3 }), 'review');
  assert.equal(distillationMode({}, { autonomyLevel: 3 }), 'review');
  assert.equal(distillationMode(gAuto, {}), 'review');
});

test('buildDistillationRequest: whole-skill re-synthesis prompt', () => {
  const req = buildDistillationRequest(OK_MD, { entryIds: ['a', 'b'], convergence: ['dev-1', 'dev-2'] }, {
    domain: { name: 'Dev workflow' },
  });
  assert.ok(Number.isInteger(req.max_tokens) && req.max_tokens >= 2048);
  const content = req.messages[0].content;
  assert.match(content, /DISTILLATION/);
  assert.match(content, /Dev workflow/);
  assert.match(content, /NEVER drop evidence/i);
  assert.match(content, /2 recorded lesson/);
  assert.match(content, /dev-1, dev-2/);
  // the current playbook is embedded so the LLM re-synthesises from it
  assert.ok(content.includes(OK_MD));
});

test('applyDistillation: LLM failure leaves skill BYTE-IDENTICAL (AC2)', () => {
  const prov = { entryIds: ['a', 'b'], amendmentsSinceDistillation: 6, convergence: ['x'] };
  for (const bad of [null, undefined, '', '   ', 'too short', 'no heading here at all just prose text ok']) {
    const r = applyDistillation({ skillMd: OK_MD, provenance: prov, llmText: bad });
    assert.equal(r.changed, false);
    assert.equal(r.skillMd, OK_MD, 'skill byte-identical');
    assert.equal(r.provenance, prov, 'provenance object untouched');
    assert.equal(r.reason, 'llm-failed');
  }
});

test('applyDistillation: entryIds IDENTICAL before/after (AC1) + counter reset + history', () => {
  const prov = {
    entryIds: ['a1b2c3d4e5f6', '0011223344ff'],
    canonicalId: 'a1b2c3d4e5f6',
    convergence: ['dev-1', 'dev-2'],
    amendmentsSinceDistillation: 7,
    extensions: [{ extendedBy: 'curator' }],
  };
  const newMd = '# Dev workflow\n\n## When to use\n\nA cleaner, restructured playbook.\n\n## Rules & conventions\n\n- One clear rule.\n';
  const r = applyDistillation({ skillMd: OK_MD, provenance: prov, llmText: newMd, now: '2026-07-22T20:00:00Z' });
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'distilled');
  assert.equal(r.skillMd, newMd.trim(), 'trimmed (write path re-adds trailing newline)');
  // AC1: provenance entryIds identical before/after.
  assert.deepEqual(r.provenance.entryIds, prov.entryIds);
  assert.equal(r.provenance.canonicalId, 'a1b2c3d4e5f6');
  assert.deepEqual(r.provenance.convergence, ['dev-1', 'dev-2'], 'evidence links kept');
  assert.deepEqual(r.provenance.extensions, [{ extendedBy: 'curator' }], 'prior lineage kept');
  // counter reset + history recorded
  assert.equal(r.provenance.amendmentsSinceDistillation, 0);
  assert.equal(r.provenance.lastDistilledAt, '2026-07-22T20:00:00Z');
  assert.equal(r.provenance.lastDistilledBy, 'curator');
  assert.equal(r.provenance.distillations.length, 1);
  assert.deepEqual(r.provenance.distillations[0], { at: '2026-07-22T20:00:00Z', by: 'curator', entryCount: 2 });
  // input not mutated
  assert.equal(prov.amendmentsSinceDistillation, 7);
});

test('applyDistillation: identical output resets counter but does not rewrite/bump', () => {
  const prov = { entryIds: ['a'], amendmentsSinceDistillation: 8 };
  const r = applyDistillation({ skillMd: OK_MD, provenance: prov, llmText: OK_MD, now: '2026-07-22T20:00:00Z' });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'identical');
  assert.equal(r.skillMd, OK_MD);
  assert.equal(r.provenance.amendmentsSinceDistillation, 0);
  assert.equal(r.provenance.lastDistilledAt, '2026-07-22T20:00:00Z');
  assert.deepEqual(r.provenance.entryIds, ['a']);
});

test('buildDistillationEvent: transparency shape', () => {
  const ev = buildDistillationEvent({
    teamId: 'agent-studio', skill: { name: 'dev-workflow', tier: 'team' },
    mode: 'applied', auto: true, entryCount: 5, reason: 'distilled', ts: '2026-07-22T20:00:00Z',
  });
  assert.deepEqual(ev, {
    type: 'distillation', ts: '2026-07-22T20:00:00Z', teamId: 'agent-studio',
    skill: { name: 'dev-workflow', tier: 'team' }, mode: 'applied', auto: true, entryCount: 5, reason: 'distilled',
  });
  assert.equal(buildDistillationEvent({ mode: 'review' }).mode, 'review');
  assert.equal(buildDistillationEvent({}).mode, 'applied');
});
