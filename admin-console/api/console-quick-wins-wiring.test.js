'use strict';

// #570 wiring guard (source-reading, like the other api.js guards):
//   1. /api/agents/statuses goes through the SWR cache, and its orchestrator
//      hop through the one-request source (decisions: agent-processes-view.js);
//   2. GET /api/environments reads the fleet once for the whole list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function body(marker, end = '\n}') {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `${marker} not found — this guard needs re-pointing`);
  return API_SRC.slice(start, API_SRC.indexOf(end, start));
}

test('statuses are served through the SWR cache', () => {
  assert.match(body('function agentStatusEntries()'), /return await agentStatusCache\.get\(buildAllAgentStatuses\);/);
  const decl = body('const agentStatusCache = createSwrCache({', '\n});');
  assert.match(decl, /freshMs: STATUS_CACHE_TTL_MS,/);
  assert.match(decl, /maxStaleMs: STATUS_CACHE_MAX_STALE_MS,/);
  assert.match(decl, /failureBackoffMs: STATUS_CACHE_TTL_MS,/);
  assert.match(decl, /onError: /);
  assert.match(decl, /onRecover: /);
  assert.doesNotMatch(API_SRC, /_statusCache\b/, 'the hand-rolled cache is gone');
});

test('the processes hop goes through the one-request source (agent-processes-view.js)', () => {
  const b = body('async function buildAllAgentStatuses()');
  assert.match(b, /const view = await agentProcesses\.read\(\);/);
  assert.doesNotMatch(b, /fetch\(/, 'no per-build request — the source owns the one outstanding fetch');
  const decl = body('const agentProcesses = createProcessesSource({', '\n});');
  assert.match(decl, /fetch\(`\$\{orchestratorUrl\}\/internal\/agents\/processes`, \{\n\s+signal: AbortSignal\.timeout\(AGENT_PROCESSES_TIMEOUT_MS\),/);
  assert.match(decl, /return resp\.ok \? resp\.json\(\) : null;/);
  assert.match(decl, /waitMs: AGENT_PROCESSES_WAIT_MS,/);
  assert.match(decl, /timeoutMs: AGENT_PROCESSES_TIMEOUT_MS,/);
  assert.match(decl, /viewMaxMs: AGENT_PROCESSES_LAST_VIEW_MAX_MS,/);
  // A slow orchestrator is waited out by the request, never by the build.
  assert.match(API_SRC, /const AGENT_PROCESSES_WAIT_MS = ttlMsFromEnv\(process\.env\.AGENT_PROCESSES_WAIT_MS, 3000\) \|\| 3000;/);
  assert.match(API_SRC, /const AGENT_PROCESSES_TIMEOUT_MS = ttlMsFromEnv\(process\.env\.AGENT_PROCESSES_TIMEOUT_MS, 60_000\) \|\| 60_000;/);
});

test('an all-offline build (no runtime view) is served but never cached', () => {
  const b = body('async function buildAllAgentStatuses()');
  assert.match(b, /if \(view\.source === 'none'\) \{[\s\S]*?err\.entries = entries;\s+throw err;/,
    'the build rejects so the SWR cache keeps the previous good set');
  assert.match(body('async function agentStatusEntries()'),
    /catch \(err\) \{\s+if \(Array\.isArray\(err\.entries\)\) return err\.entries;\s+throw err;/,
    'a waiting caller still gets the all-offline set');
});

test('GET /api/environments reads the fleet once, not once per environment', () => {
  const r = body("app.get('/api/environments', ", '\n});');
  assert.equal((r.match(/agentsByEnvironment\(\)/g) || []).length, 1);
  assert.match(r, /agentsUsingEnvironment\(e\.id, scope, byEnv\)/);
  assert.doesNotMatch(r, /listAgentDirs|readJsonFile/);
  assert.match(body('function agentsUsingEnvironment('), /byEnv = agentsByEnvironment\(\)/, 'single-env callers keep one scan each');
});
