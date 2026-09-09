'use strict';

// #2080 — the wiring half of the D9 Team-Member boundary.
//
// `team-member-boundary.test.js` proves the gate refuses the right people. This
// file proves it is mounted where §6 says it must be, by reading api.js's
// source — because that is the only thing that can prove it. Every one of these
// gates is invisible when it goes missing: a route that stops calling the
// predicate returns the right data to the caller who is allowed, and to
// everyone else too. Same reasoning and same mechanism as
// `draft-routes-access.test.js` / `convert-to-team-route.test.js`.
//
// The scan runs in BOTH directions, and the second one is the point:
//
//   table → source   no entry in the matrix names a route api.js dropped
//   source → table   no route api.js registers in the three scanned families
//                    is missing from the matrix
//
// The second direction is what makes AC3 deliverable. There is no manual
// trigger-firing route today, so it cannot be gated — but a new one cannot
// arrive unclassified either, because it fails this test until someone puts it
// in the table, and §6 has already decided the answer.
//
// Every assertion here is additionally run over a SYNTHETIC source with the
// faults deliberately introduced (see the last test). An assertion that has
// only ever run against a correct api.js could be silently vacuous — this is
// the `help-coverage.test.js` AC4 technique.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  MUTATION_CLASS,
  WORK_PLANE_ROUTES,
  SCANNED_FAMILIES,
  manageRoutes,
  classifyWorkPlaneRoute,
} = require('./team-member-boundary');

const API_PATH = path.join(__dirname, 'api.js');
const API_SRC = fs.readFileSync(API_PATH, 'utf8');

/** The express middleware this ticket adds, and the pre-existing config-plane
 *  helper the trigger routes already use. A manage-class route must carry one. */
const MANAGE_GATES = Object.freeze({
  middleware: 'requireAgentManage',
  inline: 'denyUnlessCanManageAgent',
});

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every route api.js registers in the scanned families, as
 * `{ method, routePath, registration, body }`.
 *
 * `registration` is the `app.<verb>('<path>', …middleware…, handler` prefix —
 * where a middleware name has to appear — and `body` is the whole handler up to
 * the next top-level `app.` call, which is where an inline gate appears. Both
 * are comment-stripped, so a comment merely *naming* a gate never satisfies an
 * assertion that the gate is called.
 */
function scanRoutes(src) {
  const families = SCANNED_FAMILIES.join('|');
  // The family segment must END here — either at the closing quote or at a `/`.
  // Without that, `context` would also match `/api/agents/:id/context-mount`,
  // a config-plane route that carries its own gate and is not ours to touch.
  const re = new RegExp(
    `app\\.(get|post|put|patch|delete)\\('(/api/agents/:(?:id|agentId)/(?:${families})(?:/[^']*)?)'`,
    'g',
  );
  const found = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    const next = src.indexOf('\napp.', start + 1);
    const body = src.slice(start, next === -1 ? src.length : next);
    // The registration is everything up to the handler's parameter list.
    const handlerAt = body.search(/\(\s*req\s*,\s*res\s*(,|\))|async\s*\(\s*req/);
    found.push({
      method: m[1],
      routePath: m[2],
      registration: stripComments(handlerAt > 0 ? body.slice(0, handlerAt) : body.slice(0, 200)),
      body: stripComments(body),
    });
  }
  return found;
}

const ROUTES = scanRoutes(API_SRC);

function key(r) {
  return `${r.method} ${r.routePath || r.path}`;
}

/** Which manage gate, if any, a scanned route carries. */
function gateOf(route) {
  if (route.registration.includes(MANAGE_GATES.middleware)) return 'middleware';
  if (route.body.includes(`${MANAGE_GATES.inline}(req, res`)) return 'inline';
  return null;
}

// ── The two directions of the scan ──────────────────────────────────────────

test('the scan finds routes at all (the guard is not vacuous)', () => {
  assert.ok(ROUTES.length >= 20,
    `expected the three scanned families to hold 20+ routes, found ${ROUTES.length} — the scan regex needs re-pointing`);
});

test('table → source: every route in the matrix is registered by api.js', () => {
  const registered = new Set(ROUTES.map(key));
  for (const r of WORK_PLANE_ROUTES) {
    assert.ok(registered.has(key(r)),
      `${key(r)} is in the §6 matrix but api.js does not register it — the table needs re-pointing`);
  }
});

test('source → table: no route in the scanned families is unclassified', () => {
  for (const r of ROUTES) {
    const cls = classifyWorkPlaneRoute(r.method, r.routePath);
    assert.ok(cls !== null,
      `${key(r)} is registered by api.js but is not in the §6 matrix of team-member-boundary.js. `
      + 'Classify it: a Team Member may read and chat, but may not change any agent setting (D9). '
      + 'A trigger-firing route is `manage` — see MANUAL_FIRE_RULE.');
  }
});

test('the matrix and the scanned families are the same set, exactly', () => {
  const inTable = new Set(WORK_PLANE_ROUTES.map(key));
  const inSource = new Set(ROUTES.map(key));
  assert.deepEqual([...inSource].sort(), [...inTable].sort());
});

test('context-mount is NOT swept into the work plane', () => {
  // The segment-boundary hazard: `context` is a prefix of `context-mount`,
  // which is a `:id`-keyed CONFIG-plane route with its own `canManageAgent`
  // gate. Sweeping it in here would be harmless today and wrong in principle —
  // and it is exactly the kind of claim that breaks on a regex tweak.
  assert.ok(API_SRC.includes("app.patch('/api/agents/:id/context-mount'"),
    'the context-mount route moved — this assertion needs re-pointing');
  for (const r of ROUTES) {
    assert.ok(!r.routePath.includes('context-mount'), `${key(r)} must not be scanned`);
  }
});

// ── Every manage-class route carries a gate; no other route does ────────────

test('AC1/AC4: every manage-class route carries a manage gate', () => {
  for (const r of manageRoutes()) {
    const scanned = ROUTES.find(s => key(s) === key(r));
    assert.ok(scanned, `${key(r)} not found in api.js`);
    assert.ok(gateOf(scanned) !== null,
      `${key(r)} is Team-Admin-only per §6 but carries neither `
      + `${MANAGE_GATES.middleware} nor ${MANAGE_GATES.inline}`);
  }
});

test('the gate split is counted, so drift in either direction fails', () => {
  // Counts rather than "at least one": a refactor that quietly moves a route
  // from the middleware to nothing, or adds an eleventh manage route without a
  // gate, would otherwise still satisfy a per-route existence check.
  const tally = { middleware: 0, inline: 0, none: 0 };
  for (const r of manageRoutes()) {
    const scanned = ROUTES.find(s => key(s) === key(r));
    tally[gateOf(scanned) || 'none'] += 1;
  }
  assert.deepEqual(tally, { middleware: 7, inline: 3, none: 0 },
    'expected the 7 workspace/context writes on requireAgentManage and the 3 '
    + 'trigger mutations on the pre-existing denyUnlessCanManageAgent');
});

test('AC2: no read-class route carries the manage gate', () => {
  // The other half of "reads stay allowed" — and the reason the gate is
  // per-route rather than an `app.use` mount: within `…/workspace/` the reads
  // and the writes share a prefix, so a mount could not tell them apart.
  for (const r of WORK_PLANE_ROUTES.filter(x => x.cls === MUTATION_CLASS.READ)) {
    const scanned = ROUTES.find(s => key(s) === key(r));
    assert.ok(scanned, `${key(r)} not found in api.js`);
    assert.equal(gateOf(scanned), null,
      `${key(r)} is "allowed" for a Team Member per §6 but carries a manage gate`);
  }
});

test('the two upload routes gate BEFORE multer buffers the body', () => {
  for (const p of ['/api/agents/:agentId/workspace/upload', '/api/agents/:agentId/context/upload']) {
    const scanned = ROUTES.find(s => s.routePath === p && s.method === 'post');
    assert.ok(scanned, `${p} not found`);
    const gateAt = scanned.registration.indexOf(MANAGE_GATES.middleware);
    const multerAt = scanned.registration.indexOf('uploadFiles');
    assert.ok(gateAt > 0, `${p} must carry ${MANAGE_GATES.middleware}`);
    assert.ok(multerAt > 0, `${p} must still parse multipart with uploadFiles`);
    assert.ok(gateAt < multerAt,
      `${p} must refuse before uploadFiles, or a caller who will be refused still `
      + 'costs up to 500×50 MB of buffered body');
  }
});

// ── The gate's own construction ─────────────────────────────────────────────

test('api.js builds the gate from the shared module and the real predicates', () => {
  assert.match(API_SRC, /const \{ createAgentManageGate \} = require\('\.\/team-member-boundary'\)/,
    'the gate must come from the shared module, not be restated in api.js');
  const build = API_SRC.slice(API_SRC.indexOf('const requireAgentManage = createAgentManageGate('));
  const ctor = stripComments(build.slice(0, build.indexOf('});') + 3));
  for (const dep of ['getScope', 'loadAgentMeta', 'isValidAgentId', 'visibleAgent', 'canManageAgent']) {
    assert.ok(ctor.includes(dep), `the gate must be wired with ${dep}`);
  }
  // The meta, not the raw config (see the raw-config test in the sibling file).
  assert.match(ctor, /agentMetaForScope\(cfg\)/,
    'loadAgentMeta must resolve the access boundary via agentMetaForScope, never hand over a raw config');
  assert.match(ctor, /cfg \?/, 'an unreadable config must fail closed as absent');
});

// ── The three grant routes AC1 names as "plugins" and "skills" ──────────────

test('AC1: skill and plugin grant routes are gated on management, not visibility', () => {
  // These were `visibleAgent`, which let any member of the owning team re-grant
  // its skills and plugins — the substance of AC1's "agent settings (prompt,
  // model, plugins, skills, …)" row beyond the work plane.
  const sites = [
    ['async function proxySkillActivation(', 'skill activation'],
    ['async function proxyPluginActivation(', 'plugin activation'],
    ["app.post('/api/skills/install'", 'skill install'],
  ];
  for (const [marker, label] of sites) {
    const start = API_SRC.indexOf(marker);
    assert.ok(start > 0, `${label}: marker not found — this guard needs re-pointing`);
    const end = API_SRC.indexOf('\napp.', API_SRC.indexOf('\n', start));
    const src = stripComments(API_SRC.slice(start, end === -1 ? start + 4000 : end));
    assert.match(src, /canManageAgent\(scope, agentMetaForScope\(cfg\)\)/,
      `${label} must gate on canManageAgent over the resolved meta`);
    assert.ok(!/if \(!visibleAgent\(scope, cfg\)\)/.test(src),
      `${label} must no longer gate on mere visibility`);
  }
});

// ── AC3's factual premise, and AC2's recorded consequence ──────────────────

test('AC3: api.js still registers no manual trigger-firing route', () => {
  // The rule in §6 is pre-emptive because the route does not exist. If that
  // ever stops being true, `source → table` above fails first — this assertion
  // is the plain-language statement of the same fact, so the reason is legible
  // at the point of failure.
  for (const r of ROUTES) {
    assert.ok(!/\/triggers\/:[A-Za-z]+\/(run|fire|run-now|execute|trigger)$/.test(r.routePath),
      `${key(r)} looks like a manual-fire route: it must be manage-class and gated (MANUAL_FIRE_RULE)`);
  }
});

test('AC2: the team ZIP export stays open to a Team Member, deliberately', () => {
  // §6's export row reads "Unchanged (deliberately)" — a member may take a
  // complete copy of the team definition, recorded as an accepted consequence
  // rather than discovered later. This asserts the decision, so silently
  // gating it later is a visible change and not a drive-by.
  const start = API_SRC.indexOf("app.get('/api/agents/:id/export'");
  assert.ok(start > 0, 'the export route moved — this assertion needs re-pointing');
  const src = stripComments(API_SRC.slice(start, API_SRC.indexOf('\napp.', start + 1)));
  assert.ok(!src.includes(MANAGE_GATES.middleware) && !src.includes(MANAGE_GATES.inline),
    'export is "allowed" for a Team Member per §6 — gating it is a decision change, not a fix');
});

// ── Prove the guard fires ───────────────────────────────────────────────────

test('the guard detects a missing gate and an unclassified route in a synthetic source', () => {
  // Without this, every assertion above could be silently vacuous: they have
  // only ever run against an api.js that satisfies them.

  // (1) A manage-class route that lost its gate.
  const ungated = scanRoutes(
    "app.delete('/api/agents/:agentId/workspace/file', apiLimiter, (req, res) => {\n"
    + "  res.json({});\n});\n",
  );
  assert.equal(ungated.length, 1);
  assert.equal(gateOf(ungated[0]), null, 'the scan must see that the gate is gone');

  // (2) A gate mentioned only in a COMMENT must not count.
  const commented = scanRoutes(
    "app.post('/api/agents/:agentId/workspace/move', apiLimiter /* requireAgentManage */, (req, res) => {\n"
    + "  // denyUnlessCanManageAgent(req, res, dir)\n  res.json({});\n});\n",
  );
  assert.equal(gateOf(commented[0]), null, 'a commented-out gate must not satisfy the guard');

  // (3) A brand-new route in a scanned family is unclassified, so the ratchet
  //     catches it — this is the manual-fire case arriving.
  const fresh = scanRoutes(
    "app.post('/api/agents/:id/triggers/:triggerId/run', apiLimiter, (req, res) => {\n"
    + "  res.json({});\n});\n",
  );
  assert.equal(fresh.length, 1);
  // It is caught by classification (as manage, pre-decided) and would then fail
  // the gate assertion, which is exactly the intended sequence.
  assert.equal(classifyWorkPlaneRoute(fresh[0].method, fresh[0].routePath), MUTATION_CLASS.MANAGE);
  assert.equal(gateOf(fresh[0]), null);

  // (4) A route in a scanned family with a name nobody has considered is NOT
  //     silently classified.
  const unknown = scanRoutes(
    "app.post('/api/agents/:agentId/workspace/chmod', apiLimiter, (req, res) => {\n"
    + "  res.json({});\n});\n",
  );
  assert.equal(classifyWorkPlaneRoute(unknown[0].method, unknown[0].routePath), null,
    'an unconsidered route must fail the ratchet, not receive a default');

  // (5) The upload-ordering assertion is falsifiable.
  const badOrder = scanRoutes(
    "app.post('/api/agents/:agentId/workspace/upload', heavyLimiter, uploadFiles, requireAgentManage, (req, res) => {\n"
    + "  res.json({});\n});\n",
  );
  const g = badOrder[0].registration.indexOf('requireAgentManage');
  const u = badOrder[0].registration.indexOf('uploadFiles');
  assert.ok(g > u, 'the synthetic source really does have the wrong order');
});
