'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProcessTemplate, validateProcessTemplate, templateToCustomRoles, buildMemberFromTemplate, liftTriggerEmits, expandGithubChannels, normalizeLegacyReview, expandDataFlowSteps, stampDerivedActivation, emptyDraftBundle, roleKeyOf, slugifyDraft, deriveUniqueDraftId } = require('./process-template');

// A tiny stand-in for the on-disk draft store: an id is "taken" iff present.
const existsIn = (set) => (id) => set.has(id);

test('slugifyDraft normalizes name → slug (unchanged rules)', () => {
  assert.equal(slugifyDraft('Q3 Roadmap'), 'q3-roadmap');
  assert.equal(slugifyDraft('  Hello, World!  '), 'hello-world');
  assert.equal(slugifyDraft('--Trim--'), 'trim');
  assert.equal(slugifyDraft(''), 'process');
  assert.equal(slugifyDraft('💥🚀'), 'process');
  assert.equal(slugifyDraft('x'.repeat(60)).length, 48);
});

test('deriveUniqueDraftId derives a fresh slug when nothing is taken', () => {
  assert.equal(deriveUniqueDraftId('Q3 Roadmap', { exists: existsIn(new Set()) }), 'q3-roadmap');
});

test('deriveUniqueDraftId appends -2/-3 on collision (AC4)', () => {
  const taken = new Set(['q3-roadmap', 'q3-roadmap-2']);
  assert.equal(deriveUniqueDraftId('Q3 Roadmap', { exists: existsIn(taken) }), 'q3-roadmap-3');
});

test('deriveUniqueDraftId keeps distinct slugs distinct for similar names', () => {
  const taken = new Set(['q3-roadmap']);
  // "Q3 – Roadmap" slugifies to the same base, so it must get a suffix.
  assert.equal(deriveUniqueDraftId('Q3 – Roadmap', { exists: existsIn(taken) }), 'q3-roadmap-2');
});

test('deriveUniqueDraftId treats the draft own id as free — no spurious -2 (AC8)', () => {
  const taken = new Set(['q3-roadmap']); // only this draft exists
  // Renaming to a name whose slug equals its own current id is a no-op.
  assert.equal(deriveUniqueDraftId('Q3 Roadmap', { currentId: 'q3-roadmap', exists: existsIn(taken) }), 'q3-roadmap');
});

test('deriveUniqueDraftId re-keys off a suffixed id back to the clean base when free', () => {
  const taken = new Set(['q3-roadmap-2']); // the other q3-roadmap draft is gone
  assert.equal(deriveUniqueDraftId('Q3 Roadmap', { currentId: 'q3-roadmap-2', exists: existsIn(taken) }), 'q3-roadmap');
});

test('deriveUniqueDraftId keeps a suffix when the clean base is taken by another draft', () => {
  const taken = new Set(['q3-roadmap', 'q3-roadmap-2']); // base owned by another draft; self is -2
  assert.equal(deriveUniqueDraftId('Q3 Roadmap', { currentId: 'q3-roadmap-2', exists: existsIn(taken) }), 'q3-roadmap-2');
});

test('deriveUniqueDraftId falls back to process for an empty slug and stays unique', () => {
  assert.equal(deriveUniqueDraftId('💥', { exists: existsIn(new Set(['process'])) }), 'process-2');
});

const sampleRoles = [
  {
    id: 'acme-developer', displayName: 'Developer', role: 'team-member', sessionPolicy: 'per-invocation',
    systemPrompt: 'You implement issues.',
    // Label hand-offs live at the role level (#414/#783), not on triggers.
    emits: ['started:dev'],
    triggers: [
      { id: 'dev-assigned', type: 'github-event', enabled: true, events: ['issues.labeled'],
        from: 'any-except-self', labelFilter: 'assigned:dev', repo: 'acme/app',
        prompt: 'Implement it.', description: 'assigned' },
      { id: 'curate', type: 'cron', enabled: true, cron: '5 3 * * 1', prompt: 'Tidy memory.' },
    ],
  },
];

test('liftTriggerEmits: legacy trigger-level emits are lifted to role level (#783 AC7)', () => {
  const legacy = {
    processTemplateVersion: 1, name: 'legacy', level: 'template',
    roles: [
      { id: 'triage', systemPrompt: 'p', triggers: [
        { id: 't', type: 'github-event', events: ['issues.opened'], emits: ['req:refine'], emitsDerived: true },
      ] },
      { id: 'dev', systemPrompt: 'p', emits: ['ready'], triggers: [
        { id: 't2', type: 'github-event', events: ['x'], emits: ['ready', 'started:dev'] },
      ] },
      { id: 'plain', systemPrompt: 'p', triggers: [{ id: 't3', type: 'cron', cron: '0 9 * * 1' }] },
    ],
  };
  const lifted = liftTriggerEmits(legacy);
  // triage: role gains the trigger's label; trigger loses emits/emitsDerived.
  assert.deepEqual(lifted.roles[0].emits, ['req:refine']);
  assert.ok(!('emits' in lifted.roles[0].triggers[0]));
  assert.ok(!('emitsDerived' in lifted.roles[0].triggers[0]));
  // dev: role emit + trigger emits merge, deduped, role-first order.
  assert.deepEqual(lifted.roles[1].emits, ['ready', 'started:dev']);
  assert.ok(!('emits' in lifted.roles[1].triggers[0]));
  // plain: untouched, no emits introduced.
  assert.ok(!('emits' in lifted.roles[2]));
  // Idempotent: a second pass changes nothing.
  assert.deepEqual(liftTriggerEmits(lifted), lifted);
});

test('roleKeyOf strips the team prefix', () => {
  assert.equal(roleKeyOf('acme-developer', 'acme'), 'developer');
  assert.equal(roleKeyOf('developer', 'acme'), 'developer');
  assert.equal(roleKeyOf('developer', undefined), 'developer');
});

test('buildProcessTemplate shapes a versioned bundle and drops team-specifics', () => {
  const b = buildProcessTemplate({
    name: 'Acme', level: 'live', teamId: 'acme', roles: sampleRoles,
    gates: [{ label: 'human:td-approved' }], labels: [{ name: 'assigned:dev', humanGate: false, brake: false }],
  });
  assert.equal(b.processTemplateVersion, 1);
  assert.equal(b.name, 'Acme');
  assert.equal(b.roles.length, 1);
  const r = b.roles[0];
  assert.equal(r.id, 'developer');         // team prefix stripped
  assert.equal(r.sessionPolicy, 'per-invocation');
  assert.equal(r.systemPrompt, 'You implement issues.');
  // Label hand-offs are carried at the role level (#783), not on triggers.
  assert.deepEqual(r.emits, ['started:dev']);
  const t = r.triggers[0];
  assert.equal(t.labelFilter, 'assigned:dev');
  assert.ok(!('emits' in t), 'trigger-level emits removed (#783)');
  assert.equal(t.prompt, 'Implement it.');
  assert.ok(!('repo' in t), 'repo is team-specific and must not be in the bundle');
  assert.ok(!('from' in t), 'origin filter removed — triggers fire on any matching event');
  assert.deepEqual(b.gates, [{ label: 'human:td-approved' }]);
});

test('validateProcessTemplate accepts a built bundle and rejects junk', () => {
  const b = buildProcessTemplate({ name: 'x', level: 'template', roles: sampleRoles });
  assert.equal(validateProcessTemplate(b).ok, true);
  assert.equal(validateProcessTemplate(null).ok, false);
  assert.equal(validateProcessTemplate({ processTemplateVersion: 99, roles: [] }).ok, false);
  assert.equal(validateProcessTemplate({ processTemplateVersion: 1, roles: [] }).ok, false);
  assert.equal(validateProcessTemplate({ processTemplateVersion: 1, roles: [{}] }).ok, false);
});

test('templateToCustomRoles maps to the /api/teams pseudo-template shape', () => {
  const b = buildProcessTemplate({ name: 'x', level: 'live', teamId: 'acme', roles: sampleRoles });
  const cr = templateToCustomRoles(b);
  assert.equal(cr.length, 1);
  const role = cr[0];
  assert.equal(role.id, 'developer');
  assert.equal(role.sessionPolicy, 'per-invocation');
  assert.equal(role.promptTemplate, 'You implement issues.');
  // trigger prompt is carried as promptTemplate (what the materialiser renders)
  const t = role.triggers.find(x => x.id === 'dev-assigned');
  assert.equal(t.promptTemplate, 'Implement it.');
  assert.equal(t.labelFilter, 'assigned:dev');
  assert.ok(!('emits' in t), 'trigger-level emits removed (#783)');
  // Label hand-offs are carried at the role level.
  assert.deepEqual(role.emits, ['started:dev']);
});

test('stage: per-role stage + ordered stages survive build → customRoles (#stage-order)', () => {
  const staged = [{ ...sampleRoles[0], stage: 'build' }];
  const b = buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme', roles: staged, stages: ['intake', 'build'],
  });
  // Ordered stage list is portable on the bundle...
  assert.deepEqual(b.stages, ['intake', 'build']);
  // ...and each role carries its stage band...
  assert.equal(b.roles[0].stage, 'build');
  // ...through to the /api/teams pseudo-template shape so the materialised
  // member records it and the live graph reproduces the draft layout.
  const cr = templateToCustomRoles(b);
  assert.equal(cr[0].stage, 'build');
  // A role with no stage carries none (inherit signal), not an empty string.
  const noStage = templateToCustomRoles(buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme', roles: sampleRoles,
  }));
  assert.equal('stage' in noStage[0], false);
});

test('round-trip: build → validate → customRoles preserves wiring', () => {
  const b = buildProcessTemplate({ name: 'rt', level: 'live', teamId: 'acme', roles: sampleRoles });
  assert.equal(validateProcessTemplate(b).ok, true);
  const cr = templateToCustomRoles(b);
  assert.deepEqual(cr.map(r => r.id), ['developer']);
  // Label hand-off preserved at the role level through the round-trip (#783).
  assert.deepEqual(cr[0].emits, ['started:dev']);
  assert.ok(!('emits' in cr[0].triggers.find(t => t.id === 'dev-assigned')));
});

test('emptyDraftBundle is a valid draft (empty roles) but not a materialisable template', () => {
  const d = emptyDraftBundle('My Process');
  assert.equal(d.processTemplateVersion, 1);
  assert.equal(d.name, 'My Process');
  assert.deepEqual(d.roles, []);
  // strict (materialise) rejects empty roles; draft mode allows it
  assert.equal(validateProcessTemplate(d).ok, false);
  assert.equal(validateProcessTemplate(d, { allowEmptyRoles: true }).ok, true);
});

test('validateProcessTemplate checks gates/labels are arrays', () => {
  const base = emptyDraftBundle('x');
  assert.equal(validateProcessTemplate({ ...base, gates: {} }, { allowEmptyRoles: true }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, labels: 'no' }, { allowEmptyRoles: true }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, roles: [{ id: 'a', triggers: 'no' }] }, { allowEmptyRoles: true }).ok, false);
});

test('expandGithubChannels: a consumer channel yields a scoped PR-opened trigger', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'rev', level: 'template',
    roles: [
      { id: 'developer', displayName: 'Developer', systemPrompt: 'build', github: { producesPr: true }, triggers: [] },
      { id: 'reviewer', displayName: 'Reviewer', channels: [{ artifact: 'pr', from: 'developer' }], triggers: [] },
      { id: 'release', displayName: 'Release', systemPrompt: 'ship', triggers: [] },
    ],
    gates: [], labels: [],
  };
  const out = expandGithubChannels(bundle, { teamId: 'acme' });
  const reviewer = out.roles.find(r => r.id === 'reviewer');
  // New id scheme drops the producer (#826): `<consumer>-on-<artifact>[-<label>]`.
  const t = reviewer.triggers.find(t => t.id === 'reviewer-on-pr');
  assert.ok(t);
  assert.equal(t.channel, true);
  assert.deepEqual(t.events, ['pull_request.opened', 'pull_request.reopened']);
  assert.deepEqual(t.sources, ['developer']); // provenance: the one contributing producer
  assert.ok(!('from' in t), 'no origin filter — the trigger fires on any matching PR event');
  assert.equal(t.labelFilter, undefined);
  // non-consumer roles untouched
  assert.equal(out.roles.find(r => r.id === 'release').triggers.length, 0);
});

test('expandGithubChannels: a labelled human gate reacts to *.labeled (label-only, no origin filter)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'dev', github: { producesPr: true }, triggers: [] },
      { id: 'deployer', channels: [{ artifact: 'pr', from: 'dev', label: 'approved', gate: 'human' }], triggers: [] },
    ],
  };
  const out = expandGithubChannels(bundle);
  const t = out.roles.find(r => r.id === 'deployer').triggers[0];
  assert.deepEqual(t.events, ['pull_request.labeled']);
  assert.equal(t.labelFilter, 'approved');
  // The human gate is expressed purely by the `approved` label convention —
  // no origin filter. A human applies the label; agents don't, by convention.
  assert.ok(!('from' in t), 'human gate is label-only');
});

test('expandGithubChannels: regenerates (strips stale) derived channel triggers, idempotent', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'dev', github: { producesIssue: true }, triggers: [] },
      { id: 'triage', channels: [{ artifact: 'issue', from: 'dev' }], triggers: [] },
    ],
  };
  const once = expandGithubChannels(bundle);
  const twice = expandGithubChannels(once);
  const triage = twice.roles.find(r => r.id === 'triage');
  assert.equal(triage.triggers.filter(t => t.id === 'triage-on-issue').length, 1);
  assert.deepEqual(triage.triggers[0].events, ['issues.opened']);
});

test('expandGithubChannels: two same-label channels from different producers → ONE listener with both sources (\#826)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'consolidate', level: 'template',
    roles: [
      { id: 'ba1', displayName: 'BA One', github: { producesIssue: true }, triggers: [] },
      { id: 'ba2', displayName: 'BA Two', github: { producesIssue: true }, triggers: [] },
      { id: 'dispatcher', displayName: 'Dispatcher',
        channels: [
          { artifact: 'issue', from: 'ba1', label: 'dispatch' },
          { artifact: 'issue', from: 'ba2', label: 'dispatch' },
        ], triggers: [] },
    ],
  };
  const out = expandGithubChannels(bundle);
  const disp = out.roles.find(r => r.id === 'dispatcher');
  const listeners = disp.triggers.filter(t => t.channel);
  assert.equal(listeners.length, 1, 'exactly one derived trigger for the shared (events, labelFilter)');
  const t = listeners[0];
  assert.equal(t.id, 'dispatcher-on-issue-dispatch'); // new id scheme, producer dropped
  assert.deepEqual(t.events, ['issues.labeled']);
  assert.equal(t.labelFilter, 'dispatch');
  assert.deepEqual(t.sources, ['ba1', 'ba2']); // both producers recorded (informational)
  assert.ok(!('from' in t), 'no origin filter');
  assert.match(t.description, /BA One, BA Two/); // display names of both sources
});

test('expandGithubChannels: distinct (artifact,label) pairs stay separate listeners (\#826)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'split', level: 'template',
    roles: [
      { id: 'dev', github: { producesPr: true }, triggers: [] },
      { id: 'consumer', channels: [
        { artifact: 'pr', from: 'dev' },                       // pr.opened, no label
        { artifact: 'pr', from: 'dev', label: 'approved' },    // pr.labeled + approved
      ], triggers: [] },
    ],
  };
  const out = expandGithubChannels(bundle);
  const c = out.roles.find(r => r.id === 'consumer');
  const ids = c.triggers.filter(t => t.channel).map(t => t.id).sort();
  assert.deepEqual(ids, ['consumer-on-pr', 'consumer-on-pr-approved']);
});

test('expandGithubChannels: appends an idempotent producer block; buildProcessTemplate strips it', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [{ id: 'dev', displayName: 'Dev', systemPrompt: 'Base prompt.', github: { producesPr: true }, triggers: [] }],
  };
  const once = expandGithubChannels(bundle);
  const p1 = once.roles[0].systemPrompt;
  assert.match(p1, /Base prompt\./);
  assert.match(p1, /github-io:start/);
  assert.match(p1, /gh pr create/);
  // Re-expanding does not duplicate the block.
  const twice = expandGithubChannels(once);
  assert.equal((twice.roles[0].systemPrompt.match(/github-io:start/g) || []).length, 1);
  // Export strips the block back out so the portable bundle stays clean.
  const b = buildProcessTemplate({ name: 'x', level: 'live', roles: twice.roles });
  assert.equal(b.roles[0].systemPrompt, 'Base prompt.');
  assert.ok(!b.roles[0].systemPrompt.includes('github-io'));
});

test('normalizeLegacyReview: a legacy pr-review role maps to github channel ports', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'developer', triggers: [] },
      { id: 'reviewer', kind: 'pr-review', review: { reviewsPrFrom: 'developer', onApprove: 'release' }, triggers: [] },
    ],
  };
  const out = normalizeLegacyReview(bundle);
  const reviewer = out.roles.find(r => r.id === 'reviewer');
  const developer = out.roles.find(r => r.id === 'developer');
  assert.equal(reviewer.kind, undefined);
  assert.equal(reviewer.review, undefined);
  assert.deepEqual(reviewer.channels, [{ artifact: 'pr', from: 'developer' }]);
  assert.equal(developer.github.producesPr, true);
});

test('buildProcessTemplate carries github + channels; drops derived channel triggers', () => {
  const b = buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme',
    roles: [
      { id: 'acme-developer', displayName: 'Developer', github: { producesPr: true }, triggers: [] },
      { id: 'acme-reviewer', displayName: 'Reviewer',
        channels: [{ artifact: 'pr', from: 'acme-developer' }],
        triggers: [{ id: 'acme-reviewer-on-pr-acme-developer', type: 'github-event', channel: true, events: ['pull_request.opened'] }] },
    ],
  });
  const dev = b.roles.find(r => r.id === 'developer');
  const rev = b.roles.find(r => r.id === 'reviewer');
  assert.deepEqual(dev.github, { producesPr: true });
  assert.deepEqual(rev.channels, [{ artifact: 'pr', from: 'developer' }]); // team prefix stripped on `from`
  assert.equal(rev.triggers.length, 0); // derived channel trigger dropped from the portable bundle
});

test('an agent-studio-shaped bundle (custom role ids, gates) validates', () => {
  const bundle = {
    processTemplateVersion: 1,
    name: 'accessio-lifecycle',
    level: 'template',
    roles: [
      { id: 'requirements', displayName: 'Requirements', role: 'team-member', systemPrompt: '…',
        triggers: [{ id: 'r1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'stage:requirements', from: 'any-except-self', emits: ['stage:fdd'] }] },
      { id: 'functional-design', displayName: 'Functional Design', role: 'team-member', systemPrompt: '…',
        triggers: [{ id: 'f1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'stage:fdd', from: 'any-except-self' }] },
    ],
    gates: [{ label: 'human:fdd-approved' }],
    labels: [{ name: 'stage:fdd', humanGate: false, brake: false }],
  };
  assert.equal(validateProcessTemplate(bundle).ok, true);
  const cr = templateToCustomRoles(bundle);
  assert.deepEqual(cr.map(r => r.id), ['requirements', 'functional-design']);
});

// ─── expandDataFlowSteps (#379) ────────────────────────────────────────────

test('expandDataFlowSteps: depends_on becomes a push trigger scoped to the upstream member', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'a', displayName: 'Analyst', triggers: [] },
      { id: 'b', displayName: 'Builder', triggers: [], dependsOn: ['a'] },
    ],
    gates: [], labels: [],
  };
  const out = expandDataFlowSteps(bundle, { teamId: 'acme' });
  const b = out.roles.find(r => r.id === 'b');
  const t = b.triggers.find(x => x.id === 'b-on-push-a');
  assert.ok(t, 'consumer gets a push trigger for its upstream');
  assert.equal(t.type, 'github-event');
  assert.deepEqual(t.events, ['push']);
  assert.equal(t.dataFlow, true, 'marked as a data-flow dependency for the UI');
  assert.ok(!('from' in t), 'no origin filter — fires on any push, agent decides relevance');
  assert.match(t.prompt, /Analyst/);
  // The upstream itself gets no data-flow trigger.
  assert.equal(out.roles.find(r => r.id === 'a').triggers.length, 0);
});

test('expandDataFlowSteps: artifact output→input match creates a push trigger and names the paths', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'producer', displayName: 'Producer', triggers: [], outputs: [{ path: 'spec.md' }] },
      { id: 'consumer', displayName: 'Consumer', triggers: [], inputs: [{ path: 'spec.md' }] },
    ],
    gates: [], labels: [],
  };
  const out = expandDataFlowSteps(bundle, { teamId: 'acme' });
  const t = out.roles.find(r => r.id === 'consumer').triggers.find(x => x.id === 'consumer-on-push-producer');
  assert.ok(t);
  assert.ok(!('from' in t), 'no origin filter on the derived push trigger');
  assert.match(t.prompt, /spec\.md/, 'declared input path appears in the hand-off prompt');
});

test('expandDataFlowSteps: artifacts match by logical name, not path (#382)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      // Producer and consumer agree on the NAME; their path hints differ (paths
      // vary per run) — a path-equality match would miss this, a name match hits.
      { id: 'ba', displayName: 'BA', triggers: [], outputs: [{ name: 'Functional Design', hint: 'designs/a.md' }] },
      { id: 'dev', displayName: 'Dev', triggers: [], inputs: [{ name: 'Functional Design', hint: 'designs/**' }] },
    ],
    gates: [], labels: [],
  };
  const out = expandDataFlowSteps(bundle, { teamId: 'acme' });
  const t = out.roles.find(r => r.id === 'dev').triggers.find(x => x.id === 'dev-on-push-ba');
  assert.ok(t, 'named artifact links producer → consumer');
  assert.ok(!('from' in t), 'no origin filter on the derived push trigger');
  assert.match(t.prompt, /Functional Design/, 'the artifact name appears in the prompt');
  assert.match(t.prompt, /aee-artifact/, 'the prompt tells the consumer to resolve the path from the manifest');
  assert.match(t.prompt, /designs\/\*\*/, 'the path hint is surfaced');
});

test('expandDataFlowSteps: a differing name does NOT match even with the same path', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'a', displayName: 'A', triggers: [], outputs: [{ name: 'Spec', path: 'shared.md' }] },
      { id: 'b', displayName: 'B', triggers: [], inputs: [{ name: 'Design', path: 'shared.md' }] },
    ],
    gates: [], labels: [],
  };
  const out = expandDataFlowSteps(bundle, { teamId: 'acme' });
  assert.equal(out.roles.find(r => r.id === 'b').triggers.length, 0,
    'name is the match key — same path but different names do not connect');
});

test('expandDataFlowSteps: dependency + shared artifact collapse into one trigger per upstream', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'a', displayName: 'A', triggers: [], outputs: [{ path: 'x.md' }] },
      { id: 'b', displayName: 'B', triggers: [], dependsOn: ['a'], inputs: [{ path: 'x.md' }] },
    ],
    gates: [], labels: [],
  };
  const out = expandDataFlowSteps(bundle, { teamId: 'acme' });
  const triggers = out.roles.find(r => r.id === 'b').triggers.filter(t => t.id.startsWith('b-on-push-'));
  assert.equal(triggers.length, 1, 'one push trigger per upstream even when both dependency and artifact link them');
  assert.match(triggers[0].prompt, /x\.md/);
});

test('expandDataFlowSteps: no-op for catalog roles without ports; idempotent', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'dev', displayName: 'Dev', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' }] },
    ],
    gates: [], labels: [],
  };
  const once = expandDataFlowSteps(bundle, { teamId: 'acme' });
  assert.equal(once.roles[0].triggers.length, 1, 'no push trigger added without ports');
  const twice = expandDataFlowSteps(once, { teamId: 'acme' });
  assert.deepEqual(twice.roles[0].triggers, once.roles[0].triggers);
});

test('expandDataFlowSteps: a dangling dependency (no such role) is skipped', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [{ id: 'b', displayName: 'B', triggers: [], dependsOn: ['ghost'] }],
    gates: [], labels: [],
  };
  const out = expandDataFlowSteps(bundle, { teamId: 'acme' });
  assert.equal(out.roles[0].triggers.length, 0);
});

test('expandDataFlowSteps idempotent through the full materialise chain (push trigger survives templateToCustomRoles)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'a', displayName: 'A', triggers: [], outputs: [{ path: 'spec.md' }] },
      { id: 'b', displayName: 'B', triggers: [], inputs: [{ path: 'spec.md' }], dependsOn: ['a'] },
    ],
    gates: [], labels: [],
  };
  const cr = templateToCustomRoles(expandDataFlowSteps(bundle, { teamId: 'acme' }));
  const b = cr.find(r => r.id === 'b');
  // ports carried for the live graph
  assert.deepEqual(b.dependsOn, ['a']);
  assert.deepEqual(b.inputs, [{ path: 'spec.md' }]);
  // push trigger flattened with prompt → promptTemplate
  const t = b.triggers.find(x => x.id === 'b-on-push-a');
  assert.ok(t && t.promptTemplate);
  assert.ok(!('from' in t), 'no origin filter carried through the materialise chain');
});

// ─── ordered stages (layout backbone) ────────────────────────────────────────

test('buildProcessTemplate carries an ordered stages list', () => {
  const b = buildProcessTemplate({ name: 'p', roles: [], stages: ['Intake', 'Build', 'Release'] });
  assert.deepEqual(b.stages, ['Intake', 'Build', 'Release']);
});

test('buildProcessTemplate omits stages when none given', () => {
  const b = buildProcessTemplate({ name: 'p', roles: [] });
  assert.equal('stages' in b, false);
});

test('validateProcessTemplate accepts a string stages array, rejects non-strings', () => {
  const base = { processTemplateVersion: 1, roles: [], gates: [], labels: [] };
  assert.equal(validateProcessTemplate({ ...base, stages: ['A', 'B'] }, { allowEmptyRoles: true }).ok, true);
  assert.equal(validateProcessTemplate({ ...base, stages: 'nope' }, { allowEmptyRoles: true }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, stages: [1, 2] }, { allowEmptyRoles: true }).ok, false);
});

test('emptyDraftBundle seeds an empty stages array', () => {
  assert.deepEqual(emptyDraftBundle('x').stages, []);
});

// #522: the default (unnamed) draft is labelled with the standardised "Flow"
// terminology, not the legacy "Process" wording.
test('emptyDraftBundle defaults an unnamed draft to "Untitled flow"', () => {
  assert.equal(emptyDraftBundle().name, 'Untitled flow');
  assert.equal(emptyDraftBundle('').name, 'Untitled flow');
});

// ── stampDerivedActivation (#446): preserve horizon across regeneration ────────

const T0 = '2026-01-01T00:00:00.000Z';
const NOW = '2026-07-08T12:00:00.000Z';

test('stampDerivedActivation: preserves prior activatedAt for a regenerated channel trigger', () => {
  const prev = [{ id: 'c-on-pr-d', channel: true, activatedAt: T0 }];
  const next = [{ id: 'c-on-pr-d', channel: true }]; // freshly regenerated, unstamped
  const out = stampDerivedActivation(next, prev, NOW);
  assert.equal(out[0].activatedAt, T0); // kept — NOT bumped to NOW
});

test('stampDerivedActivation: stamps NOW for a genuinely new derived trigger', () => {
  const out = stampDerivedActivation([{ id: 'new', dataFlow: true }], [], NOW);
  assert.equal(out[0].activatedAt, NOW);
});

test('stampDerivedActivation: treats both channel and dataFlow as derived', () => {
  const out = stampDerivedActivation(
    [{ id: 'ch', channel: true }, { id: 'df', dataFlow: true }], [], NOW,
  );
  assert.equal(out[0].activatedAt, NOW);
  assert.equal(out[1].activatedAt, NOW);
});

test('stampDerivedActivation: leaves non-derived triggers untouched (no stamp added)', () => {
  const out = stampDerivedActivation([{ id: 'cron', type: 'cron' }], [], NOW);
  assert.equal('activatedAt' in out[0], false);
});

test('stampDerivedActivation: keeps an already-stamped derived trigger as-is', () => {
  const out = stampDerivedActivation(
    [{ id: 'c', channel: true, activatedAt: '2026-05-05T00:00:00.000Z' }],
    [{ id: 'c', channel: true, activatedAt: T0 }],
    NOW,
  );
  assert.equal(out[0].activatedAt, '2026-05-05T00:00:00.000Z'); // its own wins over prev/now
});

test('stampDerivedActivation: preserves other fields and is non-mutating', () => {
  const next = [{ id: 'c', channel: true, labelFilter: 'x', events: ['pull_request.opened'] }];
  const out = stampDerivedActivation(next, [], NOW);
  assert.equal(out[0].labelFilter, 'x');
  assert.deepEqual(out[0].events, ['pull_request.opened']);
  assert.equal('activatedAt' in next[0], false); // input not mutated
});

test('stampDerivedActivation: migrating per-producer channel triggers carries the OLDEST activatedAt (\#826)', () => {
  // Old scheme: two per-producer triggers for the same (events, labelFilter).
  const prev = [
    { id: 'disp-on-issue-ba1', channel: true, events: ['issues.labeled'], labelFilter: 'dispatch', activatedAt: T0 },
    { id: 'disp-on-issue-ba2', channel: true, events: ['issues.labeled'], labelFilter: 'dispatch', activatedAt: '2026-03-03T00:00:00.000Z' },
  ];
  // New scheme: one consolidated trigger, different id, SAME listener signature.
  const next = [{ id: 'disp-on-issue-dispatch', channel: true, events: ['issues.labeled'], labelFilter: 'dispatch' }];
  const out = stampDerivedActivation(next, prev, NOW);
  assert.equal(out[0].activatedAt, T0, 'oldest of the merged set — horizon cannot jump to now');
});

test('stampDerivedActivation: signature fallback does NOT apply to data-flow (a new upstream gets NOW) (\#826)', () => {
  // Two push triggers share the same `push` signature but are per-upstream.
  const prev = [{ id: 'c-on-push-up1', dataFlow: true, events: ['push'], activatedAt: T0 }];
  const next = [
    { id: 'c-on-push-up1', dataFlow: true, events: ['push'] }, // regenerated — id match keeps T0
    { id: 'c-on-push-up2', dataFlow: true, events: ['push'] }, // genuinely new — must be NOW, not T0
  ];
  const out = stampDerivedActivation(next, prev, NOW);
  assert.equal(out.find(t => t.id === 'c-on-push-up1').activatedAt, T0);
  assert.equal(out.find(t => t.id === 'c-on-push-up2').activatedAt, NOW);
});

test('stampDerivedActivation: non-array inputs yield []', () => {
  assert.deepEqual(stampDerivedActivation(null, null, NOW), []);
  assert.deepEqual(stampDerivedActivation(undefined, undefined, NOW), []);
});

// ─── buildMemberFromTemplate (#586: add role from a template) ─────────────────

// A role template shaped like the on-disk agent-templates catalog: prompt +
// per-invocation policy + a github-event trigger and a self-curation cron, plus
// declarative ports (emits, dependsOn, parent, stage, github, channels).
const devTemplate = {
  id: 'developer',
  displayName: 'Developer',
  sessionPolicy: 'per-invocation',
  promptTemplate: 'You build for {{repoFullName}} as {{agentId}}.',
  emits: ['started:{{agentId}}'],
  dependsOn: ['business-analyst'],
  parent: 'lead',
  stage: 'build',
  github: { producesPr: true },
  channels: [{ artifact: 'issue', from: 'business-analyst', label: 'assigned:{{agentId}}' }],
  triggers: [
    { id: 'dev-assigned', type: 'github-event', enabled: true,
      events: ['issues.labeled'], labelFilter: 'assigned:{{agentId}}',
      dataFlow: false,
      promptTemplate: 'Implement the issue for {{repoFullName}}.',
      preCheckEnv: { REPO: '{{repoFullName}}' } },
    { id: 'dev-curate', type: 'cron', enabled: true, cron: '5 3 * * 1',
      promptTemplate: 'Tidy memory.' },
  ],
};

const devVars = { repoFullName: 'acme/app', agentId: 'acme-developer', readyLabel: 'ready' };

test('buildMemberFromTemplate: substitutes {{vars}} in prompt, labelFilter, preCheckEnv', () => {
  const m = buildMemberFromTemplate(devTemplate, {
    teamId: 'acme', memberId: 'acme-developer', memberDisplayName: 'Developer', vars: devVars,
  });
  assert.equal(m.systemPromptOverride, 'You build for acme/app as acme-developer.');
  const gh = m.triggers.find(t => t.id === 'dev-assigned');
  assert.equal(gh.labelFilter, 'assigned:acme-developer');
  assert.ok(!('emits' in gh), 'trigger-level emits removed (#783)');
  assert.equal(gh.prompt, 'Implement the issue for acme/app.');
  assert.deepEqual(gh.preCheckEnv, { REPO: 'acme/app' });
  // Agent-level emits are carried through (raw template value — resolved by the
  // orchestrator's own substitution when the member config is written).
  assert.deepEqual(m.emits, ['started:{{agentId}}']);
});

test('buildMemberFromTemplate: github-event trigger gets repo + fresh activation stamps', () => {
  const before = Date.now();
  const m = buildMemberFromTemplate(devTemplate, {
    teamId: 'acme', memberId: 'acme-developer', memberDisplayName: 'Developer', vars: devVars,
  });
  const gh = m.triggers.find(t => t.id === 'dev-assigned');
  assert.equal(gh.repo, 'acme/app');
  assert.deepEqual(gh.events, ['issues.labeled']);
  // horizon stamps present + parseable + recent (#320/#446)
  assert.ok(gh.createdAt && gh.activatedAt);
  assert.equal(gh.createdAt, gh.activatedAt);
  assert.ok(Date.parse(gh.createdAt) >= before);
  // a cron trigger carries its schedule, no repo/horizon stamps
  const cron = m.triggers.find(t => t.id === 'dev-curate');
  assert.equal(cron.cron, '5 3 * * 1');
  assert.equal('repo' in cron, false);
  assert.equal('activatedAt' in cron, false);
});

test('buildMemberFromTemplate: carries session policy + declarative ports (parent/stage/github/channels)', () => {
  const m = buildMemberFromTemplate(devTemplate, {
    teamId: 'acme', memberId: 'acme-developer', memberDisplayName: 'Developer', vars: devVars,
  });
  assert.equal(m.id, 'acme-developer');
  assert.equal(m.displayName, 'Developer');
  assert.equal(m.sessionPolicy, 'per-invocation');
  // dependsOn role ids → member ids
  assert.deepEqual(m.dataFlow.dependsOn, ['acme-business-analyst']);
  // hierarchy parent → member id
  assert.equal(m.parentMemberId, 'acme-lead');
  assert.equal(m.stage, 'build');
  assert.deepEqual(m.github, { producesPr: true });
  // channel `from` role id → member id; other channel fields preserved
  assert.deepEqual(m.channels, [{ artifact: 'issue', from: 'acme-business-analyst', label: 'assigned:{{agentId}}' }]);
  // skillsOverride is never set — members inherit the team grant
  assert.equal('skillsOverride' in m, false);
});

test('buildMemberFromTemplate: a persistent DM-only template yields no sessionPolicy and no ports', () => {
  const ba = {
    id: 'business-analyst', displayName: 'Business Analyst',
    sessionPolicy: 'persistent', promptTemplate: 'Analyse for {{teamName}}.', triggers: [],
  };
  const m = buildMemberFromTemplate(ba, {
    teamId: 'acme', memberId: 'acme-business-analyst', memberDisplayName: 'Business Analyst',
    vars: { teamName: 'Acme' },
  });
  assert.equal(m.systemPromptOverride, 'Analyse for Acme.');
  assert.equal(m.sessionPolicy, undefined); // only per-invocation is emitted
  assert.deepEqual(m.triggers, []);
  assert.equal('dataFlow' in m, false);
  assert.equal('parentMemberId' in m, false);
  assert.equal('github' in m, false);
  assert.equal('channels' in m, false);
  assert.equal('materialize' in m, false);
});

test('buildMemberFromTemplate: unknown {{vars}} stay literal; materialize passes through', () => {
  const m = buildMemberFromTemplate(
    { id: 'x', displayName: 'X', promptTemplate: 'Hi {{missing}}.', triggers: [] },
    { teamId: 'acme', memberId: 'acme-x', memberDisplayName: 'X', vars: {}, materialize: true });
  assert.equal(m.systemPromptOverride, 'Hi {{missing}}.'); // no silent "undefined"
  assert.equal(m.materialize, true);
});
