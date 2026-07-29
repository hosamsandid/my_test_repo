'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProcessTemplates, loadProcessTemplate } = require('./process-template-registry');
const { validateProcessTemplate } = require('./process-template');
const { buildProcessGraph } = require('./process-graph');

function tmpRegistry(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-templates-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const validBundle = (name) => ({
  processTemplateVersion: 1,
  name,
  description: `${name} description`,
  level: 'template',
  stages: ['Requirements', 'Build'],
  roles: [
    { id: 'analyst', displayName: 'Analyst', role: 'team-member', sessionPolicy: 'persistent',
      github: { producesIssue: true }, systemPrompt: 'You analyse.', triggers: [] },
    { id: 'developer', displayName: 'Developer', role: 'team-member', sessionPolicy: 'per-invocation',
      channels: [{ artifact: 'issue', from: 'analyst', label: 'ready' }],
      github: { producesPr: true }, systemPrompt: 'You build.', triggers: [] },
  ],
  gates: [],
  labels: [{ name: 'ready', humanGate: false, brake: false }],
});

test('listProcessTemplates lists valid bundles with a shape summary', () => {
  const dir = tmpRegistry({ 'my-flow.json': validBundle('My Flow') });
  const list = listProcessTemplates(dir);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: 'my-flow', name: 'My Flow', description: 'My Flow description',
    roleCount: 2, stages: ['Requirements', 'Build'],
  });
});

test('listProcessTemplates skips invalid JSON and invalid bundles', () => {
  const dir = tmpRegistry({
    'good.json': validBundle('Good'),
    'broken.json': '{not json',
    'wrong-version.json': { processTemplateVersion: 2, roles: [{ id: 'x' }] },
    'empty-roles.json': { processTemplateVersion: 1, roles: [] }, // materialisation-strict
    'Bad Name.json': validBundle('Bad Name'), // id fails the slug pattern
  });
  const list = listProcessTemplates(dir);
  assert.deepEqual(list.map(t => t.id), ['good']);
});

test('listProcessTemplates returns [] for a missing directory', () => {
  assert.deepEqual(listProcessTemplates('/nonexistent/nope'), []);
});

test('loadProcessTemplate returns the full bundle, null for unknown/invalid ids', () => {
  const dir = tmpRegistry({ 'good.json': validBundle('Good') });
  const b = loadProcessTemplate(dir, 'good');
  assert.equal(b.name, 'Good');
  assert.equal(b.roles.length, 2);
  assert.equal(loadProcessTemplate(dir, 'missing'), null);
  assert.equal(loadProcessTemplate(dir, '../escape'), null);
  assert.equal(loadProcessTemplate(dir, 'UPPER'), null);
});

// The curated templates checked into the repo must stay valid and lint-clean
// (no error/warning lints — info is fine). This is the CI guard for #419.
const CURATED_DIR = path.join(__dirname, '..', '..', 'orchestrator', 'skill-pool', 'process-templates');

test('curated repo templates are valid bundles', () => {
  const list = listProcessTemplates(CURATED_DIR);
  const ids = list.map(t => t.id);
  assert.ok(ids.includes('core-sdlc'), `core-sdlc missing (got ${ids.join(', ')})`);
  assert.ok(ids.includes('extended-sdlc'), `extended-sdlc missing (got ${ids.join(', ')})`);
  for (const t of list) {
    const b = loadProcessTemplate(CURATED_DIR, t.id);
    assert.ok(validateProcessTemplate(b).ok, `${t.id} must validate`);
    assert.ok(t.description, `${t.id} needs a description`);
  }
});

test('curated repo templates render with no error/warning lints', () => {
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const b = loadProcessTemplate(CURATED_DIR, t.id);
    // Mirror the POST /api/process/graph preview path: roles become nodes with
    // their declarative ports; effective emits = persisted emits.
    const agents = b.roles.map(r => ({
      id: r.id, role: r.role || 'team-member', displayName: r.displayName,
      sessionPolicy: r.sessionPolicy, emits: r.emits, github: r.github,
      // Thread the structured `outcomes` port (#827/#830) so the outcome lints
      // (outcome-without-consumer / same-label-multiple-outcomes /
      // human-label-as-outcome / switch-with-one-option) are exercised against
      // the shipped templates too — they must stay clean under the new rules.
      outcomes: r.outcomes,
      channels: r.channels, triggers: r.triggers || [],
    }));
    // The bundle's `labels[]` registry is the authoritative gate/brake source
    // (#928) — the endpoint threads it in, so the guard must too. Without it a
    // gate listener (e.g. dispatched-sdlc's dispatcher) looks like an orphan.
    const graph = buildProcessGraph(agents, { labels: b.labels });
    const bad = graph.lints.filter(l => l.severity === 'error' || l.severity === 'warning');
    assert.deepEqual(bad, [], `${t.id} must be lint-clean, got: ${JSON.stringify(bad)}`);
  }
});

// #928 AC7 (forward half) — after #927 retires the `human:` prefix, the SAME
// bundle must still classify its gate from the flag. Simulate the rename here so
// the guarantee is proven before that ticket lands: rename every `human:*` token
// across the registry, the role triggers and the channels, and assert the gate
// survives and the bundle stays lint-clean.
test('#928 AC7: renaming the human:* tokens away keeps the gate and the lints clean', () => {
  const rename = (s) => (typeof s === 'string' && s.startsWith('human:')
    ? `approved-for-${s.slice('human:'.length)}` : s);
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const b = JSON.parse(JSON.stringify(loadProcessTemplate(CURATED_DIR, t.id)));
    const renamed = new Set();
    for (const l of (b.labels || [])) {
      if (l.name !== rename(l.name)) renamed.add(l.name);
      l.name = rename(l.name);
    }
    for (const g of (b.gates || [])) g.label = rename(g.label);
    for (const r of b.roles) {
      if (Array.isArray(r.emits)) r.emits = r.emits.map(rename);
      for (const ch of (r.channels || [])) if (ch.label) ch.label = rename(ch.label);
      for (const tr of (r.triggers || [])) if (tr.labelFilter) tr.labelFilter = rename(tr.labelFilter);
    }
    assert.ok(validateProcessTemplate(b).ok, `${t.id} must still validate after the rename`);

    const agents = b.roles.map(r => ({
      id: r.id, role: r.role || 'team-member', displayName: r.displayName,
      sessionPolicy: r.sessionPolicy, emits: r.emits, github: r.github,
      outcomes: r.outcomes, channels: r.channels, triggers: r.triggers || [],
    }));
    const graph = buildProcessGraph(agents, { labels: b.labels });

    // Every renamed gate label still classifies as a gate — on the flag alone.
    for (const old of renamed) {
      const now = rename(old);
      const entry = graph.labels.find(l => l.name === now);
      assert.ok(entry, `${t.id}: renamed label ${now} must survive into the registry`);
      assert.equal(entry.humanGate, true, `${t.id}: ${now} must still be a gate`);
      assert.ok(!graph.labels.some(l => l.name === old), `${t.id}: the old token ${old} must be gone`);
      // Its listener edge still originates outside the agent set (a human acts).
      for (const e of graph.edges.filter(x => x.label === now)) {
        assert.equal(e.kind, 'gate', `${t.id}: ${now} edge must stay a gate`);
        assert.equal(e.from, null);
      }
    }
    const bad = graph.lints.filter(l => l.severity === 'error' || l.severity === 'warning');
    assert.deepEqual(bad, [], `${t.id} must stay lint-clean after the rename, got: ${JSON.stringify(bad)}`);
  }
});
