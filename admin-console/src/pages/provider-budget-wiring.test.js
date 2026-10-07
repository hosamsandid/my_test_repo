import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// #2732: the JSX half of the provider budget feature. The decisions (Budget cell
// text/tone, Warning label, banner copy) are unit-tested in
// provider-health-view.test.js; JSX is uncovered by unit tests (#651), so this
// pins the wiring by reading the source: the Health cell paints Warning orange
// and shows its reason line, the Budget cell renders budgetCellModel from the
// right field per row kind, and Agent Chat shows the budget banner as a
// non-blocking status that never gates sending.

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY = readFileSync(join(here, 'ModelRegistry.jsx'), 'utf8');
const CHAT = readFileSync(join(here, 'agent-chat', 'ChatPanel.jsx'), 'utf8');

function column(src, key) {
  const start = src.indexOf(`key: '${key}',`);
  assert.ok(start >= 0, `column ${key} not found in ModelRegistry.jsx`);
  const end = src.indexOf('\n    {', start);
  assert.ok(end > start, `end of column ${key} not found`);
  return src.slice(start, end);
}

const CHECKS = {
  healthWarningIsOrange(src) {
    const health = column(src, 'health');
    assert.match(health, /tone === 'warning' \? 'var\(--eb-status-warning\)'/,
      'the Health cell must paint the Warning tone orange');
    assert.match(health, /v\.status === 'error' \|\| v\.status === 'warning'/,
      'the Health cell must show the reason line for Warning as well as Error');
  },

  budgetCellWiring(src) {
    const budget = column(src, 'budget');
    assert.match(budget, /row\.readOnly \? row\.budget : row\.health\?\.budget/,
      'the .env row reads its top-level budget, registered rows the health view budget');
    assert.match(budget, /budgetCellModel\(budget, row\.readOnly \? null : row\.health\?\.status\)/,
      'the Budget cell must render budgetCellModel, toned by the row Health');
    assert.match(budget, /section=\{MODELS_HELP_SECTIONS\.budget\}/,
      'the Budget header "?" must open the budget help section');
  },

  chatBannerNonBlocking(src) {
    assert.match(src, /const providerBudgetWarning = providerBudgetWarningText\(modelOptions\?\.endpointHealth, modelOptions\?\.endpointName\)/,
      'ChatPanel must derive the budget banner from the bound provider health');
    assert.match(src, /\{providerBudgetWarning && \(\s*<div role="status"/,
      'the budget banner must render as a role="status" block');
    // #2713 folded the composer gate into one `composerDisabled` expression.
    const gates = [...(src.match(/disabled=\{[^}]*\}/g) || []), ...(src.match(/const composerDisabled = [^;]*;/g) || [])];
    assert.ok(!gates.some(g => /providerBudgetWarning/.test(g)),
      'the budget banner must never disable sending (AC9: non-blocking)');
  },
};

test('ModelRegistry: Warning health is orange with its reason line (AC6)', () => CHECKS.healthWarningIsOrange(REGISTRY));
test('ModelRegistry: Budget column renders budgetCellModel per row kind (AC3–AC5)', () => CHECKS.budgetCellWiring(REGISTRY));
test('ChatPanel: budget banner is a non-blocking status (AC9)', () => CHECKS.chatBannerNonBlocking(CHAT));

const MUTATIONS = [
  { fires: 'healthWarningIsOrange', src: REGISTRY,
    apply: s => s.replace("tone === 'warning' ? 'var(--eb-status-warning)'", "tone === 'warning' ? 'var(--eb-text-secondary)'") },
  { fires: 'budgetCellWiring', src: REGISTRY,
    apply: s => s.replace('row.readOnly ? row.budget : row.health?.budget', 'row.health?.budget') },
  { fires: 'chatBannerNonBlocking', src: CHAT,
    apply: s => s.replace('const composerDisabled = disabled ||', 'const composerDisabled = disabled || Boolean(providerBudgetWarning) ||') },
];

for (const { fires, src, apply } of MUTATIONS) {
  test(`mutation proof: ${fires} catches its own sabotage`, () => {
    const mutated = apply(src);
    assert.notEqual(mutated, src, 'the mutation did not change the source — re-point it');
    assert.throws(() => CHECKS[fires](mutated), assert.AssertionError);
  });
}
