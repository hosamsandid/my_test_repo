'use strict';
// #2813 — orchestrator wiring of the portable role settings. orchestrator.js
// is not loadable in isolation (it boots the control plane), so — like
// acting-sender-wiring / admission-control-wiring — the call sites are pinned
// by source text; the pure helpers they call are unit-tested elsewhere
// (memory-limit.test.js, spawn-container.test.js, spawn-kubernetes-pod.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function fnBody(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return SRC.slice(start, SRC.indexOf('\n}\n', start));
}

test('addTeamMember records the portable fields through the shared memberPortableFields helper', () => {
  assert.match(SRC, /const \{ memberPortableFields \} = require\("\.\/member-portable-fields"\);/);
  // Both the stub and the materialised branch of addTeamMember use it.
  assert.equal((SRC.match(/memberPortableFields\(opts\)/g) || []).length, 2);
});

test('every container start sizes from the role memory, clamped to the ceiling (AC3/AC5)', () => {
  const body = fnBody('resolveRoleMemoryLimit');
  assert.match(body, /memoryCeiling\(process\.env\)/);
  assert.match(body, /eff\.clamped/);
  assert.match(fnBody('startAgentProcess'), /const memoryLimit = resolveRoleMemoryLimit\(id, config\)/);
});

test('a pool instance inherits its template\'s prompt mode, model and memory (AC3)', () => {
  const at = SRC.indexOf('systemPromptOverride: templateCfg.systemPrompt');
  assert.ok(at >= 0);
  const call = SRC.slice(at, at + 1200);
  assert.match(call, /promptMode: templateCfg\.promptMode/);
  assert.match(call, /modelOverride: templateCfg\.modelOverride/);
  assert.match(call, /memoryLimit: templateCfg\.memoryLimit/);
});
