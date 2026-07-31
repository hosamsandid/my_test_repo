'use strict';

// #1009 — read-only mirror parity (concept §8.2 V6, §8.3 rule 4): the
// Team-Setup wizard's inline flow preview must render the SAME edge set the
// Flows view computes for the same bundle — the server graph, never a local
// approximation. This guard runs the shipped curated bundles through the real
// endpoint pipeline (processTemplateToUnified → buildUnifiedGraph, labels +
// humans threaded exactly like POST /api/flows/graph) and asserts the wizard's
// adapter reproduces the graph's role-to-role edges 1:1.
//
// Lives in api/ (the CI-covered suite) and dynamic-imports the ESM adapter
// from src/pages/team-setup, across the same package boundary the app uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('node:url');

const { listProcessTemplates, loadProcessTemplate } = require('./process-template-registry');
const { processTemplateToUnified, buildUnifiedGraph } = require('./unified-graph');

const CURATED_DIR = path.join(__dirname, '..', '..', 'orchestrator', 'skill-pool', 'process-templates');
const ADAPTER = pathToFileURL(path.join(__dirname, '..', 'src', 'pages', 'team-setup', 'flow-preview-layout.js')).href;

function serverGraph(bundle) {
  const flow = processTemplateToUnified(bundle);
  return buildUnifiedGraph(flow.nodes, flow.edges, {
    labels: flow.labels,
    humans: Array.isArray(bundle.humans) ? bundle.humans : [],
  });
}

test('#1009: the wizard preview adapter mirrors the server edge set 1:1 for every curated bundle', async () => {
  const { previewEdgesFromGraph } = await import(ADAPTER);
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const bundle = loadProcessTemplate(CURATED_DIR, t.id);
    const graph = serverGraph(bundle);
    const roleIds = new Set(bundle.roles.map(r => r.id));
    const preview = previewEdgesFromGraph(graph);

    // Every role-to-role wiring edge of the server graph appears in the
    // preview exactly once, and nothing else does.
    const expectable = graph.edges.filter(e =>
      e && roleIds.has(e.from) && roleIds.has(e.to) && e.from !== e.to
      && ['github', 'label', 'review', 'dependency', 'artifact'].includes(e.on));
    assert.equal(preview.length, expectable.length,
      `${t.id}: preview must carry exactly the server's role-to-role edges`);
    const expectedLabel = (e) => {
      if (e.on === 'github') return e.label || (e.artifact === 'issue' ? 'issue' : 'PR');
      if (e.on === 'dependency') return 'depends-on';
      if (e.on === 'review') return e.label || 'review';
      if (e.on === 'artifact') return e.label || 'data flow';
      return e.label;
    };
    for (const e of expectable) {
      const hit = preview.filter(p => p.from === e.from && p.to === e.to && p.label === expectedLabel(e));
      assert.equal(hit.length, 1, `${t.id}: server edge ${e.from}→${e.to} (${e.on}) must map 1:1`);
      // A human-gated edge keeps its gate classification in the preview.
      if (e.gate === 'human') assert.equal(hit[0].gate, true, `${t.id}: gate flag lost on ${e.from}→${e.to}`);
    }
    // The busy templates must actually exercise the mirror (guards against a
    // silently-empty adapter passing the 1:1 check vacuously).
    if (t.id === 'extended-sdlc') assert.ok(preview.length >= 10, 'extended-sdlc preview must be busy');
  }
});
