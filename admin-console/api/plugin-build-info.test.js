'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeBuildInfo, readPluginBuildInfo } = require('./plugin-build-info');

function tmpPluginDir(id, content) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-build-info-'));
  fs.mkdirSync(path.join(base, id));
  if (content !== undefined) fs.writeFileSync(path.join(base, id, 'build-info.json'), content);
  return base;
}

// AC3: the seeded build-info.json is what the installed files report.
test('readPluginBuildInfo: reads the seeded build-info.json', () => {
  const base = tmpPluginDir('jira', '{"commit":"abc1234","dirty":"","commitTime":"2026-09-30T21:08:25+02:00"}\n');
  assert.deepEqual(readPluginBuildInfo(base, 'jira'), { commit: 'abc1234', dirty: '', commitTime: '2026-09-30T21:08:25+02:00' });
});

// AC7: the -dirty convention travels with the file.
test('readPluginBuildInfo: keeps the dirty flag', () => {
  const base = tmpPluginDir('jira', '{"commit":"abc1234","dirty":"dirty","commitTime":""}');
  assert.equal(readPluginBuildInfo(base, 'jira').dirty, 'dirty');
});

// AC6: a copy seeded before #2646 (no file) or a broken file is null, never a throw.
test('readPluginBuildInfo: missing or broken file → null', () => {
  assert.equal(readPluginBuildInfo(tmpPluginDir('jira'), 'jira'), null);
  assert.equal(readPluginBuildInfo(tmpPluginDir('jira', 'not json'), 'jira'), null);
});

// Tarball checkouts seed `"commit":"unknown"`; junk is coerced to unknown too.
test('normalizeBuildInfo: unknown / junk commit → unknown, dirty dropped', () => {
  assert.deepEqual(normalizeBuildInfo({ commit: 'unknown', dirty: '', commitTime: '' }), { commit: 'unknown', dirty: '', commitTime: '' });
  assert.deepEqual(normalizeBuildInfo({ commit: '"><img>', dirty: 'dirty' }), { commit: 'unknown', dirty: '', commitTime: '' });
  assert.equal(normalizeBuildInfo(null), null);
  assert.equal(normalizeBuildInfo([1]), null);
});

// #2893: the seeded release tag + distance (strings in the file) come out as
// `tag` + numeric `tagDistance`; a file seeded without a reachable tag (empty
// strings) or before #2893 (no keys) keeps the #2646 shape — hash only.
test('readPluginBuildInfo: reads the seeded release tag and distance', () => {
  const base = tmpPluginDir('jira', '{"commit":"5500e15","dirty":"","commitTime":"","tag":"v0.4.0","tagDistance":"12"}\n');
  assert.deepEqual(readPluginBuildInfo(base, 'jira'), { commit: '5500e15', dirty: '', commitTime: '', tag: 'v0.4.0', tagDistance: 12 });
  const none = tmpPluginDir('jira', '{"commit":"5500e15","dirty":"","commitTime":"","tag":"","tagDistance":""}\n');
  assert.deepEqual(readPluginBuildInfo(none, 'jira'), { commit: '5500e15', dirty: '', commitTime: '' });
});

test('normalizeBuildInfo: junk, non-release or orphaned tag info is dropped', () => {
  const plain = { commit: 'abc1234', dirty: '', commitTime: '' };
  for (const extra of [{ tag: 'v0.4.0' }, { tag: 'v0.4.0', tagDistance: -1 }, { tag: 'v0.4.0', tagDistance: 1.5 }, { tag: 'nightly', tagDistance: '2' }, { tag: '<img>', tagDistance: '2' }, { tag: 'v0.4.0', tagDistance: '2x' }]) {
    assert.deepEqual(normalizeBuildInfo({ ...plain, ...extra }), plain, JSON.stringify(extra));
  }
  assert.equal(normalizeBuildInfo({ commit: 'abc1234', tag: 'v0.4.0', tagDistance: 0 }).tagDistance, 0);
  assert.deepEqual(normalizeBuildInfo({ commit: 'unknown', tag: 'v0.4.0', tagDistance: '0' }), { commit: 'unknown', dirty: '', commitTime: '' });
});

// The twin in orchestrator/ must apply the same rule (disjoint build contexts).
test('normalizeBuildInfo matches the orchestrator twin', () => {
  const twin = path.join(__dirname, '..', '..', 'orchestrator', 'plugin-build-info.js');
  if (!fs.existsSync(twin)) return;
  const other = require(twin).normalizeBuildInfo;
  for (const raw of [null, {}, { commit: 'abc1234', dirty: 'dirty', commitTime: '2026-09-30T21:08:25+02:00' }, { commit: 'zz', dirty: 'dirty' }, { commit: 'abc1234', commitTime: 'x'.repeat(65) },
    { commit: 'abc1234', tag: 'v0.4.0', tagDistance: '12' }, { commit: 'abc1234', tag: 'v0.4.0', tagDistance: 0 }, { commit: 'abc1234', tag: 'v0.4.0' },
    { commit: 'abc1234', tag: 'nightly', tagDistance: '1' }, { commit: 'zz', tag: 'v0.4.0', tagDistance: '1' }]) {
    assert.deepEqual(normalizeBuildInfo(raw), other(raw));
  }
});
