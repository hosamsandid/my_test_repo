'use strict';

// Run: node --test admin-console/api/resource-access-mode.test.js
//
// Behavioural cases for the AEE_RESOURCE_ACCESS_V2 mode reader (#2356), plus the
// console side of the two-sided mirror guard: resource-access-mode.js is kept
// byte-identical with the orchestrator copy because the unified-access redesign
// gates code in both container images (see the module header).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveResourceAccessV2,
  describeResourceAccessMode,
  resourceAccessModeLogLine,
} = require('./resource-access-mode');

test('AEE_RESOURCE_ACCESS_V2 defaults to off — today\'s behaviour by default', () => {
  assert.equal(resolveResourceAccessV2({}), false);
  assert.equal(resolveResourceAccessV2({ AEE_RESOURCE_ACCESS_V2: undefined }), false);
  assert.equal(resolveResourceAccessV2(), false);
});

test('AEE_RESOURCE_ACCESS_V2 accepts the usual on-tokens, case- and space-insensitively', () => {
  for (const raw of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
    assert.equal(resolveResourceAccessV2({ AEE_RESOURCE_ACCESS_V2: raw }), true, `expected on for '${raw}'`);
  }
});

test('AEE_RESOURCE_ACCESS_V2 accepts the usual off-tokens', () => {
  for (const raw of ['', 'false', 'FALSE', '0', 'no', 'off', '  ']) {
    assert.equal(resolveResourceAccessV2({ AEE_RESOURCE_ACCESS_V2: raw }), false, `expected off for '${raw}'`);
  }
});

test('an unrecognised value is off and flagged as unrecognised', () => {
  const mode = describeResourceAccessMode({ AEE_RESOURCE_ACCESS_V2: 'enabled' });
  assert.equal(mode.enabled, false);
  assert.equal(mode.recognised, false);
  assert.equal(mode.raw, 'enabled');
  assert.match(resourceAccessModeLogLine({ AEE_RESOURCE_ACCESS_V2: 'enabled' }), /not a recognised boolean/);
});

test('the boot log line names the mode in plain language', () => {
  assert.match(resourceAccessModeLogLine({}), /disabled \(default\)/);
  assert.match(resourceAccessModeLogLine({ AEE_RESOURCE_ACCESS_V2: 'true' }), /^Unified resource access: enabled/);
});

test('two-sided guard: admin-console copy is byte-identical to orchestrator copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'resource-access-mode.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'resource-access-mode.js'));
  assert.ok(here.equals(there), 'resource-access-mode.js copies differ — change both in one commit');
});
