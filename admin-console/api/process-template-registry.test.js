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
  assert.ok(ids.includes('simple-sdlc'), `simple-sdlc missing (got ${ids.join(', ')})`);
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
      channels: r.channels, triggers: r.triggers || [],
    }));
    const graph = buildProcessGraph(agents);
    const bad = graph.lints.filter(l => l.severity === 'error' || l.severity === 'warning');
    assert.deepEqual(bad, [], `${t.id} must be lint-clean, got: ${JSON.stringify(bad)}`);
  }
});
