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
      github: { issues: [issue(8, { updatedAt: iso(90) })], // Labelled just now — inside the parked-wake window (#2872).
      prs: [pr(80, { labels: ['ready-for-review'], updatedAt: iso(5) })] },
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
        pr(62, { mergeable: 'CONFLICTING', labels: ['merge-conflict'], updatedAt: iso(5) }), // just queued (#2872)
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

test('NEEDS_HELP_MS: one exported threshold, default 1 h, longer than the idle stall window (#2734)', () => {
  assert.equal(fb.NEEDS_HELP_MS, 60 * 60 * 1000);
  assert.ok(fb.NEEDS_HELP_MS > fb.STALL_MS);
  assert.equal(fb.REASONS.needsHelp, 'stuck — no progress, needs help');
});

test('buildFlowBoard: a claim past the threshold with no live worker needs help, with its waiting time (#2734)', () => {
  const stuck = (minsAgo, extra = {}) => board({
    github: { issues: [issue(20, { labels: ['ready:wip'], updatedAt: iso(minsAgo) })] },
    events: [delivered(20, 't-developer', minsAgo)],
    ...extra,
  });
  const b = stuck(75);
  assert.equal(b.rows[0].status, 'working');
  assert.equal(b.rows[0].stageId, 't-developer');
  const release = [{ repo: 'o/r', number: 20, kind: 'issue', claim: 'ready:wip', wake: 'ready' }];
  assert.deepEqual(b.rows[0].needsHuman, { reason: 'stuck — no progress, needs help', since: iso(75), release });
  assert.deepEqual(b.needsHuman.map((n) => [n.id, n.reason, n.since]), [['o/r#20', 'stuck — no progress, needs help', iso(75)]]);
  assert.deepEqual(b.needsHuman[0].release, release);
  // Inside the threshold it is still ordinary in-progress work.
  assert.equal(stuck(59).rows[0].needsHuman, null);
  assert.deepEqual(stuck(59).needsHuman, []);
  // Exactly at the threshold is not yet past it.
  assert.equal(stuck(60).rows[0].needsHuman, null);
});

test('buildFlowBoard: a stale claim alongside a re-applied wake label still needs help (#2734)', () => {
  // The #2713 shape: claimed, then the wake label re-applied on top.
  const b = board({
    github: { issues: [issue(21, { labels: ['ready', 'ready:wip'], updatedAt: iso(190) })] },
    events: [delivered(21, 't-developer', 195)],
  });
  assert.equal(b.rows[0].status, 'working');
  assert.equal(b.rows[0].needsHuman.reason, 'stuck — no progress, needs help');
  // Re-adding a wake already present wakes nobody, so its release entry is
  // marked for a remove-then-re-add (#2754 review).
  assert.deepEqual(b.rows[0].needsHuman.release, [
    { repo: 'o/r', number: 21, kind: 'issue', claim: 'ready:wip', wake: 'ready', wakePresent: true },
  ]);
});

test('buildFlowBoard: a long claim with a running session or a live pool instance is not flagged (#2734)', () => {
  const claimed = issue(12, { labels: ['ready:wip'], updatedAt: iso(180) });
  const withSession = board({
    github: { issues: [claimed] },
    events: [delivered(12, 't-developer-i12', 180)],
    sessions: [{ agentId: 't-developer-i12', session: { id: 's', startedAt: iso(90), workItem: { repo: 'o/r', kind: 'issue', number: 12 } } }],
  });
  assert.equal(withSession.rows[0].status, 'working');
  assert.equal(withSession.rows[0].needsHuman, null);
  // A live pool instance for the item (between runs, no session) is live work too.
  const withInstance = board({
    github: { issues: [claimed] },
    events: [delivered(12, 't-developer-i12', 180)],
    pools: [{ agentId: 't-developer', roleId: 'developer', maxInstances: 3, instances: [{ instanceId: 't-developer-i12' }] }],
  });
  assert.equal(withInstance.rows[0].needsHuman, null);
  // An instance alive for another item does not vouch for this one.
  const otherInstance = board({
    github: { issues: [claimed] },
    events: [delivered(12, 't-developer-i12', 180)],
    pools: [{ agentId: 't-developer', roleId: 'developer', maxInstances: 3, instances: [{ instanceId: 't-developer-i13' }] }],
  });
  assert.equal(otherInstance.rows[0].needsHuman.reason, 'stuck — no progress, needs help');
});

test('buildFlowBoard: the needs-help flag is report-only — the claim, status and stage stay as they are (#2734)', () => {
  const labels = ['ready:wip'];
  const github = { issues: [issue(22, { labels, updatedAt: iso(120) })] };
  const b = board({ github, events: [delivered(22, 't-developer', 120)] });
  assert.equal(b.rows[0].needsHuman.reason, 'stuck — no progress, needs help');
  assert.deepEqual(github.issues[0].labels, ['ready:wip']);
  assert.equal(b.rows[0].status, 'working');
  assert.equal(b.rows[0].stageId, 't-developer');
  // A queued wake is not a claim — the needs-help branch never fires for it.
  const q = board({ github: { issues: [issue(23, { labels: ['ready-for-review'], updatedAt: iso(300) })] }, events: [delivered(23, 't-reviewer', 300)] });
  assert.equal(q.rows[0].status, 'queued');
  assert.equal(q.rows[0].needsHuman, null);
});

test('buildFlowBoard: a needs-help row lists every orphaned claim it can release, across its items (#2754)', () => {
  const b = board({
    github: {
      issues: [issue(30, { labels: ['ready:wip', 'bug'], updatedAt: iso(200) })],
      prs: [pr(60, { labels: ['ready-to-merge:wip'], updatedAt: iso(200), body: 'Closes #30\n<!-- agent: t-developer -->', closes: [30] })],
    },
    events: [delivered(30, 't-developer', 200)],
  });
  const row = b.rows.find((r) => r.id === 'o/r#30');
  assert.equal(row.needsHuman.reason, fb.REASONS.needsHelp);
  assert.deepEqual(row.needsHuman.release.map((r) => [r.number, r.kind, r.claim, r.wake]).sort(), [
    [30, 'issue', 'ready:wip', 'ready'],
    [60, 'pr', 'ready-to-merge:wip', 'ready-to-merge'],
  ]);
  // Other flags never carry a release list.
  const flagged = board({ github: { issues: [issue(31, { labels: ['ready:wip', 'needs-human'], updatedAt: iso(200) })] }, events: [delivered(31, 't-developer', 200)] });
  assert.equal(flagged.rows[0].needsHuman.reason, fb.REASONS.flagged);
  assert.equal(flagged.rows[0].needsHuman.release, undefined);
  assert.equal(flagged.needsHuman[0].release, undefined);
});

test('buildFlowBoard: a needs-help row offers only the claims a live consumer would pick up (#2754)', () => {
  const offReviewer = SDLC.map((m) => (m.id === 't-reviewer' ? { ...m, enabled: false } : m));
  const b = board({
    members: offReviewer,
    github: { issues: [issue(32, { labels: ['ready:wip', 'ready-for-review:wip'], updatedAt: iso(200) })] },
    events: [delivered(32, 't-developer', 200)],
  });
  assert.equal(b.rows[0].needsHuman.reason, fb.REASONS.needsHelp);
  assert.deepEqual(b.rows[0].needsHuman.release.map((r) => r.claim), ['ready:wip']);
});

test('buildFlowBoard: a wake whose only consumer is switched off reads as "nobody picks it up", not stuck or queued (#2754)', () => {
  assert.equal(fb.REASONS.noConsumer, 'nobody picks it up — its agent is switched off');
  const offDev = SDLC.map((m) => (m.id === 't-developer' ? { ...m, enabled: false } : m));
  // A queued wake for a disabled agent.
  const q = board({ members: offDev, github: { issues: [issue(40, { labels: ['ready'], updatedAt: iso(20) })] } });
  assert.equal(q.rows[0].status, 'queued');
  assert.deepEqual(q.rows[0].needsHuman, { reason: fb.REASONS.noConsumer, since: iso(20) });
  // An orphaned claim for a disabled agent: releasing it would wake nobody.
  const c = board({ members: offDev, github: { issues: [issue(41, { labels: ['ready:wip'], updatedAt: iso(200) })] }, events: [delivered(41, 't-developer', 200)] });
  assert.equal(c.rows[0].needsHuman.reason, fb.REASONS.noConsumer);
  assert.equal(c.rows[0].needsHuman.release, undefined);
  // The consumer's only trigger on that label switched off counts too.
  const offTrig = SDLC.map((m) => (m.id === 't-reviewer' ? { ...m, triggers: [trig('ready-for-review', { enabled: false })] } : m));
  const t = board({ members: offTrig, github: { issues: [issue(42, { labels: ['ready-for-review'], updatedAt: iso(20) })] }, events: [delivered(42, 't-developer', 30)] });
  assert.equal(t.rows[0].needsHuman.reason, fb.REASONS.noConsumer);
  // Enabled consumers: ordinary queued work, no flag.
  const ok = board({ github: { issues: [issue(43, { labels: ['ready'], updatedAt: iso(20) })] } });
  assert.equal(ok.rows[0].needsHuman, null);
});

test('buildFlowBoard: one live consumer on the row keeps it off the "nobody picks it up" flag (#2754)', () => {
  const offDev = SDLC.map((m) => (m.id === 't-developer' ? { ...m, enabled: false } : m));
  // `ready` is dead, but `ready-for-review` still wakes the enabled reviewer.
  const b = board({ members: offDev, github: { issues: [issue(44, { labels: ['ready', 'ready-for-review'], updatedAt: iso(20) })] } });
  assert.equal(b.rows[0].needsHuman, null);
  // A running session for the item is live work regardless.
  const s = board({
    members: offDev,
    github: { issues: [issue(45, { labels: ['ready:wip'], updatedAt: iso(200) })] },
    sessions: [{ agentId: 't-developer', session: { id: 's', startedAt: iso(5), workItem: { repo: 'o/r', kind: 'issue', number: 45 } } }],
  });
  assert.equal(s.rows[0].needsHuman, null);
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

test('#2789 buildFlowBoard: pools count idle instances waiting on a PR apart from busy ones', () => {
  const b = board({
    github: { issues: [issue(12)] },
    sessions: [{ agentId: 't-developer-i12', session: { id: 's', startedAt: iso(3) } }],
    pools: [{ agentId: 't-developer', roleId: 'developer', maxInstances: 3,
      instances: [
        { instanceId: 't-developer-i12', waiting: true, prs: [40] }, // working again — active, not waiting
        { instanceId: 't-developer-i13', waiting: true, prs: [41] },
        { instanceId: 't-developer-i14' },
      ] }],
  });
  assert.deepEqual({ busy: b.pools[0].busy, waiting: b.pools[0].waiting, live: b.pools[0].live }, { busy: 1, waiting: 1, live: 3 });
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

test('buildFlowBoard: a PR hand-off held by its CI / conflict gate shows what it waits for on the row (#2795)', () => {
  const ev = delivered(7, 't-developer-i7', 90);
  const base = {
    github: { issues: [issue(7)], prs: [pr(70, { labels: ['ready-for-review'] })] },
    events: [ev],
    prRecords: [{ kind: 'pr-created', agentId: 't-developer-i7', repo: 'o/r', prNumber: 70, correlationId: `trigger:t:gh:${ev.eventId}`, ts: iso(60) }],
  };
  const b = board({
    ...base,
    gateHolds: [
      { repo: 'o/r', number: 70, agentId: 't-reviewer', waitingFor: ['conflict'], heldAt: iso(5) },
      { repo: 'o/r', number: 70, agentId: 't-security', waitingFor: ['ci'], heldAt: iso(8) },
      { repo: 'o/r', number: 99, agentId: 't-reviewer', waitingFor: ['ci'], heldAt: iso(1) }, // not on the board
      { repo: 'o/r', number: 'x' },
    ],
  });
  const row = b.rows.find((r) => r.id === 'o/r#7');
  assert.deepEqual(row.gateHold, { number: 70, waitingFor: ['ci', 'conflict'], since: iso(8), agentIds: ['t-reviewer', 't-security'] });
  // No hold → null, as before.
  assert.equal(board(base).rows.find((r) => r.id === 'o/r#7').gateHold, null);
});

// ---------------------------------------------------------------------------
// Parked on an undelivered wake (#2872)
// ---------------------------------------------------------------------------

// One Event Log entry: `created` is when it happened on GitHub, `logged` when
// the poller recorded it (hours later for a late Events API delivery).
const logged = (n, { kind = 'pr', action = 'labeled', label, created, logged: at = created, outcomes = [] }) => ({
  ts: iso(at), createdAt: iso(created), eventId: `ev-${n}-${label}-${created}`, repo: 'o/r',
  event: `${kind === 'pr' ? 'pull_request' : 'issues'}.${action}`, label,
  workItem: { kind, number: n }, outcomes,
});
const dropped = (agentId, reason) => ({ agentId, status: 'dropped', reason });
const got = (agentId, wakeLabel) => ({ agentId, status: 'delivered', wakeLabel });

// The 2026-10-06 incident on agent-studio-3-0, one PR per constellation. The
// Developer opened each PR for its issue earlier; the wake label is on it now.
function incident(extra = {}) {
  const prOf = (n, issueN, labels) => pr(n, { labels, closes: [issueN], body: '<!-- agent: t-developer -->', updatedAt: iso(1000) });
  return board({
    github: {
      issues: [issue(2859), issue(2819), issue(2813), issue(2858)],
      prs: [
        prOf(2863, 2859, ['ready-for-review']),
        prOf(2820, 2819, ['ready-for-review']),
        prOf(2844, 2813, ['ready-for-review']),
        prOf(2862, 2858, ['changes-requested']),
      ],
    },
    events: [
      // #2863: reviewed once, then the manual re-add dropped as already armed.
      logged(2863, { label: 'ready-for-review', created: 1500, outcomes: [got('t-reviewer', 'ready-for-review')] }),
      logged(2863, { label: 'ready-for-review:wip', created: 1499, outcomes: [dropped('t-reviewer', 'self-claim-label')] }),
      logged(2863, { label: 'ready-for-review', created: 1100, outcomes: [dropped('t-reviewer', 'wake-already-armed')] }),
      // #2820 / #2844: the add predates the moved team's triggers and arrived ~5 h late.
      logged(2820, { label: 'ready-for-review', created: 1094, logged: 784, outcomes: [dropped('t-reviewer', 'history-horizon')] }),
      logged(2844, { label: 'ready-for-review', created: 1087, logged: 780, outcomes: [dropped('t-reviewer', 'history-horizon')] }),
      // #2862: an earlier rework round, then only the swaps — the bare re-add never surfaced.
      logged(2862, { label: 'changes-requested', created: 1400, outcomes: [got('t-reworker', 'changes-requested')] }),
      logged(2862, { label: 'changes-requested:wip', created: 1399, outcomes: [dropped('t-reworker', 'self-claim-label')] }),
      logged(2862, { label: 'changes-requested:completed', created: 1300, outcomes: [dropped('t-reworker', 'self-claim-label')] }),
    ],
    ...extra,
  });
}

test('PARKED_WAKE_MS / wakeLost: one exported threshold and reason (#2872)', () => {
  assert.equal(fb.PARKED_WAKE_MS, 30 * 60 * 1000);
  assert.equal(fb.REASONS.wakeLost, 'wake never delivered');
});

test('buildFlowBoard: every constellation of the 2026-10-06 incident is flagged with its cause (#2872)', () => {
  const b = incident();
  const flag = (issueN) => b.rows.find((r) => r.id === `o/r#${issueN}`).needsHuman;
  for (const n of [2859, 2819, 2813, 2858]) {
    assert.equal(b.rows.find((r) => r.id === `o/r#${n}`).status, 'queued', `#${n} reads up next`);
    assert.equal(flag(n).reason, 'wake never delivered', `#${n}`);
  }
  assert.deepEqual(flag(2859).wakes, [{
    repo: 'o/r', number: 2863, kind: 'pr', label: 'ready-for-review', roles: [{ id: 't-reviewer', label: 'Code Reviewer' }],
    cause: 'wake-already-armed', eventId: 'ev-2863-ready-for-review-1100', since: iso(1100),
  }]);
  assert.deepEqual(flag(2819).wakes.map((w) => [w.number, w.cause, w.eventId, w.since]), [
    [2820, 'history-horizon', 'ev-2820-ready-for-review-1094', iso(1094)],
  ]);
  assert.equal(flag(2813).wakes[0].cause, 'history-horizon');
  // Never seen: no event to link, and the clock starts at the item's last update.
  assert.deepEqual(flag(2858).wakes, [{
    repo: 'o/r', number: 2862, kind: 'pr', label: 'changes-requested', roles: [{ id: 't-reworker', label: 'Reworker' }],
    cause: 'not-seen', eventId: null, since: iso(1000),
  }]);
  // The rows also land in "Needs you", with the per-label causes.
  const n = b.needsHuman.find((x) => x.id === 'o/r#2819');
  assert.equal(n.reason, 'wake never delivered');
  assert.equal(n.wakes[0].cause, 'history-horizon');
});

test('buildFlowBoard: two PRs of one issue parked on the same wake are both listed (#2820 + #2842, #2872)', () => {
  const b = board({
    github: {
      issues: [issue(2819)],
      prs: [
        pr(2820, { labels: ['ready-for-review'], closes: [2819], updatedAt: iso(900) }),
        pr(2842, { labels: ['ready-for-review'], closes: [2819], updatedAt: iso(900) }),
      ],
    },
    events: [
      logged(2820, { label: 'ready-for-review', created: 1094, logged: 784, outcomes: [dropped('t-reviewer', 'history-horizon')] }),
      logged(2842, { label: 'ready-for-review', created: 1100, logged: 784, outcomes: [dropped('t-reviewer', 'history-horizon')] }),
    ],
  });
  const row = b.rows.find((r) => r.id === 'o/r#2819');
  assert.deepEqual(row.needsHuman.wakes.map((w) => [w.number, w.cause]).sort(), [[2820, 'history-horizon'], [2842, 'history-horizon']]);
  assert.equal(row.needsHuman.since, iso(1100)); // the oldest parked wake
});

test('buildFlowBoard: any other drop reads as dropped with its reason; no consumer outcome as no-subscriber (#2872)', () => {
  const b = board({
    github: { prs: [pr(80, { labels: ['ready-for-review'], body: '<!-- agent: t-developer -->' }), pr(81, { labels: ['ready-for-review'], body: '<!-- agent: t-developer -->' })] },
    events: [
      logged(80, { label: 'ready-for-review', created: 200, outcomes: [dropped('t-reviewer', 'throttle')] }),
      logged(81, { label: 'ready-for-review', created: 200, outcomes: [got('t-developer', null)] }),
    ],
  });
  const w = (n) => b.rows.find((r) => r.id === `o/r#${n}`).needsHuman.wakes[0];
  assert.deepEqual([w(80).cause, w(80).dropReason], ['dropped', 'throttle']);
  assert.deepEqual([w(81).cause, w(81).dropReason], ['dropped', 'no-subscriber']);
});

test('buildFlowBoard: a delivered wake is never flagged, nor a re-add after a delivered round (#2872)', () => {
  const base = { github: { prs: [pr(90, { labels: ['ready-for-review'], body: '<!-- agent: t-developer -->' })] } };
  // Delivered on the label's own add.
  assert.equal(board({ ...base, events: [logged(90, { label: 'ready-for-review', created: 300, outcomes: [got('t-reviewer', 'ready-for-review')] })] }).rows[0].needsHuman, null);
  // Delivered through a collapsed multi-label event (attributed to another label).
  assert.equal(board({ ...base, events: [logged(90, { label: 'ux', created: 300, outcomes: [got('t-reviewer', 'ready-for-review')] })] }).rows[0].needsHuman, null);
  // Delivered to a pool instance of the consumer role.
  const pooled = SDLC.map((m) => (m.id === 't-reviewer' ? { ...m } : m)).concat([
    { id: 't-reviewer-i90', poolInstance: true, poolOf: 't-reviewer', poolItem: 90, poolRepo: 'o/r' },
  ]);
  assert.equal(board({ ...base, members: pooled, events: [logged(90, { label: 'ready-for-review', created: 300, outcomes: [got('t-reviewer-i90', 'ready-for-review')] })] }).rows[0].needsHuman, null);
  // Held by the WIP lane or a readiness gate counts as reached, too.
  assert.equal(board({ ...base, events: [logged(90, { label: 'ready-for-review', created: 300, outcomes: [{ agentId: 't-reviewer', status: 'held', reason: 'wip' }] })] }).rows[0].needsHuman, null);
  // A delivery to some other role does not vouch for the consumer.
  assert.equal(board({ ...base, events: [logged(90, { label: 'ready-for-review', created: 300, outcomes: [got('t-developer', 'ready-for-review'), dropped('t-reviewer', 'history-horizon')] })] }).rows[0].needsHuman.wakes[0].cause, 'history-horizon');
});

test('buildFlowBoard: a legacy delivered entry with no label stamp counts as delivered (#2872)', () => {
  // The pre-#1846 log shape — no event key, no label, no wakeLabel.
  const q = board({ github: { issues: [issue(23, { labels: ['ready-for-review'], updatedAt: iso(300) })] }, events: [delivered(23, 't-reviewer', 300)] });
  assert.equal(q.rows[0].needsHuman, null);
  // A comment delivered to the consumer is not a delivery of the wake.
  const c = board({
    github: { issues: [issue(24, { labels: ['ready-for-review'], updatedAt: iso(300) })] },
    events: [{ ...delivered(24, 't-reviewer', 300), event: 'issue_comment.created' }],
  });
  assert.equal(c.rows[0].needsHuman.wakes[0].cause, 'not-seen');
});

test('buildFlowBoard: a running, queued, gate-held or pooled consumer keeps the row unflagged (#2872)', () => {
  const ev = [logged(2820, { label: 'ready-for-review', created: 1094, logged: 784, outcomes: [dropped('t-reviewer', 'history-horizon')] })];
  const github = { issues: [issue(2819)], prs: [pr(2820, { labels: ['ready-for-review'], closes: [2819], updatedAt: iso(900) })] };
  const flagOf = (extra) => board({ github, events: ev, ...extra }).rows.find((r) => r.id === 'o/r#2819').needsHuman;
  assert.equal(flagOf({}).reason, 'wake never delivered');
  // A dispatch waiting in a queue (or held in the lane) for the issue or the PR.
  assert.equal(flagOf({ queued: [{ repo: 'o/r', numbers: [2819, 2820] }] }), null);
  assert.equal(flagOf({ queued: [{ repo: 'o/r', numbers: [2820] }] }), null);
  assert.equal(flagOf({ queued: [{ repo: 'o/other', numbers: [2820] }] }).reason, 'wake never delivered');
  // A hand-off held by its readiness gate.
  assert.equal(flagOf({ gateHolds: [{ repo: 'o/r', number: 2820, agentId: 't-reviewer', waitingFor: ['ci'], heldAt: iso(5) }] }), null);
  // A live pool instance for the item.
  const members = SDLC.concat([{ id: 't-reviewer-i2820', poolInstance: true, poolOf: 't-reviewer', poolItem: 2820, poolRepo: 'o/r' }]);
  assert.equal(flagOf({ members, pools: [{ agentId: 't-reviewer', roleId: 'reviewer', instances: [{ instanceId: 't-reviewer-i2820' }] }] }), null);
  // A running session on the PR (the row then reads working, not parked).
  const s = flagOf({ sessions: [{ agentId: 't-reviewer', session: { id: 's', startedAt: iso(2), workItem: { repo: 'o/r', number: 2820 } } }] });
  assert.equal(s, null);
});

test('buildFlowBoard: a wake within the threshold, or carrying its claim, is not parked (#2872)', () => {
  const at = (mins) => board({
    github: { prs: [pr(95, { labels: ['ready-for-review'], body: '<!-- agent: t-developer -->', updatedAt: iso(mins) })] },
    events: [logged(95, { label: 'ready-for-review', created: mins, outcomes: [dropped('t-reviewer', 'wake-already-armed')] })],
  }).rows[0].needsHuman;
  assert.equal(at(30), null);
  assert.equal(at(31).reason, 'wake never delivered');
  // Not seen and just updated: the Events API may still be on its way.
  const fresh = board({ github: { prs: [pr(96, { labels: ['ready-for-review'], body: '<!-- agent: t-developer -->', updatedAt: iso(10) })] } });
  assert.equal(fresh.rows[0].needsHuman, null);
  // A claimed wake is the needs-help case, never this one.
  const claimed = board({
    github: { prs: [pr(97, { labels: ['ready-for-review', 'ready-for-review:wip'], body: '<!-- agent: t-developer -->', updatedAt: iso(300) })] },
    events: [logged(97, { label: 'ready-for-review', created: 300, outcomes: [dropped('t-reviewer', 'history-horizon')] })],
  });
  assert.notEqual(claimed.rows[0].needsHuman && claimed.rows[0].needsHuman.reason, 'wake never delivered');
});

test('buildFlowBoard: a wake whose consumer is off stays "nobody picks it up", not parked (#2872)', () => {
  const offReviewer = SDLC.map((m) => (m.id === 't-reviewer' ? { ...m, enabled: false } : m));
  const b = board({
    members: offReviewer,
    github: { prs: [pr(98, { labels: ['ready-for-review'], body: '<!-- agent: t-developer -->', updatedAt: iso(300) })] },
    events: [logged(98, { label: 'ready-for-review', created: 300, outcomes: [dropped('t-reviewer', 'history-horizon')] })],
  });
  assert.equal(b.rows[0].needsHuman.reason, fb.REASONS.noConsumer);
});

test('buildFlowBoard: a removed-then-re-added wake whose re-add was never seen is not-seen (#2872)', () => {
  const b = board({
    github: { prs: [pr(99, { labels: ['ready-for-review'], body: '<!-- agent: t-developer -->', updatedAt: iso(200) })] },
    events: [
      logged(99, { label: 'ready-for-review', created: 500, outcomes: [got('t-reviewer', 'ready-for-review')] }),
      logged(99, { action: 'unlabeled', label: 'ready-for-review', created: 400, outcomes: [dropped('t-reviewer', 'label-filter')] }),
    ],
  });
  assert.deepEqual([b.rows[0].needsHuman.wakes[0].cause, b.rows[0].needsHuman.since], ['not-seen', iso(200)]);
});
