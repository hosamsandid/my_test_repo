import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// #2814 wiring guard — the JSX is uncovered by a renderer (#651), so the facts
// the pure `pool-instance-hint.js` relies on are checked in the source.

const here = dirname(fileURLToPath(import.meta.url));
const sourceOf = (rel) => readFileSync(join(here, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('AC4: the canvas reads the team pool-control and badges each role node with its hint', () => {
  const src = sourceOf('../ProcessCanvas.jsx');
  assert.match(src, /`\/api\/teams\/\$\{encodeURIComponent\(scope\)\}\/pool-control`/);
  assert.match(src, /poolInstanceHintsByNode\(poolControl\)/);
  assert.match(src, /badge\.textContent = hint\.text;/);
});

test('AC3: an instance\'s anomalies count on its role node', () => {
  const src = sourceOf('../ProcessCanvas.jsx');
  assert.match(src, /anomalyCountByNode\(anomalyList, poolInstanceRoleMap\(agents\)\)/);
});

test('Copilot member ids leave pool instances out', () => {
  const src = sourceOf('../ProcessCanvas.jsx');
  assert.match(src, /memberIds:[^\n]*!isPoolInstanceRow\(a\)/);
});

test('AC5: the Node Inspector lists the role\'s instances from its own pool-control read', () => {
  const src = sourceOf('./NodeInspector.jsx');
  assert.match(src, /poolInstanceHint\(poolControl, memberCfg\.id\)/);
  assert.match(src, /poolHint\.instances\.map\(/);
});
