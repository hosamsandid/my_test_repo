import test from 'node:test';
import assert from 'node:assert/strict';
import { healthCellModel, healthCellDetail, providerWarningText } from './provider-health-view.js';

test('healthCellModel: ok/error/unknown map to tones', () => {
  assert.deepEqual(healthCellModel({ status: 'ok' }), { label: 'OK', tone: 'ok' });
  assert.deepEqual(healthCellModel({ status: 'error' }), { label: 'Error', tone: 'error' });
  assert.deepEqual(healthCellModel({ status: 'unknown' }), { label: 'Unknown', tone: 'muted' });
  // AC6: no health object at all is honest 'unknown', never a guessed green.
  assert.deepEqual(healthCellModel(null), { label: 'Unknown', tone: 'muted' });
  assert.deepEqual(healthCellModel(undefined), { label: 'Unknown', tone: 'muted' });
});

test('healthCellDetail: reason on error, http on ok, hint on unknown', () => {
  assert.equal(healthCellDetail({ status: 'error', reason: 'HTTP 401 — bad token' }), 'HTTP 401 — bad token');
  assert.equal(healthCellDetail({ status: 'error', reason: null }), 'Unreachable');
  assert.equal(healthCellDetail({ status: 'ok', httpStatus: 200 }), 'HTTP 200');
  assert.equal(healthCellDetail({ status: 'ok', httpStatus: null }), 'Reachable');
  assert.equal(healthCellDetail({ status: 'unknown' }), 'Not yet checked');
  assert.equal(healthCellDetail(null), 'Not yet checked');
});

test('providerWarningText: only errors warn; unknown/ok are silent', () => {
  assert.equal(providerWarningText({ status: 'ok' }, 'GW'), null);
  assert.equal(providerWarningText({ status: 'unknown' }, 'GW'), null);
  assert.equal(providerWarningText(null, 'GW'), null);
  const w = providerWarningText({ status: 'error', reason: 'timeout' }, 'LiteLLM');
  assert.match(w, /LiteLLM/);
  assert.match(w, /timeout/);
  assert.match(w, /starting this agent may fail/);
});

test('providerWarningText: falls back gracefully with no name / no reason', () => {
  const w = providerWarningText({ status: 'error', reason: null }, '');
  assert.match(w, /the bound Model Provider/);
  assert.doesNotMatch(w, /\(\)/); // no empty parens when reason is absent
});
