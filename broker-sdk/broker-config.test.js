'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { brokerConfig, quotaExceeded, positiveInt } = require('./broker-config');

test('the standard AEE_PLUGIN_* contract is read in full', () => {
  const cfg = brokerConfig({
    env: {
      AEE_PLUGIN_ID: 'podman-sandbox',
      AEE_PLUGIN_PORT: '4004',
      AEE_PLUGIN_SIGNING_SECRET: 's3cret',
      AEE_PLUGIN_QUOTA_MAX_OBJECTS: '8',
      AEE_PLUGIN_QUOTA_TTL_SECONDS: '86400',
      AEE_PLUGIN_AUDIT_DIR: '/audit',
      AEE_PLUGIN_STATE_DIR: '/state',
    },
  });
  assert.deepEqual(cfg, {
    id: 'podman-sandbox',
    port: 4004,
    signingSecret: 's3cret',
    quota: { maxObjects: 8, ttlSeconds: 86400 },
    auditDir: '/audit',
    stateDir: '/state',
  });
});

test('an empty env yields safe defaults — no cap, no secret', () => {
  const cfg = brokerConfig({ env: {} });
  assert.equal(cfg.port, 4004);
  assert.equal(cfg.signingSecret, '');
  assert.deepEqual(cfg.quota, { maxObjects: null, ttlSeconds: null });
  assert.equal(cfg.auditDir, null);
  assert.equal(cfg.stateDir, null);
});

test('the state volume is read from AEE_PLUGIN_STATE_DIR', () => {
  const cfg = brokerConfig({ env: { AEE_PLUGIN_STATE_DIR: '/plugin-state' } });
  assert.equal(cfg.stateDir, '/plugin-state');
});

test('legacy variable names are honoured only as a fallback', () => {
  const env = {
    AEE_PLUGIN_SIGNING_SECRET: 'new',
    PODMAN_MCP_SIGNING_SECRET: 'old',
    PODMAN_MCP_PORT: '9999',
  };
  const fallbacks = {
    signingSecret: ['PODMAN_MCP_SIGNING_SECRET'],
    port: ['PODMAN_MCP_PORT'],
  };
  const cfg = brokerConfig({ env, fallbacks });
  assert.equal(cfg.signingSecret, 'new', 'the standard name wins when both are set');
  assert.equal(cfg.port, 9999, 'the legacy name is used when the standard one is absent');
});

test('a blank standard value falls through to the legacy name', () => {
  const cfg = brokerConfig({
    env: { AEE_PLUGIN_SIGNING_SECRET: '   ', PODMAN_MCP_SIGNING_SECRET: 'old' },
    fallbacks: { signingSecret: ['PODMAN_MCP_SIGNING_SECRET'] },
  });
  assert.equal(cfg.signingSecret, 'old');
});

test('a garbled quota reads as absent, never as zero', () => {
  // The failure mode this guards: parsing "" or "abc" as 0 would make the
  // broker refuse every single call.
  for (const raw of ['', 'abc', '0', '-3', '2.5']) {
    const cfg = brokerConfig({ env: { AEE_PLUGIN_QUOTA_MAX_OBJECTS: raw } });
    assert.equal(cfg.quota.maxObjects, null, `"${raw}" must not become a cap`);
    assert.equal(quotaExceeded(cfg.quota, 1000), null, `"${raw}" must not refuse calls`);
  }
});

test('positiveInt accepts only positive integers', () => {
  assert.equal(positiveInt('7'), 7);
  assert.equal(positiveInt(7), 7);
  assert.equal(positiveInt('0'), null);
  assert.equal(positiveInt(null), null);
  assert.equal(positiveInt(undefined), null);
});

test('quotaExceeded enforces the per-scope cap at the boundary', () => {
  const quota = { maxObjects: 8 };
  assert.equal(quotaExceeded(quota, 0), null);
  assert.equal(quotaExceeded(quota, 7), null, 'the 8th object still fits');
  assert.match(quotaExceeded(quota, 8), /quota exceeded: 8 of 8/);
  assert.match(quotaExceeded(quota, 12), /quota exceeded: 12 of 8/);
});

test('quotaExceeded accounts for a multi-object call', () => {
  const quota = { maxObjects: 8 };
  assert.equal(quotaExceeded(quota, 5, { adding: 3 }), null);
  assert.match(quotaExceeded(quota, 5, { adding: 4 }), /quota exceeded/);
});

test('no declared quota means uncapped', () => {
  assert.equal(quotaExceeded(null, 9999), null);
  assert.equal(quotaExceeded({}, 9999), null);
  assert.equal(quotaExceeded({ maxObjects: null }, 9999), null);
});
