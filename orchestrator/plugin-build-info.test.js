'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBuildInfo, probeBrokerBuild, probeRunningBrokerBuilds, imageBuildFromInspect, inspectSidecarImageBuilds,
} = require('./plugin-build-info');

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

// ─── the image a recreated sidecar would run (AC8) ──────────────────────────

const LABELS = {
  'org.opencontainers.image.revision': 'bbbbbbb',
  'aee.build.dirty': 'dirty',
  'aee.build.commit-time': '2026-09-30T21:08:25+02:00',
};

test('imageBuildFromInspect: reads the OCI build labels (top-level or Config)', () => {
  const want = { commit: 'bbbbbbb', dirty: 'dirty', commitTime: '2026-09-30T21:08:25+02:00' };
  assert.deepEqual(imageBuildFromInspect({ Labels: LABELS }), want);
  assert.deepEqual(imageBuildFromInspect({ Labels: null, Config: { Labels: LABELS } }), want);
});

test('imageBuildFromInspect: unlabelled image → unknown; no body → null', () => {
  // busybox / a pre-#2646 image: inspected fine, just no build.
  assert.deepEqual(imageBuildFromInspect({ Labels: { maintainer: 'x' } }), { commit: 'unknown', dirty: '', commitTime: '' });
  assert.deepEqual(imageBuildFromInspect({}), { commit: 'unknown', dirty: '', commitTime: '' });
  assert.deepEqual(imageBuildFromInspect({ Labels: { 'org.opencontainers.image.revision': 'unknown' } }), { commit: 'unknown', dirty: '', commitTime: '' });
  assert.equal(imageBuildFromInspect(null), null);
  assert.equal(imageBuildFromInspect('no such image'), null);
  assert.equal(imageBuildFromInspect([]), null);
});

test('inspectSidecarImageBuilds: every installed broker image, running or not', async () => {
  const entries = [
    { id: 'jira', ok: true, manifest: { id: 'jira', sidecar: { image: 'localhost/aee-plugin-jira:latest', internalPort: 4009 } } },
    { id: 'gke', ok: true, manifest: { id: 'gke', sidecar: { image: 'localhost/aee-plugin-gke:latest', internalPort: 4007 } } },
    { id: 'gone', ok: true, manifest: { id: 'gone', sidecar: { image: 'localhost/aee-plugin-gone:latest', internalPort: 4010 } } },
    { id: 'boom', ok: true, manifest: { id: 'boom', sidecar: { image: 'localhost/aee-plugin-boom:latest', internalPort: 4011 } } },
    { id: 'spec-kit', ok: true, manifest: { id: 'spec-kit' } },
    { id: 'broken', ok: false, manifest: null, errors: ['invalid JSON'] },
  ];
  const asked = [];
  const out = await inspectSidecarImageBuilds(entries, async (image) => {
    asked.push(image);
    if (image.includes('gone')) return null;             // not in the local store / Kubernetes
    if (image.includes('boom')) throw new Error('socket'); // runtime down
    return { Labels: { ...LABELS, 'aee.build.dirty': '' } };
  });
  assert.deepEqual(asked, [
    'localhost/aee-plugin-jira:latest', 'localhost/aee-plugin-gke:latest',
    'localhost/aee-plugin-gone:latest', 'localhost/aee-plugin-boom:latest',
  ]);
  const build = { commit: 'bbbbbbb', dirty: '', commitTime: '2026-09-30T21:08:25+02:00' };
  assert.deepEqual(out, { jira: build, gke: build, gone: null, boom: null });
});
