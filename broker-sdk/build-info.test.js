'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInfoFromEnv } = require('./build-info');

test('buildInfoFromEnv: reads the baked-in commit, dirty flag and commit time', () => {
  assert.deepEqual(
    buildInfoFromEnv({ AEE_BUILD_COMMIT: 'abc1234', AEE_BUILD_DIRTY: '', AEE_BUILD_COMMIT_TIME: '2026-09-30T21:08:25+02:00' }),
    { commit: 'abc1234', dirty: '', commitTime: '2026-09-30T21:08:25+02:00' },
  );
  assert.equal(buildInfoFromEnv({ AEE_BUILD_COMMIT: 'abc1234', AEE_BUILD_DIRTY: 'dirty' }).dirty, 'dirty');
});

// AC6: an image built before #2646 (or without git metadata) says "unknown",
// never an empty commit.
test('buildInfoFromEnv: missing or blank variables report unknown', () => {
  assert.deepEqual(buildInfoFromEnv({}), { commit: 'unknown', dirty: '', commitTime: '' });
  assert.deepEqual(buildInfoFromEnv({ AEE_BUILD_COMMIT: '  ', AEE_BUILD_DIRTY: 'dirty' }), { commit: 'unknown', dirty: '', commitTime: '' });
});

test('buildInfoFromEnv: only the literal "dirty" marks a dirty build', () => {
  assert.equal(buildInfoFromEnv({ AEE_BUILD_COMMIT: 'abc1234', AEE_BUILD_DIRTY: 'yes' }).dirty, '');
  assert.equal(buildInfoFromEnv({ AEE_BUILD_COMMIT: 'abc1234', AEE_BUILD_DIRTY: ' dirty\n' }).dirty, 'dirty');
});

// AC1: every broker image is built with the build identity baked in — a new
// broker Dockerfile without the ARG/ENV block, or a Makefile build line that
// forgets the build args, would silently ship "unknown".
const fs = require('node:fs');
const path = require('node:path');
const REPO = path.join(__dirname, '..');

test('every plugin broker Dockerfile bakes the build identity into ENV and labels', () => {
  const dirs = fs.readdirSync(path.join(REPO, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO, 'plugins', e.name, 'broker', 'Dockerfile')));
  assert.ok(dirs.length > 0);
  for (const d of dirs) {
    const src = fs.readFileSync(path.join(REPO, 'plugins', d.name, 'broker', 'Dockerfile'), 'utf8');
    for (const v of ['AEE_BUILD_COMMIT', 'AEE_BUILD_DIRTY', 'AEE_BUILD_COMMIT_TIME']) {
      assert.match(src, new RegExp(`^ARG ${v}=`, 'm'), `${d.name}: ARG ${v}`);
      assert.match(src, new RegExp(`${v}="\\$\\{${v}\\}"`), `${d.name}: ENV ${v}`);
    }
    assert.match(src, /org\.opencontainers\.image\.revision="\$\{AEE_BUILD_COMMIT\}"/, `${d.name}: revision label`);
  }
});

test('make plugin-images passes the build identity to every broker build', () => {
  const mk = fs.readFileSync(path.join(REPO, 'Makefile'), 'utf8');
  const builds = mk.split('\n').filter((l) => /podman build .*aee-plugin-/.test(l));
  assert.ok(builds.length > 0);
  for (const l of builds) assert.match(l, /podman build \$\(PLUGIN_BUILD_ARGS\) /, l.trim());
  assert.match(mk, /--build-arg AEE_BUILD_COMMIT=\$\(GIT_COMMIT\)/);
  assert.match(mk, /--build-arg AEE_BUILD_DIRTY=\$\(GIT_DIRTY\)/);
  assert.match(mk, /--build-arg AEE_BUILD_COMMIT_TIME=\$\(GIT_COMMIT_TIME\)/);
  // AC3: seed-plugins stamps each pool plugin with build-info.json.
  assert.match(mk, /> "\$\$d\/build-info\.json"/);
});
