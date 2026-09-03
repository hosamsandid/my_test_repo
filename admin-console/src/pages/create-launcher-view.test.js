import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEntries,
  createdAgentDestination,
  CREATE_ENTRY_KEYS,
  entryByKey,
  hasForcedDefault,
  isSingleAgentFormOpen,
  SINGLE_AGENT_ROUTE,
} from './create-launcher-view.js';

// #1665's four intent tiles, in order. #1956 appended a fifth entry that is
// deliberately NOT an intent tile (see the AC7 test below).
const INTENT_KEYS = ['describe', 'template', 'build', 'chat'];

test('exposes the four equally-ranked intent entries in order, then the direct one (AC1)', () => {
  const entries = createEntries();
  assert.equal(entries.length, 5);
  assert.deepEqual(
    entries.map((e) => e.key),
    [...INTENT_KEYS, 'single-agent'],
  );
  assert.deepEqual(CREATE_ENTRY_KEYS, [...INTENT_KEYS, 'single-agent']);
});

test('no entry is a forced default (AC1 — D1 equal tiles)', () => {
  assert.equal(hasForcedDefault(), false);
  for (const e of createEntries()) {
    assert.ok(!('default' in e) || e.default !== true, `${e.key} must not be default`);
    assert.ok(!('primary' in e) || e.primary !== true, `${e.key} must not be primary`);
    assert.ok(
      !('recommended' in e) || e.recommended !== true,
      `${e.key} must not be recommended`,
    );
  }
});

test('every entry has a plain-language title/description and an icon + route', () => {
  for (const e of createEntries()) {
    assert.equal(typeof e.title, 'string');
    assert.ok(e.title.length > 0);
    assert.equal(typeof e.description, 'string');
    assert.ok(e.description.length > 0);
    assert.equal(typeof e.icon, 'string');
    assert.ok(e.icon.length > 0);
    assert.equal(typeof e.to, 'string');
    assert.ok(e.to.startsWith('/'));
  }
});

test('AC7 — the four intent tiles avoid the jargon words, the direct one names it', () => {
  // #1665 AC7 protects a first-time user CHOOSING BY INTENT: those four tiles
  // must be pickable without knowing the words agent / team / flow / template.
  // #1956's fifth entry is the deliberate exception — it is the "I know exactly
  // what I want" path, so naming the artifact is the whole point; called
  // anything vaguer it would be indistinguishable from the `chat` fast lane
  // right above it. The guard is narrowed to the intent tiles rather than
  // deleted, so the original rule still holds where it was aimed.
  const jargon = /\b(agent|team|flow|template|orchestrator)s?\b/i;
  for (const e of createEntries().filter((x) => INTENT_KEYS.includes(x.key))) {
    assert.ok(!jargon.test(e.title), `title for ${e.key} leaks jargon: ${e.title}`);
  }
  assert.match(entryByKey('single-agent').title, jargon);
});

test('each entry wires to the existing backend/flow route (AC3–AC6)', () => {
  // Describe → conversational creator (Flow Copilot on a fresh draft, AC3).
  assert.equal(entryByKey('describe').to, '/flows?new=describe');
  // From a ready-made setup → the template registry via the wizard (AC4).
  assert.equal(entryByKey('template').to, '/team-setup');
  // Build it yourself → blank draft in the Flows canvas (AC5).
  assert.equal(entryByKey('build').to, '/flows?new=blank');
  // Fast lane → the merged single-agent form from Phase A #1664 (AC6).
  assert.equal(entryByKey('chat').to, '/quickstart');
  // #1956 — the direct create form is a state OF the launcher, not a route of
  // its own, so `New Agent` in Agent Chat's header can hand over to plain
  // `/create` and still reach it.
  assert.equal(entryByKey('single-agent').to, SINGLE_AGENT_ROUTE);
  assert.match(SINGLE_AGENT_ROUTE, /^\/create\?/);
});

test('#1956 — the single-agent panel opens only on its own query param', () => {
  assert.equal(isSingleAgentFormOpen(SINGLE_AGENT_ROUTE.split('?')[1]), true);
  assert.equal(isSingleAgentFormOpen('?form=agent'), true);
  assert.equal(isSingleAgentFormOpen(new URLSearchParams('form=agent')), true);
  // Anything else leaves the launcher as it was.
  assert.equal(isSingleAgentFormOpen(''), false);
  assert.equal(isSingleAgentFormOpen(undefined), false);
  assert.equal(isSingleAgentFormOpen('?form=team'), false);
  assert.equal(isSingleAgentFormOpen('?other=agent'), false);
  assert.equal(isSingleAgentFormOpen({}), false);
});

test('#1956 — a created agent lands on its own chat, except a team (which has none)', () => {
  assert.equal(createdAgentDestination({ id: 'cobol-agent', role: 'agent' }), '/chats/cobol-agent');
  // An orchestrator does have a DM room of its own.
  assert.equal(createdAgentDestination({ id: 'omega', role: 'orchestrator' }), '/chats/omega');
  // A `team` agent hosts no chat — it is a prompt template plus a rail group
  // header — so deep-linking to it would drop the user on an empty chat.
  assert.equal(createdAgentDestination({ id: 'alpha', role: 'team' }), '/chats');
  // Never a broken URL when the response is thinner than expected.
  assert.equal(createdAgentDestination({ role: 'agent' }), '/chats');
  assert.equal(createdAgentDestination(null), '/chats');
  assert.equal(createdAgentDestination({ id: 'a b/c', role: 'agent' }), '/chats/a%20b%2Fc');
});

test('#1667 Phase D — fast-lane tile frames a single agent as a team of one (AC3/AC4)', () => {
  const chat = entryByKey('chat');
  assert.ok(chat, 'the explicit fast-lane entry still exists (AC4)');
  assert.equal(chat.to, '/quickstart', 'fast lane routes to the quickstart form (AC4)');
  // Consistent "a single agent is a team of one" language in the launcher (AC3).
  assert.match(chat.description, /team of one/i);
  // No launcher entry may re-introduce a forced up-front agent-vs-team choice (AC1).
  const forced = /\b(agent vs team|single agent vs team|choose (a )?(type|size)|which one)\b/i;
  for (const e of createEntries()) {
    assert.ok(
      !forced.test(e.description),
      `${e.key} description forces a mode choice: ${e.description}`,
    );
  }
});

test('entryByKey returns null for an unknown key and copies (no shared mutation)', () => {
  assert.equal(entryByKey('nope'), null);
  const a = entryByKey('describe');
  a.title = 'mutated';
  assert.notEqual(createEntries().find((e) => e.key === 'describe').title, 'mutated');
});
