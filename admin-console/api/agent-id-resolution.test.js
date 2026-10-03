'use strict';

// Run: node --test admin-console/api/agent-id-resolution.test.js
//
// The console side of a two-sided mirror guard (#2684). The behavioural cases
// live in orchestrator/agent-id-resolution.test.js; the console needs the same
// suggestion rule so the import route's 409 can name a free id, and it must be
// the SAME rule the create route already answers with.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { suggestFreeAgentId } = require('./agent-id-resolution');

test('two-sided guard: admin-console copy is byte-identical to orchestrator copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'agent-id-resolution.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'agent-id-resolution.js'));
  assert.ok(here.equals(there), 'agent-id-resolution.js copies differ — change both in one commit');
});

test('the console copy is the same function, not just the same bytes', () => {
  const taken = new Set(['a', 'a-2', 'b-2']);
  assert.equal(suggestFreeAgentId('a', (id) => taken.has(id)), 'a-3');
  assert.equal(suggestFreeAgentId('b-2', (id) => taken.has(id)), 'b-3');
});
