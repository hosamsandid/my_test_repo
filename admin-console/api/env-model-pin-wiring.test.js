'use strict';

// Route wiring for re-checking members' model pins when an environment's model
// provider changes (#2813 AC9: a pin kept pending at materialise is applied, or
// dropped with a note, once a provider is bound). api.js cannot be `require`d
// in a unit test, so — like env-prompt-rebuild-wiring.test.js — these read the
// route source. The per-member decision is covered behaviourally by
// staleModelPin in process-template-portable-settings.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function routeSource(signature) {
  const start = API_SRC.indexOf(signature);
  assert.ok(start >= 0, `route not found: ${signature}`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  return API_SRC.slice(start, end);
}

function fnSource(name) {
  const start = API_SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function not found: ${name}`);
  return API_SRC.slice(start, API_SRC.indexOf('\n}\n', start));
}

test('dropStaleEnvModelPins drops only the bound members\' pins staleModelPin flags, and persists them', () => {
  const src = fnSource('dropStaleEnvModelPins');
  assert.match(src, /if \(!endpoint\) return \[\];/, 'no provider bound → pins stay pending');
  assert.match(src, /cfg\.environmentId !== env\.id\) continue;/);
  assert.match(src, /staleModelPin\(cfg, endpoint\)/);
  assert.match(src, /delete cfg\.modelOverride;\s*writeJsonAtomic\(cfgPath, cfg\);/);
});

test('PUT /api/environments/:id re-checks model pins on a provider change, before the respawn, and reports them', () => {
  const src = routeSource("app.put('/api/environments/:id'");
  const save = src.indexOf('saveEnvironment(env.id, env)');
  const drop = src.indexOf('dropStaleEnvModelPins(env)');
  const respawn = src.indexOf('notifyEnvCredentialChange(');
  assert.ok(save >= 0 && save < drop, 'checked only after the environment is saved');
  assert.ok(drop < respawn, 'checked before the respawn so no member starts on an unserved model');
  assert.match(src, /\(env\.llmEndpointId \|\| null\) !== prevLlmEndpointId\s*\?\s*dropStaleEnvModelPins\(env\)/);
  assert.match(src, /modelPinsDropped\.length \? \{ modelWarnings: modelPinsDropped \} : \{\}/);
});
