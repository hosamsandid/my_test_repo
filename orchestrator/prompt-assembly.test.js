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
  hasSkillGrant,
  skillsSection,
  GIT_SECTION,
  TRIGGER_SECTION,
  WORKSPACE_SECTION,
  MEMORY_SECTION_UNIFIED,
} = require('./prompt-assembly');
const { parseSkillDescription } = require('./skill-source');

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

// ---- reference mode (#510) -------------------------------------------------

test('promptRef emits an @-import instead of inlining the prompt', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'Inlined body that must not appear.',
    role: 'agent', env: null, promptRef: 'AGENT-PROMPT.md',
  });
  const order = headings(md);
  assert.equal(order[0], 'Agent Role');
  // The Agent Role block references the file, not the resolved prompt text.
  assert.match(md, /## Agent Role\n\n@AGENT-PROMPT\.md/);
  assert.ok(!md.includes('Inlined body that must not appear.'));
});

test('without promptRef the prompt is still inlined (preview / AC7)', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'Inlined body.', role: 'agent', env: null,
  });
  assert.match(md, /## Agent Role\n\nInlined body\./);
  assert.ok(!md.includes('@AGENT-PROMPT.md'));
});

// ---- Team Knowledge digest import (Memory/Knowledge unification, Phase 1) ---

test('knowledgeDigestRef emits the Team Knowledge section with the @-import', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent', env: null,
    knowledgeDigestRef: 'knowledge-digest.md',
  });
  const order = headings(md);
  assert.ok(order.includes('Team Knowledge (digest)'));
  // Sits between Memory System and Skills-adjacent blocks.
  assert.ok(order.indexOf('Memory System') < order.indexOf('Team Knowledge (digest)'));
  assert.match(md, /## Team Knowledge \(digest\)\n\n@knowledge-digest\.md/);
  assert.ok(md.includes('knowledge search'));
});

test('without knowledgeDigestRef no digest import appears (autonomy 0 / no KB)', () => {
  const md = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null });
  assert.ok(!md.includes('@knowledge-digest.md'));
  assert.ok(!md.includes('Team Knowledge (digest)'));
});

// ---- unified Memory System variant (unification Phase 2) --------------------

test('knowledgeDigestRef swaps the Memory System section to the unified variant', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent', env: null,
    knowledgeDigestRef: 'knowledge-digest.md',
  });
  // The code-owned unified section replaces the base template's legacy one.
  assert.ok(md.includes(MEMORY_SECTION_UNIFIED));
  assert.ok(!md.includes('You maintain five files'));
  // Exactly one Memory System heading — the base copy must not leak through.
  const memHeadings = headings(md).filter((h) => h === 'Memory System');
  assert.equal(memHeadings.length, 1);
  // Semantic rerouting: facts/entities writes go to the KB, users.md stays private.
  assert.ok(md.includes('knowledge add fact|entity|convention'));
  assert.ok(md.includes('never shared'));
  assert.ok(md.includes('read-only legacy'));
});

test('without knowledgeDigestRef the base (legacy five-file) Memory System stays', () => {
  const md = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null });
  assert.ok(md.includes('You maintain five files'));
  assert.ok(!md.includes(MEMORY_SECTION_UNIFIED));
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

test('the injected Trigger-management block documents the loop trigger and its stop contract (#937)', () => {
  const auto = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null, autonomous: true });
  // The loop type and its distinguishing "repeat until" framing are present.
  assert.ok(auto.includes('**Loop (loop):**'));
  assert.ok(auto.includes('"type": "loop"'));
  // Stop-contract fields: maxIterations (required), until, maxTokens, verify + outcomes.
  assert.ok(auto.includes('`maxIterations` is **required**'));
  assert.ok(auto.includes('until.command'));
  assert.ok(auto.includes('maxTokens'));
  assert.ok(/done|exhausted|paused/.test(auto));
  // Separate-verifier ("don't grade your own work") rule.
  assert.ok(/Don't grade your own work/i.test(auto));
  assert.ok(auto.includes('selfGraded'));
  // A non-autonomous agent never sees any of it (no Trigger section at all).
  const dm = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null, autonomous: false });
  assert.ok(!dm.includes('**Loop (loop):**'));
});

test('interaction note gains the unattended-run framing only when autonomous', () => {
  assert.ok(!interactionNote(false).includes('unattended'));
  assert.ok(interactionNote(true).includes('unattended'));
  const dm = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null, autonomous: false });
  const auto = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: null, autonomous: true });
  assert.ok(!dm.includes('unattended on triggers'));
  assert.ok(auto.includes('unattended on triggers'));
});

test('Skills section is injected only when the resolved grant contains skills (team-owned, not env)', () => {
  const withSkills = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: {}, skills: ['cobol'] });
  const noSkills = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: {}, skills: [] });
  assert.ok(withSkills.includes('## Skills'));
  assert.ok(!noSkills.includes('## Skills'));
  // A legacy env.skills field no longer gates anything — the grant param does.
  const envOnly = assembleClaudeMd({ base: BASE, agentPrompt: 'x', role: 'agent', env: { skills: ['cobol'] } });
  assert.ok(!envOnly.includes('## Skills'));
});

// ---- Skills section enrichment (#617) --------------------------------------

test('Skills section lists each granted skill by name + its description, and keeps the SKILL.md guidance', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent', env: {},
    skills: ['cobol', 'jcl'],
    skillDescriptions: { cobol: 'Analyze COBOL programs.', jcl: 'Convert JCL jobs.' },
  });
  // AC3: the base "how skills work" guidance is preserved, not replaced.
  assert.ok(md.includes('Read the corresponding SKILL.md first.'));
  // AC3: still tells the agent to open the full SKILL.md before relying on one.
  assert.match(md, /open the full `skills\/<name>\/SKILL\.md`/);
  // AC1: name + description per granted skill.
  assert.match(md, /- \*\*cobol\*\* — Analyze COBOL programs\./);
  assert.match(md, /- \*\*jcl\*\* — Convert JCL jobs\./);
});

test('Skills section falls back to name-only for each fail-soft case (AC7)', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent', env: {},
    skills: ['has-desc', 'missing', 'empty'],
    // 'missing' has no entry at all; 'empty' resolved to an empty string.
    skillDescriptions: { 'has-desc': 'A described skill.', empty: '' },
  });
  assert.match(md, /- \*\*has-desc\*\* — A described skill\./);
  assert.match(md, /- \*\*missing\*\*$/m);
  assert.match(md, /- \*\*empty\*\*$/m);
});

test('empty grant emits no Skills section even with descriptions supplied (AC4)', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent', env: {},
    skills: [], skillDescriptions: { cobol: 'unused' },
  });
  assert.ok(!md.includes('## Skills'));
});

test('a multi-line description is normalized to a single collapsed line (AC8)', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent', env: {},
    skills: ['s'],
    skillDescriptions: { s: 'line one\n  line two\n\tline three' },
  });
  assert.match(md, /- \*\*s\*\* — line one line two line three/);
  assert.ok(!/line one\n/.test(md.split('## Skills')[1]));
});

test('assembleClaudeMd stays pure: descriptions come only from the caller (AC5)', () => {
  // No skillDescriptions supplied → every granted skill is name-only, no I/O.
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent', env: {}, skills: ['a', 'b'],
  });
  assert.match(md, /- \*\*a\*\*$/m);
  assert.match(md, /- \*\*b\*\*$/m);
  // No description separator inside the Skills section when none were supplied.
  const skillsPart = md.split('## Skills')[1];
  assert.ok(!skillsPart.includes(' — '));
});

test('skillsSection returns null for an empty grant and a section otherwise', () => {
  assert.equal(skillsSection('## Skills\n\nBase.', [], {}), null);
  const s = skillsSection('## Skills\n\nBase.', ['x'], { x: 'desc' });
  assert.ok(s.startsWith('## Skills'));
  assert.match(s, /- \*\*x\*\* — desc/);
});

// ---- parseSkillDescription (#617) ------------------------------------------

test('parseSkillDescription reads an inline description', () => {
  assert.equal(
    parseSkillDescription('---\nname: x\ndescription: Do the thing\n---\n# body'),
    'Do the thing',
  );
});

test('parseSkillDescription strips matching quotes', () => {
  assert.equal(parseSkillDescription('---\ndescription: "Quoted value"\n---\n'), 'Quoted value');
  assert.equal(parseSkillDescription("---\ndescription: 'single'\n---\n"), 'single');
});

test('parseSkillDescription collapses a folded (>-) block to one line', () => {
  const md = [
    '---',
    'name: agent-studio-dev',
    'description: >-',
    '  First sentence here',
    '  wraps across lines.',
    '  Second sentence.',
    'other: value',
    '---',
    '# Skill body',
  ].join('\n');
  assert.equal(
    parseSkillDescription(md),
    'First sentence here wraps across lines. Second sentence.',
  );
});

test('parseSkillDescription handles a plain multi-line (no indicator) value', () => {
  const md = '---\ndescription:\n  alpha\n  beta\nname: x\n---\n';
  assert.equal(parseSkillDescription(md), 'alpha beta');
});

test('parseSkillDescription returns null when there is no frontmatter, no key, or an empty value', () => {
  assert.equal(parseSkillDescription('# just a heading\nno frontmatter'), null);
  assert.equal(parseSkillDescription('---\nname: x\n---\n'), null);
  assert.equal(parseSkillDescription('---\ndescription:\nname: x\n---\n'), null);
  assert.equal(parseSkillDescription('---\ndescription: "  "\n---\n'), null);
  assert.equal(parseSkillDescription(''), null);
});

// ---- de-duplication (fix A) ------------------------------------------------

test('the /workspace path-translation rule appears exactly once (only in the CLAUDE.md Workspace section)', () => {
  const md = assembleClaudeMd({
    base: BASE, agentPrompt: 'x', role: 'agent',
    env: { repositories: [{ url: 'git@github.com:acme/x.git' }] }, skills: ['s'], autonomous: true,
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

test('workingEnvironmentSection renders repo + the granted skills and is empty for a bare env', () => {
  assert.equal(workingEnvironmentSection(null), '');
  assert.equal(workingEnvironmentSection({}), '');
  const s = workingEnvironmentSection({ name: 'E', repositories: [{ url: 'git@github.com:a/b.git' }] }, ['x']);
  assert.match(s, /## Working Environment/);
  assert.match(s, /cloned to `\.\/b\/`/);
  assert.match(s, /\*\*Skills:\*\* `x`/);
  // Skills come from the resolved grant, never from a legacy env.skills field.
  const legacy = workingEnvironmentSection({ name: 'E', skills: ['x'] });
  assert.ok(!/\*\*Skills:\*\*/.test(legacy));
  // A grant with no env still renders its skills.
  const grantOnly = workingEnvironmentSection(null, ['y']);
  assert.match(grantOnly, /\*\*Skills:\*\* `y`/);
});

test('envHasRepository / hasSkillGrant', () => {
  assert.equal(envHasRepository({ repositories: [{ url: 'x' }] }), true);
  assert.equal(envHasRepository({ repositories: [] }), false);
  assert.equal(envHasRepository(null), false);
  assert.equal(hasSkillGrant(['a']), true);
  assert.equal(hasSkillGrant([]), false);
  assert.equal(hasSkillGrant(null), false);
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

test('unified memory hint matches the Python runtime source (unification Phase 2)', () => {
  const py = fs.readFileSync(path.join(__dirname, '..', 'agent-image', 'scripts', 'agent-entrypoint.py'), 'utf8');
  const hint = buildMemoryHint(null, { unified: true });
  const fragments = [
    'Before responding, read your episodic memory files: memory/context.md and memory/log.md,',
    'and consult memory/users.md when the interaction involves a specific person.',
    'Semantic team knowledge (facts, entities, conventions) does not live in private memory files:',
    'the current team digest is already in your context via knowledge-digest.md, and anything',
    'When you learn something durable that would help ANY teammate (a project convention, an',
    'If the user asks you to remember something, route it: session state and personal or',
    'IMPORTANT: Your workspace root is the current working directory.',
  ];
  for (const frag of fragments) {
    assert.ok(hint.includes(frag), `JS unified hint should contain: ${frag}`);
    assert.ok(py.includes(frag), `Python runtime should contain: ${frag}`);
  }
  // The unified variant absorbs the knowledge-add routing — it must never name
  // facts.md/entities.md as write targets.
  assert.ok(!hint.includes('memory/facts.md'));
  assert.ok(!hint.includes('memory/entities.md'));
});

test('unified flag is ignored for blueprint instances', () => {
  const bpHint = buildMemoryHint('bp-x', { unified: true });
  assert.ok(bpHint.includes("instance of blueprint 'bp-x'"));
  assert.ok(!bpHint.includes('knowledge-digest.md'));
});

test('relocated sections are non-empty constants', () => {
  assert.ok(GIT_SECTION.startsWith('## GitHub Actions'));
  assert.ok(TRIGGER_SECTION.startsWith('## Trigger management'));
  assert.ok(WORKSPACE_SECTION.startsWith('## Workspace'));
});
