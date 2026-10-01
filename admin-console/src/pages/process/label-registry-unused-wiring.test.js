import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// #2716 — source guards for the JSX/adapter wiring of "delete unused labels"
// (JSX stays uncovered by node:test per #651; the logic lives in the pure
// label-registry-ops.js and process-graph.js, tested on their own).
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(here, rel), 'utf8');

test('panel marks unused rows and offers per-row + bulk delete behind a confirmation', () => {
  const s = src('./LabelRegistryPanel.jsx');
  assert.match(s, /registryRows\(labels, unusedLabels\)/, 'rows come from graph.labels + graph.unusedLabels');
  assert.match(s, /\{row\.unused && \(\s*<span[^>]*>\s*not used in this flow/, 'unused rows carry the mark');
  assert.match(s, /\{row\.unused && \(\s*<button[\s\S]*?setPendingDelete\(\[row\.name\]\)/, 'delete button only on unused rows');
  assert.match(s, /\{unusedNames\.length > 0 && \([\s\S]*?Delete all unused \(\{unusedNames\.length\}\)/, 'bulk action only when n > 0');
  assert.match(s, /<ConfirmDialog[\s\S]*?onConfirm=\{confirmDelete\}/);
  // One save for the whole set; the row stays and the error shows on failure.
  assert.match(s, /await ops\.removeLabels\(names\);\s*setRows\(rs => rs\.filter\(r => !names\.includes\(r\.name\)\)\);/);
  assert.match(s, /catch \(e\) \{\s*setError\(e\.message\);/);
});

test('both adapters re-check usage server-side before writing labels[] only', () => {
  const s = src('./edit-adapters.js');
  assert.match(s, /removeLabels: async \(teamId, names\) => \{\s*const g = await apiCall\('GET', `\/api\/flows\/graph\?team=\$\{encodeURIComponent\(teamId\)\}`\);\s*assertLabelsUnused\(names, g\?\.unusedLabels\);[\s\S]*?apiCall\('PUT', `\/api\/agents\/\$\{teamId\}`, \{ labels: labelsAfterRemove\(cur, names\) \}\)/);
  assert.match(s, /removeLabels: async \(names\) => \{\s*const b = clone\(getBundle\(\)\);\s*const g = await apiCall\('POST', '\/api\/flows\/graph', \{ processTemplate: b \}\);\s*assertLabelsUnused\(names, g\?\.unusedLabels\);[\s\S]*?await persist\(b\);/);
});

test('ProcessCanvas threads unusedLabels and the live removeLabels op into the panel', () => {
  const s = src('../ProcessCanvas.jsx');
  assert.match(s, /removeLabels: \(names\) => liveOps\.removeLabels\(scope, names\)/);
  assert.match(s, /<LabelRegistryPanel[\s\S]*?unusedLabels=\{displayGraph\?\.unusedLabels \|\| \[\]\}/);
});
