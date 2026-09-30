'use strict';

// Unit tests for the direct agent-to-agent hand-off core (#2030).
// Run: node --test orchestrator/wake-agent.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WAKE_NOTE_MAX,
  WAKE_NOTE_TRUNCATION_MARK,
  WAKE_REFUSALS,
  WAKE_EVENT_KEY,
  clampNote,
  validateWakeRequest,
  resolveWakeTarget,
  buildWakeEntry,
  buildWakeLogEvent,
  buildWakeLogFields,
} = require('./wake-agent');

// ── validateWakeRequest ────────────────────────────────────────────────────

test('validateWakeRequest: accepts a well-formed target-less request', () => {
  const r = validateWakeRequest({ fromAgentId: 'acme-dev', toAgentId: 'acme-reviewer' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { fromAgentId: 'acme-dev', toAgentId: 'acme-reviewer' });
});

test('validateWakeRequest: carries a note and trims the ids', () => {
  const r = validateWakeRequest({
    fromAgentId: '  acme-dev ', toAgentId: ' acme-reviewer',
    note: 'Look closely at the migration in step 3.',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    fromAgentId: 'acme-dev', toAgentId: 'acme-reviewer',
    note: 'Look closely at the migration in step 3.',
  });
});

test('validateWakeRequest: rejects malformed requests', () => {
  const bad = [
    [null, /body must be an object/],
    [[], /body must be an object/],
    [{}, /fromAgentId/],
    [{ fromAgentId: '   ' }, /fromAgentId/],
    [{ fromAgentId: 'a' }, /toAgentId/],
    [{ fromAgentId: 'a', toAgentId: '' }, /toAgentId/],
    [{ fromAgentId: 'a', toAgentId: 'b', note: 42 }, /note must be a string/],
    [{ fromAgentId: 'a', toAgentId: 'b', note: { text: 'x' } }, /note must be a string/],
  ];
  for (const [body, re] of bad) {
    const r = validateWakeRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, re, JSON.stringify(body));
  }
});

test('validateWakeRequest: a request body carries no repo, label or work item', () => {
  // The whole point of the endpoint (§5): target-LESS. A caller that sends
  // label hand-off fields (repo/label/target) must not have them silently
  // honoured here.
  const r = validateWakeRequest({
    fromAgentId: 'a', toAgentId: 'b',
    repo: 'org/repo', label: 'ready', target: { kind: 'issue', number: 7 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value).sort(), ['fromAgentId', 'toAgentId']);
});

test('validateWakeRequest: a whitespace-only note is dropped, not carried empty', () => {
  const r = validateWakeRequest({ fromAgentId: 'a', toAgentId: 'b', note: '   \n ' });
  assert.equal(r.ok, true);
  assert.equal('note' in r.value, false);
});

// ── the note cap (§4.1 / §5.3, the second half of the untrusted-note defence) ─

test('clampNote: passes a short note through untouched', () => {
  assert.equal(clampNote('one sentence'), 'one sentence');
  assert.equal(clampNote('x'.repeat(WAKE_NOTE_MAX)).length, WAKE_NOTE_MAX);
  assert.equal(clampNote('x'.repeat(WAKE_NOTE_MAX)).includes(WAKE_NOTE_TRUNCATION_MARK), false);
});

test('clampNote: truncates an over-long note WITH a marker rather than rejecting it', () => {
  const out = clampNote('x'.repeat(WAKE_NOTE_MAX + 500));
  assert.equal(out.length, WAKE_NOTE_MAX);
  assert.ok(out.endsWith(WAKE_NOTE_TRUNCATION_MARK),
    'truncation must be explicit — a silently shortened note reads as a complete thought');
});

test('validateWakeRequest: re-clamps the note at DELIVERY, not just at authoring', () => {
  // `aee-wake` can be run by hand with any --note, so the author-time cap in
  // admin-console/api/outcomes.js cannot be the only one.
  const r = validateWakeRequest({
    fromAgentId: 'a', toAgentId: 'b', note: 'y'.repeat(WAKE_NOTE_MAX * 3),
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.note.length, WAKE_NOTE_MAX);
  assert.ok(r.value.note.endsWith(WAKE_NOTE_TRUNCATION_MARK));
});

// ── resolveWakeTarget ──────────────────────────────────────────────────────

const team = (id, teamId, extra = {}) =>
  ({ agentId: id, config: { parentTeamId: teamId, ...extra } });

const ACME = [
  team('acme-dev', 'acme'),
  team('acme-reviewer', 'acme'),
  team('other-dev', 'other'),
];

test('resolveWakeTarget: resolves a same-team peer', () => {
  const r = resolveWakeTarget({ fromAgentId: 'acme-dev', toRoleId: 'acme-reviewer' }, ACME);
  assert.deepEqual(r, { ok: true, agentId: 'acme-reviewer', teamId: 'acme' });
});

test('resolveWakeTarget: an unknown target is unknown-target (404), never a silent no-op', () => {
  const r = resolveWakeTarget({ fromAgentId: 'acme-dev', toRoleId: 'nobody' }, ACME);
  assert.deepEqual(r, { ok: false, reason: 'unknown-target' });
  assert.equal(WAKE_REFUSALS['unknown-target'], 404);
});

test('resolveWakeTarget: a cross-team target is refused (403)', () => {
  const r = resolveWakeTarget({ fromAgentId: 'acme-dev', toRoleId: 'other-dev' }, ACME);
  assert.deepEqual(r, { ok: false, reason: 'cross-team' });
  assert.equal(WAKE_REFUSALS['cross-team'], 403);
});

test('resolveWakeTarget: targeting yourself is refused before the team check', () => {
  const r = resolveWakeTarget({ fromAgentId: 'acme-dev', toRoleId: 'acme-dev' }, ACME);
  assert.deepEqual(r, { ok: false, reason: 'self-target' });
  assert.equal(WAKE_REFUSALS['self-target'], 403);
});

test('resolveWakeTarget: an unresolvable team on either end refuses — unknown is not "same"', () => {
  const agents = [
    { agentId: 'lonely', config: {} },
    team('acme-reviewer', 'acme'),
    { agentId: 'also-lonely', config: {} },
  ];
  assert.deepEqual(
    resolveWakeTarget({ fromAgentId: 'lonely', toRoleId: 'acme-reviewer' }, agents),
    { ok: false, reason: 'no-team' });
  assert.deepEqual(
    resolveWakeTarget({ fromAgentId: 'acme-reviewer', toRoleId: 'lonely' }, agents),
    { ok: false, reason: 'no-team' });
  // Both team-less: still refused, so two standalone agents cannot silently
  // read as one team.
  assert.deepEqual(
    resolveWakeTarget({ fromAgentId: 'lonely', toRoleId: 'also-lonely' }, agents),
    { ok: false, reason: 'no-team' });
});

test('resolveWakeTarget: falls back to teamId when parentTeamId is absent', () => {
  // The platform idiom is `parentTeamId || teamId || null` — a standalone agent
  // carries only `teamId`.
  const agents = [
    { agentId: 'solo-a', config: { teamId: 'acme' } },
    { agentId: 'solo-b', config: { teamId: 'acme' } },
  ];
  const r = resolveWakeTarget({ fromAgentId: 'solo-a', toRoleId: 'solo-b' }, agents);
  assert.deepEqual(r, { ok: true, agentId: 'solo-b', teamId: 'acme' });
});

test('resolveWakeTarget: a missing/odd agents list refuses rather than throwing', () => {
  for (const agents of [undefined, null, [], [null], [{}], 'nope']) {
    const r = resolveWakeTarget({ fromAgentId: 'a', toRoleId: 'b' }, agents);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-target');
  }
});

test('resolveWakeTarget: an unreadable target config resolves to no-team, not a crash', () => {
  // loadAgentConfig returns null for a residue dir; the target exists but has
  // no resolvable team, which must refuse rather than throw.
  const agents = [team('acme-dev', 'acme'), { agentId: 'broken', config: null }];
  assert.deepEqual(
    resolveWakeTarget({ fromAgentId: 'acme-dev', toRoleId: 'broken' }, agents),
    { ok: false, reason: 'no-team' });
});

test('every refusal reason maps to a distinct-enough HTTP status', () => {
  // aee-wake maps any rejection to exit 1; the statuses still have to be the
  // documented 404/403 so an operator reading the log can tell them apart.
  assert.deepEqual(Object.keys(WAKE_REFUSALS).sort(),
    ['cross-team', 'no-team', 'self-target', 'unknown-target']);
  for (const status of Object.values(WAKE_REFUSALS)) {
    assert.ok(status === 403 || status === 404, `unexpected status ${status}`);
  }
});

// ── buildWakeEntry ─────────────────────────────────────────────────────────

test('buildWakeEntry: the kind is what routes it through _execute', () => {
  const e = buildWakeEntry({ from: 'acme-dev', note: 'check step 3', teamId: 'acme' });
  assert.deepEqual(e, {
    kind: 'wake-agent',
    source: 'internal',
    from: 'acme-dev',
    note: 'check step 3',
    teamId: 'acme',
  });
});

test('buildWakeEntry: omits an absent/blank note and teamId', () => {
  assert.deepEqual(buildWakeEntry({ from: 'acme-dev' }),
    { kind: 'wake-agent', source: 'internal', from: 'acme-dev' });
  assert.deepEqual(buildWakeEntry({ from: 'acme-dev', note: '  ' }),
    { kind: 'wake-agent', source: 'internal', from: 'acme-dev' });
});

test('buildWakeEntry: carries no triggerId — the consumer looks its own listener up', () => {
  // The producer cannot know the consumer's trigger id. If this ever grew one,
  // _execute_wake_agent's lookup would silently become a pin.
  const e = buildWakeEntry({ from: 'acme-dev', teamId: 'acme' });
  assert.equal('triggerId' in e, false);
});

// ── buildWakeLogEvent ──────────────────────────────────────────────────────

test('buildWakeLogEvent: attributes the producer and names the target', () => {
  const ev = buildWakeLogEvent({
    producerId: 'acme-dev', targetId: 'acme-reviewer', note: 'check step 3',
    eventId: 'wake:abc123', now: '2026-09-07T10:00:00.000Z',
  });
  assert.equal(ev.id, 'wake:abc123');
  assert.equal(ev.actor.login, 'agent:acme-dev');
  assert.equal(ev.created_at, '2026-09-07T10:00:00.000Z');
  assert.equal(ev.payload.action, 'wake');
  assert.equal(ev.payload.to, 'acme-reviewer');
  assert.equal(ev.payload.note, 'check step 3');
});

test('buildWakeLogEvent: invents no repo, no label and no work item', () => {
  // buildEventEntry is GitHub-event-shaped; those columns must render `—`
  // honestly rather than carry a plausible-looking lie.
  const ev = buildWakeLogEvent({
    producerId: 'acme-dev', targetId: 'acme-reviewer',
    eventId: 'wake:abc123', now: '2026-09-07T10:00:00.000Z',
  });
  assert.equal(ev.repo.name, null);
  assert.equal('label' in ev.payload, false);
  assert.equal('issue' in ev.payload, false);
  assert.equal('pull_request' in ev.payload, false);
  assert.equal('note' in ev.payload, false);
});

test('the event key is a dedicated handoff key, not a GitHub event type', () => {
  assert.equal(WAKE_EVENT_KEY, 'handoff.wake');
  assert.ok(!WAKE_EVENT_KEY.includes('.labeled'),
    'a hand-off must not masquerade as a label event in the transparency log');
});

// ── the buildEventEntry integration the route depends on ───────────────────

test('a wake row survives buildEventEntry without throwing or faking a work item', () => {
  const { buildEventEntry } = require('./github-event-log');
  const row = buildEventEntry({
    ghEvent: buildWakeLogEvent({
      producerId: 'acme-dev', targetId: 'acme-reviewer', note: 'n',
      eventId: 'wake:abc123', now: '2026-09-07T10:00:00.000Z',
    }),
    repoFullName: null,
    key: WAKE_EVENT_KEY,
    outcomes: [{ agentId: 'acme-reviewer', triggerId: null, status: 'delivered', reason: null, digest: false }],
  });
  assert.equal(row.event, 'handoff.wake');
  assert.equal(row.repo, null);
  assert.equal(row.label, null);
  assert.equal(row.ref, null);
  assert.equal(row.workItem, null);
  assert.equal(row.noMatchingTrigger, false);
  assert.equal(row.outcomes[0].agentId, 'acme-reviewer');
});

// ── the note cap must not split a character ────────────────────────────────

test('clampNote counts CODE POINTS, so an astral note is not cut short', () => {
  // 1024 emoji is 1024 characters, but 2048 UTF-16 code units. A length check
  // in code units would truncate a note that legitimately fits.
  const note = '😀'.repeat(WAKE_NOTE_MAX);
  assert.equal(clampNote(note), note);
});

test('clampNote never emits a lone surrogate', () => {
  // A cut between a surrogate pair yields a lone surrogate, which is not
  // encodable as UTF-8: written to the Claude CLI's stdin it raises, the write
  // error is swallowed, the pipe is never closed and the consumer's run hangs
  // while holding the workspace gate.
  for (const pad of [0, 1, 2, 3]) {
    const note = 'a'.repeat(1010 + pad) + '😀'.repeat(20);
    const out = clampNote(note);
    assert.ok(Array.from(out).length <= WAKE_NOTE_MAX, `pad=${pad}`);
    assert.deepEqual(Buffer.from(out, 'utf8').toString('utf8'), out,
      `pad=${pad}: the clamped note must survive a UTF-8 round trip`);
    for (const ch of out) {
      const cp = ch.codePointAt(0);
      assert.ok(cp < 0xd800 || cp > 0xdfff, `pad=${pad}: lone surrogate U+${cp.toString(16)}`);
    }
  }
});

test('validateWakeRequest inherits the code-point-safe clamp', () => {
  const r = validateWakeRequest({
    fromAgentId: 'a', toAgentId: 'b', note: 'a'.repeat(1015) + '😀'.repeat(20),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(Buffer.from(r.value.note, 'utf8').toString('utf8'), r.value.note);
  assert.ok(Array.from(r.value.note).length <= WAKE_NOTE_MAX);
});

// ── the event-log fields the GitHub-shaped entry has no slot for (#2032) ─────

test('buildWakeLogFields carries the pair and the note', () => {
  const f = buildWakeLogFields({
    producerId: 'team-developer', targetId: 'team-code-reviewer',
    note: 'Look closely at the migration in step 3.',
  });
  assert.deepEqual(f, {
    handoff: {
      from: 'team-developer',
      to: 'team-code-reviewer',
      note: 'Look closely at the migration in step 3.',
    },
  });
});

test('buildWakeLogFields omits an absent or blank note', () => {
  // The note is optional (§13 Q3), so the field must be ABSENT rather than an
  // empty string: the Title cell renders `—` on a falsy value either way, but
  // an empty string would filter and sort as content.
  for (const note of [undefined, '', '   ', null]) {
    const f = buildWakeLogFields({ producerId: 'a', targetId: 'b', note });
    assert.equal('note' in f.handoff, false, `note=${JSON.stringify(note)}`);
    assert.deepEqual(f, { handoff: { from: 'a', to: 'b' } });
  }
});

test('buildWakeLogFields rides ALONGSIDE buildEventEntry, not inside it', () => {
  // The regression this guards: `buildEventEntry` extracts only GitHub's own
  // vocabulary (label / ref / workItem), so a note left in the synthesized
  // payload never reaches the log and the row is a dash.
  const ghEvent = buildWakeLogEvent({
    producerId: 'a', targetId: 'b', note: 'hi', eventId: 'wake:1',
    now: '2026-09-07T00:00:00.000Z',
  });
  assert.equal(ghEvent.payload.note, 'hi', 'the synthesized payload still carries it');
  const fields = buildWakeLogFields({ producerId: 'a', targetId: 'b', note: 'hi' });
  assert.equal(fields.handoff.note, 'hi');
  assert.equal(fields.handoff.from, 'a');
  assert.equal(fields.handoff.to, 'b');
});
