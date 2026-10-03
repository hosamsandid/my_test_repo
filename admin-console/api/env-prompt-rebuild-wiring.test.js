'use strict';

// Route wiring for rebuilding bound agents' CLAUDE.md after an environment's
// Additional context changed (#2688). api.js cannot be `require`d in a unit
// test, so — like mcp-apply-wiring.test.js — these read the route source. The
// fan-out decisions are covered by orchestrator/env-prompt-rebuild.test.js.

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
  const start = API_SRC.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `function not found: ${name}`);
  return API_SRC.slice(start, API_SRC.indexOf('\n}\n', start));
}

test('rebuildEnvironmentPrompts awaits the orchestrator route and never throws', () => {
  const src = fnSource('rebuildEnvironmentPrompts');
  assert.match(src, /\/internal\/environments\/\$\{encodeURIComponent\(envId\)\}\/prompt-rebuild/);
  assert.match(src, /await fetch\(/);
  assert.match(src, /AbortSignal\.timeout\(/, 'a hung orchestrator must not hang the save');
  assert.match(src, /catch \(err\)[\s\S]*ok: false/, 'unreachable orchestrator is reported, not thrown');
});

test('PUT /api/environments/:id rebuilds bound agents\' CLAUDE.md only when Additional context changed', () => {
  const src = routeSource("app.put('/api/environments/:id'");
  const prev = src.indexOf('const prevAdditionalContext');
  const assign = src.indexOf('env.additionalContext = additionalContext');
  const save = src.indexOf('saveEnvironment(env.id, env)');
  const rebuild = src.indexOf('await rebuildEnvironmentPrompts(env.id,');
  const respawn = src.indexOf('notifyEnvCredentialChange(');
  assert.ok(prev >= 0 && prev < assign, 'the prior text is captured before it is changed');
  assert.ok(save < rebuild, 'rebuilt only after the environment is saved');
  assert.ok(rebuild < respawn, 'rebuilt before a respawn so a restarted container starts on the new text');
  assert.match(src, /\(env\.additionalContext \|\| ''\) !== prevAdditionalContext\s*\?\s*await rebuildEnvironmentPrompts/);
  assert.match(src, /\.\.\.\(promptRebuild \? \{ promptRebuild \} : \{\}\)/);
});

test('the orchestrator exposes the environment prompt-rebuild route', () => {
  const orch = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'orchestrator.js'), 'utf8');
  assert.match(orch, /\\\/internal\\\/environments\\\/\(\[\^\/\]\+\)\\\/prompt-rebuild\$/);
  assert.match(orch, /async function rebuildEnvironmentPrompts\(/);
});
