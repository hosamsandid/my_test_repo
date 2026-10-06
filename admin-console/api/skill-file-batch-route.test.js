'use strict';

// #2837 AC11/AC12/AC16/AC24 — the route behind the skill editor's "Save".
// api.js boots listeners on require and cannot be exercised directly (#651), so
// its source is read, same technique as skill-global-write-routes.test.js. The
// planning/apply logic itself is covered by skill-file-batch.test.js.

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

const BATCH = "app.post('/api/skills/:name/files/batch',";

test('batch save: agent tier refused with the same wording as PUT …/file', () => {
  const src = route(BATCH);
  assert.match(src, /source === 'agent'[\s\S]*?status\(403\)[\s\S]*?Agent skills are read-only from the registry\. Promote the skill to the pool to edit it\./);
});

test('batch save: same shared permission gate as PUT …/file (AC24)', () => {
  const src = route(BATCH);
  assert.match(src, /getScope\(req\)/);
  assert.match(src, /skillTransfer\.requiredPoolWritePermission\(\s*source === 'team' \? 'team' : 'global', teamId\)/);
  assert.match(src, /skillTransfer\.permitTransfer\(/);
  assert.match(src, /isTeamAdminOfAny:\s*\(\)\s*=>\s*isTeamAdminOfAny\(scope\)/);
  assert.match(src, /'edit'\s*,?\s*\)/);
  // the gate runs before anything touches the filesystem
  assert.ok(src.indexOf('permitTransfer(') < src.indexOf('cpSync('), 'permission check must precede the write');
});

test('batch save: skill dir resolved through the CodeQL-legible containment helpers', () => {
  const src = route(BATCH);
  assert.match(src, /safeTeamSkillDir\(teamId, name\)/);
  assert.match(src, /safeGlobalSkillDir\(name\)/);
});

test('batch save: a stale baseHash is refused with 409 conflict (AC16)', () => {
  const src = route(BATCH);
  assert.match(src, /skillManifest\.hashSkillDir\(root\)/);
  assert.match(src, /body\.baseHash !== currentHash[\s\S]*?status\(409\)[\s\S]*?conflict: true/);
});

test('batch save: validated by planBatch, applied to a staging copy, swapped in (AC11)', () => {
  const src = route(BATCH);
  assert.match(src, /skillFileBatch\.planBatch\(body, listing\)/);
  assert.match(src, /fs\.cpSync\(root, staging/);
  assert.match(src, /skillFileBatch\.applyBatch\(staging, planned\.plan\)/);
  assert.match(src, /fs\.renameSync\(backup, root\)/, 'a failed swap must restore the original');
  assert.doesNotMatch(src, /applyBatch\(root/, 'never apply in place');
});

test('batch save: exactly one version stamp and one auto-resync per save (AC12)', () => {
  const src = route(BATCH);
  assert.equal((src.match(/stampSkill\(/g) || []).length, 1);
  assert.equal((src.match(/autoResyncOnEdit\(/g) || []).length, 1);
  assert.match(src, /action: 'edited'/);
});

test('files listing returns dirs and the content hash the editor saves against', () => {
  const src = route("app.get('/api/skills/:name/files',");
  assert.match(src, /dirs: skillFileBatch\.listSkillDirs\(root\)/);
  assert.match(src, /hash\b/);
});
