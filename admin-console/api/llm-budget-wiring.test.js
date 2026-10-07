'use strict';

// Guards the api.js half of #2732 — the wiring the pure modules can't own.
//
// llm-budget.js (lookup, effective budget, formatting) and llm-health.js (the
// Warning/Error view, no backoff on Warning) are unit-tested on their own. But
// WHERE the budget is read and WHICH view the routes serve lives in api.js:
//   - every health probe also reads the budget and stores it on the record (AC1),
//     skipping the read when the probe could not reach the endpoint at all, and
//     never letting a throwing read escape (AC5);
//   - Test connection records health + budget, not just returns the probe (AC1);
//   - the poll pass also refreshes the read-only .env row's budget (edge case);
//   - every client-facing health view applies the configured warn threshold
//     (AC6/AC7) — a raw llmHealth.healthView(record) would silently use 90;
//   - model-options strips budget amounts for a caller who cannot see the
//     provider row (AC12 — another member's personal-provider lend).
//
// api.js cannot be `require`d in a unit test (it boots Express and reaches for
// the orchestrator), so this reads the source — the drift-guard technique of
// probe-oauth-fallback-wiring.test.js (#651). Each check is a named function over
// a source string, so the mutation proof re-runs it against a sabotaged copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Slice one top-level declaration up to the next top-level function/route/const. */
function block(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `${marker} not found — this guard needs re-pointing`);
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\n(?:async function |function |app\.(?:get|post|put|delete)\(|const |let )/);
  assert.ok(next > 0, `could not find the end of ${marker}`);
  return stripComments(src.slice(start, start + marker.length + next));
}

const CHECKS = {
  /** AC1/AC5: each probe reads the budget and folds it into the health record. */
  probeRecordsBudget(src) {
    const body = block(src, 'async function probeAndRecordHealth(');
    assert.match(body, /const budget = await lookupLlmBudget\(ep\.baseUrl, token, ep\.authType, probe\)/,
      'probeAndRecordHealth must read the budget alongside the probe');
    assert.match(body, /llmHealth\.applyProbeResult\(map\[ep\.id\], probe, Date\.now\(\), budget\)/,
      'probeAndRecordHealth must store the budget lookup on the health record');
  },

  /** AC5: a budget read never throws and is skipped for an unreachable endpoint. */
  lookupNeverThrows(src) {
    const body = block(src, 'async function lookupLlmBudget(');
    assert.match(body, /probe && probe\.status === 0\) return \{ status: 'unavailable'/,
      'lookupLlmBudget must skip the read when the probe could not reach the endpoint');
    assert.match(body, /try \{[\s\S]*llmBudget\.lookupBudget\([\s\S]*\} catch/,
      'lookupLlmBudget must catch a throwing read');
  },

  /** AC1: Test connection refreshes the persisted health + budget. */
  testRouteRecords(src) {
    const body = block(src, "app.post('/api/llm-endpoints/:id/test',");
    assert.match(body, /await probeAndRecordHealth\(ep, probe\)/,
      'the Test-connection route must record its probe (and a fresh budget read)');
  },

  /** Edge case: the poll pass also refreshes the .env row's budget. */
  pollRefreshesEnvBudget(src) {
    const body = block(src, 'async function runLlmHealthPass(');
    assert.match(body, /await refreshEnvFallbackBudget\(\)/,
      'runLlmHealthPass must refresh the read-only .env row budget');
    assert.match(block(src, "app.get('/api/llm-env-fallback',"), /llmBudget\.budgetView\(/,
      'GET /api/llm-env-fallback must carry the .env row budget view');
  },

  /** AC6/AC7: every served health view applies the configured warn threshold. */
  viewsApplyThreshold(src) {
    assert.match(block(src, 'function llmHealthConfig('),
      /budgetWarnPct: llmBudget\.coercePct\(process\.env\.AEE_LLM_HEALTH_BUDGET_WARN_PCT, llmBudget\.DEFAULT_WARN_PCT\)/,
      'the warn threshold must come from AEE_LLM_HEALTH_BUDGET_WARN_PCT, default 90');
    assert.match(block(src, 'function llmHealthView('), /warnPct: llmHealthConfig\(\)\.budgetWarnPct/,
      'llmHealthView must pass the configured threshold');
    const raw = stripComments(src).match(/llmHealth\.healthView\((?!null\))[^)]*\)/g) || [];
    const outsideWrapper = raw.filter(m => !/warnPct/.test(m));
    assert.deepEqual(outsideWrapper, [],
      'a route serves llmHealth.healthView(record) directly — use llmHealthView() so the threshold applies');
  },

  /** AC12: model-options strips budget amounts for a caller who can't see the provider row. */
  modelOptionsRedactsBudget(src) {
    const body = block(src, "app.get('/api/agents/:id/model-options',");
    assert.match(body,
      /endpointHealth: endpoint\s*\?\s*\(providerReadVisible\(scope, endpoint\)\s*\?\s*llmHealthViewFor\(endpoint\.id\)\s*:\s*llmBudget\.redactHealthBudget\(llmHealthViewFor\(endpoint\.id\)\)\)/,
      'model-options must serve llmBudget.redactHealthBudget(...) unless the caller can read the provider row');
  },
};

for (const [name, check] of Object.entries(CHECKS)) {
  test(`budget wiring: ${name}`, () => check(API_SRC));
}

// ── mutation proof ───────────────────────────────────────────────────────────
// Each sabotage must trip exactly its own check.

const MUTATIONS = [
  {
    fires: 'probeRecordsBudget',
    apply: (s) => s.replace(
      'llmHealth.applyProbeResult(map[ep.id], probe, Date.now(), budget)',
      'llmHealth.applyProbeResult(map[ep.id], probe)'),
  },
  {
    fires: 'lookupNeverThrows',
    apply: (s) => s.replace(
      "if (probe && probe.status === 0) return { status: 'unavailable', reason: 'provider unreachable' };",
      ''),
  },
  {
    fires: 'testRouteRecords',
    apply: (s) => s.replace('  await probeAndRecordHealth(ep, probe);\n', ''),
  },
  {
    fires: 'pollRefreshesEnvBudget',
    apply: (s) => s.replace('    await refreshEnvFallbackBudget();\n', ''),
  },
  {
    fires: 'viewsApplyThreshold',
    apply: (s) => s.replace(
      'health: llmHealthView(healthMap[ep.id])',
      'health: llmHealth.healthView(healthMap[ep.id])'),
  },
  {
    fires: 'modelOptionsRedactsBudget',
    apply: (s) => s.replace(
      ': llmBudget.redactHealthBudget(llmHealthViewFor(endpoint.id)))',
      ': llmHealthViewFor(endpoint.id))'),
  },
];

for (const { fires, apply } of MUTATIONS) {
  test(`mutation proof: breaking ${fires} fires exactly that check`, () => {
    const mutated = apply(API_SRC);
    assert.notEqual(mutated, API_SRC, 'the mutation did not change the source — re-point it');
    assert.throws(() => CHECKS[fires](mutated), assert.AssertionError,
      `${fires} did not catch its own mutation`);
    for (const [name, check] of Object.entries(CHECKS)) {
      if (name === fires) continue;
      assert.doesNotThrow(() => check(mutated),
        `${name} also fired — the checks overlap, so a failure would name the wrong one`);
    }
  });
}
