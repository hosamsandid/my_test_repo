'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const createHelperChatHandler = require('./handler');
const {
  validateHelperChatRequest,
  trimMessages,
  buildHelperChatPayload,
  MAX_TURNS,
} = require('./handler');

// ── fake req/res ──────────────────────────────────────────────────────────────
// A minimal Express response double: records the JSON error path (status+json)
// and the NDJSON stream path (the lines written via res.write). Mirrors the
// api.js copilot route's contract closely enough to exercise the handler.

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    jsonBody: undefined,
    lines: [],
    writableEnded: false,
    socket: { setNoDelay() {} },
    _closeHandlers: [],
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.jsonBody = obj; this.writableEnded = true; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    flushHeaders() {},
    on(ev, fn) { if (ev === 'close') this._closeHandlers.push(fn); },
    write(chunk) { this.lines.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
  };
  return res;
}

// Parse the collected NDJSON write chunks into event objects.
function events(res) {
  return res.lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

// A resolveAssistTarget stub that always resolves to a usable provider.
function okTarget() {
  return {
    baseUrl: 'https://llm.example/v1',
    token: 'tok',
    model: 'claude-sonnet-5',
    endpointId: 'ep-1',
    endpointName: 'Test Provider',
  };
}

// Assemble the injected dependency bag. `llmText` is what the mocked LLM returns;
// `capture` collects the buildSystemPrompt argument so a test can assert it.
function deps({ target = okTarget(), llmText = 'Hello from the assistant.', capture = {} } = {}) {
  return {
    resolveAssistTarget: () => target,
    buildMessagesUrl: (b) => `${b}/messages`,
    httpPostJson: async () => ({ status: 200, body: { content: [{ type: 'text', text: llmText }] }, error: null }),
    extractMessageText: (body) => (body.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
    assistMeta: (t) => ({ assist: { endpointId: t.endpointId ?? null, model: t.model } }),
    sendAssistSelectionError: (res, t) => { res.status(t.selectionError.status).json({ error: t.selectionError.error, code: t.selectionError.code }); return true; },
    buildSystemPrompt: (label) => { capture.label = label; return `SYSTEM PROMPT ${label || ''}`; },
  };
}

// ── pure validation ─────────────────────────────────────────────────────────

test('validateHelperChatRequest rejects missing/empty messages', () => {
  assert.ok(validateHelperChatRequest({}).error);
  assert.ok(validateHelperChatRequest({ messages: [] }).error);
  assert.ok(validateHelperChatRequest({ messages: 'nope' }).error);
});

test('validateHelperChatRequest rejects a non-user last turn', () => {
  const r = validateHelperChatRequest({
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
  });
  assert.ok(r.error);
});

test('validateHelperChatRequest rejects a malformed message shape', () => {
  assert.ok(validateHelperChatRequest({ messages: [{ role: 'system', content: 'x' }] }).error);
  assert.ok(validateHelperChatRequest({ messages: [{ role: 'user', content: 42 }] }).error);
});

test('validateHelperChatRequest accepts a valid request and normalises optional route fields', () => {
  const r = validateHelperChatRequest({
    messages: [{ role: 'user', content: 'How do I add a trigger?' }],
    currentRoute: '/flows',
    currentRouteLabel: 'Flows',
  });
  assert.equal(r.error, undefined);
  assert.equal(r.currentRoute, '/flows');
  assert.equal(r.currentRouteLabel, 'Flows');
});

test('validateHelperChatRequest ignores non-string route fields', () => {
  const r = validateHelperChatRequest({
    messages: [{ role: 'user', content: 'hi' }],
    currentRoute: 123,
    currentRouteLabel: { x: 1 },
  });
  assert.equal(r.currentRoute, undefined);
  assert.equal(r.currentRouteLabel, undefined);
});

test('trimMessages keeps only the newest MAX_TURNS turns', () => {
  const many = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const trimmed = trimMessages(many);
  assert.equal(trimmed.length, MAX_TURNS);
  assert.equal(trimmed[trimmed.length - 1].content, `m${MAX_TURNS + 4}`);
  // Short conversations pass through unchanged.
  const few = [{ role: 'user', content: 'a' }];
  assert.equal(trimMessages(few), few);
});

test('buildHelperChatPayload puts the corpus in system and maps turns', () => {
  const payload = buildHelperChatPayload({
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }],
    currentRouteLabel: 'Triggers',
    buildSystemPrompt: (label) => `SP:${label}`,
  });
  assert.equal(payload.system, 'SP:Triggers');
  assert.equal(payload.messages.length, 3);
  assert.deepEqual(payload.messages[0], { role: 'user', content: 'hi' });
});

test('buildHelperChatPayload threads currentRoute to buildSystemPrompt (#1872 grounding)', () => {
  const seen = {};
  buildHelperChatPayload({
    messages: [{ role: 'user', content: 'hi' }],
    currentRouteLabel: 'Flows',
    currentRoute: '/flows',
    buildSystemPrompt: (label, route) => { seen.label = label; seen.route = route; return 'sp'; },
  });
  assert.equal(seen.label, 'Flows');
  assert.equal(seen.route, '/flows');
});

// ── the handler ──────────────────────────────────────────────────────────────

test('valid request streams delta then done', async () => {
  const handler = createHelperChatHandler(deps({ llmText: 'To add a trigger, open the Triggers page.' }));
  const res = fakeRes();
  await handler({ body: { messages: [{ role: 'user', content: 'How do I add a trigger?' }] } }, res);

  const evs = events(res);
  const types = evs.map(e => e.type);
  assert.ok(types.includes('assist'), 'announces the assist provenance');
  assert.ok(types.includes('delta'), 'streams a delta');
  assert.equal(types[types.length - 1], 'done', 'ends with done');
  const delta = evs.find(e => e.type === 'delta');
  assert.equal(delta.text, 'To add a trigger, open the Triggers page.');
  assert.ok(res.writableEnded);
});

test('missing messages returns HTTP 400 before streaming', async () => {
  const handler = createHelperChatHandler(deps());
  const res = fakeRes();
  await handler({ body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.jsonBody.error);
  assert.equal(res.lines.length, 0, 'nothing streamed on a rejected request');
});

test('non-user last turn returns HTTP 400', async () => {
  const handler = createHelperChatHandler(deps());
  const res = fakeRes();
  await handler({ body: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.lines.length, 0);
});

test('currentRouteLabel is passed to buildSystemPrompt', async () => {
  const capture = {};
  const handler = createHelperChatHandler(deps({ capture }));
  const res = fakeRes();
  await handler({ body: { messages: [{ role: 'user', content: 'where am I?' }], currentRouteLabel: 'Flows' } }, res);
  assert.equal(capture.label, 'Flows');
});

test('a selection error is surfaced as JSON, not a stream', async () => {
  const target = { selectionError: { status: 400, code: 'assist-model-not-selected', error: 'Select an assist model.' } };
  const handler = createHelperChatHandler(deps({ target }));
  const res = fakeRes();
  await handler({ body: { messages: [{ role: 'user', content: 'hi' }] } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonBody.code, 'assist-model-not-selected');
  assert.equal(res.lines.length, 0);
});

test('an LLM transport failure emits a single error event', async () => {
  const d = deps();
  d.httpPostJson = async () => ({ status: 502, body: { error: { message: 'upstream down' } }, error: null });
  const handler = createHelperChatHandler(d);
  const res = fakeRes();
  await handler({ body: { messages: [{ role: 'user', content: 'hi' }] } }, res);
  const evs = events(res);
  const err = evs.find(e => e.type === 'error');
  assert.ok(err, 'emits an error event');
  assert.match(err.message, /upstream down/);
  assert.ok(!evs.some(e => e.type === 'done'), 'no done after an error');
});
