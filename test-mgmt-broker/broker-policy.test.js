'use strict';

// Reference tests for the broker policy glue. Dependency-free (`node --test`);
// this broker dir has no CI job (like podman-mcp/), so these are the reference
// coverage — the reusable decision itself is CI-covered in broker-sdk/authz.
const test = require('node:test');
const assert = require('node:assert');
const { decide, resolveCaller } = require('./broker-policy');

// A scope registry the orchestrator would maintain.
function registry(entries) {
  return new Map(Object.entries(entries));
}

test('resolveCaller fails closed for an unregistered scope', () => {
  assert.deepEqual(resolveCaller(registry({}), 'ghost'), { kind: 'unknown' });
  assert.deepEqual(resolveCaller(null, 'ghost'), { kind: 'unknown' });
});

test('the acceptance case: same-team non-final agent refused create-case; final agent allowed', () => {
  const reg = registry({
    'alpha-dev': { kind: 'agent', flowFinal: false, crossChecksPassed: true },
    'alpha-qa': { kind: 'agent', flowFinal: true, crossChecksPassed: true },
  });
  const nonFinal = decide('test_case_create', 'alpha-dev', reg);
  assert.equal(nonFinal.allow, false);
  assert.equal(nonFinal.code, 'not-flow-final');

  const final = decide('test_case_create', 'alpha-qa', reg);
  assert.equal(final.allow, true);
  assert.equal(final.needsApproval, false);
});

test('a team-scoped caller cannot create test cases', () => {
  const reg = registry({ alpha: { kind: 'team' } });
  const r = decide('test_case_create', 'alpha', reg);
  assert.equal(r.allow, false);
  assert.equal(r.code, 'scope-not-permitted');
});

test('unrestricted verbs are allowed for any granted scope', () => {
  const reg = registry({ alpha: { kind: 'team' } });
  assert.equal(decide('test_run_submit', 'alpha', reg).allow, true);
  assert.equal(decide('test_run_status', 'alpha', reg).allow, true);
  assert.equal(decide('test_data_list', 'alpha', reg).allow, true);
});

test('a destructive op is allowed but flagged for approval', () => {
  const reg = registry({ 'alpha-qa': { kind: 'agent', flowFinal: true, crossChecksPassed: true } });
  const r = decide('test_data_delete', 'alpha-qa', reg);
  assert.equal(r.allow, true);
  assert.equal(r.needsApproval, true);
  assert.equal(r.subcommand, 'data-delete');
});

test('data-delete from a team scope is refused (agent-only), never reaching approval', () => {
  const reg = registry({ alpha: { kind: 'team' } });
  const r = decide('test_data_delete', 'alpha', reg);
  assert.equal(r.allow, false);
  assert.equal(r.code, 'scope-not-permitted');
});
