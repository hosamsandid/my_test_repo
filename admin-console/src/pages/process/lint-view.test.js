import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LINT_INFO, lintView, severityColor } from './lint-view.js';

test('lintView maps a known code to a friendly title + fix', () => {
  const v = lintView({ code: 'gate-violation', severity: 'error', message: '`x` sets a gate.' });
  assert.equal(v.title, 'Agent claims a human-only gate');
  assert.equal(v.severityWord, 'Error');
  assert.equal(v.severityColor, 'var(--eb-status-error)');
  assert.equal(v.slug, 'gate-violation');
  assert.equal(v.message, '`x` sets a gate.');
  assert.ok(v.fix && v.fix.length > 0);
});

test('every known lint code has a title and a fix', () => {
  for (const [code, info] of Object.entries(LINT_INFO)) {
    assert.ok(info.title, `${code} missing title`);
    assert.ok(info.fix, `${code} missing fix`);
    const v = lintView({ code, severity: 'info' });
    assert.equal(v.title, info.title);
    assert.equal(v.fix, info.fix);
  }
});

// #2711: every lint code computeLints can emit must have a title + fix, so no
// lint renders as a raw slug. Scans the computeLints body in the API source for
// `code: '<slug>'` literals (#651-style source guard).
test('every code emitted by computeLints has a LINT_INFO entry', () => {
  const src = readFileSync(new URL('../../../api/process-graph.js', import.meta.url), 'utf8');
  const start = src.indexOf('\nfunction computeLints(');
  assert.ok(start >= 0, 'computeLints not found in process-graph.js');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of computeLints not found');
  const body = src.slice(start, end);
  const codes = new Set([...body.matchAll(/\bcode:\s*'([a-z0-9-]+)'/g)].map(m => m[1]));
  assert.ok(codes.size >= 20, `expected the full set of lint codes, found ${codes.size}`);
  const missing = [...codes].filter(c => !LINT_INFO[c]);
  assert.deepEqual(missing, [], `lint codes without a LINT_INFO entry: ${missing.join(', ')}`);
});

test('outcome-switch lint codes render a title and fix, not the slug (#2711)', () => {
  for (const code of ['human-label-as-outcome', 'same-label-multiple-outcomes', 'switch-with-one-option']) {
    const v = lintView({ code, severity: 'warning' });
    assert.notEqual(v.title, code);
    assert.ok(v.fix && v.fix.length > 0, `${code} missing fix`);
  }
  assert.equal(LINT_INFO['human-label-as-outcome'].title, 'Agent outcome sets a human-only gate');
});

test('unknown code falls back to the slug with no fix, never blank', () => {
  const v = lintView({ code: 'some-future-lint', severity: 'warning', message: 'msg' });
  assert.equal(v.title, 'some-future-lint');
  assert.equal(v.fix, null);
  assert.equal(v.severityWord, 'Warning');
  assert.equal(v.severityColor, 'var(--eb-status-warning)');
});

test('severity word and colour cover the three levels + fallback', () => {
  assert.equal(lintView({ severity: 'error' }).severityWord, 'Error');
  assert.equal(lintView({ severity: 'warning' }).severityWord, 'Warning');
  assert.equal(lintView({ severity: 'info' }).severityWord, 'Info');
  assert.equal(lintView({ severity: undefined }).severityWord, 'Info');
  assert.equal(severityColor('info'), 'var(--eb-text-muted)');
  assert.equal(severityColor('anything-else'), 'var(--eb-text-muted)');
});

test('lintView tolerates a null/empty lint without throwing', () => {
  const v = lintView(null);
  assert.equal(v.severityWord, 'Info');
  assert.equal(v.message, '');
  assert.equal(v.fix, null);
});
