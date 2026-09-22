'use strict';

// Run: node --test orchestrator/provider-lend-policy.test.js
//
// The personal-provider transition policy (unified resource access §14 / E10,
// #2360). Its twin lives in admin-console/api/provider-lend-policy.js; the guard
// below is the two-sided byte-identity check the resource-tier.js precedent set.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  isPersonalProvider,
  isPersonalOauthProvider,
  isPersonalApiKeyProvider,
  personalDefaultTransitionRisk,
} = require('./provider-lend-policy');

const TWIN = path.join(__dirname, '..', 'admin-console', 'api', 'provider-lend-policy.js');

test('two-sided guard: orchestrator copy is byte-identical to admin-console copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'provider-lend-policy.js'));
  const there = fs.readFileSync(TWIN);
  assert.ok(here.equals(there), 'provider-lend-policy.js copies differ — change both in one commit');
});

// ── the predicates ──────────────────────────────────────────────────────────

test('isPersonalProvider is true only for scope personal', () => {
  assert.equal(isPersonalProvider({ scope: 'personal' }), true);
  assert.equal(isPersonalProvider({ scope: 'team' }), false);
  assert.equal(isPersonalProvider({ scope: 'system' }), false);
  assert.equal(isPersonalProvider(null), false);
  assert.equal(isPersonalProvider(undefined), false);
});

test('personal oauth vs api-key split on authType', () => {
  assert.equal(isPersonalOauthProvider({ scope: 'personal', authType: 'oauth-token' }), true);
  assert.equal(isPersonalApiKeyProvider({ scope: 'personal', authType: 'oauth-token' }), false);

  // api-key is the default identity — an absent authType reads as api-key.
  assert.equal(isPersonalApiKeyProvider({ scope: 'personal', authType: 'api-key' }), true);
  assert.equal(isPersonalApiKeyProvider({ scope: 'personal' }), true);
  assert.equal(isPersonalOauthProvider({ scope: 'personal' }), false);

  // A team/global oauth (the single-user global hatch) is neither personal split.
  assert.equal(isPersonalOauthProvider({ scope: 'system', authType: 'oauth-token' }), false);
  assert.equal(isPersonalApiKeyProvider({ scope: 'team', authType: 'api-key' }), false);
});

// ── the classifier ───────────────────────────────────────────────────────────

test('a team-of-one (1 human) on a personal provider is never a problem', () => {
  assert.equal(personalDefaultTransitionRisk({
    provider: { scope: 'personal', authType: 'oauth-token' }, humanMemberCount: 1,
  }), null);
  assert.equal(personalDefaultTransitionRisk({
    provider: { scope: 'personal', authType: 'api-key' }, humanMemberCount: 1,
  }), null);
  // 0 humans (a freshly-created squad, or an unresolved count) is also fine.
  assert.equal(personalDefaultTransitionRisk({
    provider: { scope: 'personal', authType: 'oauth-token' }, humanMemberCount: 0,
  }), null);
});

test('a multi-human squad on a personal SUBSCRIPTION blocks (E9)', () => {
  assert.deepEqual(personalDefaultTransitionRisk({
    provider: { scope: 'personal', authType: 'oauth-token' }, humanMemberCount: 2,
  }), { level: 'block', identity: 'oauth' });
  assert.deepEqual(personalDefaultTransitionRisk({
    provider: { scope: 'personal', authType: 'oauth-token' }, humanMemberCount: 5,
  }), { level: 'block', identity: 'oauth' });
});

test('a multi-human squad on a personal API-KEY warns but never blocks (fragile lend)', () => {
  assert.deepEqual(personalDefaultTransitionRisk({
    provider: { scope: 'personal', authType: 'api-key' }, humanMemberCount: 2,
  }), { level: 'warn', identity: 'api-key' });
  assert.deepEqual(personalDefaultTransitionRisk({
    provider: { scope: 'personal' }, humanMemberCount: 3,
  }), { level: 'warn', identity: 'api-key' });
});

test('a team/global provider is never swept, at any headcount', () => {
  for (const scope of ['team', 'system']) {
    assert.equal(personalDefaultTransitionRisk({
      provider: { scope, authType: 'api-key' }, humanMemberCount: 9,
    }), null, `scope ${scope} must never be a transition risk`);
  }
});

test('degrades on malformed input', () => {
  assert.equal(personalDefaultTransitionRisk({}), null);
  assert.equal(personalDefaultTransitionRisk({ provider: null, humanMemberCount: 3 }), null);
  assert.equal(personalDefaultTransitionRisk(), null);
});
