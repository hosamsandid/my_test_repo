'use strict';

// Unit tests for the context-help topic registry (#1872).
// Pure parsing + resolution over fixture topics, plus a load of the real
// help-topics/ dir to prove the pilot Overview topic parses end-to-end.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  parseTopic,
  buildRegistry,
  foldTopics,
  routeGroundingPointer,
  baselineTopic,
  baselineProblems,
  loadTopics,
  loadRegistry,
  OVERVIEW_ID,
} = require('./help-registry');

// ── front-matter parsing ──────────────────────────────────────────────────────

const SAMPLE = `---
id: agents
routes: ["/agents", "/agents/new"]
title: Agents
summary: One line under the title.
seeAlso:
  - { label: "Working Environments", to: "/environments" }
  - { label: "Access & Users", to: "/teams" }
askPrompts:
  - "What is the difference between an Agent and an Agent Team?"
  - "When should I disable vs delete an agent?"
---

## What is an agent?

An agent is a single AI worker.`;

test('parseTopic reads front-matter fields and body', () => {
  const t = parseTopic(SAMPLE, 'fallback');
  assert.equal(t.id, 'agents');
  assert.deepEqual(t.routes, ['/agents', '/agents/new']);
  assert.equal(t.title, 'Agents');
  assert.equal(t.summary, 'One line under the title.');
  assert.deepEqual(t.seeAlso, [
    { label: 'Working Environments', to: '/environments' },
    { label: 'Access & Users', to: '/teams' },
  ]);
  assert.equal(t.askPrompts.length, 2);
  assert.match(t.askPrompts[0], /difference between an Agent/);
  assert.match(t.body, /^## What is an agent\?/);
});

test('parseTopic falls back to the filename id and handles empty arrays', () => {
  const t = parseTopic('---\ntitle: X\nroutes: []\naskPrompts:\n  - "q"\n---\nbody', 'stem');
  assert.equal(t.id, 'stem');
  assert.deepEqual(t.routes, []);
});

test('parseTopic returns null without front-matter', () => {
  assert.equal(parseTopic('no front matter here', 'x'), null);
});

// ── `actions` CTAs (#1874) ────────────────────────────────────────────────────

test('parseTopic reads the actions block as navigation + panel-verb CTAs', () => {
  const t = parseTopic([
    '---',
    'id: overview',
    'title: Welcome',
    'actions:',
    '  - { label: "Create a single agent", to: "/quickstart", primary: true }',
    '  - { label: "Set up a team", to: "/team-setup" }',
    '  - { label: "Take the Tour", action: "tour" }',
    '---',
    'body',
  ].join('\n'), 'overview');
  assert.deepEqual(t.actions, [
    { label: 'Create a single agent', to: '/quickstart', action: '', primary: true },
    { label: 'Set up a team', to: '/team-setup', action: '' },
    { label: 'Take the Tour', to: '', action: 'tour' },
  ]);
});

test('parseTopic drops CTAs that could only render a dead button', () => {
  const t = parseTopic([
    '---',
    'id: x',
    'title: X',
    'actions:',
    '  - { to: "/quickstart" }',              // no label
    '  - { label: "Nowhere" }',               // neither to nor action
    '  - { label: "Bogus", action: "wipe" }', // unknown panel verb
    '  - plain string item',                  // not an object
    '  - { label: "Ok", to: "/models" }',
    '---',
    'body',
  ].join('\n'), 'x');
  assert.deepEqual(t.actions, [{ label: 'Ok', to: '/models', action: '' }]);
});

test('parseTopic defaults actions to an empty list and keeps other blocks intact', () => {
  const t = parseTopic(SAMPLE, 'fallback');
  assert.deepEqual(t.actions, []);
  assert.equal(t.seeAlso.length, 2); // the actions key does not disturb seeAlso
});

// ── route resolution (static / dynamic / alias / redirect) ────────────────────

function fixtureRegistry() {
  return buildRegistry([
    { id: OVERVIEW_ID, routes: [], title: 'Overview', summary: 'home', seeAlso: [], askPrompts: ['hi'], body: 'overview body' },
    { id: 'agents', routes: ['/agents'], title: 'Agents', summary: 'agents', seeAlso: [], askPrompts: ['a'], body: 'agents body' },
    { id: 'chat', routes: ['/chats'], title: 'Agent Chat', summary: 'chat', seeAlso: [], askPrompts: ['c'], body: 'chat body' },
    { id: 'team', routes: ['/team-setup'], title: 'Team Wizard', summary: 'team', seeAlso: [], askPrompts: ['t'], body: 'team body' },
    { id: 'flows', routes: ['/flows'], title: 'Flows', summary: 'flows', seeAlso: [], askPrompts: ['f'], body: 'flows body' },
  ]);
}

test('topicForRoute resolves a static route', () => {
  assert.equal(fixtureRegistry().topicForRoute('/agents').id, 'agents');
});

test('topicForRoute resolves a dynamic child route to its parent', () => {
  assert.equal(fixtureRegistry().topicForRoute('/chats/agent-42').id, 'chat');
});

test('topicForRoute resolves an alias route', () => {
  assert.equal(fixtureRegistry().topicForRoute('/wizard/team').id, 'team');
});

test('topicForRoute resolves a redirect source to its destination topic', () => {
  const reg = fixtureRegistry();
  assert.equal(reg.topicForRoute('/').id, 'chat');            // / → /chats
  assert.equal(reg.topicForRoute('/blueprints').id, 'agents'); // /blueprints → /agents
  assert.equal(reg.topicForRoute('/process/team-x').id, 'flows'); // dynamic redirect → /flows
});

test('topicForRoute returns null for a route with no topic (Overview fallback)', () => {
  assert.equal(fixtureRegistry().topicForRoute('/skills'), null);
  assert.equal(fixtureRegistry().topicForRoute('/plugins/foo/view'), null); // allowlisted viewer
});

test('registry exposes the overview topic by id', () => {
  assert.equal(fixtureRegistry().overview.id, OVERVIEW_ID);
});

// ── corpus fold + grounding ───────────────────────────────────────────────────

test('foldTopics concatenates titles, summaries and bodies', () => {
  const folded = foldTopics([
    { id: 'a', routes: ['/a'], title: 'A', summary: 'sa', body: 'body a' },
    { id: 'b', routes: [], title: 'B', summary: '', body: 'body b' },
  ]);
  assert.match(folded, /## A \(routes: \/a\)/);
  assert.match(folded, /sa/);
  assert.match(folded, /body a/);
  assert.match(folded, /## B\n/);
  assert.match(folded, /body b/);
});

test('routeGroundingPointer points at the resolved topic, empty otherwise', () => {
  const reg = fixtureRegistry();
  assert.match(routeGroundingPointer(reg, '/agents'), /help topic "Agents"/);
  assert.equal(routeGroundingPointer(reg, '/skills'), ''); // no topic → no pointer
  assert.equal(routeGroundingPointer(reg, undefined), '');
});

// ── baseline template (§3.4) ──────────────────────────────────────────────────

test('baselineTopic produces a valid what-it-is + key-tasks topic', () => {
  const t = baselineTopic({
    id: 'about', routes: ['/about'], title: 'About', summary: 'Version info.',
    keyTasks: ['Read the version', 'Check the licence'],
    askPrompts: ['What version am I on?'],
  });
  assert.equal(baselineProblems(t).length, 0);
  assert.match(t.body, /## What is About\?/);
  assert.match(t.body, /- Read the version/);
});

test('baselineTopic caps key tasks at three', () => {
  const t = baselineTopic({ id: 'x', title: 'X', keyTasks: ['1', '2', '3', '4'], askPrompts: ['q'] });
  assert.equal((t.body.match(/^- /gm) || []).length, 3);
});

test('baselineProblems flags a topic missing an askPrompt', () => {
  const problems = baselineProblems({ id: 'x', title: 'X', body: 'b', seeAlso: [], askPrompts: [] });
  assert.ok(problems.some((p) => /askPrompt/.test(p)));
});

test('baselineTopic requires id and title', () => {
  assert.throws(() => baselineTopic({ title: 'no id' }));
});

// ── real pilot topic loads end-to-end ─────────────────────────────────────────

test('the real help-topics dir loads and includes the Overview pilot', () => {
  const reg = loadRegistry(path.join(__dirname, 'help-topics'));
  assert.ok(reg.overview, 'the Overview topic must be present');
  assert.equal(reg.overview.id, OVERVIEW_ID);
  assert.ok(reg.overview.askPrompts.length > 0, 'Overview must carry askPrompts');
  assert.ok(reg.foldTopics().length > 0, 'topics must fold into a grounding block');
});

// G1 (#1874) folded the retired Getting Started page into the Overview face: the
// six concepts became its body/related links and the "where to go next" row plus
// the Take-the-Tour button became its CTAs. Guard both so the page's content
// cannot silently be lost now that the page itself is gone.
test('the Overview topic carries the former Getting Started concepts and CTAs', () => {
  const reg = loadRegistry(path.join(__dirname, 'help-topics'));
  const body = reg.overview.body;
  for (const concept of ['Agents', 'Access & Users', 'Flows', 'Working Environments', 'Knowledge', 'Model Providers']) {
    assert.match(body, new RegExp(`\\*\\*${concept.replace('&', '&')}\\*\\*`), `Overview body must explain ${concept}`);
  }
  const linked = reg.overview.seeAlso.map((s) => s.to);
  for (const to of ['/agents', '/teams', '/flows', '/environments', '/knowledge', '/models']) {
    assert.ok(linked.includes(to), `Overview must link to ${to}`);
  }
  const ctas = reg.overview.actions;
  assert.deepEqual(ctas.filter((c) => c.to).map((c) => c.to), ['/quickstart', '/team-setup', '/models']);
  assert.ok(ctas.some((c) => c.action === 'tour'), 'Overview must keep a Take-the-Tour CTA');
  assert.equal(ctas.filter((c) => c.primary).length, 1, 'exactly one CTA is the primary action');
});

test('loadTopics is fail-soft on a missing dir', () => {
  assert.deepEqual(loadTopics(path.join(__dirname, 'does-not-exist')), []);
});
