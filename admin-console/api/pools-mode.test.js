'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePoolsEnabled, describePoolsMode, poolsModeLogLine } = require('./pools-mode');

test('AEE_POOLS_ENABLED defaults to off — stability by default', () => {
  assert.equal(resolvePoolsEnabled({}), false);
  assert.equal(resolvePoolsEnabled({ AEE_POOLS_ENABLED: undefined }), false);
  assert.equal(resolvePoolsEnabled(), false);
});

test('AEE_POOLS_ENABLED accepts the usual on-tokens, case- and space-insensitively', () => {
  for (const raw of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
    assert.equal(resolvePoolsEnabled({ AEE_POOLS_ENABLED: raw }), true, `expected on for '${raw}'`);
  }
});

test('AEE_POOLS_ENABLED accepts the usual off-tokens', () => {
  for (const raw of ['', 'false', 'FALSE', '0', 'no', 'off', '  ']) {
    assert.equal(resolvePoolsEnabled({ AEE_POOLS_ENABLED: raw }), false, `expected off for '${raw}'`);
  }
});

test('an unrecognised value is off and flagged as unrecognised', () => {
  const mode = describePoolsMode({ AEE_POOLS_ENABLED: 'enabled' });
  assert.equal(mode.enabled, false);
  assert.equal(mode.recognised, false);
  assert.equal(mode.raw, 'enabled');
  assert.match(poolsModeLogLine({ AEE_POOLS_ENABLED: 'enabled' }), /not a recognised boolean/);
});

test('the boot log line names the mode in plain language', () => {
  assert.match(poolsModeLogLine({}), /disabled \(default\)/);
  assert.match(poolsModeLogLine({ AEE_POOLS_ENABLED: 'true' }), /^Agent pools: enabled$/);
});
