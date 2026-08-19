'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProcessTemplates, loadProcessTemplate } = require('./process-template-registry');
const { validateProcessTemplate, rawTriggerError } = require('./process-template');
const { buildProcessGraph } = require('./process-graph');
const {
  bundleRoutingLabels, extractProseLabelTokens, proseSources,
  auditProseLabels, formatFindings,
} = require('./prompt-label-audit');

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

// The #1008 lint set: on top of error/warning cleanliness a shipped bundle may
// not deviate from the wiring rules (multi-event trigger / malformed claim),
// leave a label listener unclaimed, or leave a produced artifact as an
// UNDECLARED open end (`terminal`/`external` markers and human deliveries are
// the declared forms). Advisory unbound-* infos (a declared human touchpoint
// merely lacking a named role) stay allowed.
const BANNED_INFO_CODES = ['raw-trigger-nonconformant', 'unclaimed-listener', 'producer-unconsumed'];

function curatedBundleLints(b) {
  // Mirror the POST /api/process/graph preview path: roles become nodes with
  // their declarative ports; effective emits = persisted emits. The structured
  // `outcomes` port (#827/#830) is threaded so the outcome lints are exercised
  // against the shipped templates too, and the bundle's `labels[]` registry is
  // the authoritative gate/brake source (#928) — without it a gate listener
  // (e.g. dispatched-sdlc's dispatcher) looks like an orphan.
  const agents = b.roles.map(r => ({
    id: r.id, role: r.role || 'team-member', displayName: r.displayName,
    sessionPolicy: r.sessionPolicy, emits: r.emits, github: r.github,
    outcomes: r.outcomes,
    channels: r.channels, triggers: r.triggers || [],
  }));
  return buildProcessGraph(agents, { labels: b.labels, humans: b.humans }).lints;
}

test('curated repo templates render with no error/warning lints', () => {
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const lints = curatedBundleLints(loadProcessTemplate(CURATED_DIR, t.id));
    const bad = lints.filter(l => l.severity === 'error' || l.severity === 'warning');
    assert.deepEqual(bad, [], `${t.id} must be lint-clean, got: ${JSON.stringify(bad)}`);
  }
});

// ── #1008 preset conventions — the extended CI guard ─────────────────────────
// Presets are the third authoring channel besides canvas and Routing tab; a
// template that ships a convention violation seeds every team it instantiates
// with wiring the Flow Editor cannot explain. The guard therefore fails on the
// #1008 lint set, not only on error/warning.

test('#1008: curated bundles are clean under the extended lint set (no undeclared open ends)', () => {
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const lints = curatedBundleLints(loadProcessTemplate(CURATED_DIR, t.id));
    const banned = lints.filter(l => BANNED_INFO_CODES.includes(l.code));
    assert.deepEqual(banned, [], `${t.id} violates the preset conventions: ${JSON.stringify(banned)}`);
  }
});

test('#1008: catalog role templates carry single-event triggers and claimed label listeners', () => {
  const files = fs.readdirSync(CATALOG_DIR).filter(n => n.endsWith('.json'));
  assert.ok(files.length >= 24, `expected the full catalog (got ${files.length})`);
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf8'));
    for (const tr of r.triggers || []) {
      // Full raw wiring contract (#1006): one event per github-event trigger,
      // claim well-formed against its labelFilter.
      assert.equal(rawTriggerError(tr), null,
        `${f}/${tr.id}: ${rawTriggerError(tr)}`);
      if (tr.type !== 'github-event') continue;
      assert.equal((tr.events || []).length, 1, `${f}/${tr.id} must carry exactly one event`);
      // A label listener must CLAIM its wake label (#958) — templates seed
      // fresh teams, and an unclaimed preset makes a stalled run
      // indistinguishable from a wake that never arrived.
      const lf = typeof tr.labelFilter === 'string' ? tr.labelFilter.trim() : '';
      if (lf && !lf.endsWith(':wip')) {
        assert.deepEqual(tr.claim, { remove: lf, add: `${lf}:wip` },
          `${f}/${tr.id} must claim its wake label \`${lf}\``);
      }
    }
  }
});

test('#1008: audited terminal/external markers are present on the flow-ending presets', () => {
  // The audited open ends of the shipped presets (issue #1008 scope 1/2): the
  // docs follow-up PR is the end product; the reporters' output leaves the flow.
  const marker = (r, oid) => (r.outcomes.options.find(o => o.id === oid)) || {};
  const docSync = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'documentation-sync.json'), 'utf8'));
  assert.equal(marker(docSync, 'opens-pr').terminal, true);
  for (const id of ['release-notes-writer', 'roadmap-reporter']) {
    const r = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, `${id}.json`), 'utf8'));
    assert.ok(r.outcomes.options.some(o => o.external && typeof o.external.note === 'string'),
      `${id} must declare its external audience`);
  }
  const dispatched = loadProcessTemplate(CURATED_DIR, 'dispatched-sdlc');
  assert.equal(marker(dispatched.roles.find(r => r.id === 'documentation-sync'), 'opens-pr').terminal, true);
  const extended = loadProcessTemplate(CURATED_DIR, 'extended-sdlc');
  assert.equal(marker(extended.roles.find(r => r.id === 'doc-sync'), 'opens-pr').terminal, true);
});

test('#1008: the extended guard goes red on a drifted preset (mutation checks)', () => {
  // Multi-event trigger → strict validation AND the lint set reject it.
  const b = loadProcessTemplate(CURATED_DIR, 'core-sdlc');
  const reworker = b.roles.find(r => r.id === 'reworker');
  const listener = reworker.triggers.find(t => t.id === 'rework-on-revisions-required');
  listener.events = ['pull_request.labeled', 'issues.labeled'];
  assert.match(validateProcessTemplate(b).error, /exactly ONE event/);

  // Missing claim on a label listener → unclaimed-listener joins the banned set.
  const b2 = loadProcessTemplate(CURATED_DIR, 'core-sdlc');
  delete b2.roles.find(r => r.id === 'reworker')
    .triggers.find(t => t.id === 'rework-on-revisions-required').claim;
  assert.ok(curatedBundleLints(b2).some(l => l.code === 'unclaimed-listener'));

  // Undeclared open end → producer-unconsumed joins the banned set.
  const b3 = loadProcessTemplate(CURATED_DIR, 'extended-sdlc');
  const doc = b3.roles.find(r => r.id === 'doc-sync');
  delete doc.outcomes.options.find(o => o.id === 'opens-pr').terminal;
  assert.ok(curatedBundleLints(b3).some(l => l.code === 'producer-unconsumed'));
});

// #928 AC7, now realised by #927: the `human:` prefix is gone from the shipped
// bundles, so every gate must classify from its `humanGate` flag alone. What was
// a rename *simulation* while #927 was pending is now a direct assertion on the
// shipped files.
test('#928 AC7: shipped gates classify from the flag, with no human:* token left', () => {
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const b = loadProcessTemplate(CURATED_DIR, t.id);
    const agents = b.roles.map(r => ({
      id: r.id, role: r.role || 'team-member', displayName: r.displayName,
      sessionPolicy: r.sessionPolicy, emits: r.emits, github: r.github,
      outcomes: r.outcomes, channels: r.channels, triggers: r.triggers || [],
    }));
    const graph = buildProcessGraph(agents, { labels: b.labels });

    for (const entry of graph.labels) {
      assert.ok(!entry.name.startsWith('human:'),
        `${t.id}: ${entry.name} still carries the retired human: prefix`);
      if (!entry.humanGate) continue;
      // A flagged gate's listener edge originates outside the agent set (a human
      // acts), proving classification came from the flag and not the name.
      for (const e of graph.edges.filter(x => x.label === entry.name)) {
        assert.equal(e.kind, 'gate', `${t.id}: ${entry.name} edge must be a gate`);
        assert.equal(e.from, null);
      }
    }
  }
});

// ── #927 label vocabulary ────────────────────────────────────────────────────
// The rename table from #901. Every token here was retired; the guard is that
// none of them can creep back into a shipped surface.
const RETIRED_TOKENS = [
  'ready', 'ready-2', 'req:refine', 'req:approved', 'design:author-go',
  'design:escalate', 'design:approved', 'build:author-go', 'build:escalate',
  'human:dispatch', 'dispatch',
];
const CATALOG_DIR = path.join(__dirname, '..', '..', 'orchestrator', 'skill-pool', 'agent-templates');

// The label surfaces and the prose scan both come from the shared pure audit
// module (#929) so the guard below and its unit tests cannot drift apart.
// `routingLabels` = the bundle's routing universe; `extractProseLabelTokens`
// strips the generated marker blocks and keeps only label-shaped tokens.
const routingLabels = bundleRoutingLabels;

function bundleProseTokens(bundle) {
  const out = [];
  for (const src of proseSources(bundle)) out.push(...extractProseLabelTokens(src.text));
  return out;
}

test('#927 AC2: no retired label token survives in the shipped process templates', () => {
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const b = loadProcessTemplate(CURATED_DIR, t.id);
    for (const label of routingLabels(b)) {
      assert.ok(!RETIRED_TOKENS.includes(label),
        `${t.id}: retired token "${label}" is still routed`);
    }
    // Prose is checked on the delimited form only, so the English words "ready"
    // and "dispatch" in ordinary sentences stay legal.
    for (const tok of bundleProseTokens(b)) {
      assert.ok(!RETIRED_TOKENS.includes(tok),
        `${t.id}: prose still names the retired token \`${tok}\``);
    }
  }
});

test('#927 AC2: no retired label token survives in the catalog role templates', () => {
  for (const f of fs.readdirSync(CATALOG_DIR).filter(n => n.endsWith('.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf8'));
    // `envSuffix` was a dead field removed in #1065 — no longer present in templates.
    const labels = routingLabels({ roles: [r] });
    for (const label of labels) {
      assert.ok(!RETIRED_TOKENS.includes(label), `${f}: retired token "${label}" is still routed`);
    }
    // Catalog roles carry their prose in `promptTemplate`/`additionalContextSnippet`
    // rather than the bundle shape, so the fields are gathered here and only the
    // extraction is shared.
    const prose = [r.description, r.promptTemplate, r.additionalContextSnippet];
    for (const tr of r.triggers || []) prose.push(tr.promptTemplate, tr.description);
    for (const text of prose) {
      for (const tok of extractProseLabelTokens(text)) {
        assert.ok(!RETIRED_TOKENS.includes(tok), `${f}: prose still names the retired token \`${tok}\``);
      }
    }
  }
});

test('#927 AC7: the conformant tokens are kept unchanged', () => {
  const core = routingLabels(loadProcessTemplate(CURATED_DIR, 'core-sdlc'));
  for (const kept of ['ready-for-review', 'ready-to-merge', 'revisions-required', 'human-decision-required']) {
    assert.ok(core.has(kept), `core-sdlc must keep ${kept}`);
  }
});

// ── #929 prompt↔routing lint ─────────────────────────────────────────────────
// Supersedes the narrower #927 AC3 check, which only flagged a token that some
// OTHER shipped template routed. This one holds every backticked label token in
// a template's hand-authored prose against that template's own routing, so a
// freshly invented token is caught too.

test('#929: every label token in a template\'s prose is routed by that template', () => {
  const findings = [];
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const b = loadProcessTemplate(CURATED_DIR, t.id);
    findings.push(...auditProseLabels(b, { template: t.id }));
  }
  assert.deepEqual(findings, [], formatFindings(findings));
});

test('#929: the lint goes red on a drifted template (mutation check)', () => {
  // Same load path as the guard above, with one prose token that no routing
  // surface carries — the drift the CI assertion exists to catch.
  const b = loadProcessTemplate(CURATED_DIR, 'core-sdlc');
  assert.ok(b, 'core-sdlc must load');
  b.roles[0].systemPrompt += '\n\nWhen you are done, apply `shipped-to-staging`.';
  const findings = auditProseLabels(b, { template: 'core-sdlc' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].token, 'shipped-to-staging');
  assert.equal(findings[0].role, b.roles[0].id);
  assert.match(formatFindings(findings), /core-sdlc: role "[^"]+" \(systemPrompt\) names `shipped-to-staging`/);
});

test('#929: a generated marker block in a curated template is never audited', () => {
  // Guards the exclusion end-to-end: a block naming an unrouted label is ignored
  // where the identical hand-authored sentence would fail.
  const b = loadProcessTemplate(CURATED_DIR, 'core-sdlc');
  const sentence = 'Then: apply label `generated-only-token`.';
  b.roles[0].systemPrompt += `\n\n<!-- outcomes:start -->\n${sentence}\n<!-- outcomes:end -->`;
  assert.deepEqual(auditProseLabels(b, { template: 'core-sdlc' }), []);
  b.roles[0].systemPrompt += `\n\n${sentence}`;
  assert.equal(auditProseLabels(b, { template: 'core-sdlc' }).length, 1);
});

test('#927 AC4: no label is a prefix of another within one template (decision D1)', () => {
  for (const t of listProcessTemplates(CURATED_DIR)) {
    const labels = [...routingLabels(loadProcessTemplate(CURATED_DIR, t.id))];
    for (const a of labels) {
      for (const c of labels) {
        assert.ok(a === c || !c.startsWith(a),
          `${t.id}: "${a}" is a prefix of "${c}" — breaks the team-label-suffix scheme (#902)`);
      }
    }
  }
  // The lane split is the case that motivated D1: the two developer lanes carry
  // distinct non-nesting tokens and the bare form is deliberately absent.
  const dispatched = routingLabels(loadProcessTemplate(CURATED_DIR, 'dispatched-sdlc'));
  assert.ok(dispatched.has('ready-for-implementation-a'));
  assert.ok(dispatched.has('ready-for-implementation-b'));
  assert.ok(!dispatched.has('ready-for-implementation'));
});
