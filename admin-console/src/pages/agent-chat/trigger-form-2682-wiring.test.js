// #651 source guard for #2682: TriggerForm's JSX is not rendered in tests, so
// pin that the once picker shows pastOnceHint and the loop verifier field takes
// all of its copy from loopVerifierCopy (no hard-coded teammate promise left).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./TriggersPanel.jsx', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

test('the once DateTimePicker renders the past-time hint', () => {
  const picker = slice('function DateTimePicker(', '/* ── Trigger row');
  assert.match(picker, /const pastHint = pastOnceHint\(value\)/);
  assert.match(picker, /\{pastHint && \(/);
  assert.match(picker, /\{pastHint\}/);
});

test('the loop verifier field takes its copy from loopVerifierCopy', () => {
  assert.match(src, /const verifierCopy = loopVerifierCopy\(loopRoster\)/);
  const field = slice('Who checks the work?', '── Advanced settings');
  assert.match(field, /verifierCopy\.enforced \?/);
  assert.match(field, /<option value="none">\{verifierCopy\.noneLabel\}<\/option>/);
  assert.match(field, /\{verifierCopy\.notice && form\.verifyMode !== 'flow' && \(/);
  assert.match(field, /\{verifierCopy\.notice\}/);
  assert.doesNotMatch(field, /assigned automatically/, 'the teammate promise lives only in loopVerifierCopy');
});
