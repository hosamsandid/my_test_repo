'use strict';

// Run: node --test orchestrator/resource-access-mode.test.js
//
// The orchestrator side of the two-sided mirror guard (#2356). The behavioural
// cases live in admin-console/api/resource-access-mode.test.js; this file exists
// so the guard fires whichever suite a change is run against — the same
// arrangement as resource-tier.test.js / agent-team.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveResourceAccessV2 } = require('./resource-access-mode');

test('two-sided guard: orchestrator copy is byte-identical to admin-console copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'resource-access-mode.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', 'admin-console', 'api', 'resource-access-mode.js'));
  assert.ok(here.equals(there), 'resource-access-mode.js copies differ — change both in one commit');
});

test('the orchestrator copy is the same module, not just the same bytes', () => {
  // Cheap smoke test so a require-path or export-name regression in THIS image
  // is caught here, not only when the redesign's runtime code starts gating on it.
  assert.equal(resolveResourceAccessV2({ AEE_RESOURCE_ACCESS_V2: 'off' }), false);
  assert.equal(resolveResourceAccessV2({}), true); // default ON (#2360)
});
