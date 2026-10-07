'use strict';

// Flow Copilot × hand-off readiness gate (#2915).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  listHandoffs, findConflictSolver, describeHandoffGates,
  readinessRefusal, normalizeHandoffGates, conflictSolverHint,
} = require('./flow-copilot-readiness');
const { runCopilot, buildCopilotRequest } = require('./flow-copilot');
const { validateProcessTemplate } = require('./process-template');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'flow-copilot.fixture.json'), 'utf8'));
const fixture = () => JSON.parse(JSON.stringify(FIXTURE));
const role = (b, id) => b.roles.find(r => r.id === id);

// The fixture plus a conflict solver woken by `needs-conflict-resolution`.
function withSolver() {
  const b = fixture();
  b.labels.push({ name: 'needs-conflict-resolution', humanGate: false, brake: false });
  b.roles.push({
    id: 'conflict-solver', displayName: 'Conflict Solver', sessionPolicy: 'per-invocation',
    systemPrompt: 'You resolve merge conflicts on pull requests, then hand them back for review.',
    triggers: [{
      id: 'conflict-solver-on-needs-conflict-resolution', type: 'github-event', enabled: true,
      events: ['pull_request.labeled'], labelFilter: 'needs-conflict-resolution',
      claim: { remove: 'needs-conflict-resolution', add: 'needs-conflict-resolution:wip' },
      prompt: 'Resolve the conflicts on this PR.',
    }],
    outcomes: {
      mode: 'exactlyOne',
      options: [{ id: 'resolved', title: 'Resolved', when: 'Conflicts resolved', actions: [{ type: 'setLabel', label: 'ready-for-review' }] }],
    },
  });
  return b;
}

// A whole `channels` / `triggers` patch, the way the model restates a list.
const patchChannels = (b, id, map) => ({ op: 'patchRole', id, patch: { channels: role(b, id).channels.map(map) } });
const patchTriggers = (b, id, map) => ({ op: 'patchRole', id, patch: { triggers: role(b, id).triggers.map(map) } });
const opsReply = (ops, summary = 'done') => JSON.stringify({ summary, ops });

async function turn(bundle, replyText) {
  let calls = 0;
  const out = await runCopilot({
    bundle, messages: [{ role: 'user', content: 'x' }], formatDoc: 'doc', addendum: 'add',
    callLlm: async () => { calls++; return replyText; },
  });
  return { out, calls };
}

// ── AC1: reading the gates ───────────────────────────────────────────────────

test('listHandoffs covers PR/issue channels and PR/issue label listeners, nothing else', () => {
  const hs = listHandoffs(withSolver());
  assert.deepEqual(hs.map(h => [h.kind, h.consumer, h.artifact, h.label, h.from.join('/')]), [
    ['channel', 'developer', 'issue', 'ready', 'business-analyst'],
    ['channel', 'code-reviewer', 'pr', 'ready-for-review', 'developer'],
    ['trigger', 'reworker', 'pr', 'revisions-required', 'code-reviewer'],
    ['trigger', 'merger', 'pr', 'ready-to-merge', 'code-reviewer'],
    ['trigger', 'conflict-solver', 'pr', 'needs-conflict-resolution', ''],
  ]);
});

test('AC1: the system prompt states each hand-off\'s gate exactly', () => {
  const b = fixture();
  role(b, 'code-reviewer').channels[0].readiness = { ci: true, conflict: false };
  role(b, 'merger').triggers[0].readinessGate = { ci: true, conflict: true, failureLabel: 'fix-it', timeoutMinutes: 120 };
  const text = describeHandoffGates(b);
  assert.match(text, /^## Hand-off readiness gates/);
  assert.match(text, /business-analyst → developer \(issue channel, label `ready`\): issue hand-off — cannot be gated/);
  assert.match(text, /developer → code-reviewer \(PR channel, label `ready-for-review`\): waits for CI: yes; blocks on merge conflict: no; failure label `revisions-required`; timeout 60 min/);
  assert.match(text, /code-reviewer → reworker \(trigger `reworker-on-revisions-required`, label `revisions-required`\): not gated — wakes immediately/);
  assert.match(text, /code-reviewer → merger \(trigger `merger-on-ready-to-merge`, label `ready-to-merge`\): waits for CI: yes; blocks on merge conflict: yes; failure label `fix-it`; timeout 120 min/);
  assert.doesNotMatch(text, /Conflict-solver role/);
  assert.ok(buildCopilotRequest({ bundle: b, messages: [], formatDoc: '', addendum: '' }).system.includes(text));
});

test('AC1: no hand-offs → no gates section (an empty draft\'s prompt is unchanged)', () => {
  assert.equal(describeHandoffGates({ processTemplateVersion: 1, roles: [] }), '');
  assert.doesNotMatch(buildCopilotRequest({ bundle: { roles: [] }, messages: [], formatDoc: '', addendum: '' }).system, /Hand-off readiness gates/);
});

test('AC1: a question is answered without a proposal (empty ops)', async () => {
  const { out, calls } = await turn(fixture(), opsReply([], 'No — the review hand-off wakes immediately.'));
  assert.equal(calls, 1);
  assert.equal(out.answer, true);
  assert.equal(out.ok, true);
  assert.equal(out.bundle, null);
  assert.equal(out.summary, 'No — the review hand-off wakes immediately.');
  assert.deepEqual(out.changes, []);
});

test('an empty ops list without a summary is repaired, not accepted', async () => {
  const replies = [opsReply([], ''), opsReply([], 'Answer.')];
  const out = await runCopilot({
    bundle: fixture(), messages: [{ role: 'user', content: 'x' }], formatDoc: 'd', addendum: 'a',
    callLlm: async () => replies.shift(),
  });
  assert.equal(out.answer, true);
  assert.equal(out.repairIterations, 1);
});

test('the revision contract offers the answer-only reply', () => {
  const { system } = buildCopilotRequest({ bundle: fixture(), messages: [], formatDoc: '', addendum: '' });
  assert.match(system, /"ops": \[\]\} — the empty list proposes nothing/);
});

// ── AC2: setting a gate ──────────────────────────────────────────────────────

test('AC2: gating the review hand-off yields the canonical value the edge dialog stores', async () => {
  const b = fixture();
  const reply = opsReply([patchChannels(b, 'code-reviewer', c => ({
    ...c, readiness: { ci: true, conflict: false, failureLabel: 'revisions-required', timeoutMinutes: 60 },
  }))], 'The review hand-off now waits for CI.');
  const { out } = await turn(b, reply);
  assert.equal(out.ok, true);
  assert.equal(out.answer, undefined);
  // Defaults are not written — exactly readinessFromForm's output.
  assert.deepEqual(role(out.bundle, 'code-reviewer').channels[0].readiness, { ci: true, conflict: false });
  assert.deepEqual(out.changes, [{ kind: 'role-modified', id: 'code-reviewer' }]);
  assert.equal(validateProcessTemplate(out.bundle).ok, true);
});

test('AC2: a label-listener gate is set on the trigger; switching both toggles off removes it', async () => {
  const b = fixture();
  const on = await turn(b, opsReply([patchTriggers(b, 'merger', t => ({ ...t, readinessGate: { ci: true, conflict: true, timeoutMinutes: 90 } }))]));
  assert.deepEqual(role(on.out.bundle, 'merger').triggers[0].readinessGate, { ci: true, conflict: true, timeoutMinutes: 90 });

  const gated = on.out.bundle;
  const off = await turn(gated, opsReply([patchTriggers(gated, 'merger', t => ({ ...t, readinessGate: { ci: false, conflict: false } }))]));
  assert.equal('readinessGate' in role(off.out.bundle, 'merger').triggers[0], false);
});

// ── AC3 / AC4: refusals ──────────────────────────────────────────────────────

test('AC3: gating an issue hand-off is refused with a short explanation, no proposal, no repair', async () => {
  const b = fixture();
  const { out, calls } = await turn(b, opsReply([patchChannels(b, 'developer', c => ({ ...c, readiness: { ci: true, conflict: true } }))], 'Done!'));
  assert.equal(calls, 1, 'refused outright — never sent to the repair loop');
  assert.equal(out.answer, true);
  assert.equal(out.refused, true);
  assert.equal(out.bundle, null);
  assert.match(out.summary, /^Only PR hand-offs can wait for CI or a conflict-free merge — business-analyst → developer \(issue channel/);
});

test('AC3: an issue label listener cannot be gated either', () => {
  const b = fixture();
  role(b, 'developer').triggers = [{ id: 'dev-on-ready', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', prompt: 'go' }];
  const c = JSON.parse(JSON.stringify(b));
  role(c, 'developer').triggers[0].readinessGate = { ci: true, conflict: false };
  assert.match(readinessRefusal(b, c), /^Only PR hand-offs/);
});

test('AC4: a failure label equal to the wake label is refused with the API\'s reason', async () => {
  const b = fixture();
  const { out } = await turn(b, opsReply([patchChannels(b, 'code-reviewer', c => ({ ...c, readiness: { ci: true, conflict: true, failureLabel: 'ready-for-review' } }))]));
  assert.equal(out.refused, true);
  assert.equal(out.summary,
    "I can't apply that gate to developer → code-reviewer (PR channel, label `ready-for-review`): readiness gate failureLabel must differ from the hand-off label `ready-for-review`.");
});

test('AC4: the default failure label on its own hand-off counts too', () => {
  const b = fixture();
  const c = JSON.parse(JSON.stringify(b));
  role(c, 'reworker').triggers[0].readinessGate = { ci: true, conflict: false };
  assert.match(readinessRefusal(b, c), /must differ from the hand-off label `revisions-required` \(unset, it defaults to `revisions-required`\)/);
});

test('AC4: a timeout outside 1–10080 is refused with the API\'s reason', async () => {
  for (const timeoutMinutes of [0, 10081, 2.5]) {
    const b = fixture();
    const { out } = await turn(b, opsReply([patchChannels(b, 'code-reviewer', c => ({ ...c, readiness: { ci: true, conflict: false, timeoutMinutes } }))]));
    assert.equal(out.refused, true, String(timeoutMinutes));
    assert.match(out.summary, /readiness gate timeoutMinutes must be a whole number from 1 to 10080\.$/);
  }
});

test('a whole-bundle reply is checked the same way', async () => {
  const bad = fixture();
  role(bad, 'developer').channels[0].readiness = { ci: true, conflict: false };
  const { out } = await turn(undefined, JSON.stringify({ summary: 's', bundle: bad }));
  assert.equal(out.refused, true);
});

test('only CHANGED gates are checked — an untouched pre-existing value is not refused', () => {
  const b = fixture();
  role(b, 'code-reviewer').channels[0].readiness = { ci: true, conflict: false, timeoutMinutes: 0 };
  const c = JSON.parse(JSON.stringify(b));
  role(c, 'code-reviewer').systemPrompt = 'changed';
  assert.equal(readinessRefusal(b, c), null);
});

test('normalizeHandoffGates does not mutate its input and leaves malformed gates to the validator', () => {
  const b = fixture();
  role(b, 'code-reviewer').channels[0].readiness = { ci: true, conflict: false, failureLabel: 'revisions-required', timeoutMinutes: 60 };
  role(b, 'merger').triggers[0].readinessGate = { ci: true, timeoutMinutes: 0 };
  const n = normalizeHandoffGates(b);
  assert.deepEqual(role(n, 'code-reviewer').channels[0].readiness, { ci: true, conflict: false });
  assert.deepEqual(role(n, 'merger').triggers[0].readinessGate, { ci: true, timeoutMinutes: 0 });
  assert.equal(role(b, 'code-reviewer').channels[0].readiness.timeoutMinutes, 60);
});

// ── AC5: conflict-solver suggestion ──────────────────────────────────────────

test('findConflictSolver: by merge_conflict listener, else by name; null without a wake label', () => {
  assert.deepEqual(findConflictSolver(withSolver()), { id: 'conflict-solver', wakeLabel: 'needs-conflict-resolution' });
  assert.equal(findConflictSolver(fixture()), null);
  const b = withSolver();
  role(b, 'conflict-solver').triggers = [];
  assert.equal(findConflictSolver(b), null);
  const e = fixture();
  role(e, 'reworker').triggers.push({ id: 'rw-mc', type: 'github-event', events: ['pull_request.merge_conflict'], prompt: 'x' });
  assert.deepEqual(findConflictSolver(e), { id: 'reworker', wakeLabel: 'revisions-required' });
  assert.match(describeHandoffGates(withSolver()), /Conflict-solver role: `conflict-solver`, woken by label `needs-conflict-resolution`\./);
});

test('AC5: enabling "Block on merge conflict" suggests the solver\'s wake label as failure label', async () => {
  const b = withSolver();
  const { out } = await turn(b, opsReply([patchChannels(b, 'code-reviewer', c => ({ ...c, readiness: { ci: false, conflict: true } }))], 'The review hand-off now blocks on merge conflicts.'));
  assert.equal(out.ok, true);
  assert.match(out.summary, /^The review hand-off now blocks on merge conflicts\. Tip: this team has a conflict solver \(`conflict-solver`\) — use its wake label `needs-conflict-resolution` as the failure label of developer → code-reviewer/);
  // A suggestion only — nothing set unasked.
  assert.deepEqual(role(out.bundle, 'code-reviewer').channels[0].readiness, { ci: false, conflict: true });
});

test('AC5: no suggestion when the label is already the solver\'s, the model named it, or only CI was switched on', () => {
  const b = withSolver();
  const gate = (r) => { const c = JSON.parse(JSON.stringify(b)); role(c, 'code-reviewer').channels[0].readiness = r; return c; };
  assert.equal(conflictSolverHint(b, gate({ ci: false, conflict: true, failureLabel: 'needs-conflict-resolution' })), null);
  assert.equal(conflictSolverHint(b, gate({ ci: true, conflict: false })), null);
  assert.equal(conflictSolverHint(fixture(), gate({ ci: false, conflict: true })) !== null, true);
  assert.equal(conflictSolverHint(gate({ ci: false, conflict: true }), gate({ ci: true, conflict: true })), null, 'conflict was already on');
});

test('AC5: the hint is not appended twice when the model already suggested the label', async () => {
  const b = withSolver();
  const summary = 'Done. Consider `needs-conflict-resolution` as the failure label.';
  const { out } = await turn(b, opsReply([patchChannels(b, 'code-reviewer', c => ({ ...c, readiness: { ci: true, conflict: true } }))], summary));
  assert.equal(out.summary, summary);
});
