'use strict';

// #2709 — the hill-climb card write routes, EXECUTED over HTTP with a real JSON
// body and the REAL `readBody` from orchestrator.js (sliced out of the source
// and evaluated, since the monolith starts a service on require). The routes
// used to `JSON.parse()` the object `readBody` already returns, so every apply,
// rollback and analyst merge answered 500 — a regex guard on the source could
// not see that; posting a body does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const { createHillClimbCardRoutes } = require('./hill-climb-card-routes');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function sliceTopLevelFunction(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(start !== -1, `orchestrator.js defines ${name}`);
  const end = SRC.indexOf('\n}\n', start + 1);
  return SRC.slice(start + 1, end + 2);
}

// The real readBody / sendJson, evaluated in isolation.
// Host JSON, so parsed bodies carry this realm's prototypes (deepEqual).
const ctx = vm.createContext({ JSON });
vm.runInContext(`${sliceTopLevelFunction('readBody')}\n${sliceTopLevelFunction('sendJson')}`, ctx);
const realReadBody = ctx.readBody;
const realSendJson = ctx.sendJson;

function harness({ autonomy = 2, applyResult, rollbackResult } = {}) {
  const calls = { merge: [], apply: [], rollback: [] };
  const routes = createHillClimbCardRoutes({
    loadAgentConfig: (id) => (id === 'team-1' ? { id, role: 'team' } : null),
    hillClimbCardConfig: () => ({ autonomy }),
    readHillClimbCards: () => [],
    mergeAndPersistHillClimbCards: (teamId, cards, opts) => {
      calls.merge.push({ teamId, cards, opts });
      return { added: cards.length, bumped: 0, deferred: 0, rejected: [], cards };
    },
    applyHillClimbCard: (teamId, cardId, opts) => {
      calls.apply.push({ teamId, cardId, opts });
      return applyResult || { ok: true, card: { id: cardId, status: 'applied', undo: opts.undo } };
    },
    rollbackHillClimbCard: (teamId, cardId, opts) => {
      calls.rollback.push({ teamId, cardId, opts });
      return rollbackResult || { ok: true, card: { id: cardId, status: 'rolled-back' } };
    },
    readBody: realReadBody,
    sendJson: realSendJson,
    log: () => {},
  });
  const server = http.createServer((req, res) => {
    if (routes.handle(req, res)) return;
    res.writeHead(404); res.end('{}');
  });
  return { server, calls };
}

async function withServer(h, fn) {
  await new Promise((r) => h.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${h.server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => h.server.close(r)); }
}

async function post(base, url, body) {
  const resp = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

test('apply: a JSON body is recorded (200) and its undo payload reaches the store', async () => {
  const h = harness();
  const undo = { kind: 'restore-trigger', agentId: 'rev', trigger: { id: 't1', type: 'github-event' } };
  await withServer(h, async (base) => {
    const r = await post(base, '/internal/teams/team-1/hill-climb/cards/c-1/apply', {
      appliedBy: 'alice', undo, configVersionRef: { kind: 'trigger-delete', agentId: 'rev', triggerId: 't1' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.card.status, 'applied');
    assert.deepEqual(r.json.card.undo, undo);
  });
  assert.equal(h.calls.apply.length, 1);
  assert.equal(h.calls.apply[0].teamId, 'team-1');
  assert.equal(h.calls.apply[0].cardId, 'c-1');
  assert.equal(h.calls.apply[0].opts.appliedBy, 'alice');
  assert.deepEqual(h.calls.apply[0].opts.configVersionRef, { kind: 'trigger-delete', agentId: 'rev', triggerId: 't1' });
});

test('rollback: a JSON body is recorded (200) with rolledBackBy + undoResult', async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const r = await post(base, '/internal/teams/team-1/hill-climb/cards/c-2/rollback', {
      rolledBackBy: 'bob', undoResult: { kind: 'restore-trigger', agentId: 'rev', triggerId: 't1' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.card.status, 'rolled-back');
  });
  assert.equal(h.calls.rollback[0].opts.rolledBackBy, 'bob');
  assert.deepEqual(h.calls.rollback[0].opts.undoResult, { kind: 'restore-trigger', agentId: 'rev', triggerId: 't1' });
});

test('analyst merge: a JSON body { cards } is merged (200) as source analyst', async () => {
  const h = harness();
  const cards = [{ class: 'trigger-hygiene', title: 'x' }];
  await withServer(h, async (base) => {
    const r = await post(base, '/internal/teams/team-1/hill-climb/cards/merge', { cards });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.merge.added, 1);
  });
  assert.deepEqual(h.calls.merge[0].cards, cards);
  assert.equal(h.calls.merge[0].opts.source, 'analyst');
});

test('an empty body is treated as {} (no 500)', async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const r = await post(base, '/internal/teams/team-1/hill-climb/cards/c-1/apply', '');
    assert.equal(r.status, 200);
  });
  assert.deepEqual(h.calls.apply[0].opts, { appliedBy: null, undo: null, configVersionRef: null });
});

test('a malformed JSON body is a 400, and the store is not touched', async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const r = await post(base, '/internal/teams/team-1/hill-climb/cards/c-1/apply', '{not json');
    assert.equal(r.status, 400);
  });
  assert.equal(h.calls.apply.length, 0);
});

test('store refusals keep their status mapping (404 / 403 / 409) and unknown teams 404', async () => {
  const cases = [
    [{ ok: false, code: 'card-not-found' }, 404],
    [{ ok: false, code: 'autonomy-locked', autonomy: 1 }, 403],
    [{ ok: false, code: 'card-not-open', status: 'applied' }, 409],
  ];
  for (const [applyResult, status] of cases) {
    const h = harness({ applyResult });
    await withServer(h, async (base) => {
      const r = await post(base, '/internal/teams/team-1/hill-climb/cards/c-1/apply', {});
      assert.equal(r.status, status);
      assert.equal(r.json.error, applyResult.code);
    });
  }
  const h = harness();
  await withServer(h, async (base) => {
    const r = await post(base, '/internal/teams/nope/hill-climb/cards/c-1/rollback', {});
    assert.equal(r.status, 404);
  });
});

test('merge below autonomy 1 returns the cards without merging', async () => {
  const h = harness({ autonomy: 0 });
  await withServer(h, async (base) => {
    const r = await post(base, '/internal/teams/team-1/hill-climb/cards/merge', { cards: [{}] });
    assert.equal(r.status, 200);
    assert.equal(r.json.merge, null);
  });
  assert.equal(h.calls.merge.length, 0);
});

test('other routes fall through (dismiss, GET cards)', () => {
  const routes = createHillClimbCardRoutes({ readBody: realReadBody, sendJson: realSendJson });
  assert.equal(routes.handle({ method: 'POST', url: '/internal/teams/t/hill-climb/cards/c/dismiss' }, {}), null);
  assert.equal(routes.handle({ method: 'GET', url: '/internal/teams/t/hill-climb/cards' }, {}), null);
});

test('orchestrator.js wires the real readBody into the routes and never re-parses a readBody result', () => {
  const wiring = SRC.slice(SRC.indexOf('createHillClimbCardRoutes({'));
  assert.match(wiring.slice(0, wiring.indexOf('});')), /\breadBody,/);
  assert.match(SRC, /if \(hillClimbCardRoutes\.handle\(req, res\)\) return;/);
  // The class of bug: readBody already returns an object.
  assert.doesNotMatch(SRC, /JSON\.parse\(\s*\(?\s*await readBody\(/);
});
