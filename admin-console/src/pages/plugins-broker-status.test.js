import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #651 source guards for the JSX half of #2649 (the decisions themselves are
// covered in plugin-registry-view.test.js).
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'Plugins.jsx'), 'utf8');

test('an install that reached the orchestrator records when the broker started', () => {
  assert.match(src, /setStartingSince\(\(prev\) => \(\{ \.\.\.prev, \[row\.id\]: t \}\)\)/);
  assert.match(src, /startingSince: startingSince\[e\.id\] \?\? null, now,/);
});

test('the page polls /api/plugins only while a broker is starting', () => {
  assert.match(src, /const polling = needsBrokerPoll\(installed\);/);
  assert.match(src, /if \(!polling\) return undefined;/);
  assert.match(src, /setInterval\(\(\) => \{ setNow\(Date\.now\(\)\); refetch\(\); \}, BROKER_POLL_MS\)/);
  assert.match(src, /return \(\) => clearInterval\(t\);/);
});

test('the card shows why a broker is not running', () => {
  assert.match(src, /\{row\.status\.reason && \(\s*<div[^>]*>\s*\{row\.status\.reason\}\s*<\/div>/);
});

test('a broken entry shows no plugin defaults and no team sections', () => {
  assert.match(src, /\{row\.scopes\.length > 0 && <span>Scopes: \{row\.scopes\.join\(', '\)\}<\/span>\}/);
  assert.match(src, /\{row\.quota && <span>\{row\.quota\}<\/span>\}/);
  assert.match(src, /\{row\.installed && !row\.invalid && \(\s*<PluginTeamAssign/);
  assert.match(src, /\{row\.installed && !row\.invalid && row\.credentialKeys\.length > 0 && \(/);
});

test('the remove confirm uses the view-module wording', () => {
  assert.match(src, /title=\{uninstallDialog\(removing\)\.title\}/);
  assert.match(src, /confirmLabel=\{uninstallDialog\(removing\)\.confirmLabel\}/);
  assert.match(src, /const \{ body \} = uninstallDialog\(row\);/);
  assert.match(src, /\{body \|\| 'The broker stops\./);
});

test('uninstall forgets the start timestamp (S2)', () => {
  const start = src.indexOf('async function doUninstall(row)');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /setStartingSince\(\(prev\) => \{\s*const next = \{ \.\.\.prev \};\s*delete next\[row\.id\];\s*return next;\s*\}\);/);
});

test('a start timestamp is dropped once its broker runs (S3)', () => {
  assert.match(src, /const settled = settledStartIds\(installed, startingSince\);\s*if \(settled\.length === 0\) return;\s*setStartingSince\(\(prev\) => \{\s*const next = \{ \.\.\.prev \};\s*for \(const id of settled\) delete next\[id\];/);
  assert.match(src, /\}, \[installed, startingSince\]\);/);
});

test('the stack runtime comes from the API response', () => {
  assert.match(src, /const stackRuntime = \(data && data\.stackRuntime\) \|\| 'podman';/);
});
