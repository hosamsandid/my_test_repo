// Catalog-generator tests (#706) — pure, `node --test`, no Playwright.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  buildCatalog,
  renderCatalogJson,
  parseParam,
  parseJsDoc,
  parseExportNames,
  docsBeforeFunctions,
  CATALOG_PATH,
} = require('./catalog');

test('parseParam handles typed, optional, defaulted and positional forms', () => {
  assert.deepEqual(parseParam('{string} params.templateName - The template.'), {
    name: 'templateName',
    required: true,
    type: 'string',
    description: 'The template.',
  });
  assert.deepEqual(parseParam('{string} [params.branch=main] - Branch to track.'), {
    name: 'branch',
    required: false,
    type: 'string',
    default: 'main',
    description: 'Branch to track.',
  });
  // Bare positional name, no type, no description.
  assert.deepEqual(parseParam('id'), { name: 'id', required: true });
});

test('parseJsDoc splits description, params and example', () => {
  const body = `
 * Does a thing to the wizard.
 *
 * @param {string} params.name - The name.
 * @example
 * - action:
 *     do: mod.fn
 *     name: X
 `;
  const doc = parseJsDoc(body);
  assert.equal(doc.description, 'Does a thing to the wizard.');
  assert.equal(doc.params.length, 1);
  assert.equal(doc.params[0].name, 'name');
  assert.match(doc.example, /do: mod\.fn/);
  assert.match(doc.example, /name: X/);
});

test('parseExportNames reads a module.exports literal', () => {
  const names = parseExportNames('module.exports = { open, next, volatileLocators };');
  assert.deepEqual(names, ['open', 'next', 'volatileLocators']);
});

test('docsBeforeFunctions tolerates a // comment between JSDoc and the function', () => {
  const src = `/**\n * Summary here.\n */\n// an implementation note\nasync function foo(ctx) {}`;
  const map = docsBeforeFunctions(src);
  assert.ok(map.has('foo'));
  assert.equal(map.get('foo').description, 'Summary here.');
});

test('buildCatalog covers the registered step namespaces + the teamEnv fixture', () => {
  const cat = buildCatalog();
  const names = new Set(cat.steps.map((s) => s.name));
  for (const n of ['wizard.open', 'wizard.selectProcessTemplate', 'env.createFixtureEnv', 'agents.expectTeamInRail', 'teardown.teardownTeam']) {
    assert.ok(names.has(n), `catalog contains ${n}`);
  }
  // Re-exported step borrows the declaring module's JSDoc.
  assert.ok(names.has('teardown.deleteEnv'));
  assert.equal(cat.steps.find((s) => s.name === 'teardown.deleteEnv').description.length > 0, true);

  // Optional param with a default is marked non-required.
  const createEnv = cat.steps.find((s) => s.name === 'env.createFixtureEnv');
  const branch = createEnv.params.find((p) => p.name === 'branch');
  assert.equal(branch.required, false);
  assert.equal(branch.default, 'main');

  // volatileLocators is reserved and never a step.
  assert.equal(names.has('wizard.volatileLocators'), false);

  // Fixtures.
  const teamEnv = cat.fixtures.find((f) => f.name === 'teamEnv');
  assert.ok(teamEnv, 'teamEnv fixture present');
  assert.ok(teamEnv.params.some((p) => p.name === 'repoUrl' && p.required));
});

test('buildCatalog is deterministic', () => {
  assert.equal(renderCatalogJson(buildCatalog()), renderCatalogJson(buildCatalog()));
});

test('the committed steps-catalog.json is up to date', () => {
  const current = fs.readFileSync(CATALOG_PATH, 'utf8');
  assert.equal(current, renderCatalogJson(buildCatalog()), 'run `npm run journeys:catalog` and commit');
});
