// #2839 — pure helpers behind the skill version views (Versions tab, diff, edit from version).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  versionRows, toggleCompareSelection, normalizeComparePair, versionLabel,
  readDiffMode, writeDiffMode, DIFF_MODE_KEY,
  visibleDiffFiles, fileNote, fileCounts, fileStatusLabel, summaryText,
  hunkify, buildUnifiedRows, buildSplitRows,
  versionActionPermission, planEditFromVersion, decodeVersionFile, applyVersionPlan,
} from './skill-version-view.js';
import { createModel, compileChanges } from './skill-editor-model.js';

const H = (c) => c.repeat(64);

test('versionRows: working-copy row first, history after; unavailable without a snapshot', () => {
  const rows = versionRows({
    workingCopy: { hash: H('f'), current: true, available: true },
    history: [
      { version: 2, hash: H('b'), action: 'edited', current: false, available: true },
      { version: 1, hash: H('a'), action: 'created', current: false, available: false },
    ],
  });
  assert.deepEqual(rows.map(r => [r.key, r.ref === 'working' ? 'working' : r.version, r.current, r.available]), [
    ['working', 'working', true, true],
    ['h0', 2, false, true],
    ['h1', 1, false, false],
  ]);
  assert.equal(versionRows(null).length, 0);
});

test('versionRows: exactly the flagged entry is current; restoredFrom is carried', () => {
  const rows = versionRows({ history: [
    { version: 4, hash: H('d'), action: 'restored', restoredFrom: 2, current: true, available: true },
    { version: 4, hash: H('d'), action: 'imported', current: false, available: true },
  ] });
  assert.equal(rows.filter(r => r.current).length, 1);
  assert.equal(rows[0].restoredFrom, 2);
});

test('toggleCompareSelection: at most two, the oldest pick drops, re-tick unticks', () => {
  let s = [];
  s = toggleCompareSelection(s, 'a');
  s = toggleCompareSelection(s, 'b');
  s = toggleCompareSelection(s, 'c');
  assert.deepEqual(s, ['b', 'c']);
  assert.deepEqual(toggleCompareSelection(s, 'b'), ['c']);
});

test('normalizeComparePair: older → newer whatever the pick order; unavailable refused', () => {
  const rows = versionRows({
    workingCopy: { hash: H('f') },
    history: [
      { version: 2, hash: H('b'), available: true },
      { version: 1, hash: H('a'), available: true },
      { version: 0, hash: H('0'), available: false },
    ],
  });
  assert.deepEqual(normalizeComparePair(rows, 'working', 'h1'), { from: H('a'), to: 'working' });
  assert.deepEqual(normalizeComparePair(rows, 'h1', 'working'), { from: H('a'), to: 'working' });
  assert.deepEqual(normalizeComparePair(rows, 'h0', 'h1'), { from: H('a'), to: H('b') });
  assert.equal(normalizeComparePair(rows, 'h2', 'h0'), null);
  assert.equal(normalizeComparePair(rows, 'nope', 'h0'), null);
});

test('versionLabel: version, short hash, action, author, date', () => {
  assert.equal(
    versionLabel({ version: 3, hash: H('c'), action: 'edited', by: 'ana', at: '2026-10-01T10:00:00.000Z' }),
    `v3 · ${H('c').slice(0, 12)} · edited · ana · 2026-10-01 10:00:00`,
  );
});

test('diff mode: remembered in session storage, defaults to side-by-side, tolerates broken storage', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(readDiffMode(storage), 'split');
  writeDiffMode(storage, 'inline');
  assert.equal(store.get(DIFF_MODE_KEY), 'inline');
  assert.equal(readDiffMode(storage), 'inline');
  writeDiffMode(storage, 'bogus');
  assert.equal(readDiffMode(storage), 'inline');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readDiffMode(broken), 'split');
  assert.doesNotThrow(() => writeDiffMode(broken, 'inline'));
});

test('diff files: unchanged hidden unless toggled; binary/too-large notes; counts', () => {
  const files = [
    { path: 'a.md', status: 'modified', added: 2, removed: 1 },
    { path: 'b.md', status: 'unchanged', added: 0, removed: 0 },
    { path: 'img.png', status: 'modified', binary: true, contentChanged: true, added: null, removed: null },
    { path: 'big.txt', status: 'unchanged', tooLarge: true, contentChanged: false, added: null, removed: null },
  ];
  assert.deepEqual(visibleDiffFiles(files, false).map(f => f.path), ['a.md', 'img.png']);
  assert.equal(visibleDiffFiles(files, true).length, 4);
  assert.equal(fileNote(files[2]), 'binary — changed');
  assert.equal(fileNote(files[3]), 'too large — unchanged');
  assert.equal(fileNote(files[0]), null);
  assert.equal(fileCounts(files[0]), '+2 −1');
  assert.equal(fileCounts(files[2]), null);
  assert.equal(fileStatusLabel('renamed'), 'Renamed');
  assert.equal(summaryText({ modified: 1, added: 2, unchanged: 3, linesAdded: 5, linesRemoved: 1 }), '1 modified, 2 added, 3 unchanged · +5 −1 lines');
});

const ctx = (n, start = 1) => Array.from({ length: n }, (_, i) => ({ t: ' ', a: start + i, b: start + i, s: `l${start + i}` }));

test('hunkify / buildUnifiedRows: unchanged context beyond 3 lines collapses into a gap', () => {
  const ops = [...ctx(10), { t: '-', a: 11, b: null, s: 'old' }, { t: '+', a: null, b: 11, s: 'new' }, ...ctx(10, 12)];
  const segs = hunkify(ops);
  assert.deepEqual(segs.map(s => s.type === 'gap' ? `gap${s.count}` : `ops${s.ops.length}`), ['gap7', 'ops8', 'gap7']);
  const rows = buildUnifiedRows(ops);
  assert.equal(rows[0].type, 'gap');
  assert.deepEqual(rows.filter(r => r.type === 'line' && r.t !== ' ').map(r => r.t + r.s), ['-old', '+new']);
  assert.deepEqual(buildUnifiedRows([]), []);
});

test('buildSplitRows: removed lines pair with added lines; the shorter side pads with null', () => {
  const ops = [
    { t: ' ', a: 1, b: 1, s: 'same' },
    { t: '-', a: 2, b: null, s: 'r1' }, { t: '-', a: 3, b: null, s: 'r2' },
    { t: '+', a: null, b: 2, s: 'a1' },
  ];
  const rows = buildSplitRows(ops);
  assert.deepEqual(rows.map(r => [r.left && r.left.t + r.left.s, r.right && r.right.t + r.right.s]), [
    [' same', ' same'],
    ['-r1', '+a1'],
    ['-r2', null],
  ]);
});

test('versionActionPermission: agent copy uses the install right; pool copies follow edit rights', () => {
  const agentSkill = { source: 'agent', teamId: 't1' };
  assert.equal(versionActionPermission(agentSkill, { isSysAdmin: true }, 't1').restore.ok, true);
  assert.equal(versionActionPermission(agentSkill, { adminTeamIds: ['t1'] }, 't1').restore.ok, true);
  assert.equal(versionActionPermission(agentSkill, { adminTeamIds: ['t2'] }, 't1').restore.ok, false);
  assert.equal(versionActionPermission(agentSkill, { isSysAdmin: true }, 't1').editFrom.ok, false);
  const team = { source: 'team', teamId: 't1' };
  assert.equal(versionActionPermission(team, { adminTeamIds: ['t1'] }).restore.ok, true);
  assert.equal(versionActionPermission(team, { adminTeamIds: [] }).editFrom.ok, false);
  assert.equal(versionActionPermission({ source: 'pool' }, { isSysAdmin: true }).editFrom.ok, true);
});

test('planEditFromVersion: reverses a version→working diff (deletes, renames, writes)', () => {
  const plan = planEditFromVersion({ files: [
    { path: 'new.md', status: 'added' },
    { path: 'gone.md', status: 'removed' },
    { path: 'SKILL.md', status: 'modified' },
    { path: 'moved/x.md', fromPath: 'x.md', status: 'renamed', contentChanged: true },
    { path: 'y2.md', fromPath: 'y.md', status: 'renamed', contentChanged: false },
    { path: 'same.md', status: 'unchanged' },
  ] });
  assert.deepEqual(plan.deletes, ['new.md']);
  assert.deepEqual(plan.renames, [{ from: 'moved/x.md', to: 'x.md' }, { from: 'y2.md', to: 'y.md' }]);
  assert.deepEqual(plan.writes, ['SKILL.md', 'gone.md', 'x.md']);
  assert.deepEqual(plan.fetch, plan.writes);
});

const b64 = (s) => Buffer.from(s).toString('base64');

test('decodeVersionFile: text stays text, binary becomes an upload', () => {
  assert.deepEqual(decodeVersionFile({ base64: b64('héllo\n'), size: 7 }), { text: 'héllo\n', size: 7 });
  const bin = Buffer.from([0x89, 0x50, 0x00, 0x01]).toString('base64');
  assert.deepEqual(decodeVersionFile({ base64: bin, size: 4 }), { base64: bin, size: 4 });
});

test('applyVersionPlan: old content becomes pending changes that save as one batch', () => {
  const model = createModel({ files: [
    { path: 'SKILL.md', size: 3 }, { path: 'new.md', size: 1 }, { path: 'moved/x.md', size: 1 },
  ] });
  const plan = planEditFromVersion({ files: [
    { path: 'new.md', status: 'added' },
    { path: 'gone.md', status: 'removed' },
    { path: 'SKILL.md', status: 'modified' },
    { path: 'moved/x.md', fromPath: 'x.md', status: 'renamed', contentChanged: true },
  ] });
  const bin = Buffer.from([0, 1, 2]).toString('base64');
  const contents = new Map([
    ['SKILL.md', { text: 'old skill', size: 9 }],
    ['gone.md', { text: 'back', size: 4 }],
    ['x.md', { base64: bin, size: 3 }],
  ]);
  const { state, errors } = applyVersionPlan(model, plan, contents);
  assert.deepEqual(errors, []);
  const c = compileChanges(state);
  assert.deepEqual(c.deletes, ['new.md']);
  assert.deepEqual(c.moves, [{ from: 'moved/x.md', to: 'x.md' }]);
  assert.deepEqual(c.writes, [
    { path: 'gone.md', content: 'back' },
    { path: 'SKILL.md', content: 'old skill' },
    { path: 'x.md', contentBase64: bin },
  ]);
});

test('applyVersionPlan: missing content is reported, not silently skipped', () => {
  const model = createModel({ files: [{ path: 'SKILL.md', size: 1 }] });
  const { errors } = applyVersionPlan(model, { deletes: [], renames: [], writes: ['SKILL.md'] }, new Map());
  assert.deepEqual(errors, ['SKILL.md: content not available']);
});
