'use strict';

// ─── pure decisions for the per-scope plugin credential routes (Jira §5) ─────
//
// The store + push live in the orchestrator (plugin-credential-store.js); these
// are the console-side gate + shaping decisions, unit-tested in isolation
// (admin-console/api tests). No I/O, no Express.
//
// Scope model: a `scopes: ["team"]` plugin's scopeId IS a team id, so the
// visibility/management gate is exactly `visibleTeam` / `canManageTeam` against
// that scopeId — no new privilege.

// Narrow the orchestrator's full granted-scope list to the ones this caller may
// SEE. `canSeeTeam(teamId)` is `visibleTeam(scope, teamId)` bound by the route.
function visibleScopes(scopes, canSeeTeam) {
  return (Array.isArray(scopes) ? scopes : []).filter((s) => s && canSeeTeam(s.scopeId));
}

// May this caller WRITE this scope's credential? `canManageTeamId(teamId)` is
// `canManageTeam(scope, teamId)` bound by the route. Returns { ok } or
// { ok:false, status, error } so the route just forwards it.
function assertCanWriteScope(scopeId, canManageTeamId) {
  if (!scopeId) return { ok: false, status: 400, error: 'a scope id is required' };
  if (!canManageTeamId(scopeId)) {
    return { ok: false, status: 403, error: 'Team Admin of this team is required to set its plugin credential' };
  }
  return { ok: true };
}

// A field-type hint for the console form, from the credential key. Anything that
// reads like a secret is a password field; everything else is plain text. The
// store never distinguishes — this is presentation only.
const SECRET_KEY_RE = /(token|secret|password|key|pat|apikey)/i;
function fieldType(key) {
  return SECRET_KEY_RE.test(String(key || '')) ? 'password' : 'text';
}

// A value preview (`ab…wxyz`) is enough to recognise a token, so it is not
// "metadata" for someone who cannot manage the scope. GET is visible to any
// team MEMBER of a granted team; only a Team Admin (canManage) sees the preview.
// `set` / `required` / `complete` / `setBy` stay — they say whether a credential
// exists and who configured it, not what it is.
function redactScopeForViewer(scope, canManage) {
  if (canManage || !scope || typeof scope !== 'object') return scope;
  const keys = scope.keys && typeof scope.keys === 'object' ? scope.keys : {};
  const redacted = {};
  for (const [k, meta] of Object.entries(keys)) {
    redacted[k] = meta && typeof meta === 'object' ? { ...meta, preview: null } : meta;
  }
  return { ...scope, keys: redacted };
}

// Shape the PUT body: only declared keys, string values, drop keys the caller
// did not send (a form submit sends every field, but an API caller may PATCH).
// The orchestrator re-validates; this keeps an obviously-malformed body from
// even being proxied.
function shapePutBody(body, declaredKeys) {
  const declared = new Set(Array.isArray(declaredKeys) ? declaredKeys : []);
  const values = {};
  const src = body && typeof body === 'object' && body.values && typeof body.values === 'object' ? body.values : {};
  for (const [k, v] of Object.entries(src)) {
    if (declared.has(k) && typeof v === 'string') values[k] = v;
  }
  return { values };
}

module.exports = { visibleScopes, assertCanWriteScope, redactScopeForViewer, fieldType, shapePutBody, SECRET_KEY_RE };
