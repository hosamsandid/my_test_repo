'use strict';

// Reference tests for the vendor client's pure request/response shaping.
// Dependency-free (`node --test`); this broker dir has no CI job (like
// podman-mcp/), so these are reference coverage.
const test = require('node:test');
const assert = require('node:assert');
const { buildRequest, ownerLabel, parseRunState, isTerminal, TERMINAL_STATES } = require('./vendor-client');

test('every created artifact is stamped with the caller scope owner label', () => {
  const create = buildRequest('test_case_create', { title: 'x' }, 'alpha-qa');
  assert.equal(create.method, 'POST');
  assert.deepEqual(create.body.labels, [ownerLabel('alpha-qa')]);
  assert.equal(ownerLabel('alpha-qa'), 'aee.plugin.owner=alpha-qa');

  const submit = buildRequest('test_run_submit', { plan: 'REG' }, 'alpha-qa');
  assert.deepEqual(submit.body.labels, [ownerLabel('alpha-qa')]);
});

test('list is scoped to the caller owner label (cross-team invisibility)', () => {
  const list = buildRequest('test_data_list', {}, 'beta');
  assert.equal(list.method, 'GET');
  assert.match(list.path, /label=aee\.plugin\.owner%3Dbeta/);
});

test('run-status and delete address a specific id', () => {
  assert.equal(buildRequest('test_run_status', { runId: 'RUN 7' }, 's').path, '/rest/api/testrun/RUN%207');
  const del = buildRequest('test_data_delete', { key: 'FIX/9' }, 's');
  assert.equal(del.method, 'DELETE');
  assert.equal(del.path, '/rest/api/testdata/FIX%2F9');
});

test('unknown op throws', () => {
  assert.throws(() => buildRequest('nope', {}, 's'), /unknown vendor operation/);
});

test('parseRunState reads state or status, terminal detection matches CLI', () => {
  assert.equal(parseRunState({ state: 'PASSED' }), 'passed');
  assert.equal(parseRunState('{"status":"Running"}'), 'running');
  assert.equal(parseRunState('not json'), null);
  assert.equal(isTerminal('passed'), true);
  assert.equal(isTerminal('running'), false);
  assert.ok(TERMINAL_STATES.includes('failed'));
});
