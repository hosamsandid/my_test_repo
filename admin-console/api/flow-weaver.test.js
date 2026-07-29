'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { weaveProcess, stripWeaverBlock } = require('./flow-weaver');
const { validateProcessTemplate } = require('./process-template');
const { processTemplateToUnified, buildUnifiedGraph } = require('./unified-graph');

const CATALOG = path.join(__dirname, '..', '..', 'orchestrator', 'skill-pool', 'agent-templates');
const tpl = (id) => JSON.parse(fs.readFileSync(path.join(CATALOG, id + '.json'), 'utf8'));

// The weaver's contract: the woven bundle renders with zero error and zero
// warning lints (info allowed). Mirrors the canvas' unified-graph path.
function nonInfoLints(bundle) {
  const flow = processTemplateToUnified(bundle);
  // The woven bundle's own `labels[]` registry is the authoritative gate/brake
  // source (#928) — thread it in exactly as POST /api/flows/graph does, or the
  // weaver's human-gated stage boundaries look like orphan listeners.
  const g = buildUnifiedGraph(flow.nodes, flow.edges, { labels: flow.labels });
  return g.lints.filter(l => l.severity === 'error' || l.severity === 'warning');
}

const inlineAuthor = (id) => ({
  id, displayName: id, sessionPolicy: 'per-invocation', inline: true,
  patternRole: 'author', github: { producesPr: true },
  systemPrompt: `You are ${id}.`, triggers: [],
});

test('extended-SDLC-like composition is valid, complete and lint-clean', () => {
  const { bundle, notes } = weaveProcess({
    name: 'Extended SDLC (woven)',
    stages: [
      { name: 'Requirements', roles: [tpl('issue-triage'), tpl('business-analyst')] },
      { name: 'Design', roles: [tpl('scout'), tpl('stage-author'), tpl('stage-companion')] },
      { name: 'Build', roles: [tpl('developer'), tpl('code-reviewer')] },
      { name: 'Release', roles: [tpl('documentation-sync'), tpl('release-notes-writer')] },
    ],
  });

  assert.ok(validateProcessTemplate(bundle).ok);
  assert.deepEqual(nonInfoLints(bundle), []);
  assert.deepEqual(bundle.stages, ['Requirements', 'Design', 'Build', 'Release']);

  const byId = new Map(bundle.roles.map(r => [r.id, r]));
  // Generic pattern templates get stage-scoped ids.
  assert.deepEqual(
    [...byId.keys()].sort(),
    ['business-analyst', 'code-reviewer', 'design-author', 'design-companion',
      'design-scout', 'developer', 'documentation-sync', 'issue-triage', 'release-notes-writer'].sort(),
  );

  // Stage chain: BA issue → (human gate) → Design scout; Design companion
  // hand-over → (human gate) → Developer.
  assert.deepEqual(byId.get('design-scout').channels, [
    { artifact: 'issue', from: 'business-analyst', label: 'requirements:approved', gate: 'human' },
  ]);
  assert.deepEqual(byId.get('developer').channels, [
    { artifact: 'issue', from: 'design-companion', label: 'design:approved', gate: 'human' },
  ]);
  // The Design companion gained the hand-over duty (producesIssue) because
  // Build consumes it; the Build companion (last producing stage) did not.
  assert.equal(byId.get('design-companion').github.producesIssue, true);
  assert.equal(byId.get('code-reviewer').github, undefined);

  // Intra-stage wiring: scout emits author-go, author listens + emits escalate,
  // companion consumes the author's PRs and brokers the escalation.
  assert.ok(byId.get('design-scout').emits.includes('design:author-go'));
  const authorWake = byId.get('design-author').triggers.find(t => t.id === 'author-wake');
  assert.equal(authorWake.labelFilter, 'design:author-go');
  assert.ok(byId.get('design-author').emits.includes('design:escalate'));
  assert.ok(byId.get('design-author').triggers.some(t => t.id === 'rework-on-review'));
  assert.deepEqual(byId.get('design-companion').channels, [{ artifact: 'pr', from: 'design-author' }]);
  assert.equal(byId.get('design-companion').triggers.find(t => t.id === 'escalate-wake').labelFilter, 'design:escalate');
  assert.ok(byId.get('design-companion').triggers.some(t => t.id === 'human-feedback'));

  // Stage tokens resolved in prompts; wiring notes appended.
  assert.ok(byId.get('design-author').systemPrompt.includes('Design Author'));
  assert.ok(!byId.get('design-author').systemPrompt.includes('{{stageName}}'));
  assert.ok(byId.get('design-companion').systemPrompt.includes('design:approved'));

  // Dispatcher wiring on developer was dropped; intrinsic essence kept.
  assert.ok(!byId.get('developer').triggers.some(t => t.id === 'developer-assigned'));
  assert.ok(byId.get('issue-triage').triggers.some(t => t.id === 'triage-issue-opened'));
  assert.equal(byId.get('business-analyst').triggers.find(t => t.id === 'ba-on-refine').labelFilter, 'needs-refinement');

  // Gap notes: Build has no scout; Release is passive.
  assert.ok(notes.some(n => n.rule === 'no-scout' && n.stage === 'Build'));
  assert.ok(notes.some(n => n.rule === 'passive-stage' && n.stage === 'Release'));

  // Self-curation crons are staggered and unique. Every catalog role ships one
  // (the intrinsic standard trigger), so all woven roles carry a distinct slot.
  const crons = bundle.roles
    .map(r => (r.triggers || []).find(t => t.id === 'self-curation'))
    .filter(Boolean).map(t => t.cron);
  assert.equal(new Set(crons).size, crons.length);
  assert.equal(crons.length, bundle.roles.length);

  // The human-gated boundary labels are registered as such.
  const labelMap = new Map(bundle.labels.map(l => [l.name, l]));
  assert.equal(labelMap.get('requirements:approved').humanGate, true);
  assert.equal(labelMap.get('design:approved').humanGate, true);
  assert.equal(labelMap.get('design:author-go').humanGate, false);
});

test('author-only stage: gap rules merge scout+companion duties, stays lint-clean', () => {
  const { bundle, notes } = weaveProcess({
    name: 'Solo',
    stages: [{ name: 'Build', roles: [tpl('developer')] }],
  });
  assert.deepEqual(nonInfoLints(bundle), []);
  const dev = bundle.roles[0];
  // No emitter for author-go exists → no author-wake listener; no companion →
  // no escalate emit; rework listener stays.
  assert.ok(!dev.triggers.some(t => t.id === 'author-wake'));
  assert.ok(dev.triggers.some(t => t.id === 'rework-on-review'));
  assert.equal(dev.emits, undefined);
  assert.ok(notes.some(n => n.rule === 'no-scout'));
  assert.ok(notes.some(n => n.rule === 'no-companion'));
  assert.ok(dev.systemPrompt.includes('readiness check'));
});

test('two author-only stages: first author gains the hand-over duty + human gate', () => {
  const { bundle, notes } = weaveProcess({
    name: 'Duo',
    stages: [
      { name: 'Design', roles: [tpl('stage-author')] },
      { name: 'Build', roles: [inlineAuthor('builder')] },
    ],
  });
  assert.deepEqual(nonInfoLints(bundle), []);
  const design = bundle.roles.find(r => r.id === 'design-author');
  const builder = bundle.roles.find(r => r.id === 'builder');
  assert.equal(design.github.producesIssue, true);
  assert.equal(design.github.producesPr, true);
  assert.deepEqual(builder.channels, [
    { artifact: 'issue', from: 'design-author', label: 'design:approved', gate: 'human' },
  ]);
  assert.ok(notes.some(n => n.rule === 'exit-via-author' && n.stage === 'Design'));
});

test('human gate can be disabled per producing stage', () => {
  const { bundle, notes } = weaveProcess({
    name: 'No gate',
    stages: [
      { name: 'Design', roles: [tpl('stage-author')] },
      { name: 'Build', roles: [inlineAuthor('builder')] },
    ],
    options: { humanGates: { Design: false } },
  });
  assert.deepEqual(nonInfoLints(bundle), []);
  const builder = bundle.roles.find(r => r.id === 'builder');
  assert.deepEqual(builder.channels, [
    { artifact: 'issue', from: 'design-author', label: 'design:approved' },
  ]);
  assert.equal(bundle.labels.find(l => l.name === 'design:approved').humanGate, false);
  assert.ok(notes.some(n => n.rule === 'gate-disabled'));
});

test('passive stages are skipped by the chain, later stages connect around them', () => {
  const { bundle } = weaveProcess({
    name: 'Skip',
    stages: [
      { name: 'Build', roles: [tpl('stage-author'), tpl('stage-companion')] },
      { name: 'Release', roles: [tpl('release-notes-writer')] },
      { name: 'Audit', roles: [inlineAuthor('auditor')] },
    ],
  });
  assert.deepEqual(nonInfoLints(bundle), []);
  const auditor = bundle.roles.find(r => r.id === 'auditor');
  assert.deepEqual(auditor.channels, [
    { artifact: 'issue', from: 'build-companion', label: 'build:approved', gate: 'human' },
  ]);
});

test('the same generic template in two stages gets distinct stage-scoped ids', () => {
  const { bundle } = weaveProcess({
    name: 'Twice',
    stages: [
      { name: 'Design', roles: [tpl('stage-author'), tpl('stage-companion')] },
      { name: 'Build', roles: [tpl('stage-author'), tpl('stage-companion')] },
    ],
  });
  assert.deepEqual(nonInfoLints(bundle), []);
  const ids = bundle.roles.map(r => r.id).sort();
  assert.deepEqual(ids, ['build-author', 'build-companion', 'design-author', 'design-companion']);
});

test('inline roles keep all their triggers (no origin filter added)', () => {
  const { bundle } = weaveProcess({
    name: 'Inline',
    stages: [{
      name: 'Ops',
      roles: [{
        id: 'ops-bot', inline: true, sessionPolicy: 'per-invocation',
        patternRole: 'standalone', systemPrompt: 'You operate.',
        triggers: [{ id: 'on-release', type: 'github-event', events: ['release.published'] }],
      }],
    }],
  });
  assert.deepEqual(nonInfoLints(bundle), []);
  const t = bundle.roles[0].triggers.find(x => x.id === 'on-release');
  assert.ok(t, 'inline trigger is kept');
  assert.ok(!('from' in t), 'no origin filter is synthesised');
});

test('invalid input throws instead of producing a broken bundle', () => {
  assert.throws(() => weaveProcess({ name: '', stages: [] }), /name required/);
  assert.throws(() => weaveProcess({ name: 'X', stages: [] }), /non-empty/);
  assert.throws(() => weaveProcess({ name: 'X', stages: [{ name: 'A', roles: [{}] }] }), /template object with an id/);
  assert.throws(() => weaveProcess({ name: 'X', stages: [{ name: 'A', roles: [] }, { name: 'A', roles: [] }] }), /duplicate stage/);
});

test('stripWeaverBlock removes the wiring notes for round-trips', () => {
  const { bundle } = weaveProcess({
    name: 'Strip',
    stages: [{ name: 'Build', roles: [tpl('stage-author'), tpl('stage-companion')] }],
  });
  const author = bundle.roles.find(r => r.id === 'build-author');
  assert.ok(author.systemPrompt.includes('## Wiring notes'));
  assert.ok(!stripWeaverBlock(author.systemPrompt).includes('## Wiring notes'));
});

// #928 AC6 — the weaver registers `humanGate` on every gated stage boundary and
// puts `gate: 'human'` on the consuming channel, so the woven bundle classifies
// its gates from the FLAGS alone (no `human:` prefix is ever produced) and stays
// lint-clean under the flag model.
test('#928: woven gates come from the flags, not the label name, and stay lint-clean', () => {
  const { bundle } = weaveProcess({
    name: 'Flagged',
    stages: [
      { name: 'Requirements', roles: [tpl('issue-triage'), tpl('business-analyst')] },
      { name: 'Build', roles: [tpl('developer'), tpl('code-reviewer')] },
    ],
  });
  const gated = bundle.labels.filter(l => l.humanGate);
  assert.ok(gated.length >= 1, 'the weaver must register at least one human gate');
  for (const l of gated) {
    assert.ok(!l.name.startsWith('human:'), `woven gate ${l.name} must not use the retired prefix`);
  }
  // Each gated label is also carried as a channel gate on its consumer.
  for (const l of gated) {
    assert.ok(
      bundle.roles.some(r => (r.channels || []).some(c => c.label === l.name && c.gate === 'human')),
      `gate ${l.name} must ride a channel gate: 'human'`,
    );
  }
  // Flag-driven classification: the gate renders from @github, and dropping the
  // registry would demote it to a plain label (proving the name plays no part).
  const flow = processTemplateToUnified(bundle);
  const withFlags = buildUnifiedGraph(flow.nodes, flow.edges, { labels: flow.labels });
  for (const l of gated) {
    const e = withFlags.edges.find(x => x.label === l.name && x.on === 'label');
    if (e) assert.equal(e.gate, 'human', `${l.name} must render as a gate`);
  }
  assert.deepEqual(nonInfoLints(bundle), []);
});
