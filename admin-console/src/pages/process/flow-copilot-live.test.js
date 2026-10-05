// Flow Copilot on a live team (#2556) — diff → plan → run, pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  roleKeyOf, memberIdMap, bundleFingerprint, isStaleBase,
  diffLiveProposal, groupItems, describeLiveItem,
  planLiveApply, runLiveApply, summarizeLiveApply,
  inProgressFor, gateWarnings, liveConfirmModel, liveResultStatus,
  carryUnauthored,
} from './flow-copilot-live.js';

// The server-side copilot pipeline (sanitize → ops) every live proposal passes
// through — used below so the tests see exactly the keys a real turn keeps.
const { applyCopilotOps, sanitizeBundle } = createRequire(import.meta.url)('../../../api/flow-copilot.js');

const LIVE = {
  processTemplateVersion: 1, name: 'Acme', level: 'live',
  stages: ['build', 'review'],
  labels: [{ name: 'ready', humanGate: true, brake: false }, { name: 'ready-for-review', humanGate: false, brake: false }],
  humans: [{ id: 'po', name: 'Product owner', consumes: [{ artifact: 'pr', from: 'developer' }] }],
  roles: [
    {
      id: 'developer', displayName: 'Developer', sessionPolicy: 'persistent', systemPrompt: 'Build it.',
      stage: 'build', triggers: [{ id: 't1', type: 'cron', cron: '0 * * * *', prompt: 'tick' }],
    },
    {
      id: 'reviewer', displayName: 'Reviewer', sessionPolicy: 'persistent', systemPrompt: 'Review it.',
      stage: 'review', channels: [{ artifact: 'pr', from: 'developer', label: 'ready-for-review' }], triggers: [],
    },
    { id: 'tester', displayName: 'Tester', sessionPolicy: 'persistent', systemPrompt: 'Test it.', triggers: [] },
  ],
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const MEMBERS = ['acme-developer', 'acme-reviewer', 'tester'];

function proposal() {
  const p = clone(LIVE);
  // changed: reviewer prompt + stage; developer gets a new trigger, drops t1
  p.roles[1].systemPrompt = 'Review it carefully.';
  p.roles[0].triggers = [{ id: 't2', type: 'cron', cron: '5 * * * *', prompt: 'tock' }];
  // added: a documenter wired to the developer
  p.roles.push({
    id: 'documenter', displayName: 'Documenter', sessionPolicy: 'persistent', systemPrompt: 'Write docs.',
    stage: 'review', dependsOn: ['developer'], triggers: [],
    outcomes: { mode: 'anyOf', options: [{ id: 'done', title: 'Done', actions: [{ type: 'wakeAgent', to: 'reviewer' }] }] },
  });
  // removed: tester; removed human po; added stage + label
  p.roles = p.roles.filter(r => r.id !== 'tester');
  p.humans = [];
  p.stages = ['build', 'review', 'docs'];
  p.labels.push({ name: 'ready-2', humanGate: true, brake: false });
  return p;
}

test('roleKeyOf / memberIdMap mirror the export and the live Add-role id', () => {
  assert.equal(roleKeyOf('acme-developer', 'acme'), 'developer');
  assert.equal(roleKeyOf('tester', 'acme'), 'tester');
  const to = memberIdMap('acme', MEMBERS);
  assert.equal(to('developer'), 'acme-developer');
  assert.equal(to('tester'), 'tester', 'an unprefixed member keeps its real id');
  assert.equal(to('documenter'), 'acme-documenter', 'a new role gets <teamId>-<key>');
});

test('AC15: fingerprint ignores presentation, catches any content change', () => {
  const renamed = { ...clone(LIVE), name: 'Other', level: 'template' };
  assert.equal(isStaleBase(LIVE, renamed), false);
  const edited = clone(LIVE); edited.roles[0].stage = 'review';
  assert.equal(isStaleBase(LIVE, edited), true);
  const reordered = Object.fromEntries(Object.entries(clone(LIVE)).reverse());
  assert.equal(bundleFingerprint(LIVE), bundleFingerprint(reordered), 'key order does not matter');
});

test('AC3: changes are grouped added/changed/removed and name their entity', () => {
  const d = diffLiveProposal(LIVE, proposal());
  const g = groupItems(d.items);
  const lines = (arr) => arr.map(describeLiveItem);
  assert.deepEqual(lines(g.added), ['Agent “Documenter” added', 'Stage “docs” added', 'Label “ready-2” added']);
  assert.deepEqual(lines(g.changed), ['Agent “Developer” changed (triggers)', 'Agent “Reviewer” changed (prompt)']);
  assert.deepEqual(lines(g.removed), ['Agent “Tester” removed', 'Human “Product owner” removed']);
});

test('AC14: agent/human removals are separate opt-in items', () => {
  const d = diffLiveProposal(LIVE, proposal());
  const removals = d.items.filter(i => i.removal);
  assert.deepEqual(removals.map(i => i.key), ['role:removed:tester', 'human:removed:po']);
});

test('edge: a human-gate label change is flagged for the confirmation', () => {
  const p = clone(LIVE);
  p.labels = p.labels.filter(l => l.name !== 'ready');
  p.labels.push({ name: 'approved', humanGate: true });
  assert.deepEqual(gateWarnings(diffLiveProposal(LIVE, p).items), ['Label “approved” added', 'Label “ready” removed']);
  const q = clone(LIVE); q.labels[1].humanGate = true; // non-gate becomes a gate
  assert.deepEqual(gateWarnings(diffLiveProposal(LIVE, q).items), ['Label “ready-for-review” changed']);
});

test('AC6: changes with no live write path are listed as not applicable', () => {
  const p = clone(LIVE);
  p.roles[0].sessionPolicy = 'per-invocation';
  p.name = 'Renamed';
  p.hillClimb = { enabled: true };
  const d = diffLiveProposal(LIVE, p);
  const na = d.items.filter(i => !i.applicable).map(i => i.name);
  assert.deepEqual(na.sort(), ['Developer', 'hill-climb collector', 'team name']);
  const plan = planLiveApply(d, { teamId: 'acme', memberIds: MEMBERS });
  assert.equal(plan.steps.length, 0, 'nothing applicable → no writes');
  assert.equal(plan.notApplied.length, 3);
});

test('an unchanged proposal produces no items and no steps', () => {
  const d = diffLiveProposal(LIVE, clone(LIVE));
  assert.deepEqual(d.items, []);
  assert.deepEqual(planLiveApply(d, { teamId: 'acme', memberIds: MEMBERS }).steps, []);
});

test('plan: registry first, create before wiring, humans after members, removals last', () => {
  const d = diffLiveProposal(LIVE, proposal());
  const plan = planLiveApply(d, { teamId: 'acme', memberIds: MEMBERS, selectedRemovals: ['role:removed:tester', 'human:removed:po'] });
  assert.deepEqual(plan.steps.map(s => s.label), [
    'stages', 'labels',
    'create Documenter',
    'create trigger t2', 'delete trigger t1', // Developer: only its triggers changed
    'update Reviewer',
    'update Documenter',
    'humans',
    'remove Tester',
  ]);
  const create = plan.steps.find(s => s.label === 'create Documenter');
  assert.deepEqual(create.body, { id: 'acme-documenter', displayName: 'Documenter', systemPromptOverride: 'Write docs.', sessionPolicy: 'persistent', materialize: false }, 'a new agent is a stub by default, like the Add-agent dialog (#2558)');
  const wire = plan.steps.find(s => s.label === 'update Documenter');
  assert.equal(wire.url, '/api/agents/acme-documenter');
  assert.deepEqual(wire.body.dataFlow, { inputs: [], outputs: [], dependsOn: ['acme-developer'] }, 'role keys map back to member ids');
  assert.equal(wire.body.outcomes.options[0].actions[0].to, 'acme-reviewer');
  assert.equal(wire.body.stage, 'review');
  assert.equal(wire.body.systemPrompt, undefined, 'the prompt rode on the create');
  assert.deepEqual(plan.steps.find(s => s.label === 'update Reviewer').body, { promptMode: 'exclusive', systemPrompt: 'Review it carefully.' });
  assert.equal(plan.steps.find(s => s.label === 'remove Tester').url, '/api/agents/tester');
  assert.deepEqual(plan.steps.find(s => s.label === 'humans').body, { humans: [] });
  assert.equal(plan.steps.find(s => s.label === 'delete trigger t1').url, '/api/agents/acme-developer/triggers/t1');
});

test('AC14 edge: with every removal unticked, the rest is still applied and nothing is removed', () => {
  const d = diffLiveProposal(LIVE, proposal());
  const plan = planLiveApply(d, { teamId: 'acme', memberIds: MEMBERS, selectedRemovals: [] });
  assert.equal(plan.steps.some(s => s.method === 'DELETE' && s.url === '/api/agents/tester'), false);
  assert.equal(plan.steps.some(s => s.label === 'humans'), false, 'an unticked human removal writes nothing');
  assert.ok(plan.steps.some(s => s.label === 'create Documenter'));
  assert.deepEqual(plan.skippedRemovals.map(i => i.key), ['role:removed:tester', 'human:removed:po']);
});

test('an unticked human removal keeps the human when other humans change', () => {
  const p = clone(LIVE);
  p.humans = [{ id: 'qa', name: 'QA lead', consumes: [{ artifact: 'pr', from: 'reviewer' }] }];
  const plan = planLiveApply(diffLiveProposal(LIVE, p), { teamId: 'acme', memberIds: MEMBERS });
  const h = plan.steps.find(s => s.label === 'humans');
  assert.deepEqual(h.body.humans.map(x => x.id), ['qa', 'po']);
  assert.equal(h.body.humans[0].consumes[0].from, 'acme-reviewer');
  assert.equal(h.body.humans[1].consumes[0].from, 'acme-developer');
});

test('a trigger with {{placeholders}} is never written', () => {
  const p = clone(LIVE);
  p.roles[0].triggers.push({ id: 'gh', type: 'github-event', events: ['issues.labeled'], repo: '{{repoFullName}}' });
  const plan = planLiveApply(diffLiveProposal(LIVE, p), { teamId: 'acme', memberIds: MEMBERS });
  assert.equal(plan.steps.some(s => s.op === 'createTrigger'), false);
});

test('AC7: a failed step does not stop the rest; its item is reported failed', async () => {
  const d = diffLiveProposal(LIVE, proposal());
  const plan = planLiveApply(d, { teamId: 'acme', memberIds: MEMBERS, selectedRemovals: ['role:removed:tester'] });
  const seen = [];
  const res = await runLiveApply(plan, async (step) => {
    seen.push(step.label);
    if (step.label === 'update Reviewer') throw new Error('403 forbidden');
  });
  assert.equal(seen.length, plan.steps.length, 'every step ran');
  assert.deepEqual(res.failed, [{ key: 'role:changed:reviewer', error: 'update Reviewer: 403 forbidden' }]);
  assert.ok(res.applied.includes('role:added:documenter'));
  assert.ok(!res.applied.includes('role:changed:reviewer'));
  const s = summarizeLiveApply(d, res);
  assert.equal(s.ok, false, 'a partial apply never reads as success');
  assert.match(s.text, /^Partly applied: \d+ change\(s\) applied, 1 failed\./);
  assert.match(s.text, /Failed:\n- Agent “Reviewer” changed \(prompt\) — update Reviewer: 403 forbidden/);
  assert.match(s.text, /Left in place:\n- Human “Product owner” removed — kept \(not ticked\)/);
});

test('AC6: not-applied items are named again in the result message', async () => {
  const p = proposal(); p.roles[0].sessionPolicy = 'per-invocation';
  const d = diffLiveProposal(LIVE, p);
  const res = await runLiveApply(planLiveApply(d, { teamId: 'acme', memberIds: MEMBERS }), async () => {});
  const s = summarizeLiveApply(d, res);
  assert.equal(s.ok, true);
  assert.match(s.text, /Not applied \(not supported on a live team\):\n- Agent “Developer” changed \(session policy\)/);
});

test('AC14: in-progress work comes from the ticket ledger; unknown when unreadable', () => {
  const tickets = [
    { ownerAgentId: 'tester', state: 'in-progress', kind: 'issue', number: 7, title: 'Flaky', url: 'u', prNumber: 9, prState: 'open' },
    { ownerAgentId: 'tester', state: 'done', kind: 'issue', number: 8 },
    { ownerAgentId: 'acme-developer', state: 'in-progress', kind: 'issue', number: 10 },
  ];
  assert.deepEqual(inProgressFor(tickets, 'tester'), [{ label: 'Issue #7 Flaky', url: 'u', openPr: true }]);
  assert.deepEqual(inProgressFor([], 'tester'), []);
  assert.equal(inProgressFor(null, 'tester'), null);
});

test('liveConfirmModel separates removals (with in-progress work) from the grouped changes', () => {
  const live = {
    roles: [
      { id: 'developer', displayName: 'Developer', sessionPolicy: 'persistent', systemPrompt: 'a', triggers: [] },
      { id: 'tester', displayName: 'Tester', sessionPolicy: 'persistent', systemPrompt: 't', triggers: [] },
    ],
    humans: [{ id: 'po', name: 'Product owner' }],
    labels: [{ name: 'ready', humanGate: true }],
  };
  const proposed = {
    roles: [
      { id: 'developer', displayName: 'Developer', sessionPolicy: 'per-invocation', systemPrompt: 'b', triggers: [] },
      { id: 'documenter', displayName: 'Documenter', sessionPolicy: 'persistent', systemPrompt: 'd', triggers: [] },
    ],
    humans: [],
    labels: [],
  };
  const tickets = [
    { kind: 'issue', number: 7, title: 'Flaky test', url: 'https://x/7', state: 'in-progress', ownerAgentId: 'acme-tester' },
    { kind: 'issue', number: 8, title: 'Done', state: 'done', ownerAgentId: 'acme-tester' },
  ];
  const m = liveConfirmModel(diffLiveProposal(live, proposed), { teamId: 'acme', memberIds: ['acme-developer', 'acme-tester'], tickets });
  assert.deepEqual(m.groups.added.map(i => i.id), ['documenter']);
  assert.deepEqual(m.groups.changed.map(i => i.id), ['developer']);
  assert.deepEqual(m.groups.removed.map(i => i.key), ['label:removed:ready'], 'role and human removals are their own opt-in rows');
  const tester = m.removals.find(r => r.key === 'role:removed:tester');
  assert.deepEqual(tester.inProgress.map(w => w.label), ['Issue #7 Flaky test']);
  assert.deepEqual(m.removals.find(r => r.key === 'human:removed:po').inProgress, []);
  assert.equal(m.notApplied.length, 1);
  assert.match(m.notApplied[0], /session policy/);
  assert.equal(m.gates.length, 1, 'removing a human-gate label is flagged');
  assert.equal(m.empty, false);

  const unknown = liveConfirmModel(diffLiveProposal(live, proposed), { teamId: 'acme', memberIds: [], tickets: null });
  assert.equal(unknown.removals.find(r => r.key === 'role:removed:tester').inProgress, null, 'unreadable ledger → unknown, not "no work"');
});

test('liveConfirmModel is empty when only unsupported changes remain', () => {
  const live = { roles: [{ id: 'dev', sessionPolicy: 'persistent', triggers: [] }] };
  const proposed = { roles: [{ id: 'dev', sessionPolicy: 'per-invocation', triggers: [] }] };
  const m = liveConfirmModel(diffLiveProposal(live, proposed), { teamId: 't' });
  assert.equal(m.empty, true);
  assert.equal(m.notApplied.length, 1);
});

test('liveResultStatus never reports success for a partial or failed apply', () => {
  assert.equal(liveResultStatus({ ok: true, applied: ['a'] }), 'applied');
  assert.equal(liveResultStatus({ ok: false, applied: ['a'], failed: ['b'] }), 'partial');
  assert.equal(liveResultStatus({ ok: false, applied: [], failed: ['b'] }), 'failed');
});

test('plan: materializeNow provisions the new agents instead of stubbing them', () => {
  const plan = planLiveApply(diffLiveProposal(LIVE, proposal()), { teamId: 'acme', memberIds: MEMBERS, materializeNow: true });
  assert.equal(plan.steps.find(s => s.label === 'create Documenter').body.materialize, true);
});

// ── review #2565 B1: fields the copilot sanitizer strips ─────────────────────

const POOLED_LIVE = () => {
  const l = clone(LIVE);
  l.wipLimit = 2;
  l.autoDispatch = { enabled: true, contentionPolicy: 'epic-serial' };
  l.hillClimb = { enabled: true, windowDays: 7 };
  l.roles[0].pool = { enabled: true, maxInstances: 3 };
  return l;
};

test('B1: a real copilot turn (applyCopilotOps) does not switch off the supervisor, hill-climb or a pool', () => {
  const live = POOLED_LIVE();
  const proposed = applyCopilotOps(live, [{ op: 'patchRole', id: 'reviewer', patch: { displayName: 'Code Reviewer' } }]);
  assert.equal(proposed.autoDispatch, undefined, 'precondition: the sanitizer strips autoDispatch');
  assert.equal(proposed.roles[0].pool, undefined, 'precondition: the sanitizer strips a role pool');
  const diff = diffLiveProposal(live, proposed);
  assert.deepEqual(diff.items.map(it => it.key), ['role:changed:reviewer']);
  assert.deepEqual(diff.items[0].fields, ['name']);
  const plan = planLiveApply(diff, { teamId: 'acme', memberIds: MEMBERS });
  assert.deepEqual(plan.notApplied, []);
  for (const st of plan.steps) {
    assert.ok(!('autoDispatch' in (st.body || {})), `${st.label} must not write autoDispatch`);
    assert.ok(!('pool' in (st.body || {})), `${st.label} must not write pool`);
  }
});

test('B1: a whole-bundle reply (sanitizeBundle) carries the unauthored fields over too', () => {
  const live = POOLED_LIVE();
  const proposed = sanitizeBundle(clone(live));
  assert.deepEqual(diffLiveProposal(live, proposed).items, []);
});

// ── review #2565 B2: a trigger setting the proposal drops ────────────────────

const GH_LIVE = () => {
  const l = clone(LIVE);
  l.roles[1].triggers = [{
    id: 'rv', type: 'github-event', enabled: true, events: ['pull_request.labeled'], labelFilter: 'ready-for-review',
    claim: { remove: 'ready-for-review', add: 'ready-for-review:wip' }, prompt: 'Review.',
  }];
  return l;
};

test('B2: dropping a trigger setting is reported as not applied, never claimed applied', async () => {
  const live = GH_LIVE();
  const proposed = clone(live);
  delete proposed.roles[1].triggers[0].labelFilter;
  delete proposed.roles[1].triggers[0].claim;
  const diff = diffLiveProposal(live, proposed);
  assert.deepEqual(diff.items.map(it => [it.key, it.applicable]), [['role:changed:reviewer#triggerSettings', false]]);
  assert.match(diff.items[0].reason, /labelFilter, claim on rv/);
  const plan = planLiveApply(diff, { teamId: 'acme', memberIds: MEMBERS });
  assert.deepEqual(plan.steps, [], 'no PUT that the route would merge back to the old value');
  const cm = liveConfirmModel(diff, { teamId: 'acme', memberIds: MEMBERS, tickets: [] });
  assert.equal(cm.notApplied.length, 1);
  assert.match(cm.notApplied[0], /not supported on a live team/);
  const summary = summarizeLiveApply(diff, await runLiveApply(plan, async () => {}));
  assert.deepEqual(summary.applied, []);
  assert.match(summary.text, /Not applied[\s\S]*labelFilter, claim on rv/);
});

test('B2: a dropped setting next to a real edit — the edit applies, the drop is listed', () => {
  const live = GH_LIVE();
  const proposed = clone(live);
  delete proposed.roles[1].triggers[0].labelFilter;
  proposed.roles[1].triggers[0].prompt = 'Review carefully.';
  const diff = diffLiveProposal(live, proposed);
  assert.deepEqual(diff.items.map(it => [it.key, it.applicable]), [
    ['role:changed:reviewer', true], ['role:changed:reviewer#triggerSettings', false],
  ]);
  const plan = planLiveApply(diff, { teamId: 'acme', memberIds: MEMBERS });
  assert.deepEqual(plan.steps.map(s => s.label), ['update trigger rv']);
  assert.deepEqual(plan.notApplied.map(it => it.key), ['role:changed:reviewer#triggerSettings']);
});

test('carryUnauthored keeps portable role settings and the team prompt a proposal omits (#2813)', () => {
  const live = {
    teamPrompt: 'Team {{teamName}}',
    roles: [{ id: 'dev', memoryLimit: '4g', model: 'm1', promptMode: 'additional', pool: { enabled: true } }],
  };
  const out = carryUnauthored(live, { roles: [{ id: 'dev', displayName: 'Dev' }] });
  assert.equal(out.teamPrompt, 'Team {{teamName}}');
  assert.deepEqual(
    { memoryLimit: out.roles[0].memoryLimit, model: out.roles[0].model, promptMode: out.roles[0].promptMode },
    { memoryLimit: '4g', model: 'm1', promptMode: 'additional' },
  );
  // An explicit value in the proposal still wins.
  assert.equal(carryUnauthored(live, { roles: [{ id: 'dev', memoryLimit: '2g' }] }).roles[0].memoryLimit, '2g');
});
