'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBuildInfo, probeBrokerBuild, probeRunningBrokerBuilds } = require('./plugin-build-info');

const okResponse = (body) => ({ ok: true, json: async () => body });

test('normalizeBuildInfo: keeps a well-formed build', () => {
  assert.deepEqual(
    normalizeBuildInfo({ commit: 'abc1234', dirty: 'dirty', commitTime: '2026-09-30T21:08:25+02:00' }),
    { commit: 'abc1234', dirty: 'dirty', commitTime: '2026-09-30T21:08:25+02:00' },
  );
});

test('normalizeBuildInfo: no object → null; junk commit → unknown (never an empty value)', () => {
  assert.equal(normalizeBuildInfo(null), null);
  assert.equal(normalizeBuildInfo('abc1234'), null);
  assert.equal(normalizeBuildInfo([]), null);
  assert.deepEqual(normalizeBuildInfo({}), { commit: 'unknown', dirty: '', commitTime: '' });
  assert.deepEqual(normalizeBuildInfo({ commit: '<script>', dirty: 'dirty' }), { commit: 'unknown', dirty: '', commitTime: '' });
  assert.equal(normalizeBuildInfo({ commit: 'abc1234', commitTime: 'x'.repeat(65) }).commitTime, '');
  assert.equal(normalizeBuildInfo({ commit: 'abc1234', dirty: true }).dirty, '');
});

test('probeBrokerBuild: reads build from the sidecar /healthz', async () => {
  let url = null;
  const build = await probeBrokerBuild('http://aee-plugin-jira:4009', {
    fetchImpl: async (u) => { url = u; return okResponse({ ok: true, build: { commit: 'abc1234', dirty: '', commitTime: '2026-09-30T21:08:25+02:00' } }); },
  });
  assert.equal(url, 'http://aee-plugin-jira:4009/healthz');
  assert.deepEqual(build, { commit: 'abc1234', dirty: '', commitTime: '2026-09-30T21:08:25+02:00' });
});

// AC6 / edge cases: a pre-#2646 broker (no `build`), a third-party image with no
// /healthz, an unreachable sidecar — all null, never a throw.
test('probeBrokerBuild: missing build, HTTP error or network failure → null', async () => {
  assert.equal(await probeBrokerBuild('http://x', { fetchImpl: async () => okResponse({ ok: true }) }), null);
  assert.equal(await probeBrokerBuild('http://x', { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), null);
  assert.equal(await probeBrokerBuild('http://x', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), null);
  assert.equal(await probeBrokerBuild('http://x', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('not json'); } }) }), null);
});

test('probeRunningBrokerBuilds: probes only running broker-bearing plugins', async () => {
  const entries = [
    { id: 'jira', ok: true, manifest: { id: 'jira', sidecar: { internalPort: 4009 } } },
    { id: 'gke', ok: true, manifest: { id: 'gke', sidecar: { internalPort: 4007 } } },         // not running
    { id: 'spec-kit', ok: true, manifest: { id: 'spec-kit' } },                                  // command-only
    { id: 'broken', ok: false, manifest: null, errors: ['invalid JSON'] },
  ];
  const probed = [];
  const out = await probeRunningBrokerBuilds(
    entries,
    new Set(['jira', 'spec-kit', 'broken']),
    (m) => `http://aee-plugin-${m.id}:${m.sidecar.internalPort}`,
    { fetchImpl: async (u) => { probed.push(u); return okResponse({ ok: true, build: { commit: 'abc1234' } }); } },
  );
  assert.deepEqual(probed, ['http://aee-plugin-jira:4009/healthz']);
  assert.deepEqual(out, { jira: { commit: 'abc1234', dirty: '', commitTime: '' } });
});
