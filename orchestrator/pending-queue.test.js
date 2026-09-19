'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  entryKind,
  deriveLegacyId,
  withIds,
  removeEntryById,
  summarizeEntry,
  QUEUE_NOTE_PREVIEW_MAX,
} = require('./pending-queue');

test('entryKind classifies every queue entry shape', () => {
  assert.equal(entryKind({ github: { event: 'push' } }), 'github');
  assert.equal(entryKind({ kind: 'github-digest', events: [] }), 'github-digest');
  assert.equal(entryKind({ kind: 'throttle-warning' }), 'throttle-warning');
  assert.equal(entryKind({ kind: 'session-reset', roomId: '!r:x' }), 'session-reset');
  assert.equal(entryKind({ kind: 'session-set', roomId: '!r:x' }), 'session-set');
  assert.equal(entryKind({ triggerId: 'hook-1' }), 'trigger');
  assert.equal(entryKind({}), 'unknown');
  assert.equal(entryKind(null), 'unknown');
  assert.equal(entryKind('nope'), 'unknown');
});

test('withIds keeps stamped ids and backfills legacy entries deterministically', () => {
  const entries = [
    { id: 'abc', kind: 'session-reset' },
    { github: { event: 'push', eventId: '1' } },
  ];
  const first = withIds(entries);
  const second = withIds(entries);
  assert.equal(first[0].id, 'abc');
  assert.match(first[1].id, /^legacy-[0-9a-f]{16}$/);
  // Deterministic: same input → same derived id (so a view→cancel pair agrees).
  assert.equal(first[1].id, second[1].id);
  // Inputs are not mutated.
  assert.equal(entries[1].id, undefined);
});

test('withIds gives two byte-identical legacy entries distinct ids', () => {
  const dup = { github: { event: 'issues.labeled', repo: 'o/r', eventId: '9' } };
  const out = withIds([dup, { ...dup }]);
  assert.notEqual(out[0].id, out[1].id, 'occurrence index must disambiguate duplicates');
});

test('withIds tolerates corrupt / non-array input (AC10)', () => {
  assert.deepEqual(withIds(null), []);
  assert.deepEqual(withIds('garbage'), []);
  assert.deepEqual(withIds(undefined), []);
  // A stray non-object element still gets an id and doesn't throw.
  const out = withIds([42]);
  assert.match(out[0].id, /^legacy-/);
});

test('deriveLegacyId is stable and index-sensitive', () => {
  const e = { github: { eventId: '7' } };
  assert.equal(deriveLegacyId(e, 0), deriveLegacyId(e, 0));
  assert.notEqual(deriveLegacyId(e, 0), deriveLegacyId(e, 1));
});

test('removeEntryById removes one entry and preserves the rest in order (AC5)', () => {
  const entries = [
    { id: 'a', kind: 'session-reset' },
    { id: 'b', kind: 'throttle-warning' },
    { id: 'c', kind: 'session-set' },
  ];
  const { entries: next, removed, changed } = removeEntryById(entries, 'b');
  assert.equal(changed, true);
  assert.equal(removed.id, 'b');
  assert.deepEqual(next.map((e) => e.id), ['a', 'c']);
});

test('removeEntryById no-ops for an unknown id (AC7)', () => {
  const entries = [{ id: 'a' }, { id: 'b' }];
  const { entries: next, removed, changed } = removeEntryById(entries, 'zzz');
  assert.equal(changed, false);
  assert.equal(removed, null);
  assert.deepEqual(next.map((e) => e.id), ['a', 'b']);
});

test('removeEntryById can address and remove a legacy (un-stamped) entry', () => {
  const legacy = [{ github: { event: 'push', eventId: '1' } }, { kind: 'session-reset' }];
  const derivedId = withIds(legacy)[0].id;
  const { removed, changed, entries } = removeEntryById(legacy, derivedId);
  assert.equal(changed, true);
  assert.equal(removed.id, derivedId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'session-reset');
});

test('removeEntryById clearing the last entry yields a valid empty queue (AC8)', () => {
  const { entries: next, changed } = removeEntryById([{ id: 'only' }], 'only');
  assert.equal(changed, true);
  assert.deepEqual(next, []);
});

test('summarizeEntry exposes GitHub fields and omits the payload (AC4)', () => {
  const s = summarizeEntry({
    id: 'x', receivedAt: '2026-07-17T00:00:00Z', triggerId: 't1',
    github: { event: 'pull_request.opened', repo: 'o/r', actor: 'alice', eventId: '42', payload: { huge: 'x'.repeat(1000) } },
  });
  assert.equal(s.kind, 'github');
  assert.equal(s.event, 'pull_request.opened');
  assert.equal(s.repo, 'o/r');
  assert.equal(s.actor, 'alice');
  assert.equal(s.eventId, '42');
  assert.equal(s.triggerId, 't1');
  assert.equal('payload' in s, false, 'payload must never appear in the summary');
});

test('summarizeEntry lifts the label name for a *.labeled event, still omitting the payload (#1649)', () => {
  const s = summarizeEntry({
    id: 'x', receivedAt: '2026-08-12T00:00:00Z',
    github: {
      event: 'issues.labeled', repo: 'o/r', actor: 'alice', eventId: '9',
      payload: { label: { name: 'ready-2' }, issue: { number: 1 } },
    },
  });
  assert.equal(s.event, 'issues.labeled');
  assert.equal(s.label, 'ready-2');
  assert.equal('payload' in s, false, 'payload must never appear in the summary');
});

test('summarizeEntry omits label for a non-label github event (AC2/AC3)', () => {
  const s = summarizeEntry({
    id: 'y', github: { event: 'pull_request.opened', repo: 'o/r', eventId: '42', payload: { pull_request: {} } },
  });
  assert.equal('label' in s, false, 'no empty label artifact on a non-label event');
});

test('summarizeEntry degrades gracefully on a malformed payload.label', () => {
  const s = summarizeEntry({
    id: 'z', github: { event: 'issues.labeled', eventId: '3', payload: { label: {} } },
  });
  assert.equal('label' in s, false);
});

// ── #2151: the stamped wakeLabel wins over the collapsed payload label ─────

test('#2151: summarizeEntry prefers the stamped wakeLabel over a collapsed payload.label.name', () => {
  const s = summarizeEntry({
    id: 'x', receivedAt: '2026-09-10T00:00:00Z', wakeLabel: 'ready',
    github: {
      event: 'issues.labeled', repo: 'o/r', actor: 'alice', eventId: '9',
      payload: { label: { name: 'flow-control' }, issue: { number: 1 } },
    },
  });
  assert.equal(s.label, 'ready',
    "the label shown must be the one that woke this subscriber, not the collapsed attributed label");
});

test('#2151: summarizeEntry falls back to payload.label.name when wakeLabel is null (any-label listener)', () => {
  const s = summarizeEntry({
    id: 'x', wakeLabel: null,
    github: {
      event: 'issues.labeled', repo: 'o/r', eventId: '9',
      payload: { label: { name: 'ux' }, issue: { number: 1 } },
    },
  });
  assert.equal(s.label, 'ux');
});

test('#2151: summarizeEntry falls back to payload.label.name when the entry carries no wakeLabel stamp at all (pre-deploy entries)', () => {
  const s = summarizeEntry({
    id: 'x',
    github: {
      event: 'issues.labeled', repo: 'o/r', eventId: '9',
      payload: { label: { name: 'ready-2' }, issue: { number: 1 } },
    },
  });
  assert.equal(s.label, 'ready-2');
});

test('summarizeEntry surfaces per-kind hints for non-GitHub entries', () => {
  assert.equal(summarizeEntry({ id: 'd', kind: 'github-digest', count: 5, convKey: 'pr:1' }).count, 5);
  assert.equal(summarizeEntry({ id: 'd', kind: 'github-digest', events: [1, 2] }).count, 2);
  assert.equal(summarizeEntry({ id: 's', kind: 'session-set', roomId: '!r:x' }).roomId, '!r:x');
  assert.equal(summarizeEntry({ id: 'w', kind: 'throttle-warning', convKey: 'push:main' }).convKey, 'push:main');
});

// ── which PR/issue is waiting (#2101) ───────────────────────────────────────

test('summarizeEntry projects the work item of a PR entry, in the Processed tab shape (AC1)', () => {
  const s = summarizeEntry({
    id: 'p', github: {
      event: 'pull_request.labeled', repo: 'o/r', actor: 'alice', eventId: '14629937419',
      payload: {
        label: { name: 'revisions-required:completed' },
        pull_request: {
          number: 1907, title: 'Fix the drain',
          html_url: 'https://github.com/o/r/pull/1907', closesIssues: [1900],
        },
      },
    },
  });
  assert.deepEqual(s.workItem, {
    kind: 'pr', number: 1907, title: 'Fix the drain',
    url: 'https://github.com/o/r/pull/1907', closesIssues: [1900],
  });
});

test('summarizeEntry projects the work item of an issue entry (AC1)', () => {
  const s = summarizeEntry({
    id: 'i', github: {
      event: 'issues.labeled', repo: 'o/r', eventId: '9',
      payload: { label: { name: 'ready-6' }, issue: { number: 2101, title: 'Pending queue', html_url: 'https://github.com/o/r/issues/2101' } },
    },
  });
  assert.deepEqual(s.workItem, {
    kind: 'issue', number: 2101, title: 'Pending queue', url: 'https://github.com/o/r/issues/2101',
  });
});

test('summarizeEntry nulls the work item for an event that has none, rather than omitting it (AC1)', () => {
  // `push` / `release.published` carry no PR or issue. The key is always
  // present because "no work item" is a fact the row renders as `—`, not the
  // absence of a field a caller has to guess about.
  const s = summarizeEntry({ id: 'u', github: { event: 'push', repo: 'o/r', eventId: '1', payload: { ref: 'refs/heads/main' } } });
  assert.equal('workItem' in s, true);
  assert.equal(s.workItem, null);
});

test('summarizeEntry keeps the full github payload out of the list response (AC1)', () => {
  const entry = {
    id: 'p', github: {
      event: 'pull_request.opened', repo: 'o/r', eventId: '5',
      payload: { pull_request: { number: 7, title: 'T', body: 'x'.repeat(50000) }, huge: 'y'.repeat(50000) },
    },
  };
  const s = summarizeEntry(entry);
  assert.equal('payload' in s, false);
  assert.equal('github' in s, false);
  // Belt and braces: nothing large rode in on the new field either.
  assert.ok(JSON.stringify(s).length < 500, JSON.stringify(s).slice(0, 200));
});

test('summarizeEntry never throws on a malformed or absent payload while projecting a work item', () => {
  for (const payload of [undefined, null, {}, 'nope', { pull_request: 'not-an-object' }, { issue: {} }]) {
    const s = summarizeEntry({ id: 'x', github: { event: 'issues.opened', payload } });
    assert.equal(s.workItem, null, JSON.stringify(payload));
  }
});

test('a non-github kind carries no work item at all (AC4)', () => {
  for (const kind of ['github-digest', 'throttle-warning', 'session-reset', 'session-set', 'trigger', 'wake-agent']) {
    const s = summarizeEntry({ id: 'k', kind });
    assert.equal('workItem' in s, false, kind);
  }
});

test('AC2 — the pending projection and the event log share ONE extractor', () => {
  // Two copies of this extraction is exactly how "which PR is waiting" and
  // "which PR did we process" would come to disagree, so assert identity of the
  // function object rather than equality of two outputs.
  const workItem = require('./github-work-item');
  const eventLog = require('./github-event-log');
  assert.equal(eventLog.extractWorkItem, workItem.extractWorkItem);
});

test('AC2 — pending-queue.js stays free of fs, and so does the extractor it now requires', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['pending-queue.js', 'github-work-item.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(!/require\(['"](node:)?fs['"]\)/.test(src), `${file} requires fs`);
    assert.ok(!/\bfs\./.test(src.replace(/\/\/.*$/gm, '')), `${file} uses fs`);
  }
});

// ── direct agent-to-agent hand-off (#2032) ──────────────────────────────────

test('summarizeEntry projects a wake-agent hand-off (producer + note)', () => {
  const s = summarizeEntry({
    id: 'w1', kind: 'wake-agent', source: 'internal', receivedAt: '2026-09-07T10:00:00.000Z',
    from: 'team-developer', teamId: 'team', note: 'Look at the migration in step 3.',
  });
  assert.equal(s.kind, 'wake-agent');
  assert.equal(s.from, 'team-developer');
  assert.equal(s.note, 'Look at the migration in step 3.');
  assert.equal(s.receivedAt, '2026-09-07T10:00:00.000Z');
  // A hand-off carries no triggerId — the consumer resolves its own listener at
  // drain time — so projecting one would invent a field the entry never had.
  assert.equal('triggerId' in s, false);
});

test('summarizeEntry omits the note key when a hand-off carries none', () => {
  for (const note of [undefined, '', '   ']) {
    const s = summarizeEntry({ id: 'w', kind: 'wake-agent', from: 'a', note });
    assert.equal('note' in s, false, `note=${JSON.stringify(note)}`);
    assert.equal(s.from, 'a');
  }
});

test('summarizeEntry previews a long hand-off note instead of carrying it whole', () => {
  // The note is capped at 1024 code points at author AND delivery time, which
  // is a wall of text in a queue row; this projection exists to keep the list
  // small, and the full entry is one GET /internal/agents/:id/pending/:id away.
  const long = 'x'.repeat(400);
  const s = summarizeEntry({ id: 'w', kind: 'wake-agent', from: 'a', note: long });
  assert.ok(Array.from(s.note).length <= QUEUE_NOTE_PREVIEW_MAX + 1, 'preview is bounded');
  assert.ok(s.note.endsWith('…'), 'a cut note says it was cut');
  assert.notEqual(s.note, long);
});

test('summarizeEntry cuts a hand-off note preview in code points', () => {
  // Same surrogate hazard as clampNote: `String#slice` can land between a
  // surrogate pair, and a lone surrogate is not encodable as UTF-8 — here it
  // would be JSON-serialized into the API response as a replacement char.
  for (const pad of [0, 1, 2, 3]) {
    const note = 'a'.repeat(118 + pad) + '😀'.repeat(10);
    const s = summarizeEntry({ id: 'w', kind: 'wake-agent', from: 'a', note });
    assert.deepEqual(Buffer.from(s.note, 'utf8').toString('utf8'), s.note, `pad=${pad}`);
    for (const ch of s.note) {
      const cp = ch.codePointAt(0);
      assert.ok(cp < 0xd800 || cp > 0xdfff, `pad=${pad}: lone surrogate`);
    }
  }
});

test('a malformed hand-off entry degrades rather than throwing', () => {
  const s = summarizeEntry({ id: 'w', kind: 'wake-agent', from: 42, note: { nope: 1 } });
  assert.equal(s.from, null);
  assert.equal('note' in s, false);
});

test('entryKind classifies a wake-agent entry from its explicit kind', () => {
  assert.equal(entryKind({ kind: 'wake-agent', from: 'a' }), 'wake-agent');
});

test('summarizeEntry projects a plugin-event entry (plugin, event, summary, triggerId) and omits the payload', () => {
  const s = summarizeEntry({
    id: 'p1', kind: 'plugin-event', source: 'internal-plugin', pluginId: 'jira', event: 'status_changed',
    summary: 'KAN-6 → Ready for Dev', eventId: 'e-1', triggerId: 'on-jira-ready',
    payload: { issue: { key: 'KAN-6' } }, receivedAt: '2026-09-15T10:00:00Z',
  });
  assert.equal(s.kind, 'plugin-event');
  assert.equal(s.pluginId, 'jira');
  assert.equal(s.event, 'status_changed');
  assert.equal(s.summary, 'KAN-6 → Ready for Dev');
  assert.equal(s.triggerId, 'on-jira-ready');
  assert.equal('payload' in s, false);
  // Optional fields degrade to null / absent rather than throwing.
  const bare = summarizeEntry({ id: 'p2', kind: 'plugin-event' });
  assert.equal(bare.pluginId, null);
  assert.equal(bare.event, null);
  assert.equal('summary' in bare, false);
});
