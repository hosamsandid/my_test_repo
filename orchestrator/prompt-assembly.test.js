'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  splitSections,
  assembleClaudeMd,
  buildMemoryHint,
  interactionNote,
  workingEnvironmentSection,
  blueprintSection,
  envHasRepository,
  envHasSkills,
  GIT_SECTION,
  TRIGGER_SECTION,
  WORKSPACE_SECTION,
} = require('./prompt-assembly');

// A minimal base template mirroring the real one's H2 structure.
const BASE = [
  '# Claude — Enterprise Assistant',
  '',
  'You are an AI assistant. You respond in the language the user writes in.',
  '',
  '## Response Formatting',
  '',
  'Use markdown.',
  '',
  '## Memory System',
  '',
  'You maintain five files in `memory/`.',
  '',
  '### Rules',
  '',
  '1. **Session start:** Read `context.md` and `log.md`; consult the others when relevant.',
  '',
  '## Skills',
  '',
  'Read the corresponding SKILL.md first.',
  '',
  '## Important Notes',
  '',
  '- Do not perform destructive operations.',
].join('\n');

const headings = (md) => md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.replace(/^## /, ''));

// ---- splitSections ---------------------------------------------------------

test('splitSections separates preamble from H2 sections and ignores H3', () => {
  const { preamble, sections } = splitSections(BASE);
  assert.match(preamble, /^# Claude/);
  assert.match(preamble, /respond in the language/);
  assert.deepEqual(sections.map((s) => s.heading), [
    'Response Formatting', 'Memory System', 'Skills', 'Important Notes',
  ]);
  // The H3 "### Rules" stays inside the Memory System block, not its own section.
  const mem = sections.find((s) => s.heading === 'Memory System');
  assert.match(mem.text, /### Rules/);
});

test('splitSections tolerates empty / nullish input', () => {
  assert.deepEqual(splitSections('').sections, []);
  assert.equal(splitSections(null).preamble, '');
});

// ---- ordering (fix D) ------------------------------------------------------

test('Agent Role is hoisted above the generic base sections', () => {
  const md = assembleClaudeMd({ base: BASE, agentPrompt: 'Do the thing.', role: 'agent', env: null });
  const order = headings(md);
  assert.equal(order[0], 'Agent Role');
  assert.ok(order.indexOf('Agent Role') < order.indexOf('Memory System'));
  assert.ok(order.indexOf('Agent Role') < order.indexOf('Response Formatting'));
  assert.match(md, /## Agent Role\n\nDo the thing\./);
});

// ---- conditional gating (fix C) --------------------------------------------

test('Git section is injected only when the env has a repository', () => {
  const withRepo = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent',
    env: { repositories: [{ url: 'git@github.com:acme/x.git' }] },
  });
  const noRepo = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: { repositories: [] } });
  assert.ok(withRepo.includes('gh-as-agent'));
  assert.ok(!noRepo.includes('gh-as-agent'));
});

test('Trigger docs are injected only for autonomous agents', () => {
  const auto = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null, autonomous: true });
  const dm = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null, autonomous: false });
  assert.ok(auto.includes('## Trigger management'));
  assert.ok(!dm.includes('## Trigger management'));
});

test('interaction note gains the unattended-run framing only when autonomous', () => {
  assert.ok(!interactionNote(false).includes('unattended'));
  assert.ok(interactionNote(true).includes('unattended'));
  const dm = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null, autonomous: false });
  const auto = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null, autonomous: true });
  assert.ok(!dm.includes('unattended on triggers'));
  assert.ok(auto.includes('unattended on triggers'));
});

test('Skills section is injected only when the env grants skills', () => {
  const withSkills = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: { skills: ['cobol'] } });
  const noSkills = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: { skills: [] } });
  assert.ok(withSkills.includes('## Skills'));
  assert.ok(!noSkills.includes('## Skills'));
});

// ---- de-duplication (fix A) ------------------------------------------------

test('the /workspace path-translation rule appears exactly once (only in the CLAUDE.md Workspace section)', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent',
    env: { repositories: [{ url: 'git@github.com:acme/x.git' }], skills: ['s'] }, autonomous: true,
  });
  const occurrences = md.split('translate these to relative paths').length - 1;
  assert.equal(occurrences, 1, 'path rule should live once in the Workspace section');
  assert.ok(md.includes('## Workspace'));
  // The runtime append hint must NOT repeat the path rule / example.
  assert.ok(!buildMemoryHint(null).includes('314092_foo'));
  assert.ok(!/translate these to relative paths/i.test(buildMemoryHint(null)));
});

test('runtime memory hint no longer names a 2-file subset that contradicts the 5-file model', () => {
  const hint = buildMemoryHint(null);
  // References all five files, framed as "start with … consult …".
  for (const f of ['context.md', 'log.md', 'facts.md', 'entities.md', 'users.md']) {
    assert.ok(hint.includes(f), `hint should mention ${f}`);
  }
  assert.ok(!/Read memory\/context\.md and memory\/log\.md first/.test(hint));
});

// ---- blueprint path --------------------------------------------------------

test('blueprint instances get a shared-memory section and a blueprint memory hint', () => {
  const md = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'bp-instance', env: null, blueprintId: 'abc123', autonomous: true });
  assert.ok(md.includes('## Memory System (Shared — Blueprint Instance)'));
  assert.ok(md.includes('abc123'));
  const hint = buildMemoryHint('abc123');
  assert.ok(hint.includes('SHARED across all instances'));
  assert.ok(hint.includes('abc123'));
});

// ---- operator-added sections are preserved ---------------------------------

test('unknown operator-added base sections are preserved verbatim', () => {
  const custom = BASE + '\n\n## Company Policy\n\nAlways be polite.';
  const md = assembleClaudeMd({ base: custom, agentPrompt: 'x', role: 'agent', env: null });
  assert.ok(md.includes('## Company Policy'));
  assert.ok(md.includes('Always be polite.'));
});

test('a stale base template with the old Git/Trigger/Workspace sections does not double-inject', () => {
  const stale = BASE +
    '\n\n## Workspace\n\nOLD workspace text.' +
    '\n\n## GitHub Actions — Identity Tagging\n\nOLD gh-as-agent text.' +
    '\n\n## Trigger management (triggers.json)\n\nOLD trigger text.';
  const md = assembleClaudeMd({
    base: stale, agentPrompt: 'x', role: 'agent',
    env: { repositories: [{ url: 'git@github.com:a/b.git' }] }, autonomous: true,
  });
  // Stale copies dropped; code-owned versions injected exactly once.
  assert.ok(!md.includes('OLD workspace text.'));
  assert.ok(!md.includes('OLD gh-as-agent text.'));
  assert.ok(!md.includes('OLD trigger text.'));
  assert.equal(md.split('## Workspace').length - 1, 1);
  assert.equal(md.split('## GitHub Actions').length - 1, 1);
  assert.equal(md.split('## Trigger management').length - 1, 1);
});

// ---- helpers ---------------------------------------------------------------

test('workingEnvironmentSection renders repo/skills and is empty for a bare env', () => {
  assert.equal(workingEnvironmentSection(null), '');
  assert.equal(workingEnvironmentSection({}), '');
  const s = workingEnvironmentSection({ name: 'E', repositories: [{ url: 'git@github.com:a/b.git' }], skills: ['x'] });
  assert.match(s, /## Working Environment/);
  assert.match(s, /cloned to `\.\/b\/`/);
  assert.match(s, /\*\*Skills:\*\* `x`/);
});

test('envHasRepository / envHasSkills', () => {
  assert.equal(envHasRepository({ repositories: [{ url: 'x' }] }), true);
  assert.equal(envHasRepository({ repositories: [] }), false);
  assert.equal(envHasRepository(null), false);
  assert.equal(envHasSkills({ skills: ['a'] }), true);
  assert.equal(envHasSkills({ skills: [] }), false);
});

// ---- cross-language drift guard --------------------------------------------
//
// buildMemoryHint() (JS) MUST stay byte-identical to _build_memory_hint() in
// agent-image/scripts/agent-entrypoint.py (the live runtime). We can't run
// Python here, so assert the Python source literally contains the same
// sentences this JS produces. If someone edits one and not the other, this
// fails.

test('non-blueprint memory hint matches the Python runtime source', () => {
  const py = fs.readFileSync(path.join(__dirname, '..', 'agent-image', 'scripts', 'agent-entrypoint.py'), 'utf8');
  const hint = buildMemoryHint(null);
  // The JS hint is built from concatenated string literals; the Python one is
  // too. Compare on the distinctive, whitespace-stable sentence fragments.
  const fragments = [
    'Before responding, read your memory files: start with memory/context.md and memory/log.md,',
    'and consult memory/facts.md, memory/entities.md and memory/users.md when the topic calls for it.',
    'If the user asks you to remember something, update the relevant memory files.',
    'IMPORTANT: Your workspace root is the current working directory.',
  ];
  for (const frag of fragments) {
    assert.ok(hint.includes(frag), `JS hint should contain: ${frag}`);
    assert.ok(py.includes(frag), `Python runtime should contain: ${frag}`);
  }
});

test('relocated sections are non-empty constants', () => {
  assert.ok(GIT_SECTION.startsWith('## GitHub Actions'));
  assert.ok(TRIGGER_SECTION.startsWith('## Trigger management'));
  assert.ok(WORKSPACE_SECTION.startsWith('## Workspace'));
});
