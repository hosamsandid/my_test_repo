'use strict';

// Unit tests for the pure skill-import validator/planner (#628).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const si = require('./skill-import');
const { parseSkillDescription } = require('../../orchestrator/skill-source');

/* ─── parseFrontmatterField / parseSkillMeta ──────────────────────────────── */

test('parses inline name + description', () => {
  const md = '---\nname: cobol-analyze\ndescription: Analyse COBOL programs\n---\nbody\n';
  assert.deepEqual(si.parseSkillMeta(md), { name: 'cobol-analyze', description: 'Analyse COBOL programs' });
});

test('parses quoted and block-scalar values', () => {
  const quoted = '---\nname: "x"\ndescription: "quoted desc"\n---\n';
  assert.deepEqual(si.parseSkillMeta(quoted), { name: 'x', description: 'quoted desc' });
  const block = '---\nname: y\ndescription: >-\n  first line\n  second line\n---\n';
  assert.equal(si.parseSkillMeta(block).description, 'first line second line');
});

test('missing frontmatter / keys → null', () => {
  assert.deepEqual(si.parseSkillMeta('no frontmatter here'), { name: null, description: null });
  assert.deepEqual(si.parseSkillMeta('---\nname: z\n---\n'), { name: 'z', description: null });
});

test('description parser matches orchestrator parseSkillDescription (no drift)', () => {
  const cases = [
    '---\ndescription: inline\n---\n',
    "---\ndescription: 'quoted'\n---\n",
    '---\ndescription: >-\n  folded one\n  folded two\n---\n',
    '---\ndescription:\n  plain\n  multiline\n---\n',
    'no fm',
    '---\ndescription:\n---\n',
  ];
  for (const c of cases) {
    assert.equal(si.parseFrontmatterField(c, 'description'), parseSkillDescription(c), `drift on: ${JSON.stringify(c)}`);
  }
});

/* ─── validateSkillMd (AC2) ───────────────────────────────────────────────── */

test('valid SKILL.md passes', () => {
  const r = si.validateSkillMd('---\nname: ok\ndescription: does a thing\n---\nbody');
  assert.deepEqual(r, { ok: true, name: 'ok', description: 'does a thing' });
});

test('missing / empty SKILL.md rejected', () => {
  assert.equal(si.validateSkillMd('').ok, false);
  assert.equal(si.validateSkillMd(null).ok, false);
  assert.match(si.validateSkillMd('   ').error, /missing or empty/);
});

test('missing name or description rejected with a clear error', () => {
  assert.match(si.validateSkillMd('---\ndescription: d\n---\n').error, /name/);
  assert.match(si.validateSkillMd('---\nname: n\n---\n').error, /description/);
});

/* ─── planImport ──────────────────────────────────────────────────────────── */

test('defaults: global tier, reject collision — #2307: System Admin OR Team Admin of ANY team, not System-Admin-only', () => {
  const p = si.planImport({ name: 'foo' });
  assert.equal(p.ok, true);
  assert.equal(p.tier, 'global');
  assert.equal(p.onCollision, 'reject');
  assert.deepEqual(p.permission, { needsSystemAdmin: false, teamAdminOf: [], anyTeamAdmin: true });
});

test('team tier requires a valid teamId and gates on Team Admin', () => {
  assert.match(si.planImport({ name: 'foo', tier: 'team' }).error, /teamId/);
  assert.match(si.planImport({ name: 'foo', tier: 'team', teamId: 'BAD_ID' }).error, /teamId/);
  const p = si.planImport({ name: 'foo', tier: 'team', teamId: 'alpha' });
  assert.equal(p.ok, true);
  assert.equal(p.teamId, 'alpha');
  assert.deepEqual(p.permission, { needsSystemAdmin: false, teamAdminOf: ['alpha'] });
});

test('rejects invalid name, tier, and collision mode', () => {
  assert.match(si.planImport({ name: '../evil' }).error, /invalid skill name/);
  assert.match(si.planImport({ name: '' }).error, /invalid skill name/);
  assert.match(si.planImport({ name: 'foo', tier: 'agent' }).error, /tier must be one of/);
  assert.match(si.planImport({ name: 'foo', onCollision: 'merge' }).error, /onCollision must be one of/);
});

test('accepts each collision mode', () => {
  for (const mode of ['reject', 'overwrite', 'rename']) {
    assert.equal(si.planImport({ name: 'foo', onCollision: mode }).onCollision, mode);
  }
});

/* ─── #2307: global import permission — one rule, checked end-to-end with the
 * shared permitTransfer checker the import endpoint actually calls. ───────── */

const { permitTransfer } = require('./skill-transfer');

test('AC1/AC2: a Team Admin of at least one team may import to global; a Team Admin of no team may not', () => {
  const plan = si.planImport({ name: 'foo' });
  const isTeamAdmin = (id) => id === 'squad-a';
  const asTeamAdmin = permitTransfer(plan.permission, { systemAdmin: false, isTeamAdmin, isTeamAdminOfAny: () => true }, 'import');
  assert.equal(asTeamAdmin.ok, true);
  const asPlainMember = permitTransfer(plan.permission, { systemAdmin: false, isTeamAdmin: () => false, isTeamAdminOfAny: () => false }, 'import');
  assert.equal(asPlainMember.ok, false);
  assert.match(asPlainMember.error, /System Admin or Team Admin/);
  assert.doesNotMatch(asPlainMember.error, /transfer/, 'the message must name Import, not Transfer, for an import request');
});

test('AC3: importing into a team pool still names the refused team, unaffected by the global relaxation', () => {
  const plan = si.planImport({ name: 'foo', tier: 'team', teamId: 'squad-a' });
  const r = permitTransfer(plan.permission, { systemAdmin: false, isTeamAdmin: (id) => id === 'squad-b', isTeamAdminOfAny: () => true }, 'import');
  assert.equal(r.ok, false);
  assert.match(r.error, /Team Admin of 'squad-a'/);
});
