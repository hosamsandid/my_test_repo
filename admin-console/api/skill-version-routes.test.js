'use strict';

// #2839 — the version-snapshot routes (open / compare / restore an old version)
// and the copy sites that must keep snapshots to ONE copy. api.js boots
// listeners on require and cannot be exercised directly (#651), so its source is
// read, same technique as skill-file-batch-route.test.js. The snapshot core is
// covered by skill-manifest.test.js, the diff by skill-version-diff.test.js and
// the single-current rule by skill-lineage.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

function fn(name) {
  const start = API_SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(start > 0, `function ${name} not found`);
  const end = API_SRC.indexOf('\n}\n', start);
  return stripComments(API_SRC.slice(start, end + 2));
}

const FILES = "app.get('/api/skills/:name/versions/:hash/files',";
const FILE = "app.get('/api/skills/:name/versions/:hash/file',";
const DIFF = "app.get('/api/skills/:name/versions/diff',";
const RESTORE = "app.post('/api/skills/:name/versions/:hash/restore',";
const LINEAGE = "app.get('/api/skills/:name/lineage',";

test('scope gate: one resolver, same per-tier visibility as the lineage view (404 never leaks existence)', () => {
  const src = fn('resolveViewedSkillCopy');
  assert.match(src, /SKILL_NAME_RE\.test\(name/);
  assert.match(src, /AGENT_ID_RE\.test\(qAgentId\)[\s\S]*?status: 400/);
  assert.match(src, /!visibleAgent\(scope, agentMetaForScope\(cfg\)\)\) return \{ status: 404/);
  assert.match(src, /!visibleTeam\(scope, qTeamId\)\) return \{ status: 404/);
  // containment helpers resolve the directory
  assert.match(src, /safeAgentSkillDir\(qAgentId, name\)/);
  assert.match(src, /safeTeamSkillDir\(qTeamId, name\)/);
  assert.match(src, /safeGlobalSkillDir\(name\)/);
  for (const marker of [LINEAGE, FILES, FILE, DIFF, RESTORE]) {
    assert.match(route(marker), /resolveViewedSkillCopy\(req, /, `${marker} must use the scope gate`);
  }
});

test('lineage passes the working hash + snapshot hashes (single-current rule, availability)', () => {
  const src = route(LINEAGE);
  assert.match(src, /skillManifest\.hashSkillDir\(viewedDir\)/);
  assert.match(src, /skillManifest\.listSnapshotHashes\(viewedDir\)/);
  assert.match(src, /assembleLineage\(\{[^}]*workingHash, availableHashes \}\)/);
});

test('open: version hash validated; missing snapshot → 404 unavailable; file looked up inside the snapshot only', () => {
  for (const marker of [FILES, FILE]) {
    const src = route(marker);
    assert.match(src, /versionHashParam\(req\)[\s\S]*?Invalid version hash/);
    assert.match(src, /status\(404\)[\s\S]*?unavailable: true/);
  }
  const file = route(FILE);
  assert.match(file, /rel\.split\('\/'\)\.includes\('\.\.'\)\) return res\.status\(400\)/);
  assert.match(file, /v\.files\.find\(x => x\.path === rel\)/);
  assert.doesNotMatch(file, /safeSkillFilePath|readFileSync/, 'never resolves the query against the disk');
  assert.match(file, /SKILL_FILE_MAX_BYTES/);
  // raw bytes for "Edit from this version" (binary / over-cap files become uploads)
  assert.match(file, /req\.query\.encoding === 'base64'[\s\S]*?base64: f\.bytes\.toString\('base64'\)/);
});

test('snapshots are integrity-checked and the hash parameter is a content hash or "working"', () => {
  assert.match(fn('versionHashParam'), /h === 'working' \|\| skillManifest\.isContentHash\(h\)/);
  assert.match(fn('readSkillVersionFiles'), /skillManifest\.readSnapshot\(dir, hash\)/);
});

test('compare: from/to validated, order normalised older → newer, pure diff module', () => {
  const src = route(DIFF);
  assert.match(src, /status\(400\)[\s\S]*?from\/to must be a version hash or "working"/);
  assert.match(src, /rank\(a, from\) < rank\(b, to\)/);
  assert.match(src, /skillVersionDiff\.diffSkillVersions\(older\.files, newer\.files\)/);
});

test('restore: permission = editing that copy, checked BEFORE anything else touches the disk', () => {
  const src = route(RESTORE);
  assert.match(src, /viewed\.tier === 'agent'[\s\S]*?canManageAgent\(scope, agentMetaForScope\(r\.cfg\)\)[\s\S]*?status\(403\)/);
  assert.match(src, /skillTransfer\.requiredPoolWritePermission\(viewed\.tier, viewed\.teamId\)/);
  assert.match(src, /skillTransfer\.permitTransfer\(/);
  assert.match(src, /isTeamAdminOfAny:\s*\(\)\s*=>\s*isTeamAdminOfAny\(scope\)/);
  assert.match(src, /if \(!permit\.ok\) return res\.status\(403\)/);
  const gate = src.indexOf('permitTransfer(');
  for (const sink of ['hashSkillDir(', 'readSnapshot(', 'mkdirSync(', 'renameSync(']) {
    assert.ok(gate < src.indexOf(sink), `permission check must precede ${sink}`);
  }
});

test('restore: stale baseHash → 409, already-current → no-op, missing snapshot → 404', () => {
  const src = route(RESTORE);
  assert.match(src, /body\.baseHash !== currentHash[\s\S]*?status\(409\)[\s\S]*?conflict: true/);
  assert.match(src, /hash === currentHash[\s\S]*?restored: false, unchanged: true/);
  assert.match(src, /readSnapshot\(root, hash\)[\s\S]*?status\(404\)/);
});

test('restore: staging swap, path containment, one `restored` stamp, one auto-resync for pool tiers only', () => {
  const src = route(RESTORE);
  assert.match(src, /path\.relative\(staging, target\)/);
  assert.match(src, /rel\.startsWith\('\.\.'\)/);
  assert.match(src, /fs\.renameSync\(backup, root\)/, 'a failed swap must restore the original');
  assert.match(src, /isExcludedPath\(e\.name\)/, 'sidecars, _archive and _versions are carried over');
  assert.equal((src.match(/stampSkill\(/g) || []).length, 1);
  assert.match(src, /action: 'restored', restoredFrom/);
  assert.equal((src.match(/autoResyncOnEdit\(/g) || []).length, 1);
  assert.match(src, /\} else \{\s*autoResyncOnEdit/);
});

test('restore: an agent copy is mirrored into an isolated agent volume right away (same as install)', () => {
  const src = route(RESTORE);
  assert.equal((src.match(/notifyAgentReseed\(/g) || []).length, 1);
  assert.match(src, /if \(viewed\.tier === 'agent'\) \{\s*notifyAgentReseed\(viewed\.agentId, \[`skills\/\$\{name\}`\]\);\s*\} else \{\s*autoResyncOnEdit/);
  assert.ok(src.indexOf('notifyAgentReseed(') > src.indexOf('stampSkill('), 'reseed only after the swap and stamp');
});

test('snapshots never travel: every skill copy/archive cpSync filters _versions; the batch staging copy keeps them', () => {
  const copies = API_SRC.match(/fs\.cpSync\([^\n]*\n?/g) || [];
  const skillCopies = copies.filter(l => /copyFrom, destDir|skillRoot, dst\.dir|srcDir, dstDir|srcDir, dst\b|srcDir, dst\.dir/.test(l));
  assert.ok(skillCopies.length >= 7, `expected the skill copy sites, found ${skillCopies.length}`);
  for (const l of skillCopies) assert.match(l, /snapshotCopyFilter/, l);
  assert.match(API_SRC, /fs\.cpSync\(root, staging, \{ recursive: true, verbatimSymlinks: true \}\)/);
});

test('snapshots are not exported, not listed in the editor tree, not writable via PUT …/file', () => {
  assert.match(route("app.get('/api/skills/:name/export',"), /'-x', path\.posix\.join\(dirName, skillManifest\.SNAPSHOT_DIR, '\*'\)/);
  assert.match(fn('listSkillFiles'), /d\.name === skillManifest\.SNAPSHOT_DIR\) continue/);
  assert.match(route("app.put('/api/skills/:name/file',"), /=== skillManifest\.SNAPSHOT_DIR\) return res\.status\(400\)/);
});

test('a chain-continuing overwrite keeps the destination snapshots (#2315 + #2839)', () => {
  const src = fn('commitSkillWrite');
  assert.match(src, /keepSnapshots = !!\(overwrite && stamp && stamp\.continueFrom/);
  assert.match(src, /fs\.renameSync\(parkedSnapshots, path\.join\(destDir, skillManifest\.SNAPSHOT_DIR\)\)/);
});
