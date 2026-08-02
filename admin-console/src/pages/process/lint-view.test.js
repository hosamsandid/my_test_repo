import { test } from 'node:test';
import assert from 'node:assert/strict';
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
