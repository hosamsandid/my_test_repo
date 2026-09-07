'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProcessTemplate, validateProcessTemplate, templateToCustomRoles, buildMemberFromTemplate, liftTriggerEmits, expandGithubChannels, normalizeLegacyReview, expandDataFlowSteps, stampDerivedActivation, emptyDraftBundle, roleKeyOf, slugifyDraft, deriveUniqueDraftId, outcomesBlock, stripOutcomesBlock, applyDerivedPromptBlocks, cleanWakePrompt, deriveClaim, claimLabelFor, claimError, channelAutoClaim, CLAIM_SUFFIX, completedLabelFor, COMPLETED_SUFFIX, normalizeHillClimb } = require('./process-template');

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

test('slugifyDraft trims dash runs linearly (no polynomial ReDoS)', () => {
  // Interior dashes are preserved; only leading/trailing runs are trimmed.
  assert.equal(slugifyDraft('---a---b---'), 'a---b');
  assert.equal(slugifyDraft('-'.repeat(100)), 'process'); // all dashes → empty → fallback
  // A long run of '-' followed by a non-match used to trigger quadratic backtracking
  // on `/^-+|-+$/g`; the linear scan returns promptly regardless of length.
  const start = Date.now();
  assert.equal(slugifyDraft(`${'-'.repeat(100000)}x`), 'x');
  assert.ok(Date.now() - start < 500, 'slugifyDraft must stay linear on long dash runs');
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
  // Legacy flat emits lifted to outcomes on export (#831) — no raw emits field.
  assert.ok(!('emits' in r), 'emits field not exported');
  assert.deepEqual(r.outcomes, { mode: 'anyOf', options: [
    { id: 'started:dev', title: 'started:dev', actions: [{ type: 'setLabel', label: 'started:dev' }] },
  ] });
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
  // Legacy flat emits lifted to outcomes on export (#831).
  assert.ok(!('emits' in role), 'emits field not in customRoles');
  assert.deepEqual(role.outcomes, { mode: 'anyOf', options: [
    { id: 'started:dev', title: 'started:dev', actions: [{ type: 'setLabel', label: 'started:dev' }] },
  ] });
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
  // Legacy flat emits lifted to outcomes through the round-trip (#831).
  assert.ok(!('emits' in cr[0]), 'emits field not in round-tripped customRoles');
  assert.ok(cr[0].outcomes, 'outcomes port present after round-trip');
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

// ─── Per-channel wake-prompt override (#868) ────────────────────────────────

test('expandGithubChannels: an authored wakePrompt overrides the derived listener prompt (#868)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'ov', level: 'template',
    roles: [
      { id: 'dev', displayName: 'Dev', github: { producesPr: true }, triggers: [] },
      { id: 'reviewer', displayName: 'Reviewer',
        channels: [{ artifact: 'pr', from: 'dev', wakePrompt: 'Custom: review the PR against the style guide only.' }],
        triggers: [] },
    ],
  };
  const out = expandGithubChannels(bundle);
  const t = out.roles.find(r => r.id === 'reviewer').triggers.find(x => x.id === 'reviewer-on-pr');
  assert.ok(t);
  assert.equal(t.prompt, 'Custom: review the PR against the style guide only.',
    'the derived trigger carries the authored override verbatim');
});

test('expandGithubChannels: no wakePrompt keeps the generated prompt (#868)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'ov', level: 'template',
    roles: [
      { id: 'dev', displayName: 'Dev', github: { producesPr: true }, triggers: [] },
      { id: 'reviewer', displayName: 'Reviewer', channels: [{ artifact: 'pr', from: 'dev' }], triggers: [] },
    ],
  };
  const t = expandGithubChannels(bundle).roles.find(r => r.id === 'reviewer').triggers[0];
  assert.match(t.prompt, /pull request/i, 'falls back to the generated consume prompt');
});

test('expandGithubChannels: a blank/whitespace wakePrompt is ignored (#868)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'ov', level: 'template',
    roles: [
      { id: 'dev', displayName: 'Dev', github: { producesIssue: true }, triggers: [] },
      { id: 'triage', displayName: 'Triage', channels: [{ artifact: 'issue', from: 'dev', wakePrompt: '   ' }], triggers: [] },
    ],
  };
  const t = expandGithubChannels(bundle).roles.find(r => r.id === 'triage').triggers[0];
  assert.match(t.prompt, /issue/i, 'a whitespace-only override does not replace the generated prompt');
});

test('expandGithubChannels: on a consolidated listener the first non-empty wakePrompt wins (#868)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'ov', level: 'template',
    roles: [
      { id: 'ba1', displayName: 'BA One', github: { producesIssue: true }, triggers: [] },
      { id: 'ba2', displayName: 'BA Two', github: { producesIssue: true }, triggers: [] },
      { id: 'dispatcher', displayName: 'Dispatcher',
        channels: [
          { artifact: 'issue', from: 'ba1', label: 'dispatch' },                                   // no override
          { artifact: 'issue', from: 'ba2', label: 'dispatch', wakePrompt: 'Triage the dispatched issue.' },
        ], triggers: [] },
    ],
  };
  const listeners = expandGithubChannels(bundle).roles.find(r => r.id === 'dispatcher').triggers.filter(t => t.channel);
  assert.equal(listeners.length, 1, 'still one consolidated listener');
  assert.equal(listeners[0].prompt, 'Triage the dispatched issue.',
    'the first non-empty override in insertion order is carried onto the shared listener');
});

test('expandDataFlowSteps: an authored input wakePrompt overrides the derived push prompt (#868)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'producer', displayName: 'Producer', triggers: [], outputs: [{ name: 'Spec', hint: 'spec.md' }] },
      { id: 'consumer', displayName: 'Consumer', triggers: [],
        inputs: [{ name: 'Spec', hint: 'spec.md', wakePrompt: 'Custom: rebuild from the new Spec.' }] },
    ],
  };
  const t = expandDataFlowSteps(bundle).roles.find(r => r.id === 'consumer').triggers.find(x => x.id === 'consumer-on-push-producer');
  assert.ok(t);
  assert.equal(t.prompt, 'Custom: rebuild from the new Spec.', 'the derived push trigger carries the authored override');
});

test('buildProcessTemplate round-trips a channel wakePrompt on export (#868)', () => {
  const b = buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme',
    roles: [
      { id: 'acme-dev', displayName: 'Dev', github: { producesPr: true }, triggers: [] },
      { id: 'acme-rev', displayName: 'Rev', channels: [{ artifact: 'pr', from: 'acme-dev', wakePrompt: 'Look here.' }], triggers: [] },
    ],
  });
  const rev = b.roles.find(r => r.id === 'rev');
  assert.equal(rev.channels[0].wakePrompt, 'Look here.', 'export preserves the authored override');
  assert.equal(rev.channels[0].from, 'dev', 'and still remaps the portable role key');
});

test('validateProcessTemplate rejects a non-string channel wakePrompt (#868)', () => {
  const bad = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [{ id: 'r', channels: [{ artifact: 'pr', from: 'p', wakePrompt: 42 }], triggers: [] }],
  };
  assert.equal(validateProcessTemplate(bad).ok, false);
});

test('cleanWakePrompt trims and drops blank overrides (#868)', () => {
  assert.equal(cleanWakePrompt('  hi  '), 'hi');
  assert.equal(cleanWakePrompt('   '), '');
  assert.equal(cleanWakePrompt(undefined), '');
  assert.equal(cleanWakePrompt(42), '');
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

// ── #1194: internal transport on labelled PR/issue channels ──

test('#1194: expandGithubChannels stamps transport:internal on a labelled internal channel; poller-excluded', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'reviewer', github: { producesPr: true }, triggers: [] },
      { id: 'merger', channels: [{ artifact: 'pr', from: 'reviewer', label: 'approved', transport: 'internal' }], triggers: [] },
    ],
  };
  const out = expandGithubChannels(bundle);
  const t = out.roles.find(r => r.id === 'merger').triggers.find(x => x.channel);
  assert.equal(t.labelFilter, 'approved');
  assert.deepEqual(t.events, ['pull_request.labeled']);
  assert.equal(t.transport, 'internal', 'derived listener carries internal transport');
});

test('#1194: an UNLABELLED channel never goes internal (artifact-open stays poller-delivered)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'dev', github: { producesPr: true }, triggers: [] },
      // transport on an unlabelled channel is meaningless — must be ignored.
      { id: 'rev', channels: [{ artifact: 'pr', from: 'dev', transport: 'internal' }], triggers: [] },
    ],
  };
  const t = expandGithubChannels(bundle).roles.find(r => r.id === 'rev').triggers.find(x => x.channel);
  assert.deepEqual(t.events, ['pull_request.opened', 'pull_request.reopened']);
  assert.ok(!('transport' in t), 'no transport stamped on an artifact-open listener');
});

test('#1194: a gate:human labelled channel stays poller-delivered even if transport:internal is set', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'dev', github: { producesPr: true }, triggers: [] },
      { id: 'deployer', channels: [{ artifact: 'pr', from: 'dev', label: 'approved', gate: 'human', transport: 'internal' }], triggers: [] },
    ],
  };
  const t = expandGithubChannels(bundle).roles.find(r => r.id === 'deployer').triggers.find(x => x.channel);
  assert.equal(t.labelFilter, 'approved');
  assert.ok(!('transport' in t), 'a person applies the label on GitHub — poller only');
});

test('#1194: consolidation is all-or-nothing — a mixed internal/poller group stays poller-delivered', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'a', github: { producesIssue: true }, triggers: [] },
      { id: 'b', github: { producesIssue: true }, triggers: [] },
      { id: 'router', channels: [
        { artifact: 'issue', from: 'a', label: 'dispatch', transport: 'internal' },
        { artifact: 'issue', from: 'b', label: 'dispatch' }, // poller — one poller producer disqualifies the shared listener
      ], triggers: [] },
    ],
  };
  const listeners = expandGithubChannels(bundle).roles.find(r => r.id === 'router').triggers.filter(x => x.channel);
  assert.equal(listeners.length, 1, 'still one consolidated listener');
  assert.ok(!('transport' in listeners[0]), 'a lone poller producer keeps the whole listener on the poller');
});

test('#1194: all-internal channels consolidate into ONE internal listener', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'a', github: { producesIssue: true }, triggers: [] },
      { id: 'b', github: { producesIssue: true }, triggers: [] },
      { id: 'router', channels: [
        { artifact: 'issue', from: 'a', label: 'dispatch', transport: 'internal' },
        { artifact: 'issue', from: 'b', label: 'dispatch', transport: 'internal' },
      ], triggers: [] },
    ],
  };
  const listeners = expandGithubChannels(bundle).roles.find(r => r.id === 'router').triggers.filter(x => x.channel);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].transport, 'internal');
});

test('#1194: the internal channel flips the producer Outcomes-block instruction to aee-emit', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'reviewer', displayName: 'Reviewer', systemPrompt: 'Base.',
        outcomes: { mode: 'anyOf', options: [{ id: 'approved', title: 'Approve', actions: [{ type: 'setLabel', label: 'approved' }] }] },
        github: { producesPr: true }, triggers: [] },
      { id: 'merger', displayName: 'Merger',
        channels: [{ artifact: 'pr', from: 'reviewer', label: 'approved', transport: 'internal' }], triggers: [] },
    ],
  };
  const out = expandGithubChannels(bundle);
  const rev = out.roles.find(r => r.id === 'reviewer');
  assert.match(rev.systemPrompt, /aee-emit/, 'producer told to announce the label internally');
});

test('#1194: buildProcessTemplate round-trips channel transport on export', () => {
  const b = buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme',
    roles: [
      { id: 'acme-rev', displayName: 'Rev', github: { producesPr: true }, triggers: [] },
      { id: 'acme-mrg', displayName: 'Mrg', channels: [{ artifact: 'pr', from: 'acme-rev', label: 'approved', transport: 'internal' }], triggers: [] },
    ],
  });
  const mrg = b.roles.find(r => r.id === 'mrg');
  assert.equal(mrg.channels[0].transport, 'internal', 'export preserves the internal-delivery choice');
  assert.equal(mrg.channels[0].from, 'rev', 'and still remaps the portable role key');
});

test('#1194: remapChannel drops transport on an unlabelled or human channel (not meaningful)', () => {
  const b = buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme',
    roles: [
      { id: 'acme-p', displayName: 'P', github: { producesPr: true, producesIssue: true }, triggers: [] },
      { id: 'acme-c', displayName: 'C', channels: [
        { artifact: 'pr', from: 'acme-p', transport: 'internal' }, // unlabelled — drop
        { artifact: 'issue', from: 'acme-p', label: 'approved', gate: 'human', transport: 'internal' }, // human — drop
      ], triggers: [] },
    ],
  });
  const c = b.roles.find(r => r.id === 'c');
  assert.ok(!('transport' in c.channels[0]), 'unlabelled channel carries no transport');
  assert.ok(!('transport' in c.channels[1]), 'human-gated channel carries no transport');
});

test('#1194: validateProcessTemplate rejects a bad transport value / internal without a label / internal on a human gate', () => {
  const mk = (ch) => ({
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [{ id: 'r', channels: [ch], triggers: [] }],
  });
  assert.equal(validateProcessTemplate(mk({ artifact: 'pr', from: 'p', label: 'x', transport: 'bogus' })).ok, false);
  assert.equal(validateProcessTemplate(mk({ artifact: 'pr', from: 'p', transport: 'internal' })).ok, false);
  assert.equal(validateProcessTemplate(mk({ artifact: 'pr', from: 'p', label: 'x', gate: 'human', transport: 'internal' })).ok, false);
  // A valid labelled internal channel passes.
  assert.equal(validateProcessTemplate(mk({ artifact: 'pr', from: 'p', label: 'x', transport: 'internal' })).ok, true);
});

test('#981: buildProcessTemplate round-trips the artifact audience flags', () => {
  const b = buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme',
    roles: [
      { id: 'acme-dev', displayName: 'Dev',
        github: { producesPr: true, prAudience: 'human', producesIssue: true, issueAudience: 'human' }, triggers: [] },
      // An audience without its produce flag is meaningless and must be dropped.
      { id: 'acme-odd', displayName: 'Odd', github: { producesPr: true, issueAudience: 'human' }, triggers: [] },
    ],
  });
  assert.deepEqual(b.roles.find(r => r.id === 'dev').github,
    { producesPr: true, producesIssue: true, prAudience: 'human', issueAudience: 'human' });
  assert.deepEqual(b.roles.find(r => r.id === 'odd').github, { producesPr: true });
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

// ─── hillClimb collector config round-trip (#1222) ───────────────────────────

test('normalizeHillClimb keeps only known config keys and nulls an empty config', () => {
  assert.deepEqual(
    normalizeHillClimb({ cron: ' 0 3 * * * ', windowDays: 14, minRunsPerWindow: 5, excludeAgents: ['a', 'a', ' '] }),
    { cron: '0 3 * * *', windowDays: 14, minRunsPerWindow: 5, excludeAgents: ['a'] },
  );
  // Snapshot / applied-card state deliberately never travels.
  assert.deepEqual(normalizeHillClimb({ windowDays: 7, cards: [{ id: 'x' }], lastSnapshot: {} }), { windowDays: 7 });
  assert.equal(normalizeHillClimb({}), null);
  assert.equal(normalizeHillClimb({ windowDays: 0, minRunsPerWindow: -1 }), null);
  assert.equal(normalizeHillClimb(null), null);
  assert.equal(normalizeHillClimb([1, 2]), null);
});

test('buildProcessTemplate carries a normalized hillClimb and omits it when unset', () => {
  const b = buildProcessTemplate({ name: 'p', roles: [], hillClimb: { windowDays: 30, minRunsPerWindow: 50, junk: true } });
  assert.deepEqual(b.hillClimb, { windowDays: 30, minRunsPerWindow: 50 });
  assert.equal('hillClimb' in buildProcessTemplate({ name: 'p', roles: [] }), false);
  assert.equal('hillClimb' in buildProcessTemplate({ name: 'p', roles: [], hillClimb: {} }), false);
});

test('validateProcessTemplate accepts a well-formed hillClimb, rejects bad shapes', () => {
  const base = { processTemplateVersion: 1, roles: [], gates: [], labels: [] };
  assert.equal(validateProcessTemplate({ ...base, hillClimb: { cron: '0 3 * * *', windowDays: 7, minRunsPerWindow: 20, excludeAgents: ['x'] } }, { allowEmptyRoles: true }).ok, true);
  assert.equal(validateProcessTemplate({ ...base, hillClimb: [] }, { allowEmptyRoles: true }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, hillClimb: { windowDays: 0 } }, { allowEmptyRoles: true }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, hillClimb: { minRunsPerWindow: -1 } }, { allowEmptyRoles: true }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, hillClimb: { excludeAgents: [1] } }, { allowEmptyRoles: true }).ok, false);
});

// ─── hillClimb autonomy + maxCardsPerPass (#1224) ────────────────────────────

test('normalizeHillClimb carries the #1224 autonomy + maxCardsPerPass keys', () => {
  assert.deepEqual(
    normalizeHillClimb({ autonomy: 1, maxCardsPerPass: 3, windowDays: 7 }),
    { autonomy: 1, maxCardsPerPass: 3, windowDays: 7 },
  );
  assert.deepEqual(normalizeHillClimb({ autonomy: 0 }), { autonomy: 0 }); // 0 is meaningful (collector-only)
  // Out-of-range / non-numeric values are dropped, not clamped.
  assert.equal(normalizeHillClimb({ autonomy: 5 }), null);
  assert.equal(normalizeHillClimb({ maxCardsPerPass: -1 }), null);
});

test('validateProcessTemplate accepts autonomy/maxCardsPerPass and rejects bad values', () => {
  const base = { processTemplateVersion: 1, roles: [], gates: [], labels: [] };
  assert.equal(validateProcessTemplate({ ...base, hillClimb: { autonomy: 2, maxCardsPerPass: 5 } }, { allowEmptyRoles: true }).ok, true);
  assert.equal(validateProcessTemplate({ ...base, hillClimb: { autonomy: 4 } }, { allowEmptyRoles: true }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, hillClimb: { maxCardsPerPass: -2 } }, { allowEmptyRoles: true }).ok, false);
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

// ─── Outcomes prompt block (#829, concept §6) ────────────────────────────────

const EXACTLY_ONE = {
  mode: 'exactlyOne',
  options: [
    { id: 'dev', title: 'Route to Developer', when: 'frontend/UI task', actions: [{ type: 'setLabel', label: 'ready' }] },
    { id: 'dev2', title: 'Route to Developer 2', when: 'backend/DB task', actions: [{ type: 'setLabel', label: 'ready-2' }] },
    { id: 'hold', title: 'Hold for clarification', when: 'ambiguous', notify: 'dm', actions: [{ type: 'none' }] },
  ],
};

test('outcomesBlock: exactlyOne — lead, per-option label/when, and the single-label footer', () => {
  const block = outcomesBlock(EXACTLY_ONE);
  assert.match(block, /<!-- outcomes:start -->/);
  assert.match(block, /<!-- outcomes:end -->/);
  assert.match(block, /## Outcomes/);
  assert.match(block, /choose \*\*exactly one\*\* of the following outcomes:/);
  assert.match(block, /1\. \*\*Route to Developer\*\* — when: frontend\/UI task\. Then: apply label `ready`\./);
  assert.match(block, /2\. \*\*Route to Developer 2\*\* — when: backend\/DB task\. Then: apply label `ready-2`\./);
  // `none` action → "set no label"; notify:"dm" → DM reporting instruction.
  assert.match(block, /3\. \*\*Hold for clarification\*\* — when: ambiguous\. Then: set no label; report to the user in the DM\./);
  assert.match(block, /Never apply more than one of these labels in a single run\./);
});

test('outcomesBlock: anyOf — "all that apply, zero allowed" lead and NO single-label footer', () => {
  const block = outcomesBlock({
    mode: 'anyOf',
    options: [
      { id: 'sec', title: 'Security concern', actions: [{ type: 'setLabel', label: 'security' }] },
      { id: 'perf', actions: [{ type: 'setLabel', label: 'perf' }] }, // no title → falls back to id
    ],
  });
  assert.match(block, /choose \*\*all outcomes that apply\*\* — zero is allowed:/);
  assert.doesNotMatch(block, /Never apply more than one/);
  assert.match(block, /1\. \*\*Security concern\*\* — Then: apply label `security`\./); // no `when:` when absent
  assert.match(block, /2\. \*\*perf\*\* — Then: apply label `perf`\./); // id fallback for missing title
});

test('outcomesBlock: openPr/openIssue reuse the produce wording (once)', () => {
  const block = outcomesBlock({
    mode: 'anyOf',
    options: [
      { id: 'ship', title: 'Ship it', actions: [{ type: 'openPr' }] },
      { id: 'file', title: 'File follow-up', actions: [{ type: 'openIssue' }] },
    ],
  });
  assert.match(block, /Then: open a pull request\./);
  assert.match(block, /Then: open a GitHub issue\./);
  // The full how-to (reused producePrText/produceIssueText) appears once each.
  assert.equal((block.match(/gh pr create/g) || []).length, 1);
  assert.equal((block.match(/gh issue create/g) || []).length, 1);
});

test('outcomesBlock: setLabel options carry the verbatim-label contract (create, never substitute)', () => {
  const block = outcomesBlock(EXACTLY_ONE);
  assert.match(block, /apply each label \*\*verbatim as written above\*\*/);
  assert.match(block, /gh label create/);
  assert.match(block, /never a similar-sounding label/);
});

test('outcomesBlock: no verbatim-label contract when no option sets a label', () => {
  const block = outcomesBlock({
    mode: 'anyOf',
    options: [
      { id: 'ship', title: 'Ship it', actions: [{ type: 'openPr' }] },
      { id: 'done', title: 'Done', actions: [{ type: 'none' }] },
    ],
  });
  assert.doesNotMatch(block, /verbatim as written above/);
  assert.doesNotMatch(block, /gh label create/);
});

test('outcomesBlock: a non-authored port projects nothing (legacy no-block, AC4)', () => {
  assert.equal(outcomesBlock(null), '');
  assert.equal(outcomesBlock(undefined), '');
  assert.equal(outcomesBlock({ mode: 'anyOf', options: [] }), ''); // empty options is not authored
  assert.equal(outcomesBlock({ options: [{ id: 'x', actions: [] }] }), ''); // no mode is not authored
});

test('stripOutcomesBlock + applyDerivedPromptBlocks are byte-idempotent (AC1)', () => {
  const base = 'You are the dispatcher.';
  const once = applyDerivedPromptBlocks(base, { outcomes: EXACTLY_ONE });
  assert.match(once, /You are the dispatcher\./);
  assert.match(once, /outcomes:start/);
  // Re-applying over the already-blocked prompt yields byte-identical output.
  const twice = applyDerivedPromptBlocks(once, { outcomes: EXACTLY_ONE });
  assert.equal(twice, once);
  assert.equal((twice.match(/outcomes:start/g) || []).length, 1);
  // Stripping restores the base exactly.
  assert.equal(stripOutcomesBlock(once), base);
});

test('applyDerivedPromptBlocks: legacy emits-only agent gets a byte-identical prompt (AC4)', () => {
  const base = 'Plain agent prompt.';
  // No github, no authored outcomes → nothing appended.
  assert.equal(applyDerivedPromptBlocks(base, {}), base);
  assert.equal(applyDerivedPromptBlocks(base, { outcomes: null }), base);
  // A github-only agent keeps its produce block unchanged (no outcomes block).
  const gh = applyDerivedPromptBlocks(base, { github: { producesPr: true } });
  assert.match(gh, /github-io:start/);
  assert.doesNotMatch(gh, /outcomes:start/);
});

test('applyDerivedPromptBlocks: github-io + outcomes coexist without a doubled open-PR instruction (AC3)', () => {
  const outcomes = {
    mode: 'exactlyOne',
    options: [
      { id: 'ship', title: 'Ship', actions: [{ type: 'openPr' }] },
      { id: 'hold', title: 'Hold', actions: [{ type: 'none' }] },
    ],
  };
  // The agent ALSO carries a github.producesPr flag — the produce how-to must
  // still appear exactly once (absorbed into the outcomes block; the github-io
  // block drops the covered flag).
  const out = applyDerivedPromptBlocks('Reviewer.', { github: { producesPr: true }, outcomes });
  assert.match(out, /outcomes:start/);
  assert.equal((out.match(/gh pr create/g) || []).length, 1);
  // producesPr is fully covered by the outcome → no empty github-io block.
  assert.doesNotMatch(out, /github-io:start/);

  // A producesIssue NOT covered by any outcome still yields its github-io block.
  const out2 = applyDerivedPromptBlocks('Reviewer.', { github: { producesPr: true, producesIssue: true }, outcomes });
  assert.match(out2, /github-io:start/);
  assert.equal((out2.match(/gh pr create/g) || []).length, 1); // still once (from the outcome)
  assert.equal((out2.match(/gh issue create/g) || []).length, 1); // from the github-io block
});

test('expandGithubChannels: materialises the outcomes block; export round-trip does not duplicate it (AC2)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [{
      id: 'dispatch', displayName: 'Dispatcher', systemPrompt: 'Route issues.',
      outcomes: EXACTLY_ONE, triggers: [],
    }],
  };
  const once = expandGithubChannels(bundle);
  const p1 = once.roles[0].systemPrompt;
  assert.match(p1, /Route issues\./);
  assert.match(p1, /outcomes:start/);
  assert.match(p1, /apply label `ready`/);
  // Re-expanding does not duplicate the block.
  const twice = expandGithubChannels(once);
  assert.equal((twice.roles[0].systemPrompt.match(/outcomes:start/g) || []).length, 1);
  // Export strips the block back out so the portable bundle stays clean, and the
  // structured `outcomes` port survives — a re-import regenerates it (no dup).
  const b = buildProcessTemplate({ name: 'x', level: 'live', roles: twice.roles });
  assert.equal(b.roles[0].systemPrompt, 'Route issues.');
  assert.ok(!b.roles[0].systemPrompt.includes('outcomes:start'));
  assert.equal(b.roles[0].outcomes.mode, 'exactlyOne');
  const reimport = expandGithubChannels({ ...b });
  assert.equal((reimport.roles[0].systemPrompt.match(/outcomes:start/g) || []).length, 1);
});

test('materialise: the outcomes block reaches the member override with {{vars}} substituted', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [{
      id: 'dispatch', displayName: 'Dispatcher', systemPrompt: 'Route.',
      outcomes: { mode: 'exactlyOne', options: [{ id: 'go', title: 'Go', actions: [{ type: 'setLabel', label: '{{dispatchLabel}}' }] }] },
      triggers: [],
    }],
  };
  const expanded = expandGithubChannels(bundle);
  const custom = templateToCustomRoles(expanded, 'acme');
  const m = buildMemberFromTemplate(custom[0], {
    teamId: 'acme', memberId: 'acme-dispatch', memberDisplayName: 'Dispatcher',
    vars: { dispatchLabel: 'dispatch' }, materialize: true,
  });
  assert.match(m.systemPromptOverride, /outcomes:start/);
  assert.match(m.systemPromptOverride, /apply label `dispatch`/); // {{dispatchLabel}} substituted
  // The member also carries the structured outcomes port, itself substituted.
  assert.equal(m.outcomes.options[0].actions[0].label, 'dispatch');
});

test('reconcile fan-out (per-member transform): only authored-outcomes members get a block, idempotently', () => {
  // Model the reconciler's core: for each member config, re-render from its base
  // prompt + ports. Authored-outcomes members gain the block; legacy (emits-only)
  // and plain members are unchanged; a second pass is a no-op (byte-idempotent).
  const members = [
    { id: 'a', systemPrompt: 'A.', outcomes: EXACTLY_ONE },
    { id: 'b', systemPrompt: 'B.', emits: ['ready'] }, // legacy flat emits → no block
    { id: 'c', systemPrompt: 'C.' },                    // plain → no block
  ];
  const pass1 = members.map(m => applyDerivedPromptBlocks(m.systemPrompt, { github: m.github, outcomes: m.outcomes }));
  assert.match(pass1[0], /outcomes:start/);
  assert.equal(pass1[1], 'B.');
  assert.equal(pass1[2], 'C.');
  const pass2 = pass1.map((p, i) => applyDerivedPromptBlocks(p, { github: members[i].github, outcomes: members[i].outcomes }));
  assert.deepEqual(pass2, pass1); // idempotent fan-out
});

// ─── claim labels (#958, concept §3.4–§3.5) ──────────────────────────────────
// The claim is DERIVED by convention (`<wakeLabel>:wip`), never authored: Layer-3
// reconciliation computes the claim label from the wake label, so an arbitrary
// `add` would make a stalled run invisible again. These tests pin the convention,
// the validator, and both derivation paths (draft expanders + live reconcilers,
// which delegate to the very same pure functions).

test('deriveClaim follows the <wakeLabel>:wip convention', () => {
  assert.deepEqual(deriveClaim('ready'), { remove: 'ready', add: 'ready:wip' });
  assert.deepEqual(deriveClaim('  ready-2  '), { remove: 'ready-2', add: 'ready-2:wip' });
  assert.equal(claimLabelFor('ready'), `ready${CLAIM_SUFFIX}`);
});

test('#1163: completedLabelFor derives the <wakeLabel>:completed success mirror', () => {
  assert.equal(COMPLETED_SUFFIX, ':completed');
  assert.equal(completedLabelFor('ready'), `ready${COMPLETED_SUFFIX}`);
  assert.equal(completedLabelFor('ready'), 'ready:completed');
  // Distinct from the `:wip` claim label, so the two states never collide.
  assert.notEqual(completedLabelFor('ready'), claimLabelFor('ready'));
});

test('deriveClaim returns null where there is nothing to claim', () => {
  assert.equal(deriveClaim(undefined), null);   // raw event listener (e.g. push)
  assert.equal(deriveClaim(''), null);
  assert.equal(deriveClaim('   '), null);
  assert.equal(deriveClaim(null), null);
  // A listener already waiting on a claim label must not claim its own claim
  // (that would derive `ready:wip:wip`).
  assert.equal(deriveClaim('ready:wip'), null);
});

test('claimError: a well-formed derived claim validates', () => {
  assert.equal(claimError(deriveClaim('ready'), 'ready', 'github-event'), null);
  assert.equal(claimError(undefined, 'ready', 'github-event'), null); // optional
  assert.equal(claimError(null, 'ready', 'github-event'), null);
});

test('claimError enforces claim.remove === labelFilter', () => {
  const err = claimError({ remove: 'dispatch', add: 'dispatch:wip' }, 'ready', 'github-event');
  assert.match(err, /claim\.remove/);
  assert.match(err, /must equal labelFilter/);
});

test('claimError enforces the <wakeLabel>:wip naming convention on claim.add', () => {
  const err = claimError({ remove: 'ready', add: 'ready-in-progress' }, 'ready', 'github-event');
  assert.match(err, /<wakeLabel>:wip/);
  assert.match(err, /ready:wip/);
});

test('claimError rejects a malformed or misplaced claim', () => {
  assert.match(claimError('nope', 'ready', 'github-event'), /must be an object/);
  assert.match(claimError([], 'ready', 'github-event'), /must be an object/);
  assert.match(claimError({ add: 'ready:wip' }, 'ready', 'github-event'), /claim\.remove/);
  assert.match(claimError({ remove: 'ready' }, 'ready', 'github-event'), /claim\.add/);
  // A claim on a listener with no label filter has no wake label to take over.
  assert.match(claimError(deriveClaim('ready'), '', 'github-event'), /requires a labelFilter/);
  // ...and a claim on a cron trigger is meaningless.
  assert.match(claimError({ remove: 'ready', add: 'ready:wip' }, 'ready', 'cron'), /only valid on a github-event/);
});

test('validateProcessTemplate rejects a bundle whose claim disagrees with its listener', () => {
  const bundle = (claim) => ({
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [{ id: 'dev', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', claim }] }],
  });
  assert.equal(validateProcessTemplate(bundle(deriveClaim('ready'))).ok, true);
  const bad = validateProcessTemplate(bundle({ remove: 'other', add: 'other:wip' }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /role dev: trigger t:/);
  assert.match(bad.error, /must equal labelFilter/);
});

test('channelAutoClaim defaults ON and only an explicit false opts out', () => {
  assert.equal(channelAutoClaim({}), true);
  assert.equal(channelAutoClaim({ autoClaim: true }), true);
  assert.equal(channelAutoClaim(undefined), true);
  assert.equal(channelAutoClaim({ autoClaim: false }), false);
});

test('expandGithubChannels stamps the derived claim on a labelled channel listener', () => {
  const out = expandGithubChannels({
    roles: [
      { id: 'dev', displayName: 'Dev', github: { producesPr: true }, triggers: [] },
      { id: 'rev', displayName: 'Reviewer', channels: [{ artifact: 'pr', from: 'dev', label: 'ready-for-test' }], triggers: [] },
    ],
  });
  const t = out.roles.find(r => r.id === 'rev').triggers.find(x => x.channel);
  assert.equal(t.labelFilter, 'ready-for-test');
  assert.deepEqual(t.claim, { remove: 'ready-for-test', add: 'ready-for-test:wip' });
});

test('expandGithubChannels stamps NO claim on an unlabelled (opened) channel listener', () => {
  const out = expandGithubChannels({
    roles: [
      { id: 'dev', displayName: 'Dev', github: { producesPr: true }, triggers: [] },
      { id: 'rev', displayName: 'Reviewer', channels: [{ artifact: 'pr', from: 'dev' }], triggers: [] },
    ],
  });
  const t = out.roles.find(r => r.id === 'rev').triggers.find(x => x.channel);
  assert.equal(t.labelFilter, undefined);
  assert.equal(t.claim, undefined); // nothing to take over — it wakes on "opened"
});

test('expandGithubChannels honours the per-port autoClaim opt-out', () => {
  const out = expandGithubChannels({
    roles: [
      { id: 'dev', displayName: 'Dev', github: { producesPr: true }, triggers: [] },
      { id: 'rev', displayName: 'Reviewer', triggers: [],
        channels: [{ artifact: 'pr', from: 'dev', label: 'ready-for-test', autoClaim: false }] },
    ],
  });
  const t = out.roles.find(r => r.id === 'rev').triggers.find(x => x.channel);
  assert.equal(t.labelFilter, 'ready-for-test');
  assert.equal(t.claim, undefined);
});

test('expandGithubChannels: an opt-out on ANY consolidated channel wins', () => {
  // Two producers over the same (artifact, label) consolidate into ONE listener
  // (#826); the claim is a property of that single listener, so an explicit
  // opt-out on either contributing port disables it.
  const out = expandGithubChannels({
    roles: [
      { id: 'a', displayName: 'A', github: { producesPr: true }, triggers: [] },
      { id: 'b', displayName: 'B', github: { producesPr: true }, triggers: [] },
      { id: 'rev', displayName: 'Reviewer', triggers: [], channels: [
        { artifact: 'pr', from: 'a', label: 'ready-for-test' },
        { artifact: 'pr', from: 'b', label: 'ready-for-test', autoClaim: false },
      ] },
    ],
  });
  const ts = out.roles.find(r => r.id === 'rev').triggers.filter(x => x.channel);
  assert.equal(ts.length, 1);          // consolidated
  assert.equal(ts[0].claim, undefined); // opt-out wins
});

test('expandGithubChannels leaves a hand-authored trigger untouched', () => {
  const authored = { id: 'mine', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' };
  const out = expandGithubChannels({
    roles: [{ id: 'dev', displayName: 'Dev', triggers: [{ ...authored }] }],
  });
  assert.deepEqual(out.roles[0].triggers.find(t => t.id === 'mine'), authored);
});

test('expandDataFlowSteps stamps no claim — a push step has no wake label', () => {
  const out = expandDataFlowSteps({
    roles: [
      { id: 'up', displayName: 'Up', outputs: [{ name: 'spec' }], triggers: [] },
      { id: 'down', displayName: 'Down', inputs: [{ name: 'spec' }], triggers: [] },
    ],
  });
  const t = out.roles.find(r => r.id === 'down').triggers.find(x => x.dataFlow);
  assert.deepEqual(t.events, ['push']);
  assert.equal(t.claim, undefined);
});

test('live reconcile path derives the same claim as the draft path (#958)', () => {
  // reconcileTeamGithubChannels strips the previously-derived channel triggers and
  // re-expands from the ports through this very function, so the live port write
  // and the draft materialise cannot diverge. Model that round: expanding an
  // ALREADY-expanded role set (derived stripped first) is byte-stable.
  const roles = [
    { id: 'dev', displayName: 'Dev', github: { producesPr: true }, triggers: [] },
    { id: 'rev', displayName: 'Reviewer', channels: [{ artifact: 'pr', from: 'dev', label: 'ready-for-test' }], triggers: [] },
  ];
  const pass1 = expandGithubChannels({ roles }).roles;
  const stripped = pass1.map(r => ({ ...r, triggers: r.triggers.filter(t => t.channel !== true) }));
  const pass2 = expandGithubChannels({ roles: stripped }).roles;
  const claimOf = (rs) => rs.find(r => r.id === 'rev').triggers.find(t => t.channel).claim;
  assert.deepEqual(claimOf(pass2), { remove: 'ready-for-test', add: 'ready-for-test:wip' });
  assert.deepEqual(claimOf(pass2), claimOf(pass1)); // reconcile is stable
});

test('claim survives export → materialise round-trip', () => {
  const bundle = buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme',
    roles: [{
      id: 'acme-dev', displayName: 'Dev', systemPrompt: 'p',
      triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'],
        labelFilter: 'ready', claim: { remove: 'ready', add: 'ready:wip' } }],
    }],
  });
  // Exported bundle keeps the claim…
  const exported = bundle.roles[0].triggers.find(t => t.id === 't');
  assert.deepEqual(exported.claim, { remove: 'ready', add: 'ready:wip' });
  assert.equal(validateProcessTemplate(bundle).ok, true);
  // …and materialising re-derives it against the substituted label.
  const member = buildMemberFromTemplate(
    { displayName: 'Dev', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: '{{wake}}', claim: { remove: '{{wake}}', add: '{{wake}}:wip' } }] },
    { vars: { repoFullName: 'o/r', wake: 'ready' } },
  );
  const mt = member.triggers.find(t => t.id === 't');
  assert.equal(mt.labelFilter, 'ready');
  assert.deepEqual(mt.claim, { remove: 'ready', add: 'ready:wip' });
});

test('materialise drops the claim when the template opted out', () => {
  const member = buildMemberFromTemplate(
    { displayName: 'Dev', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' }] },
    { vars: { repoFullName: 'o/r' } },
  );
  assert.equal(member.triggers.find(t => t.id === 't').claim, undefined);
});

test('bundleTrigger drops a claim that does not satisfy the convention', () => {
  // A corrupt/legacy claim must not be exported as if it were authoritative.
  const bundle = buildProcessTemplate({
    name: 'x', level: 'template',
    roles: [{ id: 'dev', displayName: 'Dev', systemPrompt: 'p',
      triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'],
        labelFilter: 'ready', claim: { remove: 'something-else', add: 'nope' } }] }],
  });
  assert.equal(bundle.roles[0].triggers.find(t => t.id === 't').claim, undefined);
  assert.equal(validateProcessTemplate(bundle).ok, true); // and the export stays valid
});

test('templateToCustomRoles carries the claim into the member config (#958)', () => {
  // REGRESSION: dropping `claim` here made the feature a silent runtime no-op —
  // the graph rendered the badge, but the container's triggers.json had no claim
  // for `_claim_plan` (#957) to act on. Caught by an end-to-end pipeline run, not
  // by the unit tests above, so it is pinned explicitly.
  const roles = templateToCustomRoles({
    roles: [{
      id: 'dev', displayName: 'Dev', systemPrompt: 'p',
      triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'],
        labelFilter: 'ready', claim: { remove: 'ready', add: 'ready:wip' }, prompt: 'go' }],
    }],
  });
  assert.deepEqual(roles[0].triggers[0].claim, { remove: 'ready', add: 'ready:wip' });

  // ...and the full materialise chain lands it on the runtime trigger.
  const member = buildMemberFromTemplate(roles[0], { teamId: 'acme', vars: { repoFullName: 'o/r' } });
  assert.deepEqual(member.triggers.find(t => t.id === 't').claim, { remove: 'ready', add: 'ready:wip' });
});

// ── #987: named human roles round-trip + validation ─────────────────────────

test('#987: buildProcessTemplate emits a normalized humans[]; omitted when empty', () => {
  const withHumans = buildProcessTemplate({
    name: 'x', level: 'live', roles: [{ id: 'dev' }],
    humans: [{
      id: '  reviewer  ', name: '  Issue Reviewer  ', description: ' reviews ', stage: 'triage',
      emits: ['dispatch', 'dispatch', ''], consumes: [
        { label: ' needs-decision ' },
        { artifact: 'issue', from: ' ba ' },
        { artifact: 'file', name: ' report ' },
        { artifact: 'bogus' }, // dropped
      ],
    }],
  });
  assert.deepEqual(withHumans.humans, [{
    id: 'reviewer', name: 'Issue Reviewer', description: 'reviews', stage: 'triage',
    emits: ['dispatch'],
    consumes: [{ label: 'needs-decision' }, { artifact: 'issue', from: 'ba' }, { artifact: 'file', name: 'report' }],
  }]);
  const none = buildProcessTemplate({ name: 'x', level: 'live', roles: [{ id: 'dev' }] });
  assert.ok(!('humans' in none));
});

test('#987: validateProcessTemplate accepts a well-formed humans[] and rejects bad shapes', () => {
  const base = { processTemplateVersion: 1, roles: [{ id: 'dev' }] };
  assert.ok(validateProcessTemplate({ ...base, humans: [{ id: 'r', name: 'R', emits: ['go'], consumes: [{ label: 'x' }] }] }).ok);
  assert.equal(validateProcessTemplate({ ...base, humans: 'nope' }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, humans: [{ name: 'no id' }] }).ok, false);
  assert.equal(validateProcessTemplate({ ...base, humans: [{ id: 'r' }] }).ok, false); // missing name
  assert.equal(validateProcessTemplate({ ...base, humans: [{ id: 'r', name: 'R' }, { id: 'r', name: 'R2' }] }).ok, false); // dup id
  assert.equal(validateProcessTemplate({ ...base, humans: [{ id: 'r', name: 'R', consumes: [{ artifact: 'pr' }] }] }).ok, false); // missing from
  assert.equal(validateProcessTemplate({ ...base, humans: [{ id: 'r', name: 'R', emits: [1] }] }).ok, false); // non-string emit
});

test('#987 AC1: humans[] round-trips build → validate', () => {
  const bundle = buildProcessTemplate({
    name: 'flow', level: 'live', roles: [{ id: 'dev' }],
    humans: [{ id: 'reviewer', name: 'Issue Reviewer', emits: ['dispatch'], consumes: [{ artifact: 'issue', from: 'ba' }] }],
  });
  assert.ok(validateProcessTemplate(bundle).ok);
  // A second pass through build is idempotent.
  const again = buildProcessTemplate({ name: 'flow', level: 'live', roles: [{ id: 'dev' }], humans: bundle.humans });
  assert.deepEqual(again.humans, bundle.humans);
});

test('#987: emptyDraftBundle carries an empty humans[]', () => {
  assert.deepEqual(emptyDraftBundle('x').humans, []);
});

// ─── #1006: the raw-layer wiring rules (one event, claim shape) ──────────────

test('#1006: rawTriggerError — one event per github-event trigger, legacy passthrough on update', () => {
  const { rawTriggerError } = require('./process-template');
  const two = { type: 'github-event', events: ['issues.labeled', 'pull_request.labeled'], labelFilter: 'x' };
  // Create (no prev): rejected with an actionable message.
  assert.match(rawTriggerError(two), /exactly ONE event/);
  // Unchanged legacy multi-event passing through an update: tolerated.
  assert.equal(rawTriggerError(two, { ...two }), null);
  // Changing events but staying multi: rejected.
  assert.match(rawTriggerError(two, { ...two, events: ['issues.labeled', 'push'] }), /exactly ONE event/);
  // Single event: fine; non-github types: never checked.
  assert.equal(rawTriggerError({ type: 'github-event', events: ['issues.labeled'], labelFilter: 'x' }), null);
  assert.equal(rawTriggerError({ type: 'cron', events: ['a', 'b'] }), null);
  // Claim shape folds in (same claimError as the bundle validator).
  assert.match(
    rawTriggerError({ type: 'github-event', events: ['issues.labeled'], labelFilter: 'x', claim: { remove: 'x', add: 'wrong' } }),
    /:wip/,
  );
});

test('#1008: the strict bundle validator rejects multi-event triggers; drafts stay saveable', () => {
  // The #1006 tolerance existed only until the generators were migrated; #1008
  // flipped strict validation (materialise, registry, weaver self-check) to the
  // full `rawTriggerError` contract. DRAFT mode (`allowEmptyRoles`) still
  // tolerates a pre-flip multi-event trigger — the editor's migration flow
  // (shrink the events, then save) must not deadlock on an unsaveable draft.
  const bundle = {
    processTemplateVersion: 1,
    roles: [{ id: 'r', name: 'R', prompt: 'x', triggers: [
      { id: 't', type: 'github-event', events: ['issues.labeled', 'pull_request.labeled'], labelFilter: 'go', prompt: 'p' },
    ] }],
  };
  const strict = validateProcessTemplate(bundle);
  assert.equal(strict.ok, false);
  assert.match(strict.error, /exactly ONE event/);
  assert.equal(validateProcessTemplate(bundle, { allowEmptyRoles: true }).ok, true);
  // A malformed claim is rejected in BOTH modes.
  bundle.roles[0].triggers[0].events = ['issues.labeled'];
  bundle.roles[0].triggers[0].claim = { remove: 'go', add: 'wrong' };
  assert.equal(validateProcessTemplate(bundle).ok, false);
  assert.equal(validateProcessTemplate(bundle, { allowEmptyRoles: true }).ok, false);
});

// ─── #1007: wiring-aware Outcomes prompt projection ──────────────────────────

test('#1007: outcomesWiringContext derives consumers, reviewers (with gates) and gate labels', () => {
  const { outcomesWiringContext } = require('./process-template');
  const ctx = outcomesWiringContext('ba', {
    roles: [
      { id: 'ba', name: 'BA' },
      { id: 'dev', displayName: 'Developer', triggers: [
        { id: 't1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' },
      ] },
      { id: 'qa', displayName: 'QA', triggers: [
        { id: 't2', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' },
        { id: 't3', type: 'cron', cron: '* * * * *' },
      ] },
    ],
    humans: [{ id: 'p', name: 'BA Human', emits: ['approve-it'], consumes: [{ artifact: 'issue', from: 'ba' }] }],
    labels: [{ name: 'dispatch', humanGate: true }, { name: 'hold', brake: true }],
  });
  assert.deepEqual(ctx.consumersByLabel, { ready: ['Developer', 'QA'] });
  assert.deepEqual(ctx.reviewers, { issue: { name: 'BA Human', gates: ['approve-it'] } });
  assert.deepEqual(ctx.gateLabels, ['approve-it', 'dispatch']); // brake labels are NOT gates
  // No context at all → null, so the block renders exactly as before #1007.
  assert.equal(outcomesWiringContext('solo', { roles: [{ id: 'solo' }] }), null);
});

test('#1007: the generated block carries consumer, reviewer+prohibition and marker context', () => {
  const wiring = {
    consumersByLabel: { ready: ['Developer'] },
    reviewers: { issue: { name: 'BA Human', gates: ['approve-it'] } },
    gateLabels: ['approve-it'],
  };
  const block = outcomesBlock({
    mode: 'anyOf',
    options: [
      { id: 'route', title: 'Route', actions: [{ type: 'setLabel', label: 'ready' }] },
      { id: 'ticket', title: 'Files ticket', actions: [{ type: 'openIssue' }] },
      { id: 'done', title: 'Done', actions: [{ type: 'none' }], terminal: true },
      { id: 'report', title: 'Report', actions: [{ type: 'openPr' }], external: { note: 'platform team' } },
    ],
  }, wiring);
  assert.match(block, /apply label `ready` — this wakes \*\*Developer\*\*/);
  assert.match(block, /\*\*BA Human\*\* reviews it\./);
  assert.match(block, /Do \*\*not\*\* apply the gate label `approve-it` yourself — a person applies it\./);
  assert.match(block, /This is the final deliverable — set no further signal\./);
  assert.match(block, /Consumed outside this flow \(platform team\) — no further signal expected\./);
  assert.match(block, /The label `approve-it` is a human approval gate — a person applies it; never set it yourself\./);
  // Without wiring the same port renders the pre-#1007 text (no drift for
  // context-less agents) — locked by the earlier outcomesBlock tests too.
  const plain = outcomesBlock({ mode: 'anyOf', options: [{ id: 'route', title: 'Route', actions: [{ type: 'setLabel', label: 'ready' }] }] });
  assert.ok(!plain.includes('this wakes'));
});

test('#1007: materialise second pass — a producer EARLIER in the list sees later-derived consumers', () => {
  const bundle = {
    processTemplateVersion: 1,
    name: 'x',
    roles: [
      { id: 'ba', name: 'BA', systemPrompt: 'You write tickets.',
        outcomes: { mode: 'anyOf', options: [{ id: 'ticket', title: 'Opens issue', actions: [{ type: 'openIssue' }] }] } },
      // The consumer comes AFTER the producer; its listener is derived from
      // this channel during expansion — the producer's prompt must still see it.
      { id: 'dev', name: 'Developer', systemPrompt: 'You build.',
        channels: [{ artifact: 'issue', from: 'ba', label: 'go' }] },
    ],
    humans: [{ id: 'p', name: 'BA Human', emits: ['go'], consumes: [{ artifact: 'issue', from: 'ba' }] }],
  };
  const out = expandGithubChannels(bundle, { repoFullName: 'o/r' });
  const ba = out.roles.find(r => r.id === 'ba');
  assert.match(ba.systemPrompt, /\*\*BA Human\*\* reviews it\./);
  assert.match(ba.systemPrompt, /Do \*\*not\*\* apply the gate label `go` yourself/);
  // Idempotent under re-expansion (strip-then-reappend).
  const again = expandGithubChannels(out, { repoFullName: 'o/r' });
  assert.equal(again.roles.find(r => r.id === 'ba').systemPrompt, ba.systemPrompt);
});

test('launchedLoopConflict: rejects a second launched loop, allows the first (#1020 AC8)', () => {
  const { launchedLoopConflict } = require('./process-template');
  const launched = { type: 'loop', launched: true, maxIterations: 5 };
  // First launch — no existing launched loop.
  assert.equal(launchedLoopConflict([], launched), false);
  assert.equal(launchedLoopConflict([{ type: 'cron' }, { type: 'loop' }], launched), false);
  // Second launch while one runs — conflict.
  assert.equal(launchedLoopConflict([{ type: 'loop', launched: true }], launched), true);
  // A declarative loop (no `launched`) is not counted, and the candidate must
  // itself be a launched loop for a conflict to arise.
  assert.equal(launchedLoopConflict([{ type: 'loop', launched: true }], { type: 'cron' }), false);
  assert.equal(launchedLoopConflict([{ type: 'loop', launched: true }], { type: 'loop' }), false);
  assert.equal(launchedLoopConflict(null, launched), false);
});

// ── #1174: internal-channel transport — round-trip, validation, prompt wording ─

test('#1174: transport survives export → validate → customRoles → materialise', () => {
  const bundle = buildProcessTemplate({
    name: 'x', level: 'live', teamId: 'acme',
    roles: [{
      id: 'acme-dev', displayName: 'Dev', systemPrompt: 'p',
      triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'],
        labelFilter: 'ready', transport: 'internal',
        claim: { remove: 'ready', add: 'ready:wip' } }],
    }],
  });
  const exported = bundle.roles[0].triggers.find(t => t.id === 't');
  assert.equal(exported.transport, 'internal');
  assert.equal(validateProcessTemplate(bundle).ok, true);

  const roles = templateToCustomRoles(bundle);
  assert.equal(roles[0].triggers[0].transport, 'internal');

  const member = buildMemberFromTemplate(roles[0], { teamId: 'acme', vars: { repoFullName: 'o/r' } });
  const mt = member.triggers.find(t => t.id === 't');
  assert.equal(mt.transport, 'internal');
  // Claim coexists — the runner swap works on internally delivered wakes too.
  assert.deepEqual(mt.claim, { remove: 'ready', add: 'ready:wip' });
});

test('#1174: default (github/absent) transport is not exported — bundles stay noise-free', () => {
  const bundle = buildProcessTemplate({
    name: 'x', level: 'template',
    roles: [{ id: 'dev', displayName: 'Dev', systemPrompt: 'p',
      triggers: [
        { id: 'a', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', transport: 'github' },
        { id: 'b', type: 'github-event', events: ['issues.labeled'], labelFilter: 'go' },
      ] }],
  });
  for (const t of bundle.roles[0].triggers) assert.equal(t.transport, undefined);
});

test('#1174: validateProcessTemplate rejects a bad transport value and internal on a non-label trigger', () => {
  const mk = (trigger) => ({
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [{ id: 'dev', displayName: 'Dev', triggers: [trigger] }],
  });
  assert.equal(validateProcessTemplate(mk(
    { id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', transport: 'quantum' },
  )).ok, false);
  assert.equal(validateProcessTemplate(mk(
    { id: 't', type: 'github-event', events: ['pull_request.opened'], transport: 'internal' },
  )).ok, false);
  assert.equal(validateProcessTemplate(mk(
    { id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', transport: 'internal' },
  )).ok, true);
});

test('#1174: outcomesWiringContext reports labels with an internal listener', () => {
  const { outcomesWiringContext } = require('./process-template');
  const ctx = outcomesWiringContext('ba', {
    roles: [
      { id: 'ba', displayName: 'BA', triggers: [] },
      { id: 'dev', displayName: 'Developer', triggers: [
        { type: 'github-event', labelFilter: 'ready', transport: 'internal' }] },
      { id: 'qa', displayName: 'QA', triggers: [
        { type: 'github-event', labelFilter: 'qa:go' }] },
    ],
  });
  assert.deepEqual(ctx.internalLabels, ['ready']);
  // A poller-delivered label contributes no internal marker.
  assert.deepEqual(ctx.consumersByLabel['qa:go'], ['QA']);
});

test('#1174: outcomesBlock instructs aee-emit for internal labels, gh for the rest', () => {
  const outcomes = { mode: 'anyOf', options: [
    { id: 'done', title: 'Done', actions: [{ type: 'setLabel', label: 'ready' }] },
    { id: 'qa', title: 'QA', actions: [{ type: 'setLabel', label: 'qa:go' }] },
  ] };
  const wiring = {
    consumersByLabel: { ready: ['Developer'], 'qa:go': ['QA'] },
    reviewers: {}, gateLabels: [], internalLabels: ['ready'],
  };
  const block = outcomesBlock(outcomes, wiring);
  assert.match(block, /aee-emit "ready" --issue <n>/);
  assert.match(block, /wakes \*\*Developer\*\* directly/);
  // The github-delivered label keeps the plain apply wording.
  assert.match(block, /apply label `qa:go` — this wakes \*\*QA\*\*/);
  // Hard rule appended once for the internal label set.
  assert.match(block, /never with `gh issue edit --add-label`/);
});

test('#1174: outcomesBlock without internal labels is unchanged (no aee-emit mention)', () => {
  const outcomes = { mode: 'anyOf', options: [
    { id: 'done', title: 'Done', actions: [{ type: 'setLabel', label: 'ready' }] },
  ] };
  const wiring = { consumersByLabel: { ready: ['Dev'] }, reviewers: {}, gateLabels: [] };
  assert.doesNotMatch(outcomesBlock(outcomes, wiring), /aee-emit/);
});

// ── #2030: direct agent hand-off — the prompt projection (§4.3) ─────────────

const HANDOFF_ROLES = [
  { id: 'developer', displayName: 'Developer',
    outcomes: { mode: 'anyOf', options: [{ id: 'done', actions: [
      { type: 'openPr' },
      { type: 'wakeAgent', to: 'code-reviewer', note: 'Look closely at the migration in step 3.' },
    ] }] } },
  { id: 'code-reviewer', displayName: 'Code Reviewer' },
];

test('#2030: outcomesWiringContext maps a wake target to its display name', () => {
  const { outcomesWiringContext } = require('./process-template');
  const ctx = outcomesWiringContext('developer', { roles: HANDOFF_ROLES });
  assert.deepEqual(ctx.wakeTargets, { 'code-reviewer': 'Code Reviewer' });
});

test('#2030: an unresolvable wake target keeps its own id — delivery uses the id', () => {
  const { outcomesWiringContext } = require('./process-template');
  const ctx = outcomesWiringContext('developer', { roles: [HANDOFF_ROLES[0]] });
  assert.deepEqual(ctx.wakeTargets, { 'code-reviewer': 'code-reviewer' });
});

test('#2030: wakeTargets is absent for a role that hands off to nobody (null-context contract)', () => {
  const { outcomesWiringContext } = require('./process-template');
  // A lone role with no wiring at all still returns null — the pre-#1007
  // byte-identical output contract must not be perturbed by the new field.
  assert.equal(outcomesWiringContext('solo', { roles: [{ id: 'solo' }] }), null);
  // …and a role wired only by labels gets no wakeTargets key.
  const ctx = outcomesWiringContext('a', {
    roles: [
      { id: 'a', displayName: 'A' },
      { id: 'b', displayName: 'B', triggers: [{ type: 'github-event', labelFilter: 'ready' }] },
    ],
  });
  assert.equal('wakeTargets' in ctx, false);
});

test('#2030: outcomeActionClause renders the aee-wake command and names the peer', () => {
  const { outcomesWiringContext } = require('./process-template');
  const wiring = outcomesWiringContext('developer', { roles: HANDOFF_ROLES });
  const block = outcomesBlock(HANDOFF_ROLES[0].outcomes, wiring);
  assert.match(block, /hand off directly to \*\*Code Reviewer\*\*/);
  assert.match(block, /`aee-wake --to code-reviewer --note "Look closely at the migration in step 3\."`/);
  // It composes with the PR it rides alongside.
  assert.match(block, /open a pull request and hand off directly/);
});

test('#2030: WITHOUT the branch the option would render "set no label" — the silent-wrong-prompt guard', () => {
  const block = outcomesBlock({ mode: 'anyOf', options: [
    { id: 'h', title: 'Hand off', actions: [{ type: 'wakeAgent', to: 'code-reviewer' }] },
  ] });
  assert.ok(!block.includes('set no label'),
    'a wakeAgent falling through the action chain renders as "set no label" — silently wrong, not an error');
  assert.match(block, /`aee-wake --to code-reviewer`/);
});

test('#2030: the fail-closed tail paragraph is appended once, only when a hand-off exists', () => {
  const withWake = outcomesBlock({ mode: 'anyOf', options: [
    { id: 'h', actions: [{ type: 'wakeAgent', to: 'r1' }] },
    { id: 'h2', actions: [{ type: 'wakeAgent', to: 'r2' }] },
  ] });
  const rule = /A direct hand-off is delivered inside the platform: always announce it with `aee-wake`, never by applying a label/g;
  assert.equal((withWake.match(rule) || []).length, 1);
  assert.match(withWake, /nothing on GitHub will show that the hand-off did or did not happen/);
  // A flow with no direct hand-off is untouched.
  assert.ok(!outcomesBlock(EXACTLY_ONE).match(rule));
});

test('#2030: a note is quoted safely into the generated command', () => {
  const block = outcomesBlock({ mode: 'anyOf', options: [
    { id: 'h', actions: [{ type: 'wakeAgent', to: 'r', note: 'mind the "edge" case' }] },
  ] });
  // The command is a single shell word; an embedded double quote would break it.
  assert.match(block, /`aee-wake --to r --note "mind the 'edge' case"`/);
});

test('#2030: a to-less wakeAgent contributes no clause rather than a broken command', () => {
  const block = outcomesBlock({ mode: 'anyOf', options: [
    { id: 'h', title: 'Broken', actions: [{ type: 'wakeAgent' }] },
  ] });
  assert.ok(!block.includes('aee-wake'));
  assert.match(block, /set no label/);
});

test('#2030: outcomesWiringContext reads the port off a LIVE member shape too', () => {
  // reconcileTeamOutcomes (api.js) pushes `{id, cfg, displayName, triggers}` —
  // the port is on `cfg`. Reading only `r.outcomes` yields an empty map on
  // EVERY live team, so the generated clause echoes the raw member id instead
  // of the display name the map exists to supply.
  const { outcomesWiringContext } = require('./process-template');
  const live = [
    { id: 'acme-developer', displayName: 'Developer',
      cfg: { outcomes: { mode: 'anyOf', options: [{ id: 'done', actions: [
        { type: 'wakeAgent', to: 'acme-code-reviewer' }] }] } }, triggers: [] },
    { id: 'acme-code-reviewer', displayName: 'Code Reviewer', cfg: {}, triggers: [] },
  ];
  const ctx = outcomesWiringContext('acme-developer', { roles: live });
  assert.deepEqual(ctx.wakeTargets, { 'acme-code-reviewer': 'Code Reviewer' });
  const block = outcomesBlock(live[0].cfg.outcomes, ctx);
  assert.match(block, /hand off directly to \*\*Code Reviewer\*\*/);
});
