'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  rewriteProjectPaths,
  splitFrontmatter,
  parseScriptsBlock,
  resolveCommandRefs,
  hasUnresolvedPlaceholders,
  resolveSpecKitCommand,
} = require('./speckit-content');

test('rewriteProjectPaths maps top-level repo dirs to .specify layout', () => {
  assert.equal(rewriteProjectPaths('run scripts/bash/setup-plan.sh'), 'run .specify/scripts/bash/setup-plan.sh');
  assert.equal(rewriteProjectPaths('read templates/spec-template.md'), 'read .specify/templates/spec-template.md');
  assert.equal(rewriteProjectPaths('open memory/constitution.md'), 'open .specify/memory/constitution.md');
});

test('rewriteProjectPaths handles ../../ and ./ prefixes and start-of-string', () => {
  assert.equal(rewriteProjectPaths('../../scripts/common.sh'), '.specify/scripts/common.sh');
  assert.equal(rewriteProjectPaths('`./scripts/x.sh`'), '`.specify/scripts/x.sh`');
  assert.equal(rewriteProjectPaths('scripts/x.sh at start'), '.specify/scripts/x.sh at start');
});

test('rewriteProjectPaths does not touch already-.specify paths or unrelated prose', () => {
  assert.equal(rewriteProjectPaths('.specify/scripts/bash/x.sh'), '.specify/scripts/bash/x.sh');
  assert.equal(rewriteProjectPaths('descriptors/thing and helpers/tool'), 'descriptors/thing and helpers/tool');
});

test('splitFrontmatter separates YAML block from body', () => {
  const md = '---\ndescription: hi\nscripts:\n  sh: scripts/bash/x.sh --json\n---\nBody {SCRIPT}\n';
  const { frontmatter, body } = splitFrontmatter(md);
  assert.match(frontmatter, /description: hi/);
  assert.equal(body, 'Body {SCRIPT}\n');
});

test('splitFrontmatter returns whole doc as body when no frontmatter', () => {
  const { frontmatter, body } = splitFrontmatter('no fm here');
  assert.equal(frontmatter, '');
  assert.equal(body, 'no fm here');
});

test('parseScriptsBlock extracts the sh/ps/py mapping', () => {
  const fm = 'description: x\nscripts:\n  sh: scripts/bash/setup-plan.sh --json\n  ps: scripts/powershell/setup-plan.ps1 -Json\n  py: scripts/python/setup_plan.py --json';
  const s = parseScriptsBlock(fm);
  assert.equal(s.sh, 'scripts/bash/setup-plan.sh --json');
  assert.equal(s.ps, 'scripts/powershell/setup-plan.ps1 -Json');
  assert.equal(s.py, 'scripts/python/setup_plan.py --json');
});

test('parseScriptsBlock stops at the next top-level key', () => {
  const fm = 'scripts:\n  sh: scripts/bash/x.sh --json\nother: value';
  const s = parseScriptsBlock(fm);
  assert.deepEqual(s, { sh: 'scripts/bash/x.sh --json' });
});

test('resolveSpecKitCommand: {SCRIPT} resolves from sh frontmatter and is path-rewritten', () => {
  const md = '---\ndescription: Plan\nscripts:\n  sh: scripts/bash/setup-plan.sh --json\n---\nRun `{SCRIPT}` then read spec.\n';
  const out = resolveSpecKitCommand(md, { scriptVariant: 'sh', agentName: 'claude' });
  assert.match(out, /Run `\.specify\/scripts\/bash\/setup-plan\.sh --json`/);
  // frontmatter (description) preserved for the seeded-commands manifest
  assert.match(out, /description: Plan/);
});

test('resolveSpecKitCommand: {ARGS} and __AGENT__ substituted', () => {
  const md = '---\ndescription: Specify\n---\nInput {ARGS} for __AGENT__.\n';
  const out = resolveSpecKitCommand(md, { scriptVariant: 'sh', agentName: 'claude' });
  assert.match(out, /Input \$ARGUMENTS for claude\./);
});

test('resolveSpecKitCommand: no scripts block leaves {SCRIPT}-less body intact except ARGS', () => {
  const md = '---\ndescription: x\n---\nJust $ARGUMENTS and {ARGS}.\n';
  const out = resolveSpecKitCommand(md, {});
  assert.match(out, /Just \$ARGUMENTS and \$ARGUMENTS\./);
});

test('resolveSpecKitCommand: {ARGS} embedded in the sh script command is resolved', () => {
  const md = '---\nscripts:\n  sh: scripts/bash/x.sh {ARGS}\n---\n`{SCRIPT}`\n';
  const out = resolveSpecKitCommand(md, {});
  assert.match(out, /`\.specify\/scripts\/bash\/x\.sh \$ARGUMENTS`/);
});

test('resolveCommandRefs maps __SPECKIT_COMMAND_*__ to the /namespace:name invocation', () => {
  assert.equal(resolveCommandRefs('see __SPECKIT_COMMAND_PLAN__'), 'see /speckit:plan');
  assert.equal(resolveCommandRefs('run __SPECKIT_COMMAND_GIT_COMMIT__'), 'run /speckit:git-commit');
  assert.equal(resolveCommandRefs('x __SPECKIT_COMMAND_TASKS__ y', { namespace: 'sk' }), 'x /sk:tasks y');
});

test('hasUnresolvedPlaceholders detects every placeholder class', () => {
  assert.equal(hasUnresolvedPlaceholders('a {SCRIPT} b'), true);
  assert.equal(hasUnresolvedPlaceholders('a {ARGS} b'), true);
  assert.equal(hasUnresolvedPlaceholders('a __AGENT__ b'), true);
  assert.equal(hasUnresolvedPlaceholders('a __SPECKIT_COMMAND_PLAN__ b'), true);
  assert.equal(hasUnresolvedPlaceholders('fully resolved /speckit:plan $ARGUMENTS'), false);
});

test('resolveSpecKitCommand resolves cross-refs and leaves nothing unresolved', () => {
  const md = '---\ndescription: Analyze\nscripts:\n  sh: scripts/bash/check-prerequisites.sh --json\n---\nRun `{SCRIPT}`, then __SPECKIT_COMMAND_IMPLEMENT__ with {ARGS} as __AGENT__.\n';
  const out = resolveSpecKitCommand(md, {});
  assert.match(out, /Run `\.specify\/scripts\/bash\/check-prerequisites\.sh --json`/);
  assert.match(out, /then \/speckit:implement with \$ARGUMENTS as claude\./);
  assert.equal(hasUnresolvedPlaceholders(out), false);
});
