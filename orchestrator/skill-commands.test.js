'use strict';

// Unit tests for custom slash-command provisioning core (#1796).
// Run: node --test orchestrator/skill-commands.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  isCommandFile,
  slugify,
  commandNameFromFile,
  commandNamespace,
  commandInvocation,
  readSkillCommands,
  manifestEntriesFor,
  manifestWithoutSkill,
  commandsListFromManifest,
  knownCommandTokens,
} = require('./skill-commands');

test('isCommandFile accepts top-level .md, rejects dotfiles/non-md', () => {
  assert.equal(isCommandFile('plan.md'), true);
  assert.equal(isCommandFile('Plan.MD'), true);
  assert.equal(isCommandFile('.hidden.md'), false);
  assert.equal(isCommandFile('readme.txt'), false);
  assert.equal(isCommandFile('SKILL.md'), true); // filtering of SKILL.md is the caller's job
  assert.equal(isCommandFile(null), false);
});

test('slugify collapses punctuation and trims, null when empty', () => {
  assert.equal(slugify('Spec Kit'), 'spec-kit');
  assert.equal(slugify('  Plan!!  '), 'plan');
  assert.equal(slugify('ace:brief'), 'ace-brief');
  assert.equal(slugify('a__b'), 'a__b'); // underscores are allowed slug chars
  assert.equal(slugify('***'), null);
  assert.equal(slugify(''), null);
});

test('commandNameFromFile strips .md and slugifies', () => {
  assert.equal(commandNameFromFile('plan.md'), 'plan');
  assert.equal(commandNameFromFile('New Feature.md'), 'new-feature');
});

test('commandNamespace slugifies the skill name, stable fallback', () => {
  assert.equal(commandNamespace('spec-kit'), 'spec-kit');
  assert.equal(commandNamespace('Spec Kit'), 'spec-kit');
  assert.equal(commandNamespace('!!!'), 'skill');
});

test('commandInvocation is /<namespace>:<name>', () => {
  assert.equal(commandInvocation('spec-kit', 'plan'), '/spec-kit:plan');
});

// ---- readSkillCommands with injected fs doubles ----

function fakeFs(files) {
  // files: { '<skillDir>/commands': ['plan.md', ...], '<skillDir>/commands/plan.md': '<md>' }
  return {
    readdirSync: (dir) => {
      const list = files[dir];
      if (!list) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return list; // bare strings — readSkillCommands tolerates them
    },
    readFileSync: (p) => {
      if (p in files) return files[p];
      throw new Error('ENOENT ' + p);
    },
  };
}

test('readSkillCommands returns [] when there is no commands/ subdir', () => {
  const io = fakeFs({});
  assert.deepEqual(readSkillCommands('/pool/skills/cobol', 'cobol', io), []);
});

test('readSkillCommands parses description front-matter and namespaces', () => {
  const dir = path.join('/pool/skills/spec-kit', 'commands');
  const io = fakeFs({
    [dir]: ['plan.md', 'no-desc.md', 'notes.txt', '.hidden.md'],
    [path.join(dir, 'plan.md')]: '---\ndescription: Make a plan\n---\nBody $ARGUMENTS',
    [path.join(dir, 'no-desc.md')]: 'Just a body, no front-matter',
  });
  const recs = readSkillCommands('/pool/skills/spec-kit', 'spec-kit', io);
  assert.equal(recs.length, 2); // .txt and dotfile ignored
  const plan = recs.find((r) => r.name === 'plan');
  assert.equal(plan.command, 'spec-kit:plan');
  assert.equal(plan.invocation, '/spec-kit:plan');
  assert.equal(plan.namespace, 'spec-kit');
  assert.equal(plan.description, 'Make a plan');
  assert.equal(plan.targetPath, path.join('.claude', 'commands', 'spec-kit', 'plan.md'));
  assert.equal(plan.content, '---\ndescription: Make a plan\n---\nBody $ARGUMENTS');
  const nod = recs.find((r) => r.name === 'no-desc');
  assert.equal(nod.description, null); // name-only is valid
});

test('readSkillCommands drops duplicate slugs deterministically', () => {
  const dir = path.join('/pool/skills/s', 'commands');
  const io = fakeFs({
    [dir]: ['Plan.md', 'plan.md'],
    [path.join(dir, 'Plan.md')]: 'first',
    [path.join(dir, 'plan.md')]: 'second',
  });
  const recs = readSkillCommands('/pool/skills/s', 's', io);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].content, 'first'); // first wins after sort-independent de-dup
});

// ---- manifest helpers ----

test('manifestEntriesFor keys by command and preserves null description', () => {
  const recs = [
    { skill: 'spec-kit', name: 'plan', namespace: 'spec-kit', command: 'spec-kit:plan', invocation: '/spec-kit:plan', targetPath: '.claude/commands/spec-kit/plan.md', description: 'Make a plan' },
    { skill: 'spec-kit', name: 'x', namespace: 'spec-kit', command: 'spec-kit:x', invocation: '/spec-kit:x', targetPath: '.claude/commands/spec-kit/x.md', description: null },
  ];
  const m = manifestEntriesFor(recs, '2026-09-01T00:00:00Z');
  assert.deepEqual(m['spec-kit:plan'], {
    skill: 'spec-kit', name: 'plan', namespace: 'spec-kit', invocation: '/spec-kit:plan',
    description: 'Make a plan', file: '.claude/commands/spec-kit/plan.md', seededAt: '2026-09-01T00:00:00Z',
  });
  assert.equal(m['spec-kit:x'].description, null);
});

test('manifestWithoutSkill removes only that skill s entries', () => {
  const m = {
    'spec-kit:plan': { skill: 'spec-kit' },
    'spec-kit:x': { skill: 'spec-kit' },
    'cobol:build': { skill: 'cobol' },
  };
  assert.deepEqual(manifestWithoutSkill(m, 'spec-kit'), { 'cobol:build': { skill: 'cobol' } });
});

test('commandsListFromManifest flattens to name+description rows for #1797', () => {
  const m = {
    'spec-kit:plan': { skill: 'spec-kit', name: 'plan', namespace: 'spec-kit', invocation: '/spec-kit:plan', description: 'Make a plan' },
    'cobol:build': { skill: 'cobol', name: 'build', namespace: 'cobol', invocation: '/cobol:build', description: null },
  };
  const list = commandsListFromManifest(m);
  assert.deepEqual(list, [
    { command: 'cobol:build', name: 'build', namespace: 'cobol', skill: 'cobol', invocation: '/cobol:build', description: null },
    { command: 'spec-kit:plan', name: 'plan', namespace: 'spec-kit', skill: 'spec-kit', invocation: '/spec-kit:plan', description: 'Make a plan' },
  ]);
});

test('knownCommandTokens is the set of manifest keys (no leading slash)', () => {
  const m = { 'spec-kit:plan': {}, 'cobol:build': {} };
  const set = knownCommandTokens(m);
  assert.equal(set.has('spec-kit:plan'), true);
  assert.equal(set.has('cobol:build'), true);
  assert.equal(set.has('nope'), false);
  assert.equal(knownCommandTokens(null).size, 0);
});
