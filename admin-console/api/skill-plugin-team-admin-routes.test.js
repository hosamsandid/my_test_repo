'use strict';

// #2178 — move skill promote-to-global and plugin-apply to Team Admin.
//
// `skill-transfer.test.js` proves the relaxed PERMISSION DECISION (a Team
// Admin of a skill's own team may now promote it to global, same as the
// existing team→global cell). What that unit test cannot see is whether the
// two routes this ticket touches actually reach it — api.js boots two
// listeners on require and cannot be exercised directly (#651), so its source
// is read, the `draft-routes-access.test.js` / `work-plane-access.test.js`
// technique. Every one of these gates is invisible when it goes missing: a
// route that stops calling the predicate returns the right data to the caller
// who is allowed, and to everyone else too.
//
// Three routes, three different expectations:
//   - POST /api/skills/promote-to-global  — RELAXED to Team Admin OR System Admin
//   - POST /api/agents/:id/plugins/activate (and deactivate) — CONFIRMED already
//     Team-Admin-capable (canManageAgent), unchanged by this ticket
//   - POST /api/plugins/:id/install — CONFIRMED still System-Admin-only

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** The comments here quote the very ACs under test, so strip them first. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice one route's body out, so a match elsewhere in the multi-thousand-line
 *  file cannot stand in for the gate that is actually missing. */
function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

/** Slice one named function's body out (for the plugin-activation proxy,
 *  which both plugin routes delegate to rather than gating inline). */
function fn(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `function ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of function ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

/* ─── POST /api/skills/promote-to-global — relaxed to Team Admin ─────────── */

test('promote-to-global: reuses the shared skill-transfer permission model, not an inline System-Admin check', () => {
  const src = route("app.post('/api/skills/promote-to-global',");
  assert.match(src, /getScope\(req\)/, 'must resolve the caller scope');
  assert.match(
    src,
    /skillTransfer\.requiredPermission\(\s*\{\s*tier:\s*'team',\s*teamId\s*\}\s*,\s*\{\s*tier:\s*'global'\s*\}/,
    'must ask the shared engine for the team→global permission — the same cell POST /api/skills/transfer uses',
  );
  assert.match(src, /skillTransfer\.permitTransfer\(/, 'must check the plan through the shared permit checker');
  assert.doesNotMatch(
    src,
    /if\s*\(\s*!scope\.all\s*\)\s*return res\.status\(403\)/,
    'must not fall back to a bare System-Admin-only gate — that would re-lock the route this ticket opens',
  );
});

/* ─── Plugin apply/grant — confirmed already Team-Admin (no change) ──────── */

test('plugin activate/deactivate: gated on canManageAgent (Team-Admin-capable), not scope.all', () => {
  const src = fn('async function proxyPluginActivation(req, res, active)');
  assert.match(
    src,
    /canManageAgent\(scope, agentMetaForScope\(cfg\)\)/,
    'a Team Admin of the agent/team\'s tenant must be able to grant a plugin',
  );
  assert.doesNotMatch(
    src,
    /if\s*\(\s*!scope\.all\s*\)/,
    'granting a plugin must not require System Admin outright',
  );
});

test('the two plugin-grant routes both delegate to the Team-Admin-gated proxy', () => {
  assert.match(route("app.post('/api/agents/:id/plugins/activate',"), /proxyPluginActivation\(req, res, true\)/);
  assert.match(route("app.post('/api/agents/:id/plugins/deactivate',"), /proxyPluginActivation\(req, res, false\)/);
});

/* ─── Plugin install — confirmed still System-Admin-only ─────────────────── */

test('plugin install stays System-Admin-only: raw broker/socket privilege, never Team-Admin', () => {
  const src = route("app.post('/api/plugins/:id/install',");
  assert.match(
    src,
    /if\s*\(\s*!getScope\(req\)\.all\s*\)\s*return res\.status\(403\)/,
    'installing a plugin (the sidecar/broker privilege grant) must remain System-Admin-only',
  );
});
