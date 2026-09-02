import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  ALIASES,
  REDIRECTS,
  canonicalRoute,
  normalizePageHelp,
  overviewTopic,
  resolvePageTopic,
  pageHelpState,
  hasDedicatedTopic,
  askHandoff,
  seeAlsoLinks,
  askPromptChips,
  topicActions,
  seenRoutesKey,
  autoOpenRouteKey,
  autoOpenPlan,
  markSeen,
  parseSeenRoutes,
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

test('canonicalRoute sends the retired /getting-started bookmark to the app home', () => {
  // #1874: the page is gone; /chats has no dedicated topic, so the face lands on
  // the Overview that now carries the former Getting Started content.
  assert.equal(canonicalRoute('/getting-started'), '/chats');
  assert.equal(resolvePageTopic(PAYLOAD, '/getting-started'), null);
  assert.equal(pageHelpState(PAYLOAD, '/getting-started').isOverview, true);
  assert.equal(hasDedicatedTopic(PAYLOAD, '/getting-started'), false); // never auto-opens
});

// ── topicActions (#1874) ───────────────────────────────────────────────────────

test('topicActions normalizes navigation and tour CTAs, dropping unusable rows', () => {
  const topic = {
    actions: [
      { label: ' Create a single agent ', to: ' /quickstart ', primary: true },
      { label: 'Take the Tour', action: 'tour' },
      { label: 'Both given', to: '/models', action: 'tour' }, // `to` wins
      { label: 'No target' },
      { to: '/quickstart' },
      { label: 'Bad verb', action: 'wipe' },
      'not an object',
      null,
    ],
  };
  assert.deepEqual(topicActions(topic), [
    { label: 'Create a single agent', to: '/quickstart', action: '', primary: true },
    { label: 'Take the Tour', to: '', action: 'tour', primary: false },
    { label: 'Both given', to: '/models', action: '', primary: false },
  ]);
});

test('topicActions is empty for a topic without actions', () => {
  assert.deepEqual(topicActions(null), []);
  assert.deepEqual(topicActions({}), []);
  assert.deepEqual(topicActions({ actions: 'nope' }), []);
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

// ── first-run auto-open (#1873) ─────────────────────────────────────────────────

test('seenRoutesKey is per-user and collapses blank usernames to anon', () => {
  assert.equal(seenRoutesKey('alice'), 'help.seenRoutes.alice');
  assert.equal(seenRoutesKey('  bob  '), 'help.seenRoutes.bob');
  assert.equal(seenRoutesKey(''), 'help.seenRoutes.anon');
  assert.equal(seenRoutesKey(null), 'help.seenRoutes.anon');
  assert.equal(seenRoutesKey(undefined), 'help.seenRoutes.anon');
});

test('autoOpenRouteKey returns the canonical key for a topic route, null otherwise', () => {
  assert.equal(autoOpenRouteKey(PAYLOAD, '/agents'), '/agents');
  // dynamic child collapses to its canonical parent (which has a topic here? no —
  // /chats has no topic in PAYLOAD), so a route with no dedicated topic is null.
  assert.equal(autoOpenRouteKey(PAYLOAD, '/skills'), null);
  assert.equal(autoOpenRouteKey(PAYLOAD, '/chats/agent-1'), null);
});

test('autoOpenRouteKey collapses a dynamic child to its topic-bearing parent', () => {
  const payload = {
    overviewId: 'overview',
    topics: [
      { id: 'overview', routes: [], title: 'O', askPrompts: ['x'] },
      { id: 'flows', routes: ['/flows'], title: 'F', askPrompts: ['x'] },
    ],
  };
  // /process/:id collapses to /flows (a redirect/dynamic target with a topic).
  assert.equal(autoOpenRouteKey(payload, '/process/team-7'), '/flows');
});

test('autoOpenPlan opens once for an unseen topic route, then never again', () => {
  const first = autoOpenPlan(PAYLOAD, '/agents', []);
  assert.deepEqual(first, { open: true, routeKey: '/agents' });
  // Once seen, the same route no longer opens but still reports its key.
  const seen = markSeen([], first.routeKey);
  assert.deepEqual(autoOpenPlan(PAYLOAD, '/agents', seen), { open: false, routeKey: '/agents' });
});

test('autoOpenPlan never opens a route with no dedicated topic', () => {
  assert.deepEqual(autoOpenPlan(PAYLOAD, '/skills', []), { open: false, routeKey: null });
});

test('markSeen appends without mutating and de-duplicates', () => {
  const base = ['/agents'];
  const next = markSeen(base, '/flows');
  assert.deepEqual(next, ['/agents', '/flows']);
  assert.deepEqual(base, ['/agents']); // input untouched
  assert.deepEqual(markSeen(next, '/flows'), ['/agents', '/flows']); // idempotent
  assert.deepEqual(markSeen(['/x'], ''), ['/x']); // blank key is a no-op
  assert.deepEqual(markSeen(null, '/a'), ['/a']); // tolerates a non-array input
});

test('parseSeenRoutes is fail-soft over the raw localStorage value', () => {
  assert.deepEqual(parseSeenRoutes('["/a","/b"]'), ['/a', '/b']);
  assert.deepEqual(parseSeenRoutes('not json'), []);
  assert.deepEqual(parseSeenRoutes('{"a":1}'), []); // not an array
  assert.deepEqual(parseSeenRoutes('[1,"/b",null]'), ['/b']); // drops non-strings
  assert.deepEqual(parseSeenRoutes(''), []);
  assert.deepEqual(parseSeenRoutes(null), []);
});

// ── the two route-collapse copies must agree (E16 #1891) ──────────────────────
//
// This module's ALIASES/REDIRECTS/DYNAMIC maps are a deliberate duplication of
// admin-console/api/helper-chat/help-routes.js (the api image cannot import from
// src/, the browser cannot require CommonJS). Both sides were unit-tested, but
// nothing ever compared them — so an alias added on one side only would make the
// panel resolve one topic while the chat grounding resolved another, on exactly
// the routes the coverage guarantee is about. Read the CommonJS module here and
// diff them.

const serverRoutes = createRequire(import.meta.url)('../../api/helper-chat/help-routes.js');

test('client ALIASES mirror the server help-routes.js copy', () => {
  assert.deepEqual(ALIASES, serverRoutes.ALIASES);
});

test('client REDIRECTS mirror the server help-routes.js copy', () => {
  assert.deepEqual(REDIRECTS, serverRoutes.REDIRECTS);
});

test('both copies collapse every known route identically', () => {
  for (const route of [
    ...serverRoutes.KNOWN_ROUTE_PATHS,
    '/chats/release-manager',
    '/plugins/netzplan/view',
    '/process/team-x',
  ]) {
    assert.equal(
      canonicalRoute(route), serverRoutes.canonicalRoute(route),
      `client and server disagree on the canonical route for ${route}`,
    );
  }
});
