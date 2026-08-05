import test from 'node:test';
import assert from 'node:assert/strict';

import { describeSubmitState } from './model-provider-submit-state.js';

// A fully-satisfied api-key form: name, ownership resolved, base URL present.
const readyApiKey = {
  name: 'My proxy',
  ownershipReady: true,
  isOauth: false,
  requireCompliance: false,
  complianceOk: false,
  oauthTokenReady: false,
  baseUrl: 'https://api.example.com',
};

// A fully-satisfied OAuth create form: name, ownership, token, confirmation.
const readyOauth = {
  name: 'My subscription',
  ownershipReady: true,
  isOauth: true,
  requireCompliance: true,
  complianceOk: true,
  oauthTokenReady: true,
  baseUrl: '',
};

const fieldsOf = result => result.reasons.map(r => r.field);

/* ── happy paths ─────────────────────────────────────────────────────── */

test('api-key form with name + ownership + base URL can submit', () => {
  const s = describeSubmitState(readyApiKey);
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

test('OAuth create with token + ticked confirmation can submit', () => {
  const s = describeSubmitState(readyOauth);
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

/* ── AC1: the specific unmet requirement is reported ─────────────────── */

test('OAuth: unticked confirmation is the only blocker (AC1/AC5)', () => {
  const s = describeSubmitState({ ...readyOauth, complianceOk: false });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['compliance']);
});

test('OAuth: missing token is reported (login not completed)', () => {
  const s = describeSubmitState({ ...readyOauth, oauthTokenReady: false });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['oauth-token']);
});

test('OAuth: name empty + login not completed reports both, not only the checkbox', () => {
  const s = describeSubmitState({
    ...readyOauth,
    name: '   ',
    oauthTokenReady: false,
  });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['name', 'oauth-token']);
});

test('ownership not yet chosen is surfaced as a blocker', () => {
  const s = describeSubmitState({ ...readyOauth, ownershipReady: false });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['ownership']);
});

/* ── AC5: compliance cannot be bypassed while required ───────────────── */

test('OAuth with everything but the confirmation cannot submit', () => {
  const s = describeSubmitState({
    name: 'x', ownershipReady: true, isOauth: true,
    requireCompliance: true, complianceOk: false, oauthTokenReady: true, baseUrl: '',
  });
  assert.equal(s.canSubmit, false);
  assert.ok(fieldsOf(s).includes('compliance'));
});

/* ── edit edge case: compliance already recorded (requireCompliance false) ── */

test('editing an OAuth provider with compliance recorded does not block on the checkbox', () => {
  const s = describeSubmitState({
    name: 'x', ownershipReady: true, isOauth: true,
    requireCompliance: false, complianceOk: false, oauthTokenReady: true, baseUrl: '',
  });
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

/* ── AC6: api-key path unaffected by OAuth requirements ──────────────── */

test('api-key path ignores compliance + token, only needs name + base URL', () => {
  const missing = describeSubmitState({ ...readyApiKey, baseUrl: '  ' });
  assert.equal(missing.canSubmit, false);
  assert.deepEqual(fieldsOf(missing), ['base-url']);

  const named = describeSubmitState({ ...readyApiKey, name: '' });
  assert.deepEqual(fieldsOf(named), ['name']);
});

/* ── canSubmit stays byte-equivalent to the original inline boolean ──── */

test('canSubmit matches the legacy inline gate across a truth table', () => {
  const legacy = f =>
    Boolean(String(f.name ?? '').trim()) && f.ownershipReady && (f.isOauth
      ? ((!f.requireCompliance || f.complianceOk) && f.oauthTokenReady)
      : Boolean(String(f.baseUrl ?? '').trim()));

  const bools = [true, false];
  for (const nameFilled of bools)
    for (const ownershipReady of bools)
      for (const isOauth of bools)
        for (const requireCompliance of bools)
          for (const complianceOk of bools)
            for (const oauthTokenReady of bools)
              for (const baseUrlFilled of bools) {
                const f = {
                  name: nameFilled ? 'n' : '',
                  ownershipReady, isOauth, requireCompliance, complianceOk,
                  oauthTokenReady, baseUrl: baseUrlFilled ? 'u' : '',
                };
                assert.equal(describeSubmitState(f).canSubmit, legacy(f),
                  `mismatch for ${JSON.stringify(f)}`);
              }
});
