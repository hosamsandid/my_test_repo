import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAFT_KEY_PREFIX,
  draftKey,
  loadDraft,
  saveDraft,
  clearDraft,
  restoreUnsentText,
} from './message-draft.js';

// A minimal localStorage stand-in.
function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

test('draftKey follows the non-per-user agentChat.* convention', () => {
  assert.equal(draftKey('cobol-agent'), 'agentChat.draft.cobol-agent');
  assert.ok(draftKey('x').startsWith(DRAFT_KEY_PREFIX));
  // No username segment (contrast flows.lastSelected.<username>).
  assert.equal(DRAFT_KEY_PREFIX, 'agentChat.draft.');
});

test('loadDraft returns the stored draft for an agent', () => {
  const store = makeStore({ 'agentChat.draft.a': 'hello world' });
  assert.equal(loadDraft('a', store), 'hello world');
});

test('loadDraft returns empty string when nothing is stored (AC4 placeholder)', () => {
  const store = makeStore();
  assert.equal(loadDraft('a', store), '');
});

test('loadDraft returns empty string with no agentId or no store', () => {
  assert.equal(loadDraft('', makeStore({ 'agentChat.draft.': 'x' })), '');
  assert.equal(loadDraft(null, makeStore()), '');
  assert.equal(loadDraft('a', undefined), '');
});

test('saveDraft persists a non-empty draft under the per-agent key', () => {
  const store = makeStore();
  saveDraft('a', 'draft text', store);
  assert.equal(store._map.get('agentChat.draft.a'), 'draft text');
});

test('saveDraft never persists an empty / whitespace-only draft (AC4)', () => {
  const store = makeStore({ 'agentChat.draft.a': 'old' });
  saveDraft('a', '', store);
  assert.equal(store._map.has('agentChat.draft.a'), false);

  saveDraft('a', '   \n  ', store);
  assert.equal(store._map.has('agentChat.draft.a'), false);
});

test('saveDraft preserves interior whitespace of a real draft', () => {
  const store = makeStore();
  saveDraft('a', '  line one\n  line two  ', store);
  assert.equal(store._map.get('agentChat.draft.a'), '  line one\n  line two  ');
});

test('drafts are isolated per agent (AC3)', () => {
  const store = makeStore();
  saveDraft('a', 'hello', store);
  saveDraft('b', 'world', store);
  assert.equal(loadDraft('a', store), 'hello');
  assert.equal(loadDraft('b', store), 'world');
});

test('clearDraft removes only the given agent draft (AC2)', () => {
  const store = makeStore();
  saveDraft('a', 'hello', store);
  saveDraft('b', 'world', store);
  clearDraft('a', store);
  assert.equal(loadDraft('a', store), '');
  assert.equal(loadDraft('b', store), 'world');
});

test('saveDraft / clearDraft are no-ops without an agentId', () => {
  const store = makeStore({ 'agentChat.draft.a': 'keep' });
  saveDraft('', 'x', store);
  clearDraft(null, store);
  assert.equal(store._map.get('agentChat.draft.a'), 'keep');
});

test('storage failures are swallowed (best-effort)', () => {
  const throwing = {
    getItem() { throw new Error('nope'); },
    setItem() { throw new Error('nope'); },
    removeItem() { throw new Error('nope'); },
  };
  assert.equal(loadDraft('a', throwing), '');
  assert.doesNotThrow(() => saveDraft('a', 'x', throwing));
  assert.doesNotThrow(() => clearDraft('a', throwing));
});

test('does not touch the sendKeybinding key (AC5)', () => {
  const store = makeStore({ 'agentChat.sendKeybinding': 'chat' });
  saveDraft('a', 'hello', store);
  clearDraft('a', store);
  assert.equal(store._map.get('agentChat.sendKeybinding'), 'chat');
});

test('a refused send gives the typed text back to an empty composer (#2721 AC5)', () => {
  assert.equal(restoreUnsentText('', 'hello agent'), 'hello agent');
  assert.equal(restoreUnsentText('   ', 'hello agent'), 'hello agent');
});

test('a refused send never overwrites text typed since', () => {
  assert.equal(restoreUnsentText('new thought', 'hello agent'), 'new thought');
  assert.equal(restoreUnsentText('', ''), '');
});
