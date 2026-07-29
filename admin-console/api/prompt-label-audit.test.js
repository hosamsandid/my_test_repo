'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LABEL_TOKEN_RE, NON_ROUTING_LABELS, NON_LABEL_TOKENS,
  bundleRoutingLabels, extractProseLabelTokens, proseSources,
  auditProseLabels, formatFindings,
} = require('./prompt-label-audit');
const { applyDerivedPromptBlocks } = require('./process-template');

// A minimal bundle whose prose names exactly the label its channel routes on.
const cleanBundle = () => ({
  processTemplateVersion: 1,
  name: 'Clean',
  roles: [
    {
      id: 'analyst',
      systemPrompt: 'When the spec is agreed, apply `ready-for-implementation`.',
      triggers: [],
    },
    {
      id: 'developer',
      channels: [{ artifact: 'issue', from: 'analyst', label: 'ready-for-implementation' }],
      systemPrompt: 'You build what `ready-for-implementation` hands you.',
      triggers: [],
    },
  ],
  labels: [{ name: 'ready-for-implementation', humanGate: false, brake: false }],
});

// ── the shape gate ───────────────────────────────────────────────────────────

test('LABEL_TOKEN_RE admits label shapes and rejects everything else', () => {
  for (const ok of [
    'ready', 'ready-for-review', 'ready-2', 'human-decision-required',
    'priority:high', 'design:author-go', 'req:refine',
  ]) {
    assert.ok(LABEL_TOKEN_RE.test(ok), `${ok} should be a label shape`);
  }
  for (const no of [
    'memory/log.md', 'docs/', 'README*', '{{repoFullName}}', '[PASS]',
    'pull_request.merged', 'Ready', 'a:b:c', '-leading', 'trailing-', '',
  ]) {
    assert.ok(!LABEL_TOKEN_RE.test(no), `${no} should not be a label shape`);
  }
});

test('extractProseLabelTokens takes backticked label tokens, unique and in order', () => {
  const text = 'Apply `ready-for-review`, then `ready-to-merge`, never `ready-for-review` twice.';
  assert.deepEqual(extractProseLabelTokens(text), ['ready-for-review', 'ready-to-merge']);
});

test('extractProseLabelTokens ignores backticked non-labels and unquoted words', () => {
  const text = [
    'Write to `memory/log.md` in `docs/`, read `{{repoFullName}}`, reply `[PASS]`.',
    'If `pull_request.merged` is false, stop. The word ready-for-review is not quoted.',
    'Multi word `spans are skipped` because a label has no whitespace.',
  ].join('\n');
  assert.deepEqual(extractProseLabelTokens(text), []);
});

test('extractProseLabelTokens tolerates non-string and empty input', () => {
  for (const bad of [undefined, null, 42, {}, '']) {
    assert.deepEqual(extractProseLabelTokens(bad), []);
  }
});

// ── marker exclusion (AC1 / AC7) ─────────────────────────────────────────────

test('extractProseLabelTokens excludes text inside the outcomes marker block', () => {
  const text = [
    'Hand-authored: apply `ready-for-review`.',
    '',
    '<!-- outcomes:start -->',
    '## Outcomes',
    'Then: apply label `generated-only-label`.',
    '<!-- outcomes:end -->',
  ].join('\n');
  assert.deepEqual(extractProseLabelTokens(text), ['ready-for-review']);
});

test('extractProseLabelTokens excludes text inside the github-io marker block', () => {
  const text = [
    'Hand-authored prose with no labels.',
    '<!-- github-io:start -->',
    'Open a PR and apply `derived-io-label`.',
    '<!-- github-io:end -->',
  ].join('\n');
  assert.deepEqual(extractProseLabelTokens(text), []);
});

test('the SAME bytes are audited when hand-authored and skipped when generated', () => {
  const prose = 'Then: apply label `unrouted-token`.';
  // Hand-authored — the audit must see it.
  assert.deepEqual(extractProseLabelTokens(prose), ['unrouted-token']);
  // Marker-wrapped — generated from the ports, so consistent by construction.
  const wrapped = `<!-- outcomes:start -->\n${prose}\n<!-- outcomes:end -->`;
  assert.deepEqual(extractProseLabelTokens(wrapped), []);
});

test('a really generated outcomes block never trips the audit', () => {
  const outcomes = {
    mode: 'exactlyOne',
    options: [
      { id: 'approve', title: 'Approve', actions: [{ type: 'setLabel', label: 'ready-to-merge' }] },
      { id: 'reject', title: 'Reject', actions: [{ type: 'setLabel', label: 'revisions-required' }] },
    ],
  };
  const systemPrompt = applyDerivedPromptBlocks('You review code.', {
    outcomes, github: { producesPr: true },
  });
  assert.ok(systemPrompt.includes('<!-- outcomes:start -->'), 'fixture must contain a real block');
  // The role's routing is deliberately EMPTY of those labels: the only place they
  // appear is inside the generated block, so a scan that failed to strip the
  // markers would report both of them.
  const bundle = { roles: [{ id: 'reviewer', systemPrompt, triggers: [] }], labels: [] };
  assert.deepEqual(auditProseLabels(bundle, { template: 'gen' }), []);
});

// ── the routing universe ─────────────────────────────────────────────────────

test('bundleRoutingLabels unions every label-bearing surface', () => {
  const bundle = {
    labels: [{ name: 'from-registry' }],
    gates: [{ label: 'from-gate' }],
    roles: [{
      id: 'r',
      emits: ['from-emits'],
      channels: [{ label: 'from-channel' }, { artifact: 'pr' }],
      triggers: [{ labelFilter: 'from-trigger' }, { id: 'cron-only' }],
      outcomes: {
        options: [
          { id: 'o', actions: [{ type: 'setLabel', label: 'from-outcome' }, { type: 'openPr' }] },
        ],
      },
    }],
  };
  assert.deepEqual([...bundleRoutingLabels(bundle)].sort(), [
    'from-channel', 'from-emits', 'from-gate', 'from-outcome', 'from-registry', 'from-trigger',
  ]);
});

test('bundleRoutingLabels keeps a brake/gate label that outcomeSetLabels would filter', () => {
  // The #830 rule filters gate/brake labels out of the EMIT projection. For this
  // audit the label is still routed, so it must stay in the universe or prose
  // naming it would be reported as drift.
  const bundle = {
    labels: [{ name: 'human-decision-required', humanGate: false, brake: true }],
    roles: [{
      id: 'r',
      systemPrompt: 'When blocked, apply `human-decision-required` and stop.',
      outcomes: {
        options: [{ id: 'esc', actions: [{ type: 'setLabel', label: 'human-decision-required' }] }],
      },
      triggers: [],
    }],
  };
  assert.ok(bundleRoutingLabels(bundle).has('human-decision-required'));
  assert.deepEqual(auditProseLabels(bundle, { template: 't' }), []);
});

test('bundleRoutingLabels tolerates missing and malformed ports', () => {
  assert.deepEqual([...bundleRoutingLabels(undefined)], []);
  assert.deepEqual([...bundleRoutingLabels({})], []);
  assert.deepEqual([...bundleRoutingLabels({ roles: [null], labels: [null], gates: [{}] })], []);
});

// ── prose sources ────────────────────────────────────────────────────────────

test('proseSources covers bundle/role descriptions, systemPrompt and trigger prompts', () => {
  const bundle = {
    description: 'bundle prose',
    roles: [{
      id: 'r',
      description: 'role prose',
      systemPrompt: 'prompt prose',
      triggers: [{ id: 'wake', prompt: 'trigger prose', description: 'trigger note' }],
    }],
  };
  assert.deepEqual(proseSources(bundle).map(s => [s.role, s.field]), [
    [null, 'description'],
    ['r', 'systemPrompt'],
    ['r', 'description'],
    ['r', 'trigger:wake.prompt'],
    ['r', 'trigger:wake.description'],
  ]);
});

// ── the audit ────────────────────────────────────────────────────────────────

test('auditProseLabels is clean when prose names only labels the bundle routes', () => {
  assert.deepEqual(auditProseLabels(cleanBundle(), { template: 'clean' }), []);
});

test('auditProseLabels allows a routing label that no prose mentions (AC3 reverse)', () => {
  const b = cleanBundle();
  b.labels.push({ name: 'never-mentioned', humanGate: false, brake: false });
  assert.deepEqual(auditProseLabels(b, { template: 'clean' }), []);
});

test('auditProseLabels flags an unrouted prose token, naming template/role/token', () => {
  const b = cleanBundle();
  b.roles[0].systemPrompt = 'When done, apply `shipped-to-staging`.';
  const findings = auditProseLabels(b, { template: 'drifted' });
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    template: 'drifted', role: 'analyst', field: 'systemPrompt', token: 'shipped-to-staging',
  });
});

test('auditProseLabels scans trigger prompts too', () => {
  const b = cleanBundle();
  b.roles[1].triggers = [{ id: 'wake', prompt: 'Then apply `not-routed-anywhere`.' }];
  const findings = auditProseLabels(b, { template: 'drifted' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, 'trigger:wake.prompt');
  assert.equal(findings[0].token, 'not-routed-anywhere');
});

test('auditProseLabels reports one finding per role/field so every prompt is named', () => {
  const b = cleanBundle();
  b.roles[0].systemPrompt = 'apply `stray-label`';
  b.roles[1].systemPrompt = 'also apply `stray-label`';
  const findings = auditProseLabels(b, { template: 'drifted' });
  assert.deepEqual(findings.map(f => f.role), ['analyst', 'developer']);
});

test('classification and priority labels pass via the non-routing allowlist', () => {
  const b = cleanBundle();
  b.roles[0].systemPrompt = 'Triage: `bug`, `feature-request`, `question`, `duplicate`, '
    + '`needs-triage`, `priority:high`, `priority:critical`.';
  assert.deepEqual(auditProseLabels(b, { template: 'triage' }), []);
  for (const t of NON_ROUTING_LABELS) assert.ok(LABEL_TOKEN_RE.test(t), `${t} must be label-shaped`);
});

test('tooling and payload tokens pass via the non-label allowlist', () => {
  const b = cleanBundle();
  b.roles[0].systemPrompt = 'Use `gh-as-agent` and `gh`; if `merged` is not true, stop.';
  assert.deepEqual(auditProseLabels(b, { template: 'tooling' }), []);
  for (const t of NON_LABEL_TOKENS) assert.ok(LABEL_TOKEN_RE.test(t), `${t} must be label-shaped`);
});

test('the two allowlists stay disjoint — each token has one reason to be exempt', () => {
  for (const t of NON_LABEL_TOKENS) assert.ok(!NON_ROUTING_LABELS.has(t), `${t} is in both sets`);
});

test('auditProseLabels accepts a caller-supplied extra allowlist', () => {
  const b = cleanBundle();
  b.roles[0].systemPrompt = 'apply `house-style`';
  assert.equal(auditProseLabels(b, { template: 't' }).length, 1);
  assert.deepEqual(auditProseLabels(b, { template: 't', allowlist: ['house-style'] }), []);
  assert.deepEqual(auditProseLabels(b, { template: 't', allowlist: new Set(['house-style']) }), []);
});

test('membership is exact, never by prefix or suffix', () => {
  const b = cleanBundle();
  // `ready-for-implementation` IS routed; these neighbours are not.
  b.roles[0].systemPrompt = 'apply `ready-for-implementation-a` then `ready-for`';
  const tokens = auditProseLabels(b, { template: 't' }).map(f => f.token);
  assert.deepEqual(tokens, ['ready-for-implementation-a', 'ready-for']);
});

test('formatFindings names template, role, field and token, and states both escapes', () => {
  assert.equal(formatFindings([]), '');
  const msg = formatFindings(auditProseLabels(
    { roles: [{ id: 'dev', systemPrompt: 'apply `nope`', triggers: [] }] },
    { template: 'core-sdlc' },
  ));
  assert.match(msg, /1 prompt↔routing label mismatch:/);
  assert.match(msg, /core-sdlc/);
  assert.match(msg, /"dev"/);
  assert.match(msg, /systemPrompt/);
  assert.match(msg, /`nope`/);
  assert.match(msg, /NON_ROUTING_LABELS/);
  assert.match(msg, /does not route/);
  assert.match(formatFindings([{ template: 'a', role: 'r', field: 'f', token: 't' },
    { template: 'a', role: 'r2', field: 'f', token: 't' }]), /2 prompt↔routing label mismatches:/);
});
