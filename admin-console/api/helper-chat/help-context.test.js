'use strict';

// ─── Non-route help-context guard (E17 #1892, helper-chat-concept.md §3.2) ───
//
// `help-coverage.test.js` guarantees every *route* is classified. This file does
// the same job for the three surfaces that have no route at all — the Settings
// dialog, the first-run setup wizard, and a wizard step — so a context key can
// only be mistyped or orphaned on purpose:
//
//   • every key a shipped topic claims is registered in CONTEXT_KEYS,
//   • every key is well-formed and its base is something the system knows,
//   • every `alias` points at a real route,
//   • resolution is most-specific-first and falls back rather than emptying out.
//
// Every assertion that could go vacuous against the currently-correct topology is
// re-run over a synthetic input that proves it actually fires (the #1891 lesson:
// an assertion nobody has ever seen fail is not a guard).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTEXT_KEYS,
  OVERLAY_KEYS,
  KNOWN_ROUTE_PATHS,
  SINGLE_STEP_PAGES,
  PAGE_ROUTES,
  splitContextKey,
  isContextKey,
  isKnownHelpKey,
  helpContextKeys,
  contextAlias,
  classifyTopicKeys,
} = require('./help-routes');
const { loadRegistry, buildRegistry, loadTopics } = require('./help-registry');

const registry = loadRegistry();

// ── the topology itself ──────────────────────────────────────────────────────

test('every context key is well-formed and its base is known', () => {
  for (const key of Object.keys(CONTEXT_KEYS)) {
    assert.ok(isContextKey(key), `${key} is not a context key (a plain pathname belongs in PAGE_ROUTES)`);
    const [base, state] = splitContextKey(key);
    if (state) {
      assert.ok(
        KNOWN_ROUTE_PATHS.has(base) || Object.prototype.hasOwnProperty.call(OVERLAY_KEYS, base),
        `${key}: its base ${base} is neither a known route nor a registered overlay`,
      );
    } else {
      assert.match(base, /^[a-z]+:[a-z-]+$/, `${key}: an overlay key must look like <kind>:<name>`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(OVERLAY_KEYS, base),
        `${key} must also be described in OVERLAY_KEYS`,
      );
    }
    assert.ok(CONTEXT_KEYS[key].label, `${key} needs a label — the panel shows it as the "help for" line`);
  }
});

test('every OVERLAY_KEYS entry is also a CONTEXT_KEYS entry', () => {
  for (const key of Object.keys(OVERLAY_KEYS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(CONTEXT_KEYS, key), `${key} is described but not registered`);
  }
});

test('every alias points at a route the help system knows', () => {
  for (const key of Object.keys(CONTEXT_KEYS)) {
    const alias = contextAlias(key);
    if (!alias) continue;
    assert.ok(KNOWN_ROUTE_PATHS.has(alias), `${key} aliases ${alias}, which is not a classified route`);
    assert.ok(PAGE_ROUTES.has(alias), `${key} aliases ${alias}, which shows no help of its own`);
  }
});

test('isKnownHelpKey accepts routes and registered context keys, nothing else', () => {
  assert.ok(isKnownHelpKey('/agents'));
  assert.ok(isKnownHelpKey('modal:settings'));
  assert.ok(isKnownHelpKey('/team-setup#process'));
  assert.ok(!isKnownHelpKey('modal:invented'));
  assert.ok(!isKnownHelpKey('/team-setup#invented'));
  assert.ok(!isKnownHelpKey(''));
});

test('/quickstart is recorded as a single-step page, so it has no step keys', () => {
  // It is a one-page form, not a stepped wizard: its route topic IS its step
  // help. Recorded so a reader does not read the absence as an omission.
  assert.ok(SINGLE_STEP_PAGES.has('/quickstart'));
  const stepKeys = Object.keys(CONTEXT_KEYS).filter((k) => k.startsWith('/quickstart#'));
  assert.deepEqual(stepKeys, []);
});

// ── no topic may claim an unregistered key ───────────────────────────────────

test('every context key claimed by a shipped topic is registered', () => {
  const { unknown } = classifyTopicKeys(loadTopics());
  assert.deepEqual(
    unknown, [],
    `topics claim keys help-routes.js does not know: ${unknown.join(', ')} — `
    + 'register each in CONTEXT_KEYS (non-route) or PAGE_ROUTES (a real route).',
  );
});

test('AC4: classifyTopicKeys reports an invented key (the guard is not vacuous)', () => {
  const { unknown, contextKeys } = classifyTopicKeys([
    { id: 'a', routes: ['/agents', 'modal:settings'] },
    { id: 'b', routes: ['modal:typo', '/not-a-route'] },
  ]);
  assert.deepEqual(unknown, ['modal:typo', '/not-a-route']);
  assert.deepEqual(contextKeys, ['modal:settings', 'modal:typo']);
});

// ── candidate ordering ───────────────────────────────────────────────────────

test('helpContextKeys is most-specific-first: overlay, then step, then route', () => {
  assert.deepEqual(
    helpContextKeys({ route: '/team-setup', overlay: 'modal:settings', step: 'model' }),
    ['modal:settings#model', 'modal:settings', '/team-setup#model', '/team-setup'],
  );
});

test('helpContextKeys expands an alias route into both spellings', () => {
  assert.deepEqual(
    helpContextKeys({ route: '/wizard/team', step: 'process' }),
    ['/wizard/team#process', '/team-setup#process', '/wizard/team', '/team-setup'],
  );
});

test('helpContextKeys accepts a bare pathname and needs no subject', () => {
  assert.deepEqual(helpContextKeys('/agents'), ['/agents']);
  assert.deepEqual(helpContextKeys({ route: '/agents' }), ['/agents']);
  assert.deepEqual(helpContextKeys({}), []);
  assert.deepEqual(helpContextKeys(null), []);
});

test('helpContextKeys never repeats a key', () => {
  const keys = helpContextKeys({ route: '/agents', overlay: 'modal:settings', step: '' });
  assert.equal(new Set(keys).size, keys.length);
});

// ── resolution against the shipped topics ────────────────────────────────────

test('AC1: the open Settings dialog resolves to the Settings topic', () => {
  const hit = registry.resolveHelpContext({ route: '/agents', overlay: 'modal:settings' });
  assert.equal(hit?.topic?.id, 'settings');
  assert.equal(hit.key, 'modal:settings');
});

test('AC1: a Settings section with no topic of its own still lands on Settings', () => {
  const hit = registry.resolveHelpContext({ route: '/agents', overlay: 'modal:settings', step: 'display' });
  assert.equal(hit?.topic?.id, 'settings');
  assert.equal(hit.key, 'modal:settings', 'the section key falls back to the dialog key');
});

test('AC1: closing the dialog returns help to the page underneath', () => {
  const hit = registry.resolveHelpContext({ route: '/agents' });
  assert.equal(hit?.topic?.id, 'agents');
});

test('AC3: a wizard step with no step topic falls back to the wizard route topic', () => {
  // #1888 owns the wizard's topic content; whether it exists yet or not, a step
  // must never resolve to *less* than the route does.
  const step = registry.resolveHelpContext({ route: '/team-setup', step: 'process' });
  const route = registry.topicForRoute('/team-setup');
  assert.equal(step ? step.topic : null, route);
});

// ── resolution over fixtures (independent of which sibling PRs have landed) ───

const fixture = buildRegistry([
  { id: 'overview', routes: [], title: 'Overview', body: 'x' },
  { id: 'team-setup', routes: ['/team-setup'], title: 'Wizard', body: 'x' },
  { id: 'team-setup-process', routes: ['/team-setup#process'], title: 'Step: Process', body: 'x' },
  { id: 'models', routes: ['/models'], title: 'Model Providers', body: 'x' },
  { id: 'settings', routes: ['modal:settings'], title: 'Settings', body: 'x' },
]);

test('AC3: a step topic wins over the wizard route topic when one exists', () => {
  assert.equal(fixture.topicForContext({ route: '/team-setup', step: 'process' })?.id, 'team-setup-process');
  assert.equal(fixture.topicForContext({ route: '/team-setup', step: 'review' })?.id, 'team-setup');
  assert.equal(fixture.topicForContext({ route: '/wizard/team', step: 'process' })?.id, 'team-setup-process');
});

test('AC2: a first-run wizard step resolves through its alias to the page topic', () => {
  // No prose is duplicated for the wizard: `wizard:setup#llm` aliases /models.
  const hit = fixture.resolveHelpContext({ route: '/', overlay: 'wizard:setup', step: 'llm' });
  assert.equal(hit?.topic?.id, 'models');
  assert.equal(hit.key, 'wizard:setup#llm');
});

test('AC2: a first-run step whose aliased topic does not exist resolves to nothing', () => {
  // /ssh-keys is TOPIC_PENDING (#1884): the wizard shows no help box rather than
  // an empty one, and needs no change when that topic lands.
  const bare = buildRegistry([{ id: 'models', routes: ['/models'], title: 'M', body: 'x' }]);
  assert.equal(bare.topicForContext({ route: '/', overlay: 'wizard:setup', step: 'ssh-key' }), null);
});

test('an unknown context resolves to null (the caller shows the Overview)', () => {
  assert.equal(fixture.topicForContext({ route: '/nowhere', overlay: 'modal:nope' }), null);
  assert.equal(fixture.topicForContext({}), null);
});
