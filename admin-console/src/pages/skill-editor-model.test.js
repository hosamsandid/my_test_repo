// #2837 — pure model of the full-screen skill editor (AC3, AC10, AC17–AC22, AC27).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createModel, buildFileTree, visibleRows, validateName, validatePath,
  editFile, createFile, createFolder, renamePath, deletePath, uploadFile, uploadConflicts,
  compileChanges, listChanges, pendingCount, changeMarks, splitFrontmatter,
  targetFolder, isProtectedPath, skillEditPermission, MAX_UPLOAD_BYTES, looksBinary,
} from './skill-editor-model.js';

const BASE = {
  files: [
    { path: 'SKILL.md', size: 10 },
    { path: 'references/a.md', size: 1 },
    { path: 'references/deep/b.md', size: 1 },
    { path: 'scripts/run.sh', size: 4 },
    { path: 'Zeta.md', size: 1 },
    { path: 'skill.json', size: 2 },
    { path: '_archive/v1/SKILL.md', size: 2 },
  ],
  dirs: ['references', 'references/deep', 'scripts', 'empty'],
};
const model = () => createModel(BASE);
const must = (r) => { assert.equal(r.error, null, r.error); return r.state; };

/* ─── tree (AC3, AC21) ─────────────────────────────────────────────────── */

test('tree: folders first, then files, alphabetical; platform files hidden', () => {
  const tree = buildFileTree(model());
  assert.deepEqual(tree.map(n => n.name), ['empty', 'references', 'scripts', 'SKILL.md', 'Zeta.md']);
  assert.deepEqual(tree[1].children.map(n => n.name), ['deep', 'a.md']);
  const all = visibleRows(tree, new Set(['references', 'references/deep', 'scripts'])).map(r => r.path);
  assert.ok(!all.some(p => isProtectedPath(p)), 'skill.json / _archive never shown');
  assert.ok(all.includes('references/deep/b.md'));
});

test('tree: a skill with only SKILL.md shows a single file', () => {
  const tree = buildFileTree(createModel({ files: [{ path: 'SKILL.md', size: 1 }], dirs: [] }));
  assert.deepEqual(tree.map(n => n.path), ['SKILL.md']);
});

test('visibleRows hides collapsed folders and carries depth', () => {
  const rows = visibleRows(buildFileTree(model()), new Set(['references']));
  assert.deepEqual(rows.map(r => `${r.depth}:${r.name}`), ['0:empty', '0:references', '1:deep', '1:a.md', '0:scripts', '0:SKILL.md', '0:Zeta.md']);
});

/* ─── names (AC17) ─────────────────────────────────────────────────────── */

test('validateName / validatePath refuse traversal, empty, separators, platform names', () => {
  for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', ' lead', 'skill.json', '_archive', 'x'.repeat(256)]) {
    assert.ok(validateName(bad), `name ${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(validateName('notes.md'), null);
  for (const bad of ['', '/abs', 'a/../b', 'a//b', 'a/', '../x']) assert.ok(validatePath(bad), `path ${bad} should be refused`);
  assert.equal(validatePath('docs/new/a.md'), null);
});

test('createFile / createFolder refuse duplicates in the same folder', () => {
  const s = model();
  assert.match(createFile(s, 'references', 'a.md').error, /already exists/);
  assert.match(createFolder(s, '', 'scripts').error, /already exists/);
  assert.match(createFile(s, 'references', '../x').error, /cannot/);
  assert.equal(createFile(s, 'references', 'c.md').path, 'references/c.md');
});

/* ─── pending changes (AC10) ───────────────────────────────────────────── */

test('no changes on a fresh model', () => {
  assert.equal(pendingCount(model()), 0);
  assert.deepEqual(compileChanges(model()), { deletes: [], moves: [], writes: [], mkdirs: [] });
});

test('editing back to the original content is no change', () => {
  let s = must(editFile(model(), 'references/a.md', 'changed', 'A'));
  assert.equal(pendingCount(s), 1);
  assert.equal(changeMarks(s).get('references/a.md'), 'modified');
  assert.equal(changeMarks(s).get('references'), 'contains', 'collapsed folder shows it holds a change');
  s = must(editFile(s, 'references/a.md', 'A', 'A'));
  assert.equal(pendingCount(s), 0);
});

test('create then delete before Save is no net change', () => {
  let s = must(createFile(model(), '', 'tmp.md'));
  assert.equal(pendingCount(s), 1);
  s = must(deletePath(s, 'tmp.md'));
  assert.equal(pendingCount(s), 0);
});

test('renaming an edited file carries the edits along', () => {
  let s = must(editFile(model(), 'references/a.md', 'A2', 'A'));
  s = must(renamePath(s, 'references/a.md', 'docs/a.md'));
  const c = compileChanges(s);
  assert.deepEqual(c.moves, [{ from: 'references/a.md', to: 'docs/a.md' }]);
  assert.deepEqual(c.writes, [{ path: 'docs/a.md', content: 'A2' }]);
  assert.deepEqual(listChanges(s), [{ path: 'docs/a.md', from: 'references/a.md', kind: 'renamed' }]);
});

test('folder rename moves contents and deletes the old folder (AC18)', () => {
  const s = must(renamePath(model(), 'references', 'docs'));
  const c = compileChanges(s);
  assert.deepEqual(c.moves, [{ from: 'references/a.md', to: 'docs/a.md' }, { from: 'references/deep/b.md', to: 'docs/deep/b.md' }]);
  assert.deepEqual(c.deletes, ['references']);
  assert.match(renamePath(model(), 'references', 'scripts').error, /already exists/);
  assert.match(renamePath(model(), 'references', 'references/x').error, /into itself/);
  assert.match(renamePath(model(), 'references/a.md', 'Zeta.md').error, /already exists/);
});

test('folder delete removes contents in one top-level delete (AC19)', () => {
  const s = must(deletePath(model(), 'references'));
  assert.deepEqual(compileChanges(s).deletes, ['references']);
  assert.deepEqual(listChanges(s), [{ path: 'references', kind: 'folder-deleted' }]);
});

test('SKILL.md at the root cannot be deleted, renamed or moved (AC21)', () => {
  assert.match(deletePath(model(), 'SKILL.md').error, /cannot be deleted/);
  assert.match(renamePath(model(), 'SKILL.md', 'docs/SKILL.md').error, /cannot be renamed or moved/);
});

test('empty folders are persisted: new empty folder → mkdir, emptied folder kept (AC22)', () => {
  let s = must(createFolder(model(), 'references', 'new'));
  assert.deepEqual(compileChanges(s).mkdirs, ['references/new']);
  s = must(deletePath(model(), 'scripts/run.sh'));
  assert.deepEqual(compileChanges(s).deletes, ['scripts/run.sh'], 'the folder itself stays');
  assert.ok(buildFileTree(s).some(n => n.path === 'scripts'));
});

test('upload into a pending folder implies the folder (no redundant mkdir) (AC20)', () => {
  let s = must(createFolder(model(), '', 'assets'));
  s = must(uploadFile(s, 'assets', 'logo.png', { base64: 'AAEC', size: 3 }));
  const c = compileChanges(s);
  assert.deepEqual(c.writes, [{ path: 'assets/logo.png', contentBase64: 'AAEC' }]);
  assert.deepEqual(c.mkdirs, []);
  assert.deepEqual(listChanges(s), [{ path: 'assets/logo.png', kind: 'added' }]);
});

test('upload: overwrite conflicts are detected, oversize refused', () => {
  assert.deepEqual(uploadConflicts(model(), 'references', ['a.md', 'new.md']), ['a.md']);
  const r = uploadFile(model(), '', 'big.bin', { base64: '', size: MAX_UPLOAD_BYTES + 1 });
  assert.match(r.error, /upload limit/);
  const s = must(uploadFile(model(), 'references', 'a.md', { base64: 'QQ==', size: 1 }));
  assert.deepEqual(listChanges(s), [{ path: 'references/a.md', kind: 'modified' }]);
});

test('delete a file and rename another onto its name', () => {
  let s = must(deletePath(model(), 'Zeta.md'));
  s = must(renamePath(s, 'references/a.md', 'Zeta.md'));
  const c = compileChanges(s);
  assert.deepEqual(c.deletes, ['Zeta.md']);
  assert.deepEqual(c.moves, [{ from: 'references/a.md', to: 'Zeta.md' }]);
});

test('targetFolder: a folder itself, a file → its parent, nothing → root', () => {
  const s = model();
  assert.equal(targetFolder(s, 'references'), 'references');
  assert.equal(targetFolder(s, 'references/deep/b.md'), 'references/deep');
  assert.equal(targetFolder(s, null), '');
});

/* ─── content (AC6, AC9) ───────────────────────────────────────────────── */

test('splitFrontmatter separates YAML from the body', () => {
  const r = splitFrontmatter('---\nname: x\ndescription: >-\n  long\n---\n# Title\n');
  assert.equal(r.frontmatter, 'name: x\ndescription: >-\n  long');
  assert.equal(r.body, '# Title\n');
  assert.deepEqual(splitFrontmatter('# no fm'), { frontmatter: null, body: '# no fm' });
});

test('looksBinary flags a NUL byte', () => {
  assert.equal(looksBinary(new Uint8Array([65, 0, 66])), true);
  assert.equal(looksBinary(new Uint8Array([65, 66])), false);
});

/* ─── permissions (AC1, AC23) ──────────────────────────────────────────── */

test('skillEditPermission mirrors the server gate', () => {
  assert.equal(skillEditPermission({ source: 'agent' }, { isSysAdmin: true }).editable, false);
  assert.equal(skillEditPermission({ source: 'team', teamId: 't1' }, { adminTeamIds: ['t1'] }).editable, true);
  assert.equal(skillEditPermission({ source: 'team', teamId: 't1' }, { adminTeamIds: ['t2'] }).editable, false);
  assert.equal(skillEditPermission({ source: 'pool' }, { adminTeamIds: ['t2'] }).editable, true);
  assert.equal(skillEditPermission({ source: 'pool' }, { adminTeamIds: [] }).editable, false);
  assert.ok(skillEditPermission({ source: 'pool' }, {}).reason);
});
