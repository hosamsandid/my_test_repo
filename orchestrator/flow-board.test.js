'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fb = require('./flow-board');

const trig = (labelFilter, extra = {}) => ({ id: `t-${labelFilter}`, type: 'github-event', labelFilter, ...extra });

// The SDLC team of the issue's own example: Draft → Developer → Code Reviewer
// → Doc Sync → Merger → Done, with a Reworker looping back to review and a
// pooled Developer.
const SDLC = [
  { id: 't-developer', displayName: 'Developer', emits: ['ready-for-review'], triggers: [trig('ready')] },
  { id: 't-developer-i12', displayName: 'Developer', poolInstance: true, poolOf: 't-developer', poolItem: 12, poolRepo: 'o/r', triggers: [trig('ready')] },
  { id: 't-reviewer', displayName: 'Code Reviewer', emits: ['changes-requested', 'ready-for-documentation-update'], triggers: [trig('ready-for-review')] },
  { id: 't-reworker', displayName: 'Reworker', emits: ['ready-for-review'], triggers: [trig('changes-requested')] },
  { id: 't-docsync', displayName: 'Doc Sync', triggers: [trig('ready-for-documentation-update', { emits: ['ready-to-merge'] })] },
  { id: 't-merger', displayName: 'Merger', outcomes: { options: [{ id: 'x', actions: [{ type: 'setLabel', label: 'merge-conflict' }] }] }, triggers: [trig('ready-to-merge'), trig('ready-to-merge:wip')] },
  { id: 't-solver', displayName: 'Conflict Solver', emits: ['ready-to-merge'], triggers: [trig('merge-conflict')] },
];
const SDLC_LABELS = [{ name: 'ready', humanGate: true }];

// A second, entirely different vocabulary — no label or role name in common.
const KITCHEN = [
  { id: 'k-chef', displayName: 'Chef', emits: ['dish-cooked'], triggers: [trig('order-placed')] },
  { id: 'k-taster', displayName: 'Taster', emits: ['dish-approved', 'sent-back'], triggers: [trig('dish-cooked')] },
  { id: 'k-sous', displayName: 'Sous Chef', emits: ['dish-cooked'], triggers: [trig('sent-back')] },
  { id: 'k-waiter', displayName: 'Waiter', triggers: [trig('dish-approved')] },
  { id: 'k-dishwasher', displayName: 'Dishwasher', triggers: [{ id: 'c', type: 'cron', cron: '* * * * *' }] },
];

const labelsOf = (stages) => stages.map((s) => s.label);

test('deriveFlowStages: SDLC graph → Draft, roles in hand-off order, Done; pool instance and loop-back shown once', () => {
  const { stages } = fb.deriveFlowStages(SDLC, { labels: SDLC_LABELS });
  assert.deepEqual(labelsOf(stages), [
    'Draft', 'Developer', 'Code Reviewer', 'Reworker', 'Doc Sync', 'Merger', 'Conflict Solver', 'Done',
  ]);
  assert.equal(stages.filter((s) => s.label === 'Developer').length, 1);
});

test('deriveFlowStages: a different vocabulary derives its own stages (no fixed label names)', () => {
  const { stages } = fb.deriveFlowStages(KITCHEN, { labels: [] });
  assert.deepEqual(labelsOf(stages), ['Draft', 'Chef', 'Taster', 'Sous Chef', 'Waiter', 'Done']);
});

test('deriveFlowStages: channels name a hand-off without labels', () => {
  const members = [
    { id: 'x-writer', displayName: 'Writer', triggers: [trig('go')] },
    { id: 'x-editor', displayName: 'Editor', channels: [{ artifact: 'pr', from: 'writer' }], triggers: [{ id: 'e', type: 'github-event' }] },
  ];
  const { stages } = fb.deriveFlowStages(members, { teamId: 'x' });
  assert.deepEqual(labelsOf(stages), ['Draft', 'Writer', 'Editor', 'Done']);
});

test('deriveFlowStages: config renames, merges and hides stages', () => {
  const { stages, stageOf } = fb.deriveFlowStages(SDLC, {
    labels: SDLC_LABELS,
    config: {
      stages: {
        't-reviewer': { label: 'Review' },
        't-reworker': { mergeInto: 't-reviewer' },
        't-solver': { mergeInto: 't-merger' },
        't-docsync': { hidden: true },
      },
    },
  });
  assert.deepEqual(labelsOf(stages), ['Draft', 'Developer', 'Review', 'Merger', 'Done']);
  assert.equal(stageOf('t-reworker'), 2);
  assert.equal(stageOf('t-docsync'), 2); // hidden → nearest visible stage before it
  assert.equal(stageOf('t-solver'), 3);
});

test('deriveFlowStages: the unconfigured role order stays available for the column dialog', () => {
  const { roles } = fb.deriveFlowStages(SDLC, { labels: SDLC_LABELS, config: { stages: { 't-docsync': { hidden: true } } } });
  assert.deepEqual(roles.map((r) => r.label), ['Developer', 'Code Reviewer', 'Reworker', 'Doc Sync', 'Merger', 'Conflict Solver']);
  assert.equal(board().roles.length, 6);
});

test('normalizeBoardConfig: defaults, bounds and junk', () => {
  assert.deepEqual(fb.normalizeBoardConfig(null), { doneRetentionHours: 24, stages: {} });
  assert.equal(fb.normalizeBoardConfig({ doneRetentionHours: 48 }).doneRetentionHours, 48);
  assert.equal(fb.normalizeBoardConfig({ doneRetentionHours: -1 }).doneRetentionHours, 24);
  assert.deepEqual(fb.normalizeBoardConfig({ stages: { a: { hidden: 'yes', mergeInto: 'a' }, b: 5 } }).stages, {});
});

test('makeRoleResolver: instances (live or reaped) count as their role; strangers are null', () => {
  const roleOf = fb.makeRoleResolver(SDLC);
  assert.equal(roleOf('t-developer-i12'), 't-developer');
  assert.equal(roleOf('t-developer-i99'), 't-developer'); // reaped — id shape only
  assert.equal(roleOf('t-reviewer'), 't-reviewer');
  assert.equal(roleOf('other-agent'), null);
});

const NOW = Date.parse('2026-09-29T12:00:00Z');
const iso = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();
const issue = (n, extra = {}) => ({ repo: 'o/r', number: n, title: `Issue ${n}`, url: `u/${n}`, state: 'open', labels: [], updatedAt: iso(600), ...extra });
const pr = (n, extra = {}) => ({ repo: 'o/r', number: n, title: `PR ${n}`, url: `u/${n}`, state: 'open', labels: [], updatedAt: iso(600), headRef: `feat/${n}`, ...extra });
const delivered = (n, agentId, minsAgo, extra = {}) => ({
  ts: iso(minsAgo), eventId: `e${n}-${agentId}-${minsAgo}`, repo: 'o/r', workItem: { kind: 'issue', number: n },
  outcomes: [{ agentId, status: 'delivered' }], ...extra,
});

function board(overrides = {}) {
  return fb.buildFlowBoard({ members: SDLC, labels: SDLC_LABELS, teamId: 't', now: NOW, ...overrides });
}

test('buildFlowBoard: only items a team agent touched appear; dependabot and backlog never do', () => {
  const b = board({
    github: {
      issues: [issue(1), issue(2), issue(3, { labels: ['ready'] })],
      prs: [pr(50, { author: 'dependabot[bot]' }), pr(51, { body: 'x\n<!-- agent: t-developer -->' })],
    },
    events: [delivered(1, 't-developer', 30), { ...delivered(50, 't-reviewer', 5), workItem: { kind: 'pr', number: 50 } }],
  });
  const ids = b.rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ['o/r#1', 'o/r#3', 'o/r#51']);
  const released = b.rows.find((r) => r.id === 'o/r#3');
  assert.equal(released.stageId, 't-developer'); // `ready` → Developer woken next
  assert.equal(released.status, 'queued');
});

test('buildFlowBoard: issue and the PR the woken agent opened form one row, no Closes needed', () => {
  const ev = delivered(7, 't-developer-i7', 90);
  const b = board({
    github: { issues: [issue(7)], prs: [pr(70, { labels: ['ready-for-review'] }), pr(71)] },
    events: [ev],
    prRecords: [
      { kind: 'pr-created', agentId: 't-developer-i7', repo: 'o/r', prNumber: 70, correlationId: `trigger:t:gh:${ev.eventId}`, ts: iso(60) },
      { kind: 'pr-created', agentId: 't-reworker', repo: 'o/r', prNumber: 71, ts: iso(10) }, // no issue → own row
    ],
  });
  assert.equal(b.rows.length, 2);
  const row = b.rows.find((r) => r.id === 'o/r#7');
  assert.deepEqual(row.prs.map((p) => p.number), [70]);
  assert.equal(row.stageId, 't-reviewer');
  assert.equal(row.status, 'queued');
  assert.ok(b.rows.find((r) => r.id === 'o/r#71'));
});

test('buildFlowBoard: a non-pooled role woken by a platform-minted event id (int:/intlbl:/refire:) links its PR to the issue', () => {
  for (const eventId of ['int:abcdef012345', 'intlbl:0123abcd', 'refire:feedbeef']) {
    const b = board({
      github: { issues: [issue(8, { updatedAt: iso(90) })], prs: [pr(80, { labels: ['ready-for-review'] })] },
      events: [{ ...delivered(8, 't-developer', 90), eventId }],
      prRecords: [{ kind: 'pr-created', agentId: 't-developer', repo: 'o/r', prNumber: 80, correlationId: `trigger:t-ready:gh:${eventId}`, ts: iso(60) }],
    });
    assert.deepEqual(b.rows.map((r) => r.id), ['o/r#8'], eventId);
    assert.deepEqual(b.rows[0].prs.map((p) => p.number), [80]);
    assert.equal(b.rows[0].stageId, 't-reviewer');
    assert.deepEqual(b.needsHuman, []);
  }
});

test('buildFlowBoard: an idle "last woke here" never outranks an agent queued on another item of the row', () => {
  const ev = delivered(10, 't-developer', 120);
  const b = board({
    github: { issues: [issue(10)], prs: [pr(100, { labels: ['ready-for-review'] })] },
    events: [ev, delivered(10, 't-merger', 90)],
    prRecords: [{ kind: 'pr-created', agentId: 't-developer', repo: 'o/r', prNumber: 100, correlationId: `trigger:t:gh:${ev.eventId}`, ts: iso(100) }],
  });
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].stageId, 't-reviewer');
  assert.equal(b.rows[0].status, 'queued');
});

test('buildFlowBoard: several PRs for one issue — one row, stage follows the most advanced open PR', () => {
  const b = board({
    github: {
      issues: [issue(8)],
      prs: [pr(80, { labels: ['ready-for-review'] }), pr(81, { labels: ['ready-to-merge:wip'] }), pr(82, { state: 'closed', labels: ['ready-to-merge'] })],
    },
    prRecords: [80, 81, 82].map((n) => ({ kind: 'pr-created', agentId: 't-developer-i8', repo: 'o/r', prNumber: n, ts: iso(100) })),
  });
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].prs.length, 3);
  assert.equal(b.rows[0].stageId, 't-merger');
  assert.equal(b.rows[0].status, 'working');
});

test('buildFlowBoard: a running session marks the role working, with its start as time in stage', () => {
  const b = board({
    github: { issues: [issue(9)] },
    sessions: [{ agentId: 't-developer-i9', session: { id: 's', startedAt: iso(12), workItem: { repo: 'o/r', kind: 'issue', number: 9 } } }],
  });
  assert.equal(b.rows[0].status, 'working');
  assert.equal(b.rows[0].stageId, 't-developer');
  assert.equal(b.rows[0].since, iso(12));
  assert.equal(b.sessions.length, 1);
  assert.equal(b.sessions[0].roleLabel, 'Developer');
  assert.equal(b.sessions[0].instance, 9);
  assert.equal(b.sessions[0].issue.number, 9);
});

test('buildFlowBoard: done rows stay for the retention window, then drop', () => {
  const mk = (closedMinsAgo, config) => board({
    config,
    github: { issues: [issue(4, { state: 'closed', closedAt: iso(closedMinsAgo) })] },
    events: [delivered(4, 't-developer', 2000)],
  });
  assert.equal(mk(60).rows[0].status, 'done');
  assert.equal(mk(60).rows[0].stageId, 'done');
  assert.equal(mk(25 * 60).rows.length, 0);
  assert.equal(mk(25 * 60, { doneRetentionHours: 48 }).rows.length, 1);
});

test('buildFlowBoard: rows flow top to bottom — Draft, stages in hand-off order, newest in stage on top, done last newest first', () => {
  const marked = (n, mins) => issue(n, { updatedAt: iso(mins), body: 'x\n<!-- agent: t-developer -->' });
  const devSession = (n, mins) => ({ agentId: `t-developer-i${n}`, session: { id: `s${n}`, startedAt: iso(mins), workItem: { repo: 'o/r', kind: 'issue', number: n } } });
  const b = board({
    github: {
      issues: [
        marked(1, 300), marked(2, 10), // Draft (never picked up)
        issue(3), issue(4), // Developer (running sessions)
        issue(5, { labels: ['ready-for-review'], updatedAt: iso(20) }), // Code Reviewer
        issue(6, { state: 'closed', closedAt: iso(200) }), issue(7, { state: 'closed', closedAt: iso(15) }), // Done
      ],
    },
    events: [delivered(6, 't-developer', 2000), delivered(7, 't-developer', 2000)],
    sessions: [devSession(3, 90), devSession(4, 5)],
  });
  const at = (n) => b.rows.find((r) => r.id === `o/r#${n}`);
  assert.deepEqual([1, 2].map((n) => at(n).status), ['draft', 'draft']);
  assert.deepEqual([3, 4].map((n) => at(n).stageId), ['t-developer', 't-developer']);
  assert.equal(at(5).stageId, 't-reviewer');
  assert.deepEqual([6, 7].map((n) => at(n).status), ['done', 'done']);
  // Draft above role stages, earlier stage above later, newest-in-stage first,
  // done below everything, most recently done first.
  assert.deepEqual(b.rows.map((r) => r.id), ['o/r#2', 'o/r#1', 'o/r#4', 'o/r#3', 'o/r#5', 'o/r#7', 'o/r#6']);
});

test('buildFlowBoard: a missing stage-entry time sorts as oldest in its stage, tie broken by id, stable across refreshes', () => {
  const sess = (n, startedAt) => ({ agentId: `t-developer-i${n}`, session: { id: `s${n}`, startedAt, workItem: { repo: 'o/r', kind: 'issue', number: n } } });
  const mk = (order) => board({
    github: { issues: order.map((n) => issue(n)) },
    sessions: order.map((n) => sess(n, n === 11 ? iso(500) : undefined)),
  });
  const first = mk([12, 13, 11]).rows;
  assert.deepEqual(first.map((r) => r.since), [iso(500), null, null]);
  assert.deepEqual(first.map((r) => r.id), ['o/r#11', 'o/r#12', 'o/r#13']);
  assert.deepEqual(mk([13, 11, 12]).rows.map((r) => r.id), first.map((r) => r.id));
});

test('buildFlowBoard: an agent PR later handled by humans stays until done', () => {
  const b = board({
    github: { prs: [pr(90, { state: 'closed', merged: true, mergedAt: iso(30) })] },
    prRecords: [{ kind: 'pr-created', agentId: 't-developer', repo: 'o/r', prNumber: 90, ts: iso(3000) }],
  });
  assert.equal(b.rows[0].status, 'done');
  assert.equal(b.rows[0].prs[0].state, 'merged');
});

test('buildFlowBoard: human blocks carry a plain reason; an agent already queued is not a block', () => {
  const b = board({
    github: {
      prs: [
        pr(61, { mergeable: 'CONFLICTING' }),
        pr(62, { mergeable: 'CONFLICTING', labels: ['merge-conflict'] }),
        pr(63, { reviewDecision: 'APPROVED', checks: 'passing' }),
        pr(64, { checks: 'failing' }),
        pr(65, { labels: ['needs-human', 'ready-for-review'] }),
      ],
    },
    prRecords: [61, 62, 63, 64, 65].map((n) => ({ kind: 'pr-created', agentId: 't-developer', repo: 'o/r', prNumber: n, ts: iso(10) })),
  });
  const reason = (n) => (b.rows.find((r) => r.id === `o/r#${n}`).needsHuman || {}).reason || null;
  assert.equal(reason(61), 'conflict with base');
  assert.equal(reason(62), null);
  assert.equal(reason(63), 'approved — waiting for merge');
  assert.equal(reason(64), 'checks failing');
  assert.equal(reason(65), 'flagged for a human');
  assert.deepEqual(b.needsHuman.map((n) => n.id).sort(), ['o/r#61', 'o/r#63', 'o/r#64', 'o/r#65']);
});

test('buildFlowBoard: a dead end past the stall window says no agent is scheduled', () => {
  const b = board({ github: { issues: [issue(5)] }, events: [delivered(5, 't-reviewer', 45)] });
  assert.equal(b.rows[0].status, 'idle');
  assert.equal(b.rows[0].needsHuman.reason, 'no agent is scheduled to continue');
  const fresh = board({ github: { issues: [issue(5)] }, events: [delivered(5, 't-reviewer', 5)] });
  assert.equal(fresh.rows[0].needsHuman, null);
});

test('buildFlowBoard: a label handed to a person reads as waiting for approval', () => {
  const members = [...KITCHEN, { id: 'k-host', displayName: 'Host', emits: ['guest-sign-off'], triggers: [trig('dish-approved')] }];
  const b = fb.buildFlowBoard({
    members, now: NOW,
    github: { issues: [issue(3, { labels: ['guest-sign-off'] })] },
    events: [delivered(3, 'k-host', 90)],
  });
  assert.equal(b.rows[0].needsHuman.reason, 'waiting for approval');
});

test('buildFlowBoard: a session linked to a closed item keeps its run but no ghost row', () => {
  const b = board({
    github: { issues: [issue(6, { state: 'closed', closedAt: iso(26 * 60) })] },
    sessions: [{ agentId: 't-merger', session: { id: 's', startedAt: iso(1), workItem: { repo: 'o/r', kind: 'issue', number: 6 } } }],
  });
  assert.equal(b.rows.length, 0);
  assert.equal(b.sessions.length, 1);
  assert.equal(b.sessions[0].rowId, null);
  assert.equal(b.sessions[0].issue, null);
});

test('buildFlowBoard: pools report busy of capacity, state and held work', () => {
  const b = board({
    github: { issues: [issue(12)] },
    sessions: [{ agentId: 't-developer-i12', session: { id: 's', startedAt: iso(3) } }],
    pools: [{ agentId: 't-developer', roleId: 'developer', maxInstances: 3, state: 'draining', held: 2,
      instances: [{ instanceId: 't-developer-i12' }, { instanceId: 't-developer-i13' }] }],
  });
  assert.deepEqual(
    { busy: b.pools[0].busy, capacity: b.pools[0].capacity, state: b.pools[0].state, held: b.pools[0].held },
    { busy: 1, capacity: 3, state: 'draining', held: 2 },
  );
  // The pool instance's own item links the session when the run carries none.
  assert.equal(b.sessions[0].issue.number, 12);
});

// ---------------------------------------------------------------------------
// #2637 — Draft stage and "Remove from board".
// ---------------------------------------------------------------------------

// The #2563/#2033 shape: agent-created (marker), no wake label, no wake, no session.
const concept = (n, extra = {}) => issue(n, { labels: ['concept'], body: 'c\n<!-- agent: t-developer -->', ...extra });
const REMOVED_AT = iso(60);

test('buildFlowBoard: an agent-created, unreleased item still appears — in Draft, awaiting a person (AC1, AC3)', () => {
  const b = board({ github: { issues: [concept(2563), issue(2033, { body: '<!-- agent: t-reviewer -->' })] } });
  assert.equal(b.stages[0].id, 'draft');
  assert.equal(b.stages[0].label, 'Draft');
  for (const id of ['o/r#2563', 'o/r#2033']) {
    const row = b.rows.find((r) => r.id === id);
    assert.ok(row, `${id} must stay on the board`);
    assert.equal(row.stageId, 'draft');
    assert.equal(row.stageIndex, 0);
    assert.equal(row.status, 'draft');
    assert.equal(row.removable, true);
  }
});

test('buildFlowBoard: a released item is up next at its role, never in Draft, and cannot be removed (AC4, AC5)', () => {
  const b = board({ github: { issues: [concept(3, { labels: ['ready'] })] } });
  assert.equal(b.rows[0].stageId, 't-developer');
  assert.equal(b.rows[0].status, 'queued');
  assert.equal(b.rows[0].removable, false);
  const w = board({
    github: { issues: [concept(4)] },
    sessions: [{ agentId: 't-developer-i4', session: { id: 's', startedAt: iso(3), workItem: { repo: 'o/r', kind: 'issue', number: 4 } } }],
  });
  assert.equal(w.rows[0].status, 'working');
  assert.equal(w.rows[0].removable, false);
  // Idle, stalled or done rows have no agent on them — they may be removed.
  assert.equal(board({ github: { issues: [issue(5)] }, events: [delivered(5, 't-reviewer', 45)] }).rows[0].removable, true);
});

test('buildFlowBoard: a removed row is hidden and listed under removed; nothing is pruned while it is hidden (AC5, AC7, AC9)', () => {
  const b = board({
    github: { issues: [concept(2563), concept(2033)] },
    removed: { 'o/r#2563': { removedAt: REMOVED_AT, keys: ['o/r#2563'] } },
  });
  assert.deepEqual(b.rows.map((r) => r.id), ['o/r#2033']);
  assert.deepEqual(b.removed.map((r) => ({ id: r.id, removalId: r.removalId, removedAt: r.removedAt, number: r.issue.number })), [
    { id: 'o/r#2563', removalId: 'o/r#2563', removedAt: REMOVED_AT, number: 2563 },
  ]);
  assert.deepEqual(b.removalsToPrune, []);
  // Restore = the entry is gone from the store: the row is back at its computed stage.
  const restored = board({ github: { issues: [concept(2563)] }, removed: {} });
  assert.equal(restored.rows[0].stageId, 'draft');
  assert.deepEqual(restored.removed, []);
});

test('buildFlowBoard: edits, comments and cross-references do not bring a removed row back (AC8)', () => {
  const b = board({
    // A later `updatedAt` is all a comment, edit or cross-reference changes.
    github: { issues: [concept(2563, { updatedAt: iso(1) })] },
    // An event delivered BEFORE the removal is old activity.
    events: [delivered(2563, 't-reviewer', 120)],
    removed: { 'o/r#2563': { removedAt: REMOVED_AT, keys: ['o/r#2563'] } },
  });
  assert.deepEqual(b.rows, []);
  assert.equal(b.removed.length, 1);
});

test('buildFlowBoard: new flow activity brings a removed row back and prunes its removal (AC8)', () => {
  const removed = { 'o/r#7': { removedAt: REMOVED_AT, keys: ['o/r#7'] } };
  const cases = {
    'wake label added': { github: { issues: [concept(7, { labels: ['ready'] })] } },
    'claim label added': { github: { issues: [concept(7, { labels: ['ready-to-merge:wip'] })] } },
    'event delivered to a team agent': { github: { issues: [concept(7)] }, events: [delivered(7, 't-reviewer', 5)] },
    'session started': {
      github: { issues: [concept(7)] },
      sessions: [{ agentId: 't-developer-i7', session: { id: 's', startedAt: iso(2), workItem: { repo: 'o/r', kind: 'issue', number: 7 } } }],
    },
    'agent opened a PR for it': {
      github: { issues: [concept(7)], prs: [pr(70)] },
      prRecords: [{ kind: 'pr-created', agentId: 't-developer-i7', repo: 'o/r', prNumber: 70, ts: iso(5) }],
    },
  };
  for (const [name, input] of Object.entries(cases)) {
    const b = board({ ...input, removed });
    assert.deepEqual(b.rows.map((r) => r.id), ['o/r#7'], name);
    assert.deepEqual(b.removed, [], name);
    assert.deepEqual(b.removalsToPrune, ['o/r#7'], name);
  }
});

test('buildFlowBoard: removal covers the whole row — activity on any of its items revives it', () => {
  const removed = { 'o/r#8': { removedAt: REMOVED_AT, keys: ['o/r#8', 'o/r#80'] } };
  const base = {
    github: { issues: [concept(8)], prs: [pr(80, { closes: [8] })] },
    prRecords: [{ kind: 'pr-created', agentId: 't-developer-i8', repo: 'o/r', prNumber: 80, ts: iso(3000) }],
  };
  assert.deepEqual(board({ ...base, removed }).rows, []);
  const b = board({ ...base, removed, events: [{ ...delivered(80, 't-reviewer', 5), workItem: { kind: 'pr', number: 80 } }] });
  assert.deepEqual(b.rows.map((r) => r.id), ['o/r#8']);
});

test('buildFlowBoard: a removal whose item left the snapshot is pruned; a PR-only row can be removed (AC11)', () => {
  const b = board({
    github: { prs: [pr(91)] },
    prRecords: [{ kind: 'pr-created', agentId: 't-developer', repo: 'o/r', prNumber: 91, ts: iso(3000) }],
    removed: {
      'o/r#91': { removedAt: REMOVED_AT, keys: ['o/r#91'] },
      'o/r#404': { removedAt: REMOVED_AT, keys: ['o/r#404'] },
      'other/repo#1': { removedAt: REMOVED_AT },
    },
  });
  assert.deepEqual(b.rows, []);
  assert.deepEqual(b.removed.map((r) => [r.id, r.issue, r.prs[0].number]), [['o/r#91', null, 91]]);
  assert.deepEqual(b.removalsToPrune.sort(), ['o/r#404', 'other/repo#1']);
});

test('normalizeRemoved: keeps well-formed entries, always includes the row id in its keys', () => {
  assert.deepEqual(fb.normalizeRemoved(null), {});
  assert.deepEqual(fb.normalizeRemoved([]), {});
  assert.deepEqual(
    fb.normalizeRemoved({ 'o/r#1': { removedAt: REMOVED_AT, keys: ['o/r#10'] }, 'o/r#2': { removedAt: 'nope' }, 'o/r#3': 5 }),
    { 'o/r#1': { removedAt: REMOVED_AT, keys: ['o/r#1', 'o/r#10'] } },
  );
});

test('eventIdFromCorrelation / markerAgents / checksState', () => {
  assert.equal(fb.eventIdFromCorrelation('trigger:t1:gh:12345'), '12345');
  assert.equal(fb.eventIdFromCorrelation('dm:x'), null);
  assert.equal(fb.eventIdFromCorrelation('trigger:t1:gh:int:abc123'), 'int:abc123');
  assert.equal(fb.eventIdFromCorrelation('trigger:t1:gh:intlbl:abc123'), 'intlbl:abc123');
  assert.equal(fb.eventIdFromCorrelation('trigger:t1:gh:refire:abc123'), 'refire:abc123');
  assert.deepEqual(fb.markerAgents('a <!-- agent: t-dev --> b <!-- agent: t-rev -->'), ['t-dev', 't-rev']);
  assert.equal(fb.checksState('FAILURE'), 'failing');
  assert.equal(fb.checksState('PENDING'), 'pending');
  assert.equal(fb.checksState('SUCCESS'), 'passing');
  assert.equal(fb.checksState(null), null);
});
