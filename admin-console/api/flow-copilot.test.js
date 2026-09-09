'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  MAX_REPAIR_ITERATIONS,
  COPILOT_HISTORY_CAP,
  SYSTEM_PROMPT_CHAR_LIMIT,
  sanitizeBundle,
  parseCopilotResponse,
  applyCopilotOps,
  sanitizeCopilotHistory,
  evaluateBundle,
  computeChanges,
  readFormatDoc,
  buildCopilotRequest,
  buildRepairMessage,
  measureCopilotSystemPrompt,
  runCopilot,
  COPILOT_ABORTED,
  isCopilotAborted,
  MAX_TOKENS_PART,
  GENERATION_PARTS,
  canGenerateInParts,
  buildPartRequest,
  isTimeoutFailure,
  classifyTurnFailure,
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

// ── patch-based incremental edits (#1071 item 3) ─────────────────────────────

test('parseCopilotResponse: ops envelope; a bundle wins when both appear', () => {
  const ops = parseCopilotResponse(JSON.stringify({ summary: 's', ops: [{ op: 'removeRole', id: 'x' }] }));
  assert.equal(ops.summary, 's');
  assert.equal(ops.ops.length, 1);
  assert.equal(ops.bundle, undefined);
  const both = parseCopilotResponse(JSON.stringify({ summary: 's', ops: [], bundle: fixture() }));
  assert.ok(both.bundle);
  assert.equal(both.ops, undefined);
});

test('applyCopilotOps: add / patch / remove role', () => {
  const b = applyCopilotOps(fixture(), [
    { op: 'addRole', role: { id: 'security-reviewer', displayName: 'Security Reviewer', systemPrompt: 'You review.', evil: 'stripped' } },
    { op: 'patchRole', id: 'code-reviewer', patch: { systemPrompt: 'Updated prompt.', stage: null } },
    { op: 'removeRole', id: 'merger' },
  ]);
  const added = b.roles.find(r => r.id === 'security-reviewer');
  assert.ok(added);
  assert.equal(added.evil, undefined); // role keys are whitelisted like sanitizeBundle
  assert.equal(b.roles.find(r => r.id === 'code-reviewer').systemPrompt, 'Updated prompt.');
  assert.ok(!('stage' in b.roles.find(r => r.id === 'code-reviewer'))); // null deletes the key
  assert.equal(b.roles.find(r => r.id === 'merger'), undefined);
});

test('applyCopilotOps: labels / humans / name / stages', () => {
  const b = applyCopilotOps(fixture(), [
    { op: 'upsertLabel', label: { name: 'sec:approved', humanGate: true } },
    { op: 'upsertHuman', human: { id: 'sec-lead', name: 'Security Lead', emits: ['sec:approved'] } },
    { op: 'setName', name: 'Hardened SDLC' },
    { op: 'setStages', stages: ['Build', 'Harden'] },
  ]);
  assert.ok(b.labels.some(l => l.name === 'sec:approved' && l.humanGate));
  assert.ok(b.humans.some(h => h.id === 'sec-lead'));
  assert.equal(b.name, 'Hardened SDLC');
  assert.deepEqual(b.stages, ['Build', 'Harden']);
  // upsert replaces in place, no duplicates
  const again = applyCopilotOps(b, [{ op: 'upsertLabel', label: { name: 'sec:approved' } }]);
  assert.equal(again.labels.filter(l => l.name === 'sec:approved').length, 1);
});

test('applyCopilotOps fails fast with a positioned message', () => {
  assert.throws(() => applyCopilotOps(fixture(), [{ op: 'removeRole', id: 'nope' }]), /op 1 \(removeRole\): role 'nope' not found/);
  assert.throws(() => applyCopilotOps(fixture(), [{ op: 'patchRole', id: 'merger', patch: { id: 'renamed' } }]), /cannot be changed/);
  assert.throws(() => applyCopilotOps(fixture(), [{ op: 'addRole', role: { id: 'merger' } }]), /already exists/);
  assert.throws(() => applyCopilotOps(fixture(), [{ op: 'explode' }]), /unknown operation/);
  assert.throws(() => applyCopilotOps(fixture(), []), /non-empty/);
});

test('revision turn: ops reply is applied and gated like a whole bundle', async () => {
  const requests = [];
  const out = await runCopilot({
    bundle: fixture(),
    messages: [{ role: 'user', content: 'make the reviewer security-aware' }],
    callLlm: async (req) => {
      requests.push(req);
      return JSON.stringify({
        summary: 'reviewer updated',
        ops: [{ op: 'patchRole', id: 'code-reviewer', patch: { systemPrompt: 'You also check security.' } }],
      });
    },
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.changes, [{ kind: 'role-modified', id: 'code-reviewer' }]);
  assert.deepEqual(out.bundle.roles.map(r => r.id), FIXTURE.roles.map(r => r.id)); // untouched parts survive structurally
  assert.match(requests[0].system, /"ops": \[/);          // patch contract offered
  assert.match(requests[0].system, /reproduce every part/); // whole-bundle fallback documented
});

test('generation turn keeps the whole-bundle contract (no ops vocabulary)', () => {
  const request = buildCopilotRequest({
    bundle: { processTemplateVersion: 1, name: 'Untitled flow', roles: [] },
    messages: [{ role: 'user', content: 'build it' }],
    formatDoc: 'doc', addendum: 'add',
  });
  assert.ok(!request.system.includes('"op":"addRole"'));
  assert.match(request.system, /the COMPLETE bundle, never a fragment/);
});

test('failed ops application becomes a repairable finding; bundle fallback accepted', async () => {
  let calls = 0;
  const out = await runCopilot({
    bundle: fixture(),
    messages: [{ role: 'user', content: 'remove the ghost role' }],
    callLlm: async (req) => {
      if (++calls === 1) return JSON.stringify({ summary: 'x', ops: [{ op: 'removeRole', id: 'ghost' }] });
      assert.match(req.messages[req.messages.length - 1].content, /\[invalid-ops\].*ghost.*not found/);
      return reply(fixture(), 'fell back to the whole bundle');
    },
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(calls, 2);
  assert.equal(out.ok, true);
  assert.equal(out.repairIterations, 1);
  assert.equal(out.summary, 'fell back to the whole bundle');
});

// ── chat-history persistence (#1071 item 1) ──────────────────────────────────

test('sanitizeCopilotHistory whitelists fields, demotes proposed, drops junk rows', () => {
  const out = sanitizeCopilotHistory({
    messages: [
      { role: 'user', content: 'build it', retryText: 'secret-ish' },
      { role: 'assistant', summary: 's', changes: [{ kind: 'role-added', id: 'x' }], lints: [], ok: true, status: 'proposed', bundle: { huge: true }, id: 7 },
      { role: 'error', message: 'HTTP 502' },
      'not-an-object',
    ],
  });
  assert.deepEqual(out.messages, [
    { role: 'user', content: 'build it' },
    { role: 'assistant', summary: 's', changes: [{ kind: 'role-added', id: 'x' }], lints: [], ok: true, status: 'superseded' },
  ]);
});

test('sanitizeCopilotHistory caps at the last N turns and rejects malformed input', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = sanitizeCopilotHistory({ messages: many });
  assert.equal(out.messages.length, COPILOT_HISTORY_CAP);
  assert.equal(out.messages[0].content, `m${30 - COPILOT_HISTORY_CAP}`);
  assert.equal(sanitizeCopilotHistory(null), undefined);
  assert.equal(sanitizeCopilotHistory({ messages: 'nope' }), undefined);
});

test('sanitizeBundle strips the copilot storage key from the portable bundle', () => {
  const b = sanitizeBundle({ ...fixture(), copilot: { messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(b.copilot, undefined);
});

// ---- system-prompt size guard (#1404) ----------------------------------------

test('SYSTEM_PROMPT_CHAR_LIMIT is exported as 200 000', () => {
  assert.equal(SYSTEM_PROMPT_CHAR_LIMIT, 200_000);
});

test('measureCopilotSystemPrompt returns a positive number and grows with bundle size', () => {
  const base = measureCopilotSystemPrompt({ formatDoc: 'fmt', addendum: 'add', bundle: fixture() });
  assert.ok(typeof base === 'number' && base > 0, 'returns a positive number for a real fixture bundle');
  const bigBundle = { ...fixture(), roles: (fixture().roles || []).concat([{ id: 'extra', systemPrompt: 'x'.repeat(10_000) }]) };
  const big = measureCopilotSystemPrompt({ formatDoc: 'fmt', addendum: 'add', bundle: bigBundle });
  assert.ok(big > base, 'adding a large role increases the measured size');
});

test('measureCopilotSystemPrompt: empty bundle is below SYSTEM_PROMPT_CHAR_LIMIT', () => {
  const size = measureCopilotSystemPrompt({ formatDoc: '', addendum: '', bundle: {} });
  assert.ok(size < SYSTEM_PROMPT_CHAR_LIMIT, 'an empty bundle is well below the limit');
});

test('measureCopilotSystemPrompt: oversized components push size above SYSTEM_PROMPT_CHAR_LIMIT', () => {
  const size = measureCopilotSystemPrompt({
    formatDoc: 'x'.repeat(SYSTEM_PROMPT_CHAR_LIMIT),
    addendum: '',
    bundle: {},
  });
  assert.ok(size > SYSTEM_PROMPT_CHAR_LIMIT, 'oversized format doc alone is enough to exceed the limit');
});

// ── stopping a turn server-side (#2087, D2 / AC9 / AC11) ──────────────────────
// Before #2087 `runCopilot` took no signal: a Stop or a disconnect suppressed
// only the DELIVERY of the result, so up to MAX_REPAIR_ITERATIONS + 1 = 3
// × 180 s of LLM work kept running, billed, and was discarded.

test('an already-aborted signal issues no LLM request at all', async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assert.rejects(
    () => runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => { calls++; return reply(fixture()); },
      formatDoc: 'doc', addendum: 'add',
      signal: ac.signal,
    }),
    (err) => isCopilotAborted(err) && err.code === COPILOT_ABORTED,
  );
  assert.equal(calls, 0, 'not one request for a turn stopped before it started');
});

test('AC9: a stop during iteration 1 produces no iteration-2 request', async () => {
  // Force a repair iteration the way the existing repair test does — an
  // invalid claim label always yields an error-level lint — then stop while
  // the first call is in flight.
  const bad = fixture();
  bad.roles[3].triggers[0].claim.add = 'wrong-claim';
  const ac = new AbortController();
  const requests = [];
  await assert.rejects(
    () => runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async (req) => {
        requests.push(req);
        ac.abort(); // the user presses Stop while iteration 1 is running
        return reply(bad);
      },
      formatDoc: 'doc', addendum: 'add',
      signal: ac.signal,
    }),
    isCopilotAborted,
  );
  assert.equal(requests.length, 1, 'the repair call the loop would otherwise make is never issued');
});

test('AC11: a stopped turn returns no best-effort proposal even after a good reply', async () => {
  // Two iterations: the first yields a parseable bundle (so `best` is set and
  // the pre-#2087 code path would `break` and hand it back), the second is
  // aborted. A stopped turn must leave nothing to apply.
  const bad = fixture();
  bad.roles[3].triggers[0].claim.add = 'wrong-claim';
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(
    () => runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => {
        calls++;
        if (calls === 1) return reply(bad);      // parseable, but error-level lints
        ac.abort();
        throw new Error('socket destroyed');      // the aborted second call
      },
      formatDoc: 'doc', addendum: 'add',
      signal: ac.signal,
    }),
    isCopilotAborted,
  );
  assert.equal(calls, 2);
});

test('a genuine transport failure after a parseable reply still falls back (unchanged)', async () => {
  // The same shape as the test above but with NO abort: the best-effort break
  // must still work, so the abort check cannot have swallowed it.
  const bad = fixture();
  bad.roles[3].triggers[0].claim.add = 'wrong-claim';
  let calls = 0;
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async () => {
      calls++;
      if (calls === 1) return reply(bad);
      throw new Error('upstream 502');
    },
    formatDoc: 'doc', addendum: 'add',
    signal: new AbortController().signal, // present but never aborted
  });
  assert.equal(calls, 2);
  assert.equal(out.ok, false);
  assert.ok(out.bundle, 'best-effort bundle still returned');
});

test('a stop that lands in the same moment as the result lets exactly one outcome win', async () => {
  // Edge case: Stop pressed as the reply arrives. The reply is clean, so
  // without the post-await check the turn would return a proposal for a turn
  // the user stopped.
  const ac = new AbortController();
  await assert.rejects(
    () => runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => { ac.abort(); return reply(fixture(), 'built'); },
      formatDoc: 'doc', addendum: 'add',
      signal: ac.signal,
    }),
    isCopilotAborted,
  );
});

test('omitting the signal keeps the loop byte-identical (no signal, no abort path)', async () => {
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build the flow' }],
    callLlm: async () => reply(fixture(), 'built the loop'),
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(out.ok, true);
  assert.equal(out.repairIterations, 0);
});

test('isCopilotAborted only recognises the abort error', () => {
  assert.equal(isCopilotAborted(new Error('boom')), false);
  assert.equal(isCopilotAborted(null), false);
  assert.equal(isCopilotAborted(undefined), false);
  assert.equal(isCopilotAborted({ code: COPILOT_ABORTED }), true);
});

// ── generate in parts (#2131) ────────────────────────────────────────────────

test('isTimeoutFailure recognises the whole timeout class and nothing else', () => {
  for (const m of [
    'LLM request failed: timeout',
    'LLM request failed: deadline',
    'LLM request failed: HTTP 504',
    'LLM request failed: HTTP 502',
    'upstream Gateway Timeout',
    'Bad Gateway',
    'connect ETIMEDOUT 10.0.0.1:443',
    'socket hang up',
    'read ECONNRESET',
  ]) {
    assert.equal(isTimeoutFailure(new Error(m)), true, m);
  }
  for (const m of [
    'LLM returned no parseable bundle',
    'LLM request failed: HTTP 401',
    'LLM request failed: HTTP 500',
    'invalid_request_error: max_tokens too large',
  ]) {
    assert.equal(isTimeoutFailure(new Error(m)), false, m);
  }
  assert.equal(isTimeoutFailure(null), false);
});

test('classifyTurnFailure: timeout is 504 + llm-timeout, junk output stays 502', () => {
  assert.deepEqual(classifyTurnFailure(new Error('LLM request failed: HTTP 504')),
    { status: 504, code: 'llm-timeout', detail: 'LLM request failed: HTTP 504' });
  assert.deepEqual(classifyTurnFailure(new Error('LLM returned no parseable bundle')),
    { status: 502, code: 'no-parseable-bundle', detail: 'LLM returned no parseable bundle' });
  assert.deepEqual(classifyTurnFailure(new Error('boom')),
    { status: 502, code: 'llm-failed', detail: 'boom' });
  // Never an empty headline, whatever arrives.
  assert.equal(classifyTurnFailure(new Error('   ')).detail, 'the Copilot turn failed');
  assert.equal(classifyTurnFailure(null).code, 'llm-failed');
});

test('canGenerateInParts: only a fresh whole-bundle generation can be split', () => {
  assert.equal(canGenerateInParts(undefined), true);
  assert.equal(canGenerateInParts({}), true);
  assert.equal(canGenerateInParts({ roles: [] }), true);
  // A revision turn already answers with a small op list — nothing to split.
  assert.equal(canGenerateInParts({ roles: [{ id: 'dev' }] }), false);
});

test('the two parts select the two existing contracts, at the smaller token budget', () => {
  assert.deepEqual(GENERATION_PARTS.map(p => p.id), ['roles', 'wiring']);
  const messages = [{ role: 'user', content: 'build an RFP process' }];
  const rolesReq = buildPartRequest({
    part: GENERATION_PARTS[0], bundle: { processTemplateVersion: 1, roles: [] },
    messages, formatDoc: 'doc', addendum: 'add',
  });
  const wiringReq = buildPartRequest({
    part: GENERATION_PARTS[1], bundle: { processTemplateVersion: 1, roles: [{ id: 'dev' }] },
    messages, formatDoc: 'doc', addendum: 'add',
  });
  // Part 1 runs against a role-less bundle → the whole-bundle contract; part 2
  // runs against part 1's result → the ops contract. No new prompt vocabulary.
  assert.match(rolesReq.system, /Output contract:/);
  assert.doesNotMatch(rolesReq.system, /"op":"addRole"/);
  assert.match(wiringReq.system, /Output contract \(revision/);
  assert.match(wiringReq.system, /"op":"patchRole"/);
  // Both are capped below the single-call budget — that is the whole point.
  assert.equal(rolesReq.max_tokens, MAX_TOKENS_PART);
  assert.equal(wiringReq.max_tokens, MAX_TOKENS_PART);
  assert.ok(MAX_TOKENS_PART < buildCopilotRequest({ bundle: {}, messages, formatDoc: 'd', addendum: 'a' }).max_tokens);
  // The user's own request rides along in both parts, with the step instruction last.
  assert.equal(rolesReq.messages[0].content, 'build an RFP process');
  assert.match(rolesReq.messages.at(-1).content, /STEP 1 of 2/);
  assert.match(wiringReq.messages.at(-1).content, /STEP 2 of 2/);
});

test('AC3: a timed-out single generation is recovered by a two-part generation', async () => {
  const full = fixture();
  // Part 1 answers roles-only; part 2 answers the wiring the roles pass left out.
  const rolesOnly = {
    processTemplateVersion: 1, name: full.name, stages: full.stages,
    roles: full.roles.map(r => ({
      id: r.id, displayName: r.displayName, role: r.role,
      sessionPolicy: r.sessionPolicy, systemPrompt: r.systemPrompt,
    })),
  };
  const wiringOps = [
    ...full.roles.map(r => ({
      op: 'patchRole',
      id: r.id,
      patch: {
        ...(r.outcomes ? { outcomes: r.outcomes } : {}),
        ...(r.triggers ? { triggers: r.triggers } : {}),
        ...(r.channels ? { channels: r.channels } : {}),
        ...(r.emits ? { emits: r.emits } : {}),
        ...(r.github ? { github: r.github } : {}),
      },
    })).filter(o => Object.keys(o.patch).length > 0),
    ...(full.labels || []).map(l => ({ op: 'upsertLabel', label: l })),
    ...(full.humans || []).map(h => ({ op: 'upsertHuman', human: h })),
    ...(full.gates ? [{ op: 'setGates', gates: full.gates }] : []),
  ];

  const seen = [];
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build the whole RFP flow' }],
    callLlm: async (payload) => {
      seen.push(payload.max_tokens);
      if (seen.length === 1) throw new Error('LLM request failed: HTTP 504');
      if (seen.length === 2) return JSON.stringify({ summary: 'roles', bundle: rolesOnly });
      return JSON.stringify({ summary: 'wired the RFP flow', ops: wiringOps });
    },
    formatDoc: readFormatDoc(), addendum: 'add',
  });

  assert.equal(out.ok, true, JSON.stringify(out.lints));
  assert.equal(out.generatedInParts, true);
  assert.equal(out.repairIterations, 0);
  assert.equal(out.summary, 'wired the RFP flow');
  // Three calls: the single attempt that timed out, then the two parts — and
  // both parts asked for a smaller reply than the attempt that failed.
  assert.equal(seen.length, 3);
  assert.equal(seen[1], MAX_TOKENS_PART);
  assert.equal(seen[2], MAX_TOKENS_PART);
  // The merged bundle went through the SAME strict gate as a single-call reply.
  assert.equal(validateProcessTemplate(out.bundle).ok, true);
  assert.deepEqual(out.bundle.roles.map(r => r.id), full.roles.map(r => r.id));
  assert.ok(out.changes.some(c => c.kind === 'role-added'));
});

test('AC4: a single call that succeeds never triggers the split path', async () => {
  let calls = 0;
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build the flow' }],
    callLlm: async (payload) => {
      calls++;
      assert.equal(payload.max_tokens, 16000); // the unchanged single-call budget
      return reply(fixture(), 'built');
    },
    formatDoc: 'doc', addendum: 'add',
  });
  assert.equal(calls, 1);
  assert.equal(out.ok, true);
  assert.equal(out.generatedInParts, false);
});

test('a non-timeout first failure is surfaced as-is, never split', async () => {
  let calls = 0;
  await assert.rejects(
    runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => { calls++; throw new Error('LLM request failed: HTTP 401'); },
      formatDoc: 'doc', addendum: 'add',
    }),
    /HTTP 401/);
  assert.equal(calls, 1, 'a 401 is not a size problem — no second attempt');
});

test('a revision turn that times out is NOT split (its reply is already small)', async () => {
  let calls = 0;
  await assert.rejects(
    runCopilot({
      bundle: fixture(),
      messages: [{ role: 'user', content: 'add a security reviewer' }],
      callLlm: async () => { calls++; throw new Error('LLM request failed: timeout'); },
      formatDoc: 'doc', addendum: 'add',
    }),
    /LLM request failed: timeout/);
  assert.equal(calls, 1);
});

test('the split runs at most once — a timeout inside a part is not re-split', async () => {
  let calls = 0;
  await assert.rejects(
    runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => { calls++; throw new Error('LLM request failed: deadline'); },
      formatDoc: 'doc', addendum: 'add',
    }),
    /split generation also failed/);
  assert.equal(calls, 2, 'the single attempt plus part 1 — and then it gives up');
});

test('a failed split re-throws the ORIGINAL timeout so the guidance stays right', async () => {
  let calls = 0;
  await assert.rejects(
    runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => {
        if (++calls === 1) throw new Error('LLM request failed: HTTP 504');
        return 'not json at all';
      },
      formatDoc: 'doc', addendum: 'add',
    }),
    (err) => {
      // The turn began by timing out, so the card must still say "smaller
      // parts / faster model" — while the detail names both reasons.
      assert.equal(classifyTurnFailure(err).code, 'llm-timeout');
      assert.match(err.message, /HTTP 504/);
      assert.match(err.message, /split generation also failed.*no parseable reply/);
      return true;
    });
});

test('a split-generated bundle with errors still enters the repair loop, on the ops contract', async () => {
  const bad = fixture();
  bad.roles[3].triggers[0].claim.add = 'wrong-claim';
  const rolesOnly = { processTemplateVersion: 1, name: bad.name, roles: bad.roles };
  const repairRequests = [];
  let calls = 0;
  const out = await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async (payload) => {
      calls++;
      if (calls === 1) throw new Error('LLM request failed: timeout');
      if (calls === 2) return JSON.stringify({ summary: 'roles', bundle: rolesOnly });
      if (calls === 3) return JSON.stringify({ summary: 'wired', ops: [{ op: 'setName', name: bad.name }] });
      repairRequests.push(payload);
      return reply(fixture(), 'repaired');
    },
    formatDoc: readFormatDoc(), addendum: 'add',
  });
  assert.equal(out.ok, true);
  assert.equal(out.generatedInParts, true);
  assert.equal(out.repairIterations, 1);
  // The repair is aimed at the MERGED bundle, so it gets the ops contract — a
  // second full-size regeneration is the call that just timed out.
  assert.match(repairRequests[0].system, /Output contract \(revision/);
  assert.match(repairRequests[0].system, /wrong-claim/);
  // ...and the merged bundle is not echoed a second time as the assistant turn.
  const echoed = repairRequests[0].messages.find(m => m.role === 'assistant');
  assert.match(echoed.content, /generated in two steps/);
  assert.ok(echoed.content.length < 300);
});

test('a stop during the split issues no further part request', async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(
    runCopilot({
      bundle: undefined,
      messages: [{ role: 'user', content: 'build it' }],
      callLlm: async () => {
        if (++calls === 1) throw new Error('LLM request failed: timeout');
        ac.abort();
        return JSON.stringify({ summary: 'roles', bundle: { processTemplateVersion: 1, roles: [] } });
      },
      formatDoc: 'doc', addendum: 'add',
      signal: ac.signal,
    }),
    isCopilotAborted);
  assert.equal(calls, 2, 'part 1 ran, the stop landed, part 2 never issued');
});

test('the split announces its own progress so a long run is not a frozen label', async () => {
  const phases = [];
  const full = fixture();
  let calls = 0;
  await runCopilot({
    bundle: undefined,
    messages: [{ role: 'user', content: 'build it' }],
    callLlm: async () => {
      if (++calls === 1) throw new Error('LLM request failed: timeout');
      if (calls === 2) return JSON.stringify({ summary: 'roles', bundle: full });
      return JSON.stringify({ summary: 'wired', ops: [{ op: 'setName', name: full.name }] });
    },
    onProgress: (ev) => phases.push(ev),
    formatDoc: readFormatDoc(), addendum: 'add',
  });
  const parts = phases.filter(p => Number.isFinite(p.part));
  assert.deepEqual(parts.map(p => [p.part, p.parts, p.partId]), [[1, 2, 'roles'], [2, 2, 'wiring']]);
});
