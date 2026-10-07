import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_ACTION_LABELS } from '../pages/plugin-credentials-view.js';

/**
 * Source-reading drift guard over PluginCredentials.jsx, which `node --test`
 * cannot load (the #651 convention). #2640: "Clear" must open a confirmation
 * instead of deleting on one click, and the form must be able to test the
 * stored credential — on a click and right after a Save.
 */

const src = readFileSync(fileURLToPath(new URL('./PluginCredentials.jsx', import.meta.url)), 'utf8');

test('labels', () => {
  assert.equal(CREDENTIAL_ACTION_LABELS.clear, 'Clear');
  assert.equal(CREDENTIAL_ACTION_LABELS.test, 'Test connection');
});

test('the Clear button opens the confirmation; it never calls clearAll directly', () => {
  const labelAt = src.indexOf('{CREDENTIAL_ACTION_LABELS.clear}');
  assert.ok(labelAt >= 0, 'a Clear button labelled from CREDENTIAL_ACTION_LABELS.clear');
  const btn = src.slice(src.lastIndexOf('<button', labelAt), labelAt);
  assert.match(btn, /onClick=\{\(\) => setConfirmClear\(true\)\}/);
  assert.doesNotMatch(btn, /clearAll/);
});

test('the DELETE is only reachable through the confirmation dialog', () => {
  // clearAll is referenced exactly twice: its definition and the dialog's onConfirm.
  assert.equal((src.match(/\bclearAll\b/g) || []).length, 2);
  const dialog = src.match(/<ConfirmDialog[\s\S]*?\/>/);
  assert.ok(dialog, 'a ConfirmDialog is rendered');
  assert.match(dialog[0], /open=\{confirmClear\}/);
  assert.match(dialog[0], /onConfirm=\{clearAll\}/);
  assert.match(dialog[0], /onCancel=\{\(\) => setConfirmClear\(false\)\}/);
  assert.match(dialog[0], /variant="danger"/);
  // the message names the team and the keys (clearConfirmation, unit-tested)
  assert.match(dialog[0], /title=\{confirm\.title\}/);
  assert.match(dialog[0], /message=\{confirm\.message\}/);
  assert.match(src, /const confirm = clearConfirmation\(scope, descriptors, pluginName\)/);
});

test('Test connection posts to …/test and shows the result next to the scope', () => {
  assert.match(src, /apiCall\('POST', `\$\{scopeUrl\}\/test`\)/);
  const btn = src.match(/<button[^>]*onClick=\{\(\) => runTest\(\)\}[\s\S]*?<\/button>/);
  assert.ok(btn, 'a Test connection button calls runTest');
  assert.match(btn[0], /CREDENTIAL_ACTION_LABELS\.test\b/);
  assert.match(src, /credentialTestLine\(test\.result, \{ auto: test\.auto \}\)/);
  assert.match(src, /role="status"[^>]*color: TONE\[credentialTestTone\(test\.result\)\]/);
});

test('a successful Save runs the check automatically', () => {
  const save = src.slice(src.indexOf('async function save()'), src.indexOf('async function clearAll()'));
  assert.match(save, /await runTest\(\{ auto: true \}\);/);
  // a failed save returns before the check
  assert.ok(save.indexOf("setErr(e.message || 'Save failed');\n      return;") >= 0);
});
