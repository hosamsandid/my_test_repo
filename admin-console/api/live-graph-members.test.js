'use strict';

// #2814 — auto-scaled pool instances are not roles of a live team's flow.
// `live-graph-members.js` owns the decision; api.js cannot be `require`d (it
// boots Express), so the second half reads the three live graph routes'
// source to prove each one still goes through it — the same drift-guard
// technique as the sibling `*-wiring.test.js` files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isLiveGraphMember } = require('./live-graph-members');
const { buildProcessGraph } = require('./process-graph');

const TEAM = 'acme';
const role = (id, extra = {}) => ({ id, role: 'team-member', parentTeamId: TEAM, ...extra });
const SPECIFIER = role('acme-specifier', { pool: { enabled: true } });
const INSTANCE = role('acme-specifier-i71', { poolInstance: true, poolOf: 'acme-specifier', poolItem: 71 });
const LOOKALIKE = role('acme-helper-i3');

test('AC1: a pool instance is not a member of the live graph; its role is', () => {
  assert.equal(isLiveGraphMember(INSTANCE, TEAM), false);
  assert.equal(isLiveGraphMember(INSTANCE), false, 'unscoped too');
  assert.equal(isLiveGraphMember(SPECIFIER, TEAM), true);
});

test('AC7: a hand-created member whose id only LOOKS like an instance stays a node', () => {
  assert.equal(isLiveGraphMember(LOOKALIKE, TEAM), true);
  assert.equal(isLiveGraphMember({ ...LOOKALIKE, poolOf: 'acme-helper' }, TEAM), true, 'only the flag decides');
});

test('the existing exclusions still hold: team holder, other team', () => {
  assert.equal(isLiveGraphMember({ id: TEAM, role: 'team' }, TEAM), false);
  assert.equal(isLiveGraphMember(role('other-dev', { parentTeamId: 'other' }), TEAM), false);
  assert.equal(isLiveGraphMember({}, null), true, 'an unreadable config ({}) keeps today\'s behaviour');
  assert.equal(isLiveGraphMember(null, null), true);
});

test('AC2/AC3: filtering the instance leaves exactly the role\'s own edges and no duplicate-consumer lint', () => {
  // A producer hands off on `specify`; the role listens — and so does its
  // instance, which carries a copy of the role's triggers.
  const listen = [{ id: 't1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'specify' }];
  const toAgent = (cfg, triggers = []) => ({
    id: cfg.id, role: cfg.role, displayName: cfg.id, sessionPolicy: 'persistent',
    environmentId: null, triggers, emits: [], outcomes: null, github: null, channels: [],
  });
  const PRODUCER = role('acme-po');
  const configs = [
    [PRODUCER, []],
    [SPECIFIER, listen],
    [INSTANCE, listen],
  ];
  const withEmit = (a) => (a.id === 'acme-po' ? { ...a, emits: ['specify'] } : a);
  const all = buildProcessGraph(configs.map(([c, t]) => withEmit(toAgent(c, t))));
  const roles = buildProcessGraph(configs.filter(([c]) => isLiveGraphMember(c, TEAM)).map(([c, t]) => withEmit(toAgent(c, t))));
  const without = buildProcessGraph([[PRODUCER, []], [SPECIFIER, listen]].map(([c, t]) => withEmit(toAgent(c, t))));

  assert.ok(all.nodes.some((n) => n.id === INSTANCE.id), 'precondition: unfiltered, the instance is a node');
  assert.ok(all.edges.some((e) => e.to === INSTANCE.id), 'precondition: unfiltered, the instance gets a copy of the hand-off edge');
  assert.ok(roles.edges.some((e) => e.from === 'acme-po' && e.to === SPECIFIER.id), 'the role keeps its hand-off');
  assert.ok(!roles.nodes.some((n) => n.id === INSTANCE.id));
  assert.ok(!roles.edges.some((e) => e.from === INSTANCE.id || e.to === INSTANCE.id));
  assert.deepEqual(roles.edges, without.edges, 'the role keeps exactly the edges it has without the instance');
  assert.deepEqual(roles.lints, without.lints);
});

// ─── route wiring ───────────────────────────────────────────────────────────

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  return stripComments(API_SRC.slice(start, end));
}

const ROUTES = {
  'GET /api/process/graph (live)': "app.get('/api/process/graph',",
  'GET /api/flows/graph (Flow Editor)': "app.get('/api/flows/graph',",
  'GET /api/process/template (Export / Edit as draft, AC6)': "app.get('/api/process/template',",
};

/** The live member walk must skip anything the shared predicate rejects. */
function checkRoute(src) {
  const walk = src.slice(src.indexOf('for (const id of listAgentDirs())'));
  assert.ok(walk.length < src.length, 'live member walk not found');
  assert.match(walk.slice(0, 400), /if \(!isLiveGraphMember\(cfg, team\)\) continue;/);
}

for (const [name, marker] of Object.entries(ROUTES)) {
  test(`AC8: ${name} filters its live members through isLiveGraphMember`, () => {
    checkRoute(route(marker));
  });
}

test('AC8 mutation proof: the guard fires when a route drops the filter', () => {
  for (const marker of Object.values(ROUTES)) {
    const sabotaged = route(marker).replace('if (!isLiveGraphMember(cfg, team)) continue;', "if (cfg.role === 'team') continue;");
    assert.throws(() => checkRoute(sabotaged));
  }
});
