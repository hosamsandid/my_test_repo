'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProcessTemplate, validateProcessTemplate, templateToCustomRoles, expandGithubChannels, normalizeLegacyReview, expandDataFlowSteps, emptyDraftBundle, roleKeyOf } = require('./process-template');

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
  assert.deepEqual(t.from, ['acme-developer']); // scoped to the producer member id
  assert.equal(t.labelFilter, undefined);
  // non-consumer roles untouched
  assert.equal(out.roles.find(r => r.id === 'release').triggers.length, 0);
});

test('expandGithubChannels: a labelled human gate reacts to *.labeled from humans', () => {
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
  assert.equal(t.from, 'humans');
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
  assert.deepEqual(t.from, ['acme-a'], 'scoped to the upstream member id, not a generic push');
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
  assert.deepEqual(t.from, ['acme-producer']);
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
  assert.deepEqual(t.from, ['acme-ba']);
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
  assert.ok(t && t.promptTemplate && t.from.includes('acme-a'));
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
