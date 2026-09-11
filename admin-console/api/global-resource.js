'use strict';

// Pure gate for publishing a Working Environment or an MCP server as GLOBAL
// (#2158) — reachable by every user and every agent with NO entry in
// `assignedTeamIds` at all. Mirrors the shape and rationale of
// `llm-endpoint-global.js` (#2136 — global model providers): the #2158
// analysis found that `assignedTeamIds` was never the reach boundary (it
// bounds discoverability — see `api.js` `providerVisible`-style call sites for
// the write/spawn paths that already accept any id) so making a record global
// is purely an ADDITIVE widening of who may FIND and USE a system-tier
// record; authority to publish/retract/edit/delete stays exactly where
// #2083 already put it (System-Admin-only via `canManageEnvironment` /
// `canRetierEnvironment`).
//
// ONE module for both kinds (not two copies): an environment and an MCP
// server are the same kind of thing under D12 (a stanza of configuration),
// and #2158 deliberately does not add a third floor beneath `resource-tier.js`
// for them — see the comment there.
//
// DELIBERATELY NOT in `resource-tier.js` / `resolveTieredOwnership` /
// `resolveCredentialOwnership` / the generic `scope.js` credential predicates
// (AC4). Those also shape SSH keys and GitHub tokens, where a `global` key
// must stay inert (#2136 finding 2 applies here identically). Composed only
// at the environment- and MCP-server call sites in `api.js`:
// `visibleEnvironment`/`GET /api/environments`, `GET /api/environments/:id`,
// the sync-agents and repo-divergence preconditions, `GET /api/mcp-servers`
// and `GET /api/mcp-servers/:id`.
//
// Inputs:
//   wantGlobal    — request intent: `true`/`false`, or undefined/null when the
//                   body does not mention `global` (→ keep the current value,
//                   the #2136 "an ordinary save must not drop it" rule, AC6).
//   currentGlobal — the record's present flag (false on create).
//   scopeAll      — `scope.all` (a full-visibility System Admin).
//
// Returns { global } with the resolved flag to persist, or
// { error, status, code } to refuse.
function resolveGlobalFlag({ wantGlobal, currentGlobal = false, scopeAll } = {}) {
  const cur = currentGlobal === true;
  // Body did not mention `global` → keep whatever the record already carries.
  if (wantGlobal === undefined || wantGlobal === null) {
    return { global: cur };
  }
  // Only a literal boolean `true` publishes; anything else reads as "not
  // global" so a stray value can never silently open a record to every team.
  const want = wantGlobal === true;
  if (want === cur) return { global: cur };
  if (!scopeAll) {
    return {
      error: 'Only a System Admin may publish or retract a global record',
      status: 403,
      code: 'global-system-admin-only',
    };
  }
  return { global: want };
}

// Is `entry` (a Working Environment or an MCP server) GLOBAL right now —
// reachable by every user and every agent with no team assignment (#2158)?
// Re-reads BOTH preconditions on every call rather than trusting the stored
// flag alone: a hand-edited or stale `{scope: 'team', global: true}` record
// is NOT global (AC5) — the predicate answers on the record, never on a
// route invariant.
function isGlobalEnvironment(entry) {
  return !!(entry && entry.global === true && entry.scope === 'system');
}

module.exports = { resolveGlobalFlag, isGlobalEnvironment };
