'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { NO_PROVIDER_MESSAGE, validateTeamProviderAvailability } = require('./team-provider-check');

test('validateTeamProviderAvailability: blocks when the registry is empty', () => {
  const result = validateTeamProviderAvailability(0);
  assert.equal(result.error, NO_PROVIDER_MESSAGE);
  assert.equal(result.code, 'no_llm_endpoint');
});

test('validateTeamProviderAvailability: proceeds once at least one provider exists', () => {
  assert.equal(validateTeamProviderAvailability(1), null);
  assert.equal(validateTeamProviderAvailability(5), null);
});
