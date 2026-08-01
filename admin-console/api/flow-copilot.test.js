'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  MAX_REPAIR_ITERATIONS,
  sanitizeBundle,
  parseCopilotResponse,
  evaluateBundle,
  computeChanges,
  readFormatDoc,
  buildCopilotRequest,
  buildRepairMessage,
  runCopilot,
} = require('./flow-copilot');
const { validateProcessTemplate } = require('./process-template');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'flow-copilot.fixture.json'), 'utf8'));
const fixture = () => JSON.parse(JSON.stringify(FIXTURE));

// ── grounding docs ───────────────────────────────────────────────────────────

test('vendored format doc is byte-identical to docs/process-template-format.md', () => {
  // The runtime image cannot reach the repo-root docs/ (build context is
  // admin-console/), so a vendored copy ships next to the module. Change both
  // in one commit — this test is the drift guard.
  const original = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'process-template-format.md'), 'utf8');
  const vendored = fs.readFileSync(path.join(__dirname, 'process-template-format.md'), 'utf8');
  assert.equal(vendored, original);
});

test('readFormatDoc returns the format reference', () => {
  const doc = readFormatDoc();
  assert.ok(doc.includes('processTemplateVersion'));
});

// ── the motivating-example fixture (#1047) ───────────────────────────────────

test('fixture bundle is STRICT-valid', () => {
  assert.deepEqual(validateProcessTemplate(fixture()), { ok: true });
});

test('fixture bundle is lint-clean (no errors/warnings, no wiring-guard infos)', () => {
  const { lints } = evaluateBundle(fixture());
  const banned = ['raw-trigger-nonconformant', 'unclaimed-listener', 'producer-unconsumed'];
  assert.deepEqual(
    lints.filter(l => l.severity === 'error' || l.severity === 'warning' || banned.includes(l.code)),
    []);
});

// ── tolerant response parsing ────────────────────────────────────────────────

test('parseCopilotResponse: bare JSON object', () => {
  const out = parseCopilotResponse(JSON.stringify({ summary: 'built it', bundle: fixture() }));
  assert.equal(out.summary, 'built it');
  assert.equal(out.bundle.processTemplateVersion, 1);
});

test('parseCopilotResponse: fenced JSON', () => {
  const out = parseCopilotResponse('```json\n' + JSON.stringify({ summary: 's', bundle: fixture() }) + '\n```');
  assert.equal(out.summary, 's');
  assert.equal(out.bundle.roles.length, 5);
});

test('parseCopilotResponse: prose-wrapped JSON', () => {
  const text = 'Here is the flow you asked for:\n\n'
    + JSON.stringify({ summary: 's', bundle: fixture() })
    + '\n\nLet me know if you want changes.';
  const out = parseCopilotResponse(text);
  assert.ok(out);
  assert.equal(out.bundle.name, FIXTURE.name);
});

test('parseCopilotResponse: bare bundle with no envelope is tolerated', () => {
  const out = parseCopilotResponse(JSON.stringify(fixture()));
  assert.equal(out.summary, '');
  assert.equal(out.bundle.processTemplateVersion, 1);
});

test('parseCopilotResponse: garbage / no-JSON → null', () => {
  assert.equal(parseCopilotResponse('I cannot help with that.'), null);
  assert.equal(parseCopilotResponse(''), null);
  assert.equal(parseCopilotResponse('{ not: valid json'), null);
  assert.equal(parseCopilotResponse(null), null);
});

// ── sanitizer ────────────────────────────────────────────────────────────────

test('sanitizeBundle strips unknown top-level and role keys', () => {
  const dirty = {
    ...fixture(),
    repository: { url: 'git@github.com:evil/repo.git' },
    githubTokenId: 'tok-1',
    environmentId: 'env-1',
  };
  dirty.roles[0].sshKeyId = 'key-1';
  dirty.roles[0].matrixToken = 'syt_abc';
  const clean = sanitizeBundle(dirty);
  assert.equal(clean.repository, undefined);
  assert.equal(clean.githubTokenId, undefined);
  assert.equal(clean.environmentId, undefined);
  assert.equal(clean.roles[0].sshKeyId, undefined);
  assert.equal(clean.roles[0].matrixToken, undefined);
  // …while known keys survive untouched.
  assert.equal(clean.name, FIXTURE.name);
  assert.deepEqual(clean.roles.map(r => r.id), FIXTURE.roles.map(r => r.id));
  assert.deepEqual(clean.labels, FIXTURE.labels);
  assert.deepEqual(clean.humans, FIXTURE.humans);
});

test('sanitizeBundle: non-object → null', () => {
  assert.equal(sanitizeBundle(null), null);
  assert.equal(sanitizeBundle('bundle'), null);
  assert.equal(sanitizeBundle([1, 2]), null);
});

// ── strict-validation gate ───────────────────────────────────────────────────

test('evaluateBundle rejects a malformed fixture (multi-event trigger) in STRICT mode', () => {
  const bad = fixture();
  bad.roles[3].triggers[0].events = ['pull_request.labeled', 'pull_request.opened'];
  const { lints } = evaluateBundle(bad);
  const errs = lints.filter(l => l.severity === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'invalid-bundle');
  assert.match(errs[0].message, /exactly ONE event/);
});

test('evaluateBundle rejects an outcome that sets a human-gate label in STRICT mode', () => {
  const bad = fixture();
  // An agent setting the human-gate label `ready` is rejected by the strict
  // validator (same rule as gate-violation) before the graph is even built.
  bad.roles[0].outcomes.options[0].actions.push({ type: 'setLabel', label: 'ready' });
  const { lints } = evaluateBundle(bad);
  const errs = lints.filter(l => l.severity === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'invalid-bundle');
  assert.match(errs[0].message, /ready/);
});

test('evaluateBundle surfaces error-level graph lints (gate-violation via legacy emits)', () => {
  const bad = fixture();
  // A legacy flat `emits` naming the gate label skips outcome validation but is
  // lifted on the graph side — the gate-violation lint catches it there.
  // (Authored outcomes would supersede `emits`, so drop them for the lift.)
  delete bad.roles[0].outcomes;
  bad.roles[0].emits = ['ready'];
  const { lints } = evaluateBundle(bad);
  assert.ok(lints.some(l => l.code === 'gate-violation' && l.severity === 'error'));
});

// ── change list ──────────────────────────────────────────────────────────────

test('computeChanges reports added / removed / modified entities', () => {
  const before = fixture();
  const after = fixture();
  after.roles = after.roles.filter(r => r.id !== 'merger');
  after.roles.push({ id: 'security-reviewer', displayName: 'Security Reviewer', role: 'team-member', sessionPolicy: 'per-invocation', systemPrompt: 'You review PRs for security.', triggers: [] });
  after.roles.find(r => r.id === 'developer').systemPrompt = 'changed';
  after.labels.push({ name: 'security-approved', humanGate: false, brake: false });
  const changes = computeChanges(before, after);
  assert.ok(changes.some(c => c.kind === 'role-removed' && c.id === 'merger'));
  assert.ok(changes.some(c => c.kind === 'role-added' && c.id === 'security-reviewer'));
  assert.ok(changes.some(c => c.kind === 'role-modified' && c.id === 'developer'));
  assert.ok(changes.some(c => c.kind === 'label-added' && c.id === 'security-approved'));
  assert.equal(changes.filter(c => c.kind.startsWith('role-')).length, 3);
});

test('computeChanges from an empty draft reports every role as added', () => {
  const changes = computeChanges({ processTemplateVersion: 1, roles: [] }, fixture());
  assert.equal(changes.filter(c => c.kind === 'role-added').length, 5);
});

// ── prompt builder ───────────────────────────────────────────────────────────

test('prompt builder golden against the fixture', () => {
  // Sentinel grounding docs keep the golden stable while docs evolve; the doc
  // CONTENT is covered by the parity test above. Regenerate on a deliberate
  // prompt change:  node -e "…buildCopilotRequest…" > flow-copilot-request.golden.json
  const request = buildCopilotRequest({
    bundle: fixture(),
    messages: [{ role: 'user', content: 'Add a security reviewer that also reviews every PR.' }],
    formatDoc: '<FORMAT-DOC>',
    addendum: '<ADDENDUM>',
  });
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'flow-copilot-request.golden.json'), 'utf8'));
  assert.deepEqual(request, golden);
});

test('system prompt embeds the grounding docs, the current bundle, and the preservation mandate', () => {
  const request = buildCopilotRequest({
    bundle: fixture(),
    messages: [{ role: 'user', content: 'add a role' }],
    formatDoc: 'THE-FORMAT-DOC',
    addendum: 'THE-ADDENDUM',
  });
  assert.ok(request.system.includes('THE-FORMAT-DOC'));
  assert.ok(request.system.includes('THE-ADDENDUM'));
  assert.ok(request.system.includes('"business-analyst"')); // current bundle JSON
  // AC2 (loose): whole-bundle regeneration with preservation of unrelated parts.
  assert.match(request.system, /reproduce every part you were not asked to change verbatim/);
  assert.match(request.system, /Never include repository URLs/);
  assert.equal(request.max_tokens, 16000);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'add a role' }]);
});

// ── repair loop ──────────────────────────────────────────────────────────────

const reply = (bundle, summary = 'done') => JSON.stringify({ summary, bundle });

test('clean first answer: ok:true, zero repair iterations, one LLM call', async () => {
  let calls = 0;
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build the flow' }],
    callLlm: async () => { calls++; return reply(fixture(), 'built the loop'); },
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(calls, 1);
  assert.equal(out.ok, true);
  assert.equal(out.repairIterations, 0);
  assert.equal(out.summary, 'built the loop');
  assert.equal(out.bundle.roles.length, 5);
  assert.equal(out.changes.filter(c => c.kind === 'role-added').length, 5);
  assert.deepEqual(out.lints.filter(l => l.severity === 'error'), []);
});

test('repair loop terminates after MAX_REPAIR_ITERATIONS and returns ok:false best-effort', async () => {
  const bad = fixture();
  bad.roles[3].triggers[0].claim.add = 'wrong-claim';
  const requests = [];
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async (req) => { requests.push(req); return reply(bad); },
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(requests.length, 1 + MAX_REPAIR_ITERATIONS); // ≤ 3 LLM calls per turn
  assert.equal(out.repairIterations, MAX_REPAIR_ITERATIONS);
  assert.equal(out.ok, false);
  assert.ok(out.bundle); // best-effort bundle still returned
  assert.ok(out.lints.some(l => l.severity === 'error'));
  // Each repair request extends the conversation with the findings.
  const lastMsgs = requests[2].messages;
  assert.equal(lastMsgs.length, 5); // user + (assistant, user) × 2
  assert.match(lastMsgs[4].content, /invalid-bundle/);
  assert.match(lastMsgs[4].content, /wakeLabel/);
});

test('invalid first answer repaired on the second call: ok:true, repairIterations:1', async () => {
  const bad = fixture();
  bad.roles[3].triggers[0].events = ['pull_request.labeled', 'pull_request.opened'];
  let calls = 0;
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async () => (++calls === 1 ? reply(bad) : reply(fixture(), 'fixed')),
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(calls, 2);
  assert.equal(out.ok, true);
  assert.equal(out.repairIterations, 1);
  assert.equal(out.summary, 'fixed');
});

test('unparseable reply is repaired via the loop', async () => {
  let calls = 0;
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async () => (++calls === 1 ? 'Sorry, here is prose with no JSON.' : reply(fixture())),
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(out.ok, true);
  assert.equal(out.repairIterations, 1);
});

test('never parseable → throws (route maps to 502)', async () => {
  await assert.rejects(
    runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => 'no json here',
      formatDoc: 'doc', addendum: 'add',
    }),
    /no parseable bundle/);
});

test('transport failure on the first call → throws', async () => {
  await assert.rejects(
    runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => { throw new Error('LLM request failed: timeout'); },
      formatDoc: 'doc', addendum: 'add',
    }),
    /LLM request failed/);
});

test('transport failure mid-repair → best-effort ok:false with prior findings', async () => {
  const bad = fixture();
  bad.roles[3].triggers[0].claim.add = 'wrong-claim';
  let calls = 0;
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async () => {
      if (++calls === 1) return reply(bad);
      throw new Error('LLM request failed: timeout');
    },
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(out.ok, false);
  assert.ok(out.bundle);
  assert.ok(out.lints.some(l => l.code === 'invalid-bundle'));
});

test('follow-up preserves unrelated parts (mocked, loose — AC2)', async () => {
  // The mocked model applies only the asked-for change; the assertion is that
  // the pipeline passes the untouched parts through and reports a focused diff.
  const revised = fixture();
  revised.roles.find(r => r.id === 'code-reviewer').systemPrompt += ' Also check security.';
  const out = await runCopilot({
    bundle: fixture(),
    messages: [
      { role: 'user', content: 'build the loop' },
      { role: 'assistant', content: 'built it' },
      { role: 'user', content: 'make the reviewer security-aware' },
    ],
    callLlm: async (req) => {
      // The current bundle is embedded for the model to preserve from.
      assert.ok(req.system.includes('"reworker"'));
      return reply(revised, 'reviewer updated');
    },
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.changes, [{ kind: 'role-modified', id: 'code-reviewer' }]);
  assert.deepEqual(out.bundle.roles.map(r => r.id), FIXTURE.roles.map(r => r.id));
});

test('repair message lists error findings only', () => {
  const msg = buildRepairMessage([
    { code: 'invalid-bundle', severity: 'error', message: 'roles must be a non-empty array' },
  ]);
  assert.match(msg, /\[invalid-bundle\] roles must be a non-empty array/);
  assert.match(msg, /COMPLETE bundle/);
});

// ── progress events (#1070) ──────────────────────────────────────────────────

test('clean first answer emits generating → validating', async () => {
  const phases = [];
  await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build the flow' }],
    callLlm: async () => reply(fixture()),
    formatDoc: 'doc', addendum: 'add',
    onProgress: (ev) => phases.push(ev),
  });
  assert.deepEqual(phases, [
    { type: 'phase', phase: 'generating' },
    { type: 'phase', phase: 'validating' },
  ]);
});

test('repair loop emits repairing with 1-based iterations between validations', async () => {
  const bad = fixture();
  bad.roles[3].triggers[0].claim.add = 'wrong-claim';
  const phases = [];
  await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async () => reply(bad),
    formatDoc: 'doc', addendum: 'add',
    onProgress: (ev) => phases.push(ev),
  });
  assert.deepEqual(phases, [
    { type: 'phase', phase: 'generating' },
    { type: 'phase', phase: 'validating' },
    { type: 'phase', phase: 'repairing', iteration: 1 },
    { type: 'phase', phase: 'validating' },
    { type: 'phase', phase: 'repairing', iteration: 2 },
    { type: 'phase', phase: 'validating' },
  ]);
});

test('transport failure mid-repair stops the phase stream after the repairing event', async () => {
  const bad = fixture();
  bad.roles[3].triggers[0].claim.add = 'wrong-claim';
  let calls = 0;
  const phases = [];
  await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async () => {
      if (++calls === 1) return reply(bad);
      throw new Error('LLM request failed: timeout');
    },
    formatDoc: 'doc', addendum: 'add',
    onProgress: (ev) => phases.push(ev),
  });
  assert.deepEqual(phases.map(p => p.phase), ['generating', 'validating', 'repairing']);
});

test('omitting onProgress keeps the loop working (no hook required)', async () => {
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build the flow' }],
    callLlm: async () => reply(fixture()),
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(out.ok, true);
});
