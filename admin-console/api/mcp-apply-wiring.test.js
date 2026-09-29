'use strict';

// Route wiring for applying an MCP change to live agents (#2289). api.js cannot
// be `require`d in a unit test (it boots Express and reaches for the
// orchestrator), so — like pool-member-write.test.js — these read the route
// source. The apply behaviour itself is covered by orchestrator/mcp-seed.test.js.

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

test('applyMcpChange awaits the orchestrator apply-mcp route and never throws', () => {
  const src = fnSource('applyMcpChange');
  assert.match(src, /\/internal\/\$\{kind\}\/\$\{encodeURIComponent\(id\)\}\/apply-mcp/);
  assert.match(src, /await fetch\(/);
  assert.match(src, /AbortSignal\.timeout\(/, 'a hung orchestrator must not hang the save');
  assert.match(src, /catch \(err\)[\s\S]*ok: false/, 'unreachable orchestrator is reported, not thrown');
});

test('PUT /api/agents/:id applies an MCP override change (incl. back to inherit) and reports it', () => {
  const src = routeSource("app.put('/api/agents/:id'");
  const before = src.indexOf('const mcpOverrideBefore');
  const normalize = src.indexOf('normalizeMcpServersInput(mcpServersOverride)');
  assert.ok(before >= 0 && before < normalize, 'the prior override is captured before it is changed');
  assert.match(src, /mcpServersOverride \?\? null\) !== mcpOverrideBefore\s*\?\s*await applyMcpChange\('agents', id\)/);
  assert.match(src, /res\.json\(\{ id, \.\.\.fresh, \.\.\.\(mcpApply \? \{ mcpApply \} : \{\}\) \}\)/);
});

test('PUT /api/environments/:id applies an MCP set change to bound agents before any respawn', () => {
  const src = routeSource("app.put('/api/environments/:id'");
  const prev = src.indexOf('const prevMcpServers');
  const normalize = src.indexOf('normalizeMcpServersInput(mcpServers)');
  const save = src.indexOf('saveEnvironment(env.id, env)');
  const apply = src.indexOf("await applyMcpChange('environments', env.id)");
  const respawn = src.indexOf('notifyEnvCredentialChange(');
  assert.ok(prev >= 0 && prev < normalize, 'the prior set is captured before it is changed');
  assert.ok(save < apply, 'applied only after the environment is saved');
  assert.ok(apply < respawn, 'applied before a respawn so a restarted container starts on the new set');
  assert.match(src, /mcpServers \|\| \[\]\) !== prevMcpServers/);
  assert.match(src, /\.\.\.\(mcpApply \? \{ mcpApply \} : \{\}\)/);
});

test('the orchestrator exposes the apply-mcp route for agents and environments', () => {
  const orch = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'orchestrator.js'), 'utf8');
  assert.match(orch, /\\\/internal\\\/\(agents\|environments\)\\\/\(\[\^\/\]\+\)\\\/apply-mcp\$/);
  assert.match(orch, /async function applyAgentMcp\(/);
  assert.match(orch, /async function applyEnvironmentMcp\(/);
});
