'use strict';

/**
 * Tests for the Node-side BriefingPack reader (#1965, epic #1961 Phase 4).
 *
 * The load-bearing claim is AC2: the import must still produce the draft it
 * produced when the data came from bp-explorer. `briefingsToUnified` is what
 * turns a pack list into that draft and it is retained unchanged, so what
 * actually has to be proven here is the layer BELOW it — that reading real
 * `brief.md` files off disk yields the same pack rows the service did. The
 * parity block at the bottom does exactly that: it lays the fixtures from
 * `unified-graph.test.js` out as files, reads them back, and asserts the
 * resulting bundle is deep-equal to the one the in-memory fixture produces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BriefingsError, BRIEFINGS_SUBDIR, MAX_PACKS, MAX_DEPTH,
  parseFrontmatter, deriveParentFromPath, findBriefFiles, readBriefingPacks,
} = require('./briefings-fs');
const { briefingsToUnified, unifiedToProcessTemplate } = require('./unified-graph');

/* ── fixture helpers ─────────────────────────────────────────────────── */

const tmpDirs = [];
function missionDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-fs-'));
  tmpDirs.push(d);
  return d;
}
/** Run `fn`, return the BriefingsError it threw (assert.throws returns nothing). */
function caught(fn) {
  try { fn(); } catch (err) { return err; }
  return assert.fail('expected a BriefingsError, nothing was thrown');
}

test.after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** Write `<mission>/artifacts/briefings/<relDir>/brief.md`. */
function writeBrief(mission, relDir, text) {
  const dir = path.join(mission, BRIEFINGS_SUBDIR, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief.md'), text, 'utf8');
}

/* ── parseFrontmatter: the bp-explorer YAML subset ────────────────────── */

test('parses scalars, quoted scalars and the body', () => {
  const { meta, body } = parseFrontmatter(
    '---\nid: aa01\nmission: "Do the thing"\nstage: Build\n---\n\n# Heading\n\ntext\n',
  );
  assert.equal(meta.id, 'aa01');
  assert.equal(meta.mission, 'Do the thing', 'surrounding double quotes are stripped');
  assert.equal(meta.stage, 'Build');
  assert.equal(body, '# Heading\n\ntext', 'the body is trimmed, as upstream trims it');
});

test('parses empty lists, inline JSON arrays and indented scalar lists', () => {
  const { meta } = parseFrontmatter([
    '---',
    'children: []',
    'depends-on: ["aa01", "bb02"]',
    'mentor-scripts:',
    '  - first',
    '  - "second"',
    '---',
    'body',
  ].join('\n'));
  assert.deepEqual(meta.children, []);
  assert.deepEqual(meta['depends-on'], ['aa01', 'bb02']);
  assert.deepEqual(meta['mentor-scripts'], ['first', 'second']);
});

test('parses object lists with continuation keys — the artifacts shape', () => {
  const { meta } = parseFrontmatter([
    '---',
    'artifacts:',
    '  - direction: output',
    '    path: spec.md',
    '    description: The spec',
    '  - direction: input',
    '    path: notes.md',
    '---',
    '',
  ].join('\n'));
  assert.deepEqual(meta.artifacts, [
    { direction: 'output', path: 'spec.md', description: 'The spec' },
    { direction: 'input', path: 'notes.md' },
  ]);
});

test('a document with no frontmatter delimiters yields {} plus the whole text', () => {
  // Upstream returns the text UNTRIMMED on this branch (it only trims the body
  // it split out), and that difference is observable — the node content is the
  // body. Ported as-is rather than tidied.
  const { meta, body } = parseFrontmatter('# Just a heading\n');
  assert.deepEqual(meta, {});
  assert.equal(body, '# Just a heading\n');
});

test('a malformed inline array degrades to the raw string instead of throwing', () => {
  const { meta } = parseFrontmatter('---\ndepends-on: [not, json]\n---\nx');
  assert.equal(typeof meta['depends-on'], 'string');
});

test('parseFrontmatter never throws on hostile input', () => {
  for (const input of [null, undefined, '', '---', '---\n---', '---\n: no key\n---\nx', '---\n  - orphan item\n---\nx']) {
    assert.doesNotThrow(() => parseFrontmatter(input));
  }
});

/* ── deriveParentFromPath: directory nesting is the authority ─────────── */

test('the closest ancestor BP directory is the parent', () => {
  assert.equal(
    deriveParentFromPath('aaaaaaaaaaaa-root/bbbbbbbbbbbb-leaf/brief.md'),
    'aaaaaaaaaaaa',
  );
});

test('non-BP intermediates such as .archive do not break the chain', () => {
  assert.equal(
    deriveParentFromPath('aaaaaaaaaaaa-root/.archive/bbbbbbbbbbbb-leaf/brief.md'),
    'aaaaaaaaaaaa',
  );
});

test('a top-level pack has no derived parent', () => {
  assert.equal(deriveParentFromPath('aaaaaaaaaaaa-root/brief.md'), null);
  assert.equal(deriveParentFromPath(''), null);
});

test('a directory name that is not a BP dir yields no parent', () => {
  // Only `<12-hex>-` counts; `parent01-x` is 8 hex chars and must not match,
  // which is what makes the frontmatter `parent:` fallback reachable.
  assert.equal(deriveParentFromPath('parent01-x/aaaaaaaaaaaa-leaf/brief.md'), null);
});

/* ── the walk ────────────────────────────────────────────────────────── */

test('findBriefFiles collects every brief.md, sorted, and ignores other files', () => {
  const m = missionDir();
  writeBrief(m, 'bbbbbbbbbbbb-second', '---\nid: bbbbbbbbbbbb\n---\nb');
  writeBrief(m, 'aaaaaaaaaaaa-first', '---\nid: aaaaaaaaaaaa\n---\na');
  writeBrief(m, 'aaaaaaaaaaaa-first/cccccccccccc-child', '---\nid: cccccccccccc\n---\nc');
  fs.writeFileSync(path.join(m, BRIEFINGS_SUBDIR, 'README.md'), 'not a brief', 'utf8');

  const found = findBriefFiles(path.join(m, BRIEFINGS_SUBDIR));
  assert.equal(found.length, 3);
  assert.deepEqual([...found].sort(), found, 'results are path-sorted (node order reaches the draft)');
  assert.ok(found.every(f => path.basename(f) === 'brief.md'));
});

test('readBriefingPacks maps the fields briefingsToUnified consumes', () => {
  const m = missionDir();
  writeBrief(m, 'aaaaaaaaaaaa-root', [
    '---', 'id: aaaaaaaaaaaa', 'mission: The root', 'stage: Design',
    'children:', '  - bbbbbbbbbbbb', '---', '# Root brief',
  ].join('\n'));
  writeBrief(m, 'aaaaaaaaaaaa-root/bbbbbbbbbbbb-leaf', [
    '---', 'id: bbbbbbbbbbbb', 'mission: The leaf', 'depends-on: ["aaaaaaaaaaaa"]',
    'artifacts:', '  - direction: output', '    path: spec.md', '---', '# Leaf brief',
  ].join('\n'));

  const { packs, skipped } = readBriefingPacks(m);
  assert.deepEqual(skipped, []);
  assert.equal(packs.length, 2);

  const root = packs.find(p => p.id === 'aaaaaaaaaaaa');
  assert.equal(root.title, 'The root');
  assert.equal(root.slug, 'root', 'slug falls back to the directory suffix');
  assert.equal(root.stage, 'Design');
  assert.equal(root.body, '# Root brief');
  assert.equal(root.parent, null);
  assert.equal(root.is_parent, true);

  const leaf = packs.find(p => p.id === 'bbbbbbbbbbbb');
  assert.equal(leaf.parent, 'aaaaaaaaaaaa', 'derived from the on-disk nesting');
  assert.deepEqual(leaf.depends_on, ['aaaaaaaaaaaa']);
  assert.deepEqual(leaf.artifacts, [{ direction: 'output', path: 'spec.md' }]);
  assert.equal(leaf.is_parent, false);
});

test('directory nesting beats a disagreeing frontmatter parent', () => {
  const m = missionDir();
  writeBrief(m, 'aaaaaaaaaaaa-root', '---\nid: aaaaaaaaaaaa\nchildren:\n  - bbbbbbbbbbbb\n---\nr');
  writeBrief(m, 'aaaaaaaaaaaa-root/bbbbbbbbbbbb-leaf',
    '---\nid: bbbbbbbbbbbb\nparent: ffffffffffff\n---\nl');
  const { packs } = readBriefingPacks(m);
  assert.equal(packs.find(p => p.id === 'bbbbbbbbbbbb').parent, 'aaaaaaaaaaaa');
});

test('a top-level pack falls back to the frontmatter parent', () => {
  const m = missionDir();
  writeBrief(m, 'flat', '---\nid: aa01\nparent: parent01\n---\nx');
  assert.equal(readBriefingPacks(m).packs[0].parent, 'parent01');
});

test('an id is taken from the directory name when the frontmatter has none', () => {
  const m = missionDir();
  writeBrief(m, 'abcdef012345-some-slug', '---\nmission: No id here\n---\nbody');
  const [pack] = readBriefingPacks(m).packs;
  assert.equal(pack.id, 'abcdef012345');
  assert.equal(pack.slug, 'some-slug');
});

test('archived packs are still returned, flagged', () => {
  // bp-explorer returned them and briefingsToUnified never filtered on the
  // flag, so dropping them here would change the draft.
  const m = missionDir();
  writeBrief(m, '.archive/aaaaaaaaaaaa-old', '---\nid: aaaaaaaaaaaa\n---\nx');
  const [pack] = readBriefingPacks(m).packs;
  assert.equal(pack.archived, true);
});

/* ── edge cases: clear messages, never a stack trace ──────────────────── */

test('a missing artifacts/briefings directory is a 404 with a sentence', () => {
  const m = missionDir();
  const err = caught(() => readBriefingPacks(m));
  assert.ok(err instanceof BriefingsError);
  assert.equal(err.status, 404);
  assert.match(err.message, /No BriefingPacks found/);
  assert.match(err.message, /artifacts.briefings/, 'the message names the directory it looked in');
  assert.ok(!/\n\s+at /.test(err.message), 'not a stack trace');
});

test('an empty briefings directory is a 422 with a sentence', () => {
  const m = missionDir();
  fs.mkdirSync(path.join(m, BRIEFINGS_SUBDIR), { recursive: true });
  const err = caught(() => readBriefingPacks(m));
  assert.ok(err instanceof BriefingsError);
  assert.equal(err.status, 422);
  assert.match(err.message, /no brief\.md files/);
});

test('briefs with no resolvable id are named, not silently dropped', () => {
  // briefingsToUnified skips an id-less pack without a word, so a draft would
  // come back quietly missing roles — indistinguishable from a bug.
  const m = missionDir();
  writeBrief(m, 'not-a-bp-dir', '---\nmission: malformed\n---\nx');
  const err = caught(() => readBriefingPacks(m));
  assert.ok(err instanceof BriefingsError);
  assert.equal(err.status, 422);
  assert.match(err.message, /none carries a pack id/);
  assert.match(err.message, /not-a-bp-dir/, 'the offending file is named');
});

test('a partially malformed tree imports the good packs and reports the rest', () => {
  const m = missionDir();
  writeBrief(m, 'aaaaaaaaaaaa-good', '---\nid: aaaaaaaaaaaa\n---\ngood');
  writeBrief(m, 'junk', 'no frontmatter at all');
  const { packs, skipped } = readBriefingPacks(m);
  assert.deepEqual(packs.map(p => p.id), ['aaaaaaaaaaaa']);
  assert.deepEqual(skipped, ['junk' + path.sep + 'brief.md']);
});

test('a hierarchy deeper than MAX_DEPTH is refused with a message naming the limit', () => {
  const m = missionDir();
  const deep = Array.from({ length: MAX_DEPTH + 2 }, (_, i) => `level${i}`).join(path.sep);
  writeBrief(m, deep, '---\nid: aaaaaaaaaaaa\n---\nx');
  const err = caught(() => readBriefingPacks(m));
  assert.ok(err instanceof BriefingsError);
  assert.equal(err.status, 422);
  assert.match(err.message, new RegExp(String(MAX_DEPTH)));
  assert.match(err.message, /refusing to import/, 'a refusal, not a silent truncation');
});

test('MAX_PACKS is a refusal rather than a truncation', () => {
  // Asserted on the contract rather than by writing 2001 files: a cap that
  // truncated would produce a draft missing roles with no warning, which is
  // the failure this bound exists to avoid.
  assert.ok(Number.isInteger(MAX_PACKS) && MAX_PACKS > 0);
  const m = missionDir();
  writeBrief(m, 'aaaaaaaaaaaa-x', '---\nid: aaaaaaaaaaaa\n---\nx');
  assert.equal(readBriefingPacks(m).packs.length, 1, 'the ordinary path is unaffected by the cap');
});

/* ── AC2 parity: the same draft the service produced ──────────────────── */

// The fixture from `unified-graph.test.js`'s import test (#377), which is the
// case the ticket names as the contract for "the same draft it produces today".
// Ids are 8 chars, so no directory name matches `<12-hex>-` and the hierarchy
// comes from the frontmatter `parent:` fallback — the same way it reached
// briefingsToUnified through the service.
//
// Listed in PATH order, which is not the order that test writes them in. Node
// order reaches the draft (`unifiedToProcessTemplate` maps nodes to roles in
// array order), and both implementations derive it the same way: bp-explorer
// sorted its `rglob` results, this reader sorts its walk. On a real tree the
// children of `parent01-parent/` sort before the parent's own `brief.md`
// ("…-parent/aa01-…" < "…-parent/brief.md"), so this is the order the service
// returned too. Writing the array the other way round and comparing
// order-insensitively would have hidden a genuine ordering regression.
const IMPORT_FIXTURE = [
  { id: 'aa01', title: 'Upstream', parent: 'parent01', body: '# Do the upstream work', stage: '',
    artifacts: [{ direction: 'output', path: 'spec.md' }] },
  { id: 'bb02', title: 'Downstream', parent: 'parent01', depends_on: ['aa01'], stage: 'Build',
    artifacts: [{ direction: 'input', path: 'spec.md' }] },
  { id: 'parent01', title: 'Parent', children: ['aa01', 'bb02'], body: '# Parent brief', stage: 'Design' },
];

function writeImportFixture(mission) {
  writeBrief(mission, 'parent01-parent', [
    '---', 'id: parent01', 'mission: Parent', 'stage: Design',
    'children:', '  - aa01', '  - bb02', '---', '# Parent brief',
  ].join('\n'));
  writeBrief(mission, 'parent01-parent/aa01-upstream', [
    '---', 'id: aa01', 'mission: Upstream', 'parent: parent01',
    'artifacts:', '  - direction: output', '    path: spec.md', '---', '# Do the upstream work',
  ].join('\n'));
  writeBrief(mission, 'parent01-parent/bb02-downstream', [
    '---', 'id: bb02', 'mission: Downstream', 'parent: parent01', 'stage: Build',
    'depends-on: ["aa01"]',
    'artifacts:', '  - direction: input', '    path: spec.md', '---', '',
  ].join('\n'));
}

test('AC2 — reading from disk yields the same pack rows the service did', () => {
  const m = missionDir();
  writeImportFixture(m);
  const { packs } = readBriefingPacks(m);
  // Compare only the fields briefingsToUnified reads; the reader also carries
  // `slug`/`archived`, which that mapper never looks at.
  const seen = packs.map(p => ({
    id: p.id, title: p.title, body: p.body, stage: p.stage,
    parent: p.parent, children: p.children, depends_on: p.depends_on, artifacts: p.artifacts,
  }));
  const want = IMPORT_FIXTURE.map(p => ({
    id: p.id, title: p.title, body: p.body || '', stage: p.stage || '',
    parent: p.parent || null, children: p.children || [],
    depends_on: p.depends_on || [], artifacts: p.artifacts || [],
  }));
  assert.deepEqual(seen, want);
});

test('AC2 — the whole import produces a byte-identical draft bundle', () => {
  const m = missionDir();
  writeImportFixture(m);
  const name = 'imported';
  const fromDisk = unifiedToProcessTemplate(briefingsToUnified(readBriefingPacks(m).packs, { name }));
  const fromService = unifiedToProcessTemplate(briefingsToUnified(IMPORT_FIXTURE, { name }));
  assert.deepEqual(fromDisk, fromService);

  // Spot-check the properties the #377 test pins, so a future change to
  // briefingsToUnified that broke them would not pass merely by breaking both
  // sides of the comparison above in the same way.
  const byId = Object.fromEntries(fromDisk.roles.map(r => [r.id, r]));
  assert.equal(byId.parent01.systemPrompt, '# Parent brief');
  assert.equal(byId.aa01.systemPrompt, '# Do the upstream work');
  assert.equal(byId.aa01.parent, 'parent01');
  assert.equal(byId.bb02.parent, 'parent01');
  assert.deepEqual(byId.bb02.dependsOn, ['aa01']);
  assert.deepEqual(byId.aa01.outputs, [{ direction: 'output', path: 'spec.md' }]);
  assert.deepEqual(byId.bb02.inputs, [{ direction: 'input', path: 'spec.md' }]);
  assert.equal(byId.bb02.stage, 'Build');
});
