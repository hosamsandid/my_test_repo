'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProcessTemplate, validateProcessTemplate, templateToCustomRoles, expandGithubChannels, normalizeLegacyReview, expandDataFlowSteps, stampDerivedActivation, emptyDraftBundle, roleKeyOf, slugifyDraft, deriveUniqueDraftId } = require('./process-template');

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
    triggers: [
      { id: 'dev-assigned', type: 'github-event', enabled: true, events: ['issues.labeled'],
        from: 'any-except-self', labelFilter: 'assigned:dev', emits: ['started:dev'], repo: 'acme/app',
        prompt: 'Implement it.', description: 'assigned' },
      { id: 'curate', type: 'cron', enabled: true, cron: '5 3 * * 1', prompt: 'Tidy memory.' },
    ],
  },
];

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
  const t = r.triggers[0];
  assert.equal(t.labelFilter, 'assigned:dev');
  assert.deepEqual(t.emits, ['started:dev']);
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
  assert.deepEqual(t.emits, ['started:dev']);
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
  assert.deepEqual(cr[0].triggers.find(t => t.id === 'dev-assigned').emits, ['started:dev']);
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
  const t = reviewer.triggers.find(t => t.id === 'reviewer-on-pr-developer');
  assert.ok(t);
  assert.equal(t.channel, true);
  assert.deepEqual(t.events, ['pull_request.opened', 'pull_request.reopened']);
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
  assert.equal(triage.triggers.filter(t => t.id === 'triage-on-issue-dev').length, 1);
  assert.deepEqual(triage.triggers[0].events, ['issues.opened']);
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

test('stampDerivedActivation: non-array inputs yield []', () => {
  assert.deepEqual(stampDerivedActivation(null, null, NOW), []);
  assert.deepEqual(stampDerivedActivation(undefined, undefined, NOW), []);
});
