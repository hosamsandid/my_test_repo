import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEntries,
  CREATE_ENTRY_KEYS,
  entryByKey,
  hasForcedDefault,
} from './create-launcher-view.js';

test('exposes exactly the four equally-ranked entries in order (AC1)', () => {
  const entries = createEntries();
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((e) => e.key),
    ['describe', 'template', 'build', 'chat'],
  );
  assert.deepEqual(CREATE_ENTRY_KEYS, ['describe', 'template', 'build', 'chat']);
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

test('AC7 — titles avoid the jargon words agent/team/flow/template/orchestrator', () => {
  const jargon = /\b(agent|team|flow|template|orchestrator)s?\b/i;
  for (const e of createEntries()) {
    assert.ok(!jargon.test(e.title), `title for ${e.key} leaks jargon: ${e.title}`);
  }
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
