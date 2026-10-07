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

// #2893: the nearest release tag and distance, when the build recorded one.
test('buildInfoFromEnv: reads the release tag and distance', () => {
  assert.deepEqual(
    buildInfoFromEnv({ AEE_BUILD_COMMIT: 'abc1234', AEE_BUILD_TAG: 'v0.4.0', AEE_BUILD_TAG_DISTANCE: '12' }),
    { commit: 'abc1234', dirty: '', commitTime: '', tag: 'v0.4.0', tagDistance: 12 },
  );
  assert.equal(buildInfoFromEnv({ AEE_BUILD_COMMIT: 'abc1234', AEE_BUILD_TAG: 'v0.4.0', AEE_BUILD_TAG_DISTANCE: '0' }).tagDistance, 0);
});

// #2893 AC3/AC7: no tag reachable at build time, an image built before #2893,
// a non-release tag or a tag without a commit → no tag keys, hash only.
test('buildInfoFromEnv: missing, partial or non-release tag info is dropped', () => {
  const plain = { commit: 'abc1234', dirty: '', commitTime: '' };
  for (const extra of [
    {},
    { AEE_BUILD_TAG: '', AEE_BUILD_TAG_DISTANCE: '' },
    { AEE_BUILD_TAG: 'v0.4.0' },
    { AEE_BUILD_TAG: 'v0.4.0', AEE_BUILD_TAG_DISTANCE: '-1' },
    { AEE_BUILD_TAG: 'v0.4.0', AEE_BUILD_TAG_DISTANCE: 'twelve' },
    { AEE_BUILD_TAG: 'nightly', AEE_BUILD_TAG_DISTANCE: '3' },
    { AEE_BUILD_TAG: 'v1.2.0-rc1', AEE_BUILD_TAG_DISTANCE: '3' },
    { AEE_BUILD_TAG: '<b>v1</b>', AEE_BUILD_TAG_DISTANCE: '3' },
  ]) {
    assert.deepEqual(buildInfoFromEnv({ AEE_BUILD_COMMIT: 'abc1234', ...extra }), plain, JSON.stringify(extra));
  }
  assert.deepEqual(buildInfoFromEnv({ AEE_BUILD_TAG: 'v0.4.0', AEE_BUILD_TAG_DISTANCE: '0' }), { commit: 'unknown', dirty: '', commitTime: '' });
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
    for (const v of ['AEE_BUILD_COMMIT', 'AEE_BUILD_DIRTY', 'AEE_BUILD_COMMIT_TIME', 'AEE_BUILD_TAG', 'AEE_BUILD_TAG_DISTANCE']) {
      assert.match(src, new RegExp(`^ARG ${v}=`, 'm'), `${d.name}: ARG ${v}`);
      assert.match(src, new RegExp(`${v}="\\$\\{${v}\\}"`), `${d.name}: ENV ${v}`);
    }
    assert.match(src, /org\.opencontainers\.image\.revision="\$\{AEE_BUILD_COMMIT\}"/, `${d.name}: revision label`);
    // #2893 AC8: the tag is readable from the image labels too.
    assert.match(src, /aee\.build\.tag="\$\{AEE_BUILD_TAG\}"/, `${d.name}: tag label`);
    assert.match(src, /aee\.build\.tag-distance="\$\{AEE_BUILD_TAG_DISTANCE\}"/, `${d.name}: tag-distance label`);
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
  assert.match(mk, /--build-arg AEE_BUILD_TAG=\$\(GIT_TAG\)/);
  assert.match(mk, /--build-arg AEE_BUILD_TAG_DISTANCE=\$\(GIT_TAG_DISTANCE\)/);
  assert.match(mk, /^GIT_TAG_INFO := \$\(shell sh scripts\/git-release-tag\.sh/m);
  // AC3: seed-plugins stamps each pool plugin with build-info.json.
  assert.match(mk, /> "\$\$d\/build-info\.json"/);
  // #2893: …including the release tag and distance.
  assert.match(mk, /"tag":"%s","tagDistance":"%s"/);
  assert.match(mk, /-e AEE_BUILD_TAG="\$\(GIT_TAG\)" -e AEE_BUILD_TAG_DISTANCE="\$\(GIT_TAG_DISTANCE\)"/);
  // #2893 AC8: the plugin-images summary prints the tag label.
  assert.match(mk, /index \.Labels "aee\.build\.tag"/);
});

// ─── scripts/git-release-tag.sh (#2893) ──────────────────────────────────────
// Run against a throw-away repository so the rules are pinned independently of
// this checkout's own tags (and of a shallow CI clone).
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const TAG_SCRIPT = path.join(REPO, 'scripts', 'git-release-tag.sh');

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-release-tag-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  const commit = () => git('commit', '-q', '--allow-empty', '-m', 'c');
  const tagInfo = (rev) => execFileSync('sh', [TAG_SCRIPT, ...(rev ? [rev] : [])], { cwd: dir, encoding: 'utf8' }).trim();
  return { git, commit, tagInfo };
}

test('git-release-tag.sh: no release tag reachable → prints nothing, exits 0', () => {
  const r = gitRepo();
  r.commit();
  assert.equal(r.tagInfo(), '');
  // Non-release tags never become the version.
  r.git('tag', 'nightly'); r.git('tag', 'v1-test'); r.git('tag', 'jira/v1.2.0'); r.git('tag', 'v1.2.0-rc1');
  assert.equal(r.tagInfo(), '');
});

test('git-release-tag.sh: on the tag → distance 0; after it → commit count', () => {
  const r = gitRepo();
  r.commit(); r.git('tag', 'v0.3.0');
  r.commit(); r.git('tag', '-a', 'v0.4.0', '-m', 'release');
  assert.equal(r.tagInfo(), 'v0.4.0 0');
  r.commit(); r.commit(); r.commit();
  assert.equal(r.tagInfo(), 'v0.4.0 3');
  assert.equal(r.tagInfo('HEAD~3'), 'v0.4.0 0');
  assert.equal(r.tagInfo('HEAD~4'), 'v0.3.0 0');
});

test('git-release-tag.sh: several release tags on one commit → the highest version', () => {
  const r = gitRepo();
  r.commit();
  r.git('tag', 'v0.10.0'); r.git('tag', 'v0.9.0'); r.git('tag', 'v0.10.0-rc1');
  r.commit();
  assert.equal(r.tagInfo(), 'v0.10.0 1');
});

test('git-release-tag.sh: outside a git repository → prints nothing, exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-release-tag-nogit-'));
  assert.equal(execFileSync('sh', [TAG_SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } }).trim(), '');
});
