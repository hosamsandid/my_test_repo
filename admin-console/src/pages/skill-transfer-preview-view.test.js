import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCAN_STAGE_LABELS,
  transferPreviewRequiresAck,
  warningRows,
  warningsSummaryLabel,
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
