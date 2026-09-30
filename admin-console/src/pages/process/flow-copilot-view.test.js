import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STARTER_PROMPTS,
  toApiMessages,
  describeChange,
  lintColor,
  copilotErrorInfo,
  phaseLabel,
  consumeCopilotStream,
  PERSISTED_HISTORY_CAP,
  toPersistedMessages,
  hydrateMessages,
  proposalNodeDiff,
  bundleSizeCharCount,
  bundleSizeLevel,
  COPILOT_TIMEOUT_HEADLINE,
  COPILOT_TIMEOUT_HINTS,
} from './flow-copilot-view.js';

test('starter prompts: three chips, whole-flow example first', () => {
  assert.equal(STARTER_PROMPTS.length, 3);
  assert.match(STARTER_PROMPTS[0], /Business Analyst/);
  assert.match(STARTER_PROMPTS[1], /security reviewer/);
  assert.match(STARTER_PROMPTS[2], /human approval gate/);
});

test('toApiMessages maps user rows verbatim and assistant rows to their summary', () => {
  const msgs = toApiMessages([
    { role: 'user', content: 'a BA refines issues' },
    { role: 'assistant', summary: 'Created a two-role flow.', bundle: { big: 'object' }, status: 'applied' },
    { role: 'user', content: 'add a reviewer' },
  ]);
  assert.deepEqual(msgs, [
    { role: 'user', content: 'a BA refines issues' },
    { role: 'assistant', content: 'Created a two-role flow.' },
    { role: 'user', content: 'add a reviewer' },
  ]);
});

test('toApiMessages drops error rows and placeholder-fills empty summaries', () => {
  const msgs = toApiMessages([
    { role: 'user', content: 'x' },
    { role: 'error', message: 'HTTP 502' },
    { role: 'assistant', summary: '   ' },
    null,
  ]);
  assert.deepEqual(msgs, [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: '(proposal without summary)' },
  ]);
});

test('toApiMessages tolerates a non-array', () => {
  assert.deepEqual(toApiMessages(null), []);
});

test('describeChange renders every computeChanges kind', () => {
  assert.equal(describeChange({ kind: 'role-added', id: 'developer' }), 'Role added: developer');
  assert.equal(describeChange({ kind: 'label-added', id: 'ready' }), 'Label registered: ready');
  assert.equal(describeChange({ kind: 'gate-modified', id: 'ready' }), 'Gate modified: ready');
  assert.equal(describeChange({ kind: 'human-removed', id: 'po' }), 'Human role removed: po');
  assert.equal(describeChange({ kind: 'name-changed', id: 'SDLC flow' }), 'Flow renamed to: SDLC flow');
});

test('describeChange falls back to the raw kind and tolerates junk', () => {
  assert.equal(describeChange({ kind: 'exotic-op', id: 'x' }), 'exotic-op: x');
  assert.equal(describeChange({ kind: 'role-added' }), 'Role added');
  assert.equal(describeChange(null), '');
});

test('lintColor mirrors the LintsPanel palette', () => {
  assert.equal(lintColor('error'), 'var(--eb-status-error)');
  assert.equal(lintColor('warning'), 'var(--eb-status-warning)');
  assert.equal(lintColor('info'), 'var(--eb-text-muted)');
});

test('copilotErrorInfo: 400 is a non-retryable provider problem', () => {
  const e = copilotErrorInfo(400, 'No LLM endpoint configured. Add one on the Model Providers page or set ANTHROPIC_BASE_URL.');
  assert.equal(e.kind, 'provider');
  assert.equal(e.retryable, false);
  assert.match(e.message, /No LLM endpoint/);
});

test('copilotErrorInfo: 502 and network errors are retryable transport failures', () => {
  assert.deepEqual(copilotErrorInfo(502, 'LLM request failed: HTTP 500'),
    { kind: 'transport', retryable: true, message: 'LLM request failed: HTTP 500' });
  const net = copilotErrorInfo(undefined, '');
  assert.equal(net.kind, 'transport');
  assert.equal(net.retryable, true);
  assert.match(net.message, /Request failed/);
});

test('copilotErrorInfo: 400 bundle-too-large is a non-retryable bundle-size error', () => {
  const e = copilotErrorInfo(400, 'bundle-too-large');
  assert.equal(e.kind, 'bundle-too-large');
  assert.equal(e.retryable, false);
});

test('copilotErrorInfo: 504 is a retryable timeout', () => {
  const e = copilotErrorInfo(504, 'LLM request failed: HTTP 504');
  assert.equal(e.kind, 'timeout');
  assert.equal(e.retryable, true);
});

// ── plain-language timeout guidance (#2131 AC1) ──────────────────────────────

test('AC1: a timeout headline is plain language and the raw detail is demoted', () => {
  const e = copilotErrorInfo(504, 'LLM request failed: HTTP 504', 'llm-timeout');
  assert.equal(e.kind, 'timeout');
  assert.equal(e.retryable, true);
  // The headline is the sentence the user reads — never the transport string.
  assert.equal(e.message, COPILOT_TIMEOUT_HEADLINE);
  assert.doesNotMatch(e.message, /HTTP|LLM request failed/);
  // ...and the guidance names the two things that actually help.
  assert.deepEqual(e.hints, COPILOT_TIMEOUT_HINTS);
  assert.match(e.hints.join(' '), /smaller parts/i);
  assert.match(e.hints.join(' '), /Settings → Model/);
  // The raw detail is kept, for the card's expander.
  assert.equal(e.detail, 'LLM request failed: HTTP 504');
});

test('AC1: the whole timeout class lands on the guidance, by code or by message', () => {
  // The server's stable code is the primary signal...
  assert.equal(copilotErrorInfo(504, 'anything at all', 'llm-timeout').kind, 'timeout');
  // ...and the message is the fallback for a pre-#2131 server or a client-side
  // transport failure, which carries no code.
  for (const [status, msg] of [
    [502, 'LLM request failed: HTTP 504'],
    [502, 'LLM request failed: HTTP 502'],
    [502, 'LLM request failed: timeout'],
    [502, 'LLM request failed: deadline'],
    [undefined, 'Gateway Timeout'],
    [undefined, 'Bad Gateway'],
  ]) {
    const e = copilotErrorInfo(status, msg);
    assert.equal(e.kind, 'timeout', msg);
    assert.equal(e.message, COPILOT_TIMEOUT_HEADLINE, msg);
    assert.equal(e.detail, msg);
  }
});

test('AC1: a junk-output 502 keeps its own message — the guidance would be wrong', () => {
  // The route's error envelope is 502 for `no-parseable-bundle` too, so a
  // blanket status check would tell someone whose model produced invalid JSON
  // to pick a faster model.
  const e = copilotErrorInfo(502, 'LLM returned no parseable bundle', 'no-parseable-bundle');
  assert.equal(e.kind, 'transport');
  assert.equal(e.message, 'LLM returned no parseable bundle');
  assert.equal(e.hints, undefined);
  assert.equal(e.detail, undefined);
});

test('AC1: a provider/bundle-size problem is not reclassified as a timeout', () => {
  assert.equal(copilotErrorInfo(400, 'bundle-too-large').kind, 'bundle-too-large');
  assert.equal(copilotErrorInfo(400, 'No LLM endpoint configured.').kind, 'provider');
  // Even if a 400 message happened to contain the word, the 400 branch wins.
  assert.equal(copilotErrorInfo(400, 'bad request: timeout must be a number').kind, 'provider');
});

test('phaseLabel counts the steps of a generate-in-parts run (#2131)', () => {
  assert.equal(phaseLabel({ type: 'phase', phase: 'generating', part: 1, parts: 2 }),
    'Generating in parts (1/2)…');
  assert.equal(phaseLabel({ type: 'phase', phase: 'generating', part: 2, parts: 2, chars: 4200 }),
    'Generating in parts (2/2)… · 4.2k chars');
  // A plain generating event is unchanged, and a repair still reads as a repair.
  assert.equal(phaseLabel({ type: 'phase', phase: 'generating' }), 'Generating…');
  assert.equal(phaseLabel({ type: 'phase', phase: 'repairing', iteration: 1, part: 1, parts: 2 }),
    'Repairing (1/2)…');
});

test('bundleSizeCharCount returns JSON.stringify length, 0 for null/undefined', () => {
  assert.equal(bundleSizeCharCount(null), 0);
  assert.equal(bundleSizeCharCount(undefined), 0);
  const bundle = { processTemplateVersion: 1, roles: [] };
  assert.equal(bundleSizeCharCount(bundle), JSON.stringify(bundle).length);
});

test('bundleSizeLevel: ok below 160k, amber 160k–200k, red at/above 200k', () => {
  assert.equal(bundleSizeLevel(0), 'ok');
  assert.equal(bundleSizeLevel(159_999), 'ok');
  assert.equal(bundleSizeLevel(160_000), 'amber');
  assert.equal(bundleSizeLevel(199_999), 'amber');
  assert.equal(bundleSizeLevel(200_000), 'red');
  assert.equal(bundleSizeLevel(300_000), 'red');
});

// `supersedePending` / `latestProposal` were removed by #2087 — the actionable
// proposal is now held one-per-scope by the app-level FlowCopilotProvider
// rather than searched for in a card list. Their replacements are covered in
// flow-copilot-turn.test.js (`putPending`/`dropPending`/`dropPendingById`).

// ── NDJSON progress stream (#1070) ──────────────────────────────────────────

test('phaseLabel maps the server phases to live status lines', () => {
  assert.equal(phaseLabel({ type: 'phase', phase: 'generating' }), 'Generating…');
  assert.equal(phaseLabel({ type: 'phase', phase: 'validating' }), 'Validating…');
  assert.equal(phaseLabel({ type: 'phase', phase: 'repairing', iteration: 1 }), 'Repairing (1/2)…');
  assert.equal(phaseLabel({ type: 'phase', phase: 'repairing', iteration: 2 }), 'Repairing (2/2)…');
  assert.equal(phaseLabel(null), 'Generating…');
});

test('phaseLabel appends the streamed reply size when a heartbeat carries one', () => {
  // The streaming heartbeat re-emits the current phase with a `chars` count.
  assert.equal(phaseLabel({ type: 'phase', phase: 'generating', chars: 2100 }), 'Generating… · 2.1k chars');
  assert.equal(phaseLabel({ type: 'phase', phase: 'repairing', iteration: 1, chars: 500 }), 'Repairing (1/2)… · 0.5k chars');
  // No size rode along, or a zero count → the bare label (backward compatible).
  assert.equal(phaseLabel({ type: 'phase', phase: 'generating', chars: 0 }), 'Generating…');
  // Validating is a post-reply phase — never annotated even if a stray count appears.
  assert.equal(phaseLabel({ type: 'phase', phase: 'validating', chars: 9000 }), 'Validating…');
});

// Synthetic OK response whose body streams the given chunks.
function streamedRes(chunks) {
  const enc = new TextEncoder();
  return {
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
  };
}

test('consumeCopilotStream forwards phases and resolves with the result payload', async () => {
  const phases = [];
  const result = await consumeCopilotStream(streamedRes([
    '{"type":"phase","phase":"generating"}\n',
    '{"type":"phase","phase":"validating"}\n{"type":"result","ok":true,"summary":"built","bundle":{"processTemplateVersion":1},"model":"m"}\n',
  ]), (ev) => phases.push(ev.phase));
  assert.deepEqual(phases, ['generating', 'validating']);
  assert.equal(result.ok, true);
  assert.equal(result.summary, 'built');
  assert.equal(result.model, 'm');
});

test('consumeCopilotStream reassembles a line split across chunks', async () => {
  const result = await consumeCopilotStream(streamedRes([
    '{"type":"result","ok":tr', 'ue,"summary":"split"}\n',
  ]), null);
  assert.equal(result.summary, 'split');
});

test('consumeCopilotStream throws with status on a terminal error event', async () => {
  await assert.rejects(
    consumeCopilotStream(streamedRes(['{"type":"error","status":502,"error":"LLM request failed: timeout"}\n']), null),
    (err) => err.status === 502 && /timeout/.test(err.message));
});

test('consumeCopilotStream treats a stream without a result as a dropped connection', async () => {
  await assert.rejects(
    consumeCopilotStream(streamedRes(['{"type":"phase","phase":"generating"}\n']), null),
    /Connection lost/);
});

test('consumeCopilotStream survives corrupt lines and a missing trailing newline', async () => {
  const result = await consumeCopilotStream(streamedRes([
    'garbage-not-json\n',
    '{"type":"result","ok":false,"summary":"tail"}',
  ]), null);
  assert.equal(result.summary, 'tail');
});

// ── chat-history persistence (#1071 item 1) ──────────────────────────────────

test('toPersistedMessages projects to durable fields, drops errors and bundles', () => {
  const out = toPersistedMessages([
    { id: 1, role: 'user', content: 'build it' },
    { id: 2, role: 'error', message: 'HTTP 502', retryText: 'build it' },
    { id: 3, role: 'assistant', summary: 's', changes: [{ kind: 'role-added', id: 'x' }], lints: [], ok: true, status: 'proposed', bundle: { big: 1 }, hasPreview: true },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'build it' },
    { role: 'assistant', summary: 's', changes: [{ kind: 'role-added', id: 'x' }], ok: true, status: 'superseded' },
  ]);
});

test('toPersistedMessages caps to the last N turns', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = toPersistedMessages(many);
  assert.equal(out.length, PERSISTED_HISTORY_CAP);
  assert.equal(out[0].content, `m${30 - PERSISTED_HISTORY_CAP}`);
});

test('hydrateMessages rebuilds entries with fresh ids; proposals can never revive', () => {
  let n = 0;
  const out = hydrateMessages({ messages: [
    { role: 'user', content: 'build it' },
    { role: 'assistant', summary: 's', ok: true, status: 'proposed' },
    { role: 'assistant', summary: 'a', ok: true, status: 'applied' },
    { role: 'weird' },
  ] }, () => ++n);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(e => e.id), [1, 2, 3]);
  assert.equal(out[1].status, 'superseded'); // no bundle survives persistence
  assert.equal(out[1].bundle, null);
  assert.equal(out[2].status, 'applied');
  assert.deepEqual(hydrateMessages(undefined, () => 1), []);
});

// ── canvas diff-highlighting (#1071 item 2) ──────────────────────────────────

test('proposalNodeDiff classifies added / modified / removed roles and humans', () => {
  const current = {
    roles: [
      { id: 'dev', displayName: 'Developer', systemPrompt: 'a' },
      { id: 'rev', displayName: 'Reviewer', systemPrompt: 'b' },
    ],
    humans: [{ id: 'po', name: 'Product Owner' }],
  };
  const proposed = {
    roles: [
      { id: 'dev', systemPrompt: 'a', displayName: 'Developer' }, // key order only → unchanged
      { id: 'sec', displayName: 'Security Reviewer' },
    ],
    humans: [{ id: 'po', name: 'Product Owner', emits: ['ready'] }],
  };
  const d = proposalNodeDiff(current, proposed);
  assert.deepEqual(d.added, ['sec']);
  assert.deepEqual(d.modified, ['po']);
  assert.deepEqual(d.removed, [{ id: 'rev', name: 'Reviewer' }]);
});

test('proposalNodeDiff tolerates empty/missing bundles', () => {
  const d = proposalNodeDiff(null, { roles: [{ id: 'a' }] });
  assert.deepEqual(d.added, ['a']);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(proposalNodeDiff({ roles: [{ id: 'a' }] }, null).removed, [{ id: 'a', name: 'a' }]);
});

test('consumeCopilotStream carries the server failure code onto the thrown error', async () => {
  await assert.rejects(consumeCopilotStream(streamedRes([
    '{"type":"phase","phase":"generating"}\n',
    '{"type":"error","status":504,"code":"llm-timeout","error":"LLM request failed: HTTP 504"}\n',
  ]), () => {}), (err) => {
    assert.equal(err.status, 504);
    assert.equal(err.copilotCode, 'llm-timeout');
    // End to end: the code the route emitted is what turns the raw transport
    // string into the guidance card.
    assert.equal(
      copilotErrorInfo(err.status, err.message, err.copilotCode).message,
      COPILOT_TIMEOUT_HEADLINE,
    );
    return true;
  });
});

test('an error event without a code still classifies (pre-#2131 server)', async () => {
  await assert.rejects(consumeCopilotStream(streamedRes([
    '{"type":"error","status":502,"error":"LLM request failed: timeout"}\n',
  ]), null), (err) => {
    assert.equal(err.copilotCode, undefined);
    assert.equal(copilotErrorInfo(err.status, err.message, err.copilotCode).kind, 'timeout');
    return true;
  });
});

test('a live-team apply result survives persist, hydrate and the API projection (#2556)', () => {
  const result = 'Partly applied: 1 change(s) applied, 1 failed.';
  const persisted = toPersistedMessages([
    { id: 1, role: 'assistant', summary: 'Add a tester', ok: true, status: 'partial', result, bundle: { x: 1 } },
  ]);
  assert.deepEqual(persisted, [{ role: 'assistant', summary: 'Add a tester', ok: true, status: 'partial', result }]);
  let n = 0;
  const hydrated = hydrateMessages({ messages: persisted }, () => ++n);
  assert.equal(hydrated[0].result, result);
  assert.equal(hydrated[0].status, 'partial');
  const api = toApiMessages(hydrated);
  assert.equal(api[0].content, `Add a tester\n\n[Apply result]\n${result}`);
  // A draft card without a result is unchanged.
  assert.equal(toApiMessages([{ role: 'assistant', summary: 's' }])[0].content, 's');
});
