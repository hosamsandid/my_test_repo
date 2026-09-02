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
  CONTEXT_KEYS,
  OVERLAY_SETTINGS,
  OVERLAY_SETUP_WIZARD,
  helpContextKeys,
  contextAlias,
  resolveHelpContext,
  contextLabel,
  panelZIndex,
  PANEL_Z_INDEX,
  PANEL_Z_INDEX_OVER_MODAL,
  upsertSubject,
  removeSubject,
  topSubject,
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

// ─── Non-route help contexts (E17 #1892) ─────────────────────────────────────

const CTX_PAYLOAD = {
  overviewId: 'overview',
  topics: [
    { id: 'overview', routes: [], title: 'Overview', summary: 'home', seeAlso: [], askPrompts: ['hi'], body: 'ov' },
    { id: 'agents', routes: ['/agents'], title: 'Agents', summary: 'a', seeAlso: [], askPrompts: ['qa'], body: 'ab' },
    { id: 'settings', routes: ['modal:settings'], title: 'Settings', summary: 's', seeAlso: [], askPrompts: ['qs'], body: 'sb' },
    { id: 'team-setup', routes: ['/team-setup'], title: 'Wizard', summary: 'w', seeAlso: [], askPrompts: ['qw'], body: 'wb' },
    { id: 'step-process', routes: ['/team-setup#process'], title: 'Step: Process', summary: 'p', seeAlso: [], askPrompts: ['qp'], body: 'pb' },
    { id: 'models', routes: ['/models'], title: 'Model Providers', summary: 'm', seeAlso: [], askPrompts: ['qm'], body: 'mb' },
  ],
};

test('helpContextKeys orders candidates most-specific-first', () => {
  assert.deepEqual(
    helpContextKeys({ route: '/team-setup', overlay: OVERLAY_SETTINGS, step: 'model' }),
    ['modal:settings#model', 'modal:settings', '/team-setup#model', '/team-setup'],
  );
  assert.deepEqual(helpContextKeys('/agents'), ['/agents']);
  assert.deepEqual(helpContextKeys({}), []);
});

test('AC1: an open overlay resolves to its own topic, closing it returns to the page', () => {
  const open = resolveHelpContext(CTX_PAYLOAD, { route: '/agents', overlay: OVERLAY_SETTINGS });
  assert.equal(open.topic.id, 'settings');
  assert.equal(open.key, 'modal:settings');
  assert.equal(resolveHelpContext(CTX_PAYLOAD, { route: '/agents' }).topic.id, 'agents');
});

test('AC1: an overlay with no topic of its own falls through to the page underneath', () => {
  const hit = resolveHelpContext(CTX_PAYLOAD, { route: '/agents', overlay: 'modal:unclaimed' });
  assert.equal(hit.topic.id, 'agents');
});

test('AC3: the active wizard step wins, and falls back to the wizard topic', () => {
  assert.equal(resolveHelpContext(CTX_PAYLOAD, { route: '/team-setup', step: 'process' }).topic.id, 'step-process');
  assert.equal(resolveHelpContext(CTX_PAYLOAD, { route: '/team-setup', step: 'review' }).topic.id, 'team-setup');
  assert.equal(resolveHelpContext(CTX_PAYLOAD, { route: '/wizard/team', step: 'process' }).topic.id, 'step-process');
});

test('AC2: a first-run wizard step resolves through its alias, with no duplicate prose', () => {
  assert.equal(contextAlias('wizard:setup#llm'), '/models');
  const hit = resolveHelpContext(CTX_PAYLOAD, { route: '/', overlay: OVERLAY_SETUP_WIZARD, step: 'llm' });
  assert.equal(hit.topic.id, 'models');
  assert.equal(hit.key, 'wizard:setup#llm');
  // /ssh-keys has no topic in this payload → nothing to show rather than empty.
  assert.equal(resolveHelpContext(CTX_PAYLOAD, { overlay: OVERLAY_SETUP_WIZARD, step: 'ssh-key' }), null);
});

test('pageHelpState takes a context object as well as a pathname, and reports the key', () => {
  const s = pageHelpState(CTX_PAYLOAD, { route: '/agents', overlay: OVERLAY_SETTINGS });
  assert.equal(s.topic.id, 'settings');
  assert.equal(s.isOverview, false);
  assert.equal(s.contextKey, 'modal:settings');
  const bare = pageHelpState(CTX_PAYLOAD, '/agents');
  assert.equal(bare.topic.id, 'agents');
  assert.equal(bare.contextKey, '/agents');
  const none = pageHelpState(CTX_PAYLOAD, '/nowhere');
  assert.equal(none.topic.id, 'overview');
  assert.equal(none.isOverview, true);
  assert.equal(none.contextKey, '');
});

test('contextLabel names a registered context and stays silent for a plain route', () => {
  assert.equal(contextLabel('modal:settings'), CONTEXT_KEYS['modal:settings'].label);
  assert.equal(contextLabel('/agents'), '');
  assert.equal(contextLabel('modal:invented'), '');
  assert.equal(contextLabel(''), '');
});

test('the panel is lifted above the modal layer only while an overlay is active', () => {
  assert.equal(panelZIndex({ route: '/agents' }), PANEL_Z_INDEX);
  assert.equal(panelZIndex({ route: '/agents', step: 'process' }), PANEL_Z_INDEX);
  assert.equal(panelZIndex({ route: '/agents', overlay: OVERLAY_SETTINGS }), PANEL_Z_INDEX_OVER_MODAL);
  assert.ok(PANEL_Z_INDEX_OVER_MODAL > 9999, 'a Modal sits at 9999 — help for it has to be above');
});

test('the subject stack hands help back to whatever published before', () => {
  let stack = upsertSubject([], 'wizard', { step: 'process' });
  assert.deepEqual(topSubject(stack), { overlay: '', step: 'process' });
  stack = upsertSubject(stack, 'settings', { overlay: OVERLAY_SETTINGS, step: 'model' });
  assert.deepEqual(topSubject(stack), { overlay: OVERLAY_SETTINGS, step: 'model' });
  stack = removeSubject(stack, 'settings');
  assert.deepEqual(topSubject(stack), { overlay: '', step: 'process' });
  assert.deepEqual(topSubject(removeSubject(stack, 'wizard')), { overlay: '', step: '' });
});

test('re-publishing a subject moves it to the top and never mutates the input', () => {
  const first = upsertSubject([], 'a', { step: 'one' });
  const both = upsertSubject(first, 'b', { overlay: OVERLAY_SETTINGS });
  const again = upsertSubject(both, 'a', { step: 'two' });
  assert.deepEqual(topSubject(again), { overlay: '', step: 'two' });
  assert.equal(again.length, 2, 'an id is never duplicated');
  assert.deepEqual(topSubject(both), { overlay: OVERLAY_SETTINGS, step: '' }, 'the input array is untouched');
});

test('an empty or id-less subject is not published at all', () => {
  assert.deepEqual(upsertSubject([], 'a', {}), []);
  assert.deepEqual(upsertSubject([], '', { step: 'x' }), []);
  assert.deepEqual(upsertSubject([], 'a', { overlay: '  ', step: '  ' }), []);
  assert.deepEqual(removeSubject(null, 'a'), []);
  assert.deepEqual(topSubject(null), { overlay: '', step: '' });
});

test('client CONTEXT_KEYS mirror the server help-routes.js copy', () => {
  assert.deepEqual(CONTEXT_KEYS, serverRoutes.CONTEXT_KEYS);
});

test('both copies build the same candidate list for every registered context', () => {
  const contexts = [
    { route: '/agents' },
    { route: '/agents', overlay: OVERLAY_SETTINGS, step: 'model' },
    { route: '/team-setup', step: 'process' },
    { route: '/wizard/team', step: 'process' },
    { route: '/', overlay: OVERLAY_SETUP_WIZARD, step: 'ssh-key' },
    { route: '/chats/agent-1' },
    {},
  ];
  for (const ctx of contexts) {
    assert.deepEqual(
      helpContextKeys(ctx), serverRoutes.helpContextKeys(ctx),
      `client and server disagree on the candidates for ${JSON.stringify(ctx)}`,
    );
  }
});
