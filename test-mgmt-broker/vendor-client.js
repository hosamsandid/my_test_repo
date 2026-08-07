'use strict';

// ─── test-mgmt broker: vendor client (plugin system Phase 5, #1521) ──────────
//
// The one place the vendor's API surface (Xray/Zephyr/qTest) and its credential
// are named. The broker holds the token; the agent never sees it — that
// containment is why test management is a plugin and not a skill (concept §8).
//
// The request-shaping and response-parsing are pure and dependency-free so they
// are unit-testable without a live vendor (buildRequest / parseRunState /
// TERMINAL_STATES); `call` is the thin async adapter that injects the
// credential from the broker's env and performs the HTTP request with the
// runtime `fetch`. Keeping the pure core separate mirrors compose-validate.js
// in plugin #1's broker.

// Terminal run states the broker recognises (the CLI's submit→poll agrees).
const TERMINAL_STATES = Object.freeze(['passed', 'failed', 'error', 'aborted', 'cancelled']);

// Build the vendor HTTP request for one broker operation. Returns
// `{ method, path, body? }` — the caller prefixes the vendor base URL and adds
// auth. `ownerScopeId` is stamped into created artifacts so the broker's scope
// filter (aee.plugin.owner) can list/operate only within a scope (§4.6): the
// vendor stores it as a label/field, and list/get queries filter on it.
function buildRequest(op, args = {}, ownerScopeId) {
  switch (op) {
    case 'test_case_create':
      return {
        method: 'POST',
        path: '/rest/api/testcase',
        body: {
          title: args.title,
          description: args.description || '',
          folder: args.folder || null,
          labels: [ownerLabel(ownerScopeId)],
        },
      };
    case 'test_run_submit':
      return {
        method: 'POST',
        path: '/rest/api/testrun',
        body: {
          plan: args.plan || null,
          suite: args.suite || null,
          labels: [ownerLabel(ownerScopeId)],
        },
      };
    case 'test_run_status':
      return { method: 'GET', path: `/rest/api/testrun/${encodeURIComponent(args.runId)}` };
    case 'test_data_list':
      return { method: 'GET', path: `/rest/api/testdata?label=${encodeURIComponent(ownerLabel(ownerScopeId))}` };
    case 'test_data_set':
      return {
        method: 'PUT',
        path: `/rest/api/testdata/${encodeURIComponent(args.key)}`,
        body: { value: args.value, labels: [ownerLabel(ownerScopeId)] },
      };
    case 'test_data_delete':
      return { method: 'DELETE', path: `/rest/api/testdata/${encodeURIComponent(args.key)}` };
    default:
      throw new Error(`unknown vendor operation: ${op}`);
  }
}

function ownerLabel(scopeId) {
  return `aee.plugin.owner=${scopeId}`;
}

// Extract a normalized run state from a vendor response body (best-effort).
function parseRunState(body) {
  const obj = typeof body === 'string' ? safeJson(body) : body;
  if (!obj || typeof obj !== 'object') return null;
  const state = obj.state || obj.status;
  return state ? String(state).toLowerCase() : null;
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Thin async adapter: perform the request against the vendor. The credential is
// read from the broker env here and NEVER returned to the caller. Uses the
// runtime global `fetch` (Node ≥18 / the sidecar image). Returns the parsed
// JSON body (or `{}` on empty). Throws on a non-2xx so the broker maps it to an
// MCP `isError`.
async function call(op, args, ownerScopeId, { baseUrl, token } = {}) {
  const base = baseUrl || process.env.TESTMGMT_API_URL || '';
  const cred = token || process.env.TESTMGMT_API_TOKEN || '';
  if (!base) throw new Error('TESTMGMT_API_URL is not configured');
  const spec = buildRequest(op, args, ownerScopeId);
  const headers = { 'Content-Type': 'application/json' };
  if (cred) headers.Authorization = `Bearer ${cred}`;
  const res = await fetch(base.replace(/\/+$/, '') + spec.path, {
    method: spec.method,
    headers,
    body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`vendor HTTP ${res.status}: ${text.slice(0, 300)}`);
  return safeJson(text) || {};
}

module.exports = { TERMINAL_STATES, buildRequest, ownerLabel, parseRunState, isTerminal, call };
