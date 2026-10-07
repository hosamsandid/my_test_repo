'use strict';

// #2797 (follow-up to #2287): agent-facing steering must only name wake
// mechanisms the platform can actually deliver. The GitHub Events API never
// emits `check_suite` / `check_run` / `workflow_run` / `status`, so a
// `github-event` trigger on those keys never fires and an agent that follows
// such advice stalls. Likewise "wait for the next wake" stalls a claimed PR:
// with the wake label already swapped to `<wake>:wip`, no further wake comes.
// This guard scans every text an agent receives as instructions — the
// code-owned CLAUDE.md sections, the base CLAUDE.md templates, skills, and the
// shipped agent/process templates — so the dead advice cannot creep back in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const promptAssembly = require('./prompt-assembly');

const SKILL_POOL = path.join(__dirname, 'skill-pool');
const AGENT_IMAGE_CLAUDE_MD = path.join(__dirname, '..', 'agent-image', 'CLAUDE.md');

const DEAD_EVENT_KEYS = ['check_suite', 'check_run', 'workflow_run', 'status'];

// `check_suite` & co. have no legitimate place in steering at all. A bare
// `status` is ordinary prose, so it only counts as the event key when it is
// spelled as one (`status` / `status.<action>` in backticks or quotes).
const DEAD_PATTERNS = [
  /\b(check_suite|check_run|workflow_run)(\.\w+)?\b/,
  /[`"]status(\.\w+)?[`"]/,
  /\bnext wake\b/i,
];

function findDeadAdvice(text) {
  const hits = [];
  for (const re of DEAD_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20));
  }
  return hits;
}

function walkFiles(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p, ext));
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// Every string value in a JSON template, with its JSON path for the message.
function jsonStrings(node, at = '$', out = []) {
  if (typeof node === 'string') out.push([at, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => jsonStrings(v, `${at}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) jsonStrings(v, `${at}.${k}`, out);
  }
  return out;
}

function jsonTriggers(node, out = []) {
  if (Array.isArray(node)) node.forEach((v) => jsonTriggers(v, out));
  else if (node && typeof node === 'object') {
    if (Array.isArray(node.events)) out.push(node);
    Object.values(node).forEach((v) => jsonTriggers(v, out));
  }
  return out;
}

test('the guard patterns catch the dead advice they exist for', () => {
  assert.ok(findDeadAdvice('add a `github-event` trigger on `check_suite.completed`').length);
  assert.ok(findDeadAdvice('listen to "workflow_run" events').length);
  assert.ok(findDeadAdvice('a trigger on `status`').length);
  assert.ok(findDeadAdvice('If checks are pending, wait for the next wake.').length);
  // Ordinary prose and the working events stay clean.
  assert.deepEqual(findDeadAdvice('post a short status; use `pull_request.checks_passed`'), []);
});

test('the code-owned CLAUDE.md sections name no undeliverable event and no "next wake"', () => {
  const texts = [];
  for (const autonomous of [true, false]) {
    for (const hasRepository of [true, false]) {
      texts.push([`backgroundTasksSection(${autonomous}, ${hasRepository})`,
        promptAssembly.backgroundTasksSection(autonomous, hasRepository)]);
    }
  }
  for (const [name, value] of Object.entries(promptAssembly)) {
    if (typeof value === 'string') texts.push([name, value]);
  }
  const md = promptAssembly.assembleClaudeMd({
    base: fs.readFileSync(path.join(SKILL_POOL, 'CLAUDE.md'), 'utf8'),
    agentPrompt: 'x', role: 'agent', autonomous: true,
    env: { repositories: [{ url: 'git@github.com:o/r.git' }] },
  });
  texts.push(['assembleClaudeMd(autonomous, repo)', md]);
  for (const [name, text] of texts) {
    assert.deepEqual(findDeadAdvice(text), [], `${name} carries dead CI-wait steering`);
  }
});

test('the base CLAUDE.md templates and skills name no undeliverable event', () => {
  const files = [AGENT_IMAGE_CLAUDE_MD, ...walkFiles(SKILL_POOL, '.md')];
  for (const file of files) {
    const hits = findDeadAdvice(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(hits, [], `${path.relative(__dirname, file)} carries dead CI-wait steering`);
  }
});

test('shipped agent and process templates neither recommend nor wire an undeliverable event', () => {
  const files = [
    ...walkFiles(path.join(SKILL_POOL, 'agent-templates'), '.json'),
    ...walkFiles(path.join(SKILL_POOL, 'process-templates'), '.json'),
  ];
  assert.ok(files.length > 3, 'expected the shipped templates');
  for (const file of files) {
    const rel = path.relative(__dirname, file);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [at, text] of jsonStrings(doc)) {
      assert.deepEqual(findDeadAdvice(text), [], `${rel} ${at} carries dead CI-wait steering`);
    }
    for (const trigger of jsonTriggers(doc)) {
      for (const key of trigger.events) {
        const base = String(key).split('.')[0];
        assert.ok(!DEAD_EVENT_KEYS.includes(base), `${rel} trigger ${trigger.id} listens to undeliverable ${key}`);
      }
    }
  }
});

test('#2797: Merger and Code Reviewer hand a not-ready PR back instead of stalling on :wip', () => {
  const load = (f) => JSON.parse(fs.readFileSync(path.join(SKILL_POOL, 'process-templates', f), 'utf8'));
  const role = (doc, id) => doc.roles.find((r) => r.id === id);

  const merger = role(load('dispatched-sdlc.json'), 'merger');
  assert.match(merger.systemPrompt, /remove the `:wip` claim label/);
  assert.match(merger.systemPrompt, /re-apply `ready-to-merge`/);
  assert.match(merger.systemPrompt, /apply `revisions-required`/);
  const mergeWake = merger.triggers.find((t) => t.labelFilter === 'ready-to-merge');
  assert.ok(mergeWake.readinessGate, 'the merge wake relies on the hand-off gate');
  assert.match(mergeWake.prompt, /remove the `:wip` claim label/);

  for (const f of ['core-sdlc.json', 'dispatched-sdlc.json']) {
    const reviewer = role(load(f), 'code-reviewer');
    assert.match(reviewer.systemPrompt, /remove the `:wip` claim label/, f);
    assert.match(reviewer.systemPrompt, /re-apply `ready-for-review`/, f);
    assert.match(reviewer.systemPrompt, /apply `revisions-required`/, f);
    assert.ok(reviewer.channels.every((c) => c.readiness && c.readiness.ci), `${f}: reviewer wake is gated`);
  }
  const extReviewer = role(load('extended-sdlc.json'), 'code-reviewer');
  assert.match(extReviewer.systemPrompt, /`aee-wait-ci <n>` in the foreground/);
  assert.match(extReviewer.systemPrompt, /request changes naming the failing checks or the conflict/);
});
