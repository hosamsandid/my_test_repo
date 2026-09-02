import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalRoute,
  normalizePageHelp,
  overviewTopic,
  resolvePageTopic,
  pageHelpState,
  hasDedicatedTopic,
  askHandoff,
  seeAlsoLinks,
  askPromptChips,
} from './page-help-view.js';

const PAYLOAD = {
  overviewId: 'overview',
  topics: [
    { id: 'overview', routes: [], title: 'Overview', summary: 'home', seeAlso: [{ label: 'Agents', to: '/agents' }], askPrompts: ['hi', 'hi', ' '], body: 'ov' },
    { id: 'agents', routes: ['/agents'], title: 'Agents', summary: 'a', seeAlso: [{ label: 'x' }, { to: '/teams' }], askPrompts: ['qa'], body: 'ab' },
    { id: 'flows', routes: ['/flows'], title: 'Flows', summary: 'f', seeAlso: [], askPrompts: ['qf'], body: 'fb' },
  ],
};

// ── canonicalRoute ─────────────────────────────────────────────────────────────

test('canonicalRoute collapses dynamic, alias and redirect routes', () => {
  assert.equal(canonicalRoute('/chats/agent-1'), '/chats');
  assert.equal(canonicalRoute('/wizard/team'), '/team-setup');
  assert.equal(canonicalRoute('/'), '/chats');
  assert.equal(canonicalRoute('/process/team-x'), '/flows');
  assert.equal(canonicalRoute('/plugins/foo/view'), null); // allowlisted viewer → no topic
  assert.equal(canonicalRoute('/agents'), '/agents');      // plain route unchanged
});

// ── normalize + overview ───────────────────────────────────────────────────────

test('normalizePageHelp accepts wrapped and bare-array shapes', () => {
  assert.deepEqual(normalizePageHelp({ topics: [1], overviewId: 'x' }), { topics: [1], overviewId: 'x' });
  assert.deepEqual(normalizePageHelp([1, 2]), { topics: [1, 2], overviewId: 'overview' });
  assert.deepEqual(normalizePageHelp(null), { topics: [], overviewId: 'overview' });
});

test('overviewTopic returns the Overview topic by id', () => {
  assert.equal(overviewTopic(PAYLOAD).id, 'overview');
});

// ── resolution + fallback ──────────────────────────────────────────────────────

test('resolvePageTopic resolves a route, its dynamic child, and null for no-topic', () => {
  assert.equal(resolvePageTopic(PAYLOAD, '/agents').id, 'agents');
  assert.equal(resolvePageTopic(PAYLOAD, '/flows').id, 'flows');
  assert.equal(resolvePageTopic(PAYLOAD, '/skills'), null);
});

test('pageHelpState falls back to Overview when a route has no topic', () => {
  const onAgents = pageHelpState(PAYLOAD, '/agents');
  assert.equal(onAgents.topic.id, 'agents');
  assert.equal(onAgents.isOverview, false);

  const onSkills = pageHelpState(PAYLOAD, '/skills');
  assert.equal(onSkills.topic.id, 'overview');
  assert.equal(onSkills.isOverview, true);
});

test('pageHelpState marks the overview route itself as isOverview', () => {
  // A route whose topic IS the overview topic still reads as overview.
  const payload = { overviewId: 'overview', topics: [
    { id: 'overview', routes: ['/'], title: 'Overview', askPrompts: ['q'], seeAlso: [], body: 'o' },
  ] };
  const st = pageHelpState(payload, '/');
  assert.equal(st.topic.id, 'overview');
  assert.equal(st.isOverview, true);
});

test('hasDedicatedTopic drives first-run auto-open eligibility', () => {
  assert.equal(hasDedicatedTopic(PAYLOAD, '/agents'), true);
  assert.equal(hasDedicatedTopic(PAYLOAD, '/skills'), false);
});

// ── hand-off + accessors ───────────────────────────────────────────────────────

test('askHandoff shapes the Ask hand-off with a trimmed question', () => {
  assert.deepEqual(askHandoff('  How do I add a trigger?  '), { mode: 'ask', question: 'How do I add a trigger?' });
  assert.deepEqual(askHandoff(null), { mode: 'ask', question: '' });
});

test('seeAlsoLinks drops entries without a destination', () => {
  const links = seeAlsoLinks(PAYLOAD.topics[1]); // agents: [{label:x}, {to:/teams}]
  assert.deepEqual(links, [{ label: '/teams', to: '/teams' }]);
});

test('askPromptChips de-duplicates and drops blanks', () => {
  assert.deepEqual(askPromptChips(PAYLOAD.topics[0]), ['hi']);
});
