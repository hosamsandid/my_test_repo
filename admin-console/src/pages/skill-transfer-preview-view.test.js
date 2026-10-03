import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SCAN_STAGE_LABELS,
  transferPreviewRequiresAck,
  warningRows,
  warningsSummaryLabel,
  transferActivationNotice,
} from './skill-transfer-preview-view.js';

test('transferPreviewRequiresAck: only when warnings are present', () => {
  assert.equal(transferPreviewRequiresAck([]), false);
  assert.equal(transferPreviewRequiresAck(null), false);
  assert.equal(transferPreviewRequiresAck(undefined), false);
  assert.equal(transferPreviewRequiresAck([{ category: 'suspicious-url' }]), true);
});

test('warningRows: shapes stage label, keeps evidence/count, tolerates junk', () => {
  const rows = warningRows([
    { stage: 'pattern', category: 'override-instructions', message: 'a', count: 3, evidence: 'ignore all…' },
    { stage: 'llm', category: 'semantic', message: 'b' },
    null,
    42,
    { stage: 'pattern', category: 'suspicious-url', message: 'c', count: 1 },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].stageLabel, SCAN_STAGE_LABELS.pattern);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].evidence, 'ignore all…');
  assert.equal(rows[1].stageLabel, SCAN_STAGE_LABELS.llm);
  assert.equal(rows[1].evidence, null);
  assert.equal(rows[2].count, null); // count of 1 is not surfaced
  // Keys are unique so React can render them.
  assert.equal(new Set(rows.map((r) => r.key)).size, 3);
});

test('warningRows: non-array → []', () => {
  assert.deepEqual(warningRows(null), []);
  assert.deepEqual(warningRows('nope'), []);
});

test('warningsSummaryLabel: singular/plural/none', () => {
  assert.match(warningsSummaryLabel([]), /No prompt-injection/);
  assert.match(warningsSummaryLabel([{}]), /1 potential prompt-injection indicator\b/);
  assert.match(warningsSummaryLabel([{}, {}]), /2 potential prompt-injection indicators\b/);
});

/* ─── #2689: adopt into a team says whether the skill was activated ───────── */

test('transferActivationNotice: activated on the Agent Team', () => {
  const n = transferActivationNotice({
    name: 'web-search', activate: true, to: { tier: 'team', teamId: 't1' },
    activation: [{ squadId: 't1', status: 200 }],
  });
  assert.equal(n.ok, true);
  assert.match(n.text, /activated on t1/);
});

test('transferActivationNotice: no Agent Team / failed call says it is NOT active', () => {
  for (const activation of [[], [{ squadId: 't1', status: 500 }], [{ squadId: 't1', error: 'ECONNREFUSED' }], undefined]) {
    const n = transferActivationNotice({ name: 'web-search', activate: true, to: { tier: 'team', teamId: 't1' }, activation });
    assert.equal(n.ok, false, JSON.stringify(activation));
    assert.match(n.text, /not active yet/);
  }
});

test('transferActivationNotice: nothing to say when activation was not requested or the target is global', () => {
  assert.equal(transferActivationNotice({ activate: false, to: { tier: 'team', teamId: 't1' } }), null);
  assert.equal(transferActivationNotice({ activate: true, to: { tier: 'global' } }), null);
  assert.equal(transferActivationNotice(null), null);
});

// #651 guard: SkillsRegistry hands the notice to the page and renders it.
test('SkillsRegistry.jsx surfaces the transfer activation notice', () => {
  const src = readFileSync(new URL('./SkillsRegistry.jsx', import.meta.url), 'utf8');
  assert.match(src, /activationNotice: transferActivationNotice\(data\)/);
  assert.match(src, /setTransferNotice\(skill\?\.activationNotice \|\| null\)/);
  assert.match(src, /\{transferNotice\.text\}/);
  // Pin the visibility condition too, not only the rendered text.
  assert.match(src, /\{transferNotice && \(/);
  // The notice can be dismissed; it is otherwise only replaced by the next transfer.
  assert.match(src, /onClick=\{\(\) => setTransferNotice\(null\)\}/);
});
