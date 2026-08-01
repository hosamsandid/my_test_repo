import test from 'node:test';
import assert from 'node:assert/strict';

import { hasFrontmatterMeta, syncFrontmatterName, suggestFreeName } from './promotion-frontmatter.js';

const FM_DRAFT = [
  '---',
  'name: my-skill',
  'description: >-',
  '  Use this when a task involves labels.',
  '---',
  '',
  '# Labels',
  '',
  'body',
  '',
].join('\n');

test('hasFrontmatterMeta: true for inline and block-scalar values', () => {
  assert.equal(hasFrontmatterMeta(FM_DRAFT), true);
  assert.equal(hasFrontmatterMeta('---\nname: x\ndescription: "quoted value"\n---\n# T'), true);
});

test('hasFrontmatterMeta: false without a block, or with a missing/empty key', () => {
  assert.equal(hasFrontmatterMeta('# Just a title\n\nbody'), false);
  assert.equal(hasFrontmatterMeta(''), false);
  assert.equal(hasFrontmatterMeta('---\nname: x\n---\n# T'), false); // no description
  assert.equal(hasFrontmatterMeta('---\nname:\ndescription: d\n---\n# T'), false); // empty name
  assert.equal(hasFrontmatterMeta('---\nname: x\ndescription: >-\n---\n# T'), false); // block scalar with no lines
});

test('syncFrontmatterName: rewrites the name value, preserving everything else (#921 AC3)', () => {
  const out = syncFrontmatterName(FM_DRAFT, 'renamed-skill');
  assert.match(out, /^---\nname: renamed-skill\n/);
  assert.ok(out.includes('Use this when a task involves labels.'));
  assert.ok(out.includes('# Labels'));
  // idempotent
  assert.equal(syncFrontmatterName(out, 'renamed-skill'), out);
});

test('syncFrontmatterName: no-op without a frontmatter block, a name key, or a new name', () => {
  assert.equal(syncFrontmatterName('# T\n\nbody', 'x'), '# T\n\nbody');
  const noName = '---\ndescription: d\n---\n# T';
  assert.equal(syncFrontmatterName(noName, 'x'), noName);
  assert.equal(syncFrontmatterName(FM_DRAFT, '  '), FM_DRAFT);
});

test('suggestFreeName: first free -N suffix (#921 AC4)', () => {
  assert.equal(suggestFreeName('poller', ['poller']), 'poller-2');
  assert.equal(suggestFreeName('poller', ['poller', 'poller-2', 'poller-3']), 'poller-4');
  assert.equal(suggestFreeName('', ['x']), '');
});
