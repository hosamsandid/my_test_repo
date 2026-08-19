'use strict';
// Run: node --test plugins/podman-sandbox/broker/compose-harden.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enforceNetworkIsolation,
  injectResourceDefaults,
  DEFAULT_MEM_LIMIT,
  DEFAULT_CPUS,
  DEFAULT_PIDS_LIMIT,
} = require('./compose-harden');

// --- enforceNetworkIsolation ---

test('injects an internal default network when the caller declared none', () => {
  const doc = { services: { app: { image: 'x' } } };
  enforceNetworkIsolation(doc);
  assert.deepEqual(doc.networks, { default: { internal: true } });
});

test('forces internal: true on a caller-declared named network', () => {
  const doc = { services: { app: { image: 'x' } }, networks: { mynet: { driver: 'bridge' } } };
  enforceNetworkIsolation(doc);
  assert.deepEqual(doc.networks, { mynet: { driver: 'bridge', internal: true } });
});

test('overrides a caller attempt to set internal: false', () => {
  const doc = { networks: { default: { internal: false } } };
  enforceNetworkIsolation(doc);
  assert.equal(doc.networks.default.internal, true);
});

test('forces internal: true on every declared network, not just the first', () => {
  const doc = { networks: { a: {}, b: { driver: 'bridge' } } };
  enforceNetworkIsolation(doc);
  assert.equal(doc.networks.a.internal, true);
  assert.equal(doc.networks.b.internal, true);
});

// --- injectResourceDefaults ---

test('injects default mem_limit, cpus, and pids (v3 key) when caller set none', () => {
  const doc = { services: { app: { image: 'x' } } };
  injectResourceDefaults(doc);
  assert.equal(doc.services.app.mem_limit, DEFAULT_MEM_LIMIT);
  assert.equal(doc.services.app.cpus, DEFAULT_CPUS);
  // B4 fix: pids default must land in the v3 key (podman-compose 4.3.1 ignores v2 pids_limit)
  assert.equal(doc.services.app.pids_limit, undefined);
  assert.equal(doc.services.app.deploy.resources.limits.pids, DEFAULT_PIDS_LIMIT);
});

test('leaves a caller-supplied mem_limit/cpus/pids_limit (v2) untouched and does not inject v3', () => {
  const doc = { services: { app: { image: 'x', mem_limit: '2g', cpus: '4', pids_limit: 1000 } } };
  injectResourceDefaults(doc);
  assert.equal(doc.services.app.mem_limit, '2g');
  assert.equal(doc.services.app.cpus, '4');
  assert.equal(doc.services.app.pids_limit, 1000);
  // hasResourceLimit sees the v2 key, so no v3 injection happens
  assert.equal(doc.services.app.deploy, undefined);
});

test('leaves caller v3 deploy.resources.limits alone and does not add the v2 counterpart', () => {
  const doc = {
    services: {
      app: {
        image: 'x',
        deploy: { resources: { limits: { memory: '1g', cpus: '2', pids: 500 } } },
      },
    },
  };
  injectResourceDefaults(doc);
  assert.equal(doc.services.app.mem_limit, undefined);
  assert.equal(doc.services.app.cpus, undefined);
  assert.equal(doc.services.app.pids_limit, undefined);
  assert.deepEqual(doc.services.app.deploy.resources.limits, { memory: '1g', cpus: '2', pids: 500 });
});

test('applies defaults independently per resource (only fills the unset ones)', () => {
  const doc = { services: { app: { image: 'x', mem_limit: '2g' } } };
  injectResourceDefaults(doc);
  assert.equal(doc.services.app.mem_limit, '2g');
  assert.equal(doc.services.app.cpus, DEFAULT_CPUS);
  assert.equal(doc.services.app.pids_limit, undefined);
  assert.equal(doc.services.app.deploy.resources.limits.pids, DEFAULT_PIDS_LIMIT);
});

test('applies defaults to every service in a multi-service stack', () => {
  const doc = { services: { a: { image: 'x' }, b: { image: 'y', mem_limit: '1g' } } };
  injectResourceDefaults(doc);
  assert.equal(doc.services.a.mem_limit, DEFAULT_MEM_LIMIT);
  assert.equal(doc.services.b.mem_limit, '1g');
  assert.equal(doc.services.b.cpus, DEFAULT_CPUS);
});

test('no services / empty doc is a no-op', () => {
  const doc = {};
  injectResourceDefaults(doc);
  assert.deepEqual(doc.services, {});
});

// --- B4: pids default lands in v3 key ---

test('B4: caller v3 deploy.resources.limits.pids is respected and no v2 key is added', () => {
  const doc = {
    services: {
      app: {
        image: 'x',
        deploy: { resources: { limits: { memory: '1g', cpus: '2', pids: 500 } } },
      },
    },
  };
  injectResourceDefaults(doc);
  assert.equal(doc.services.app.pids_limit, undefined);
  assert.equal(doc.services.app.deploy.resources.limits.pids, 500);
});

test('B4: injected pids default does not overwrite existing deploy.resources.limits content', () => {
  const doc = {
    services: {
      app: { image: 'x', deploy: { resources: { limits: { memory: '2g' } } } },
    },
  };
  injectResourceDefaults(doc);
  assert.equal(doc.services.app.deploy.resources.limits.memory, '2g');
  assert.equal(doc.services.app.deploy.resources.limits.pids, DEFAULT_PIDS_LIMIT);
});
