import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// #2813 — edit-adapters.js imports the browser-only `useApi`, so it cannot be
// loaded under node:test; these source-text checks pin the wiring of the
// portable role settings instead (the behaviour of the save sequence is
// covered against mock ops in node-inspector-save.test.js).
const src = readFileSync(fileURLToPath(new URL('./edit-adapters.js', import.meta.url)), 'utf8');

test('draft ops: setRoleSettings writes exactly promptMode/model/memoryLimit, empty clears', () => {
  const body = src.slice(src.indexOf('setRoleSettings:'), src.indexOf('setStage:', src.indexOf('setRoleSettings:')));
  assert.match(body, /\['promptMode', 'model', 'memoryLimit'\]/);
  assert.match(body, /delete r\[key\]/, 'an empty value removes the key (platform/environment default)');
  assert.match(body, /persist\(b\)/);
});

test('live ops: setMemoryLimit PUTs the agent, null clears', () => {
  assert.match(src, /setMemoryLimit: \(roleId, memoryLimit\) => apiCall\('PUT', `\/api\/agents\/\$\{roleId\}`, \{ memoryLimit: memoryLimit \|\| null \}\)/);
});
