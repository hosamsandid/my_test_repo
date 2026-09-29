'use strict';

const { isServiceIdentity } = require('./resource-tier');

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

// Is `entry` (an SSH key or a GitHub token) a GLOBAL SERVICE credential —
// reachable as a shared secret by every team (unified resource access model
// §4 / §12.3, epic #2361 PR4 #2357)? Deliberately STRICTER than
// isGlobalEnvironment: a credential additionally must be a `service` identity.
// A `human` secret (a personal PAT, a user SSH key) acts as one specific person
// and is Personal-only — an "acts-as-me for everyone" secret is nonsensical and
// dangerous, so it can never be globally reachable (the model's core invariant,
// resource-tier.js `isAllowedTierCombo`). An UNCLASSIFIED legacy record
// (`identity: null`, never yet migrated) is likewise NOT global here — a secret
// only widens to every team once the migration has affirmatively stamped it
// `service`, never by default. Re-reads all three preconditions on every call
// (a hand-edited or stale `{scope:'team', global:true}` or a since-reclassified
// record is not global), exactly like isGlobalProvider / isGlobalEnvironment.
//
// Composed ONLY at the SSH/GitHub call sites (this widens the reach of a
// SECRET) — NEVER inside
// scope.js's generic `visibleCredential` / `credentialVisibleToTeam`, which also
// gate the personal/team tiers where a stray `global: true` must stay inert
// (#2136 finding 2 applies here identically). Providers have their own
// reachability predicate (`isGlobalProvider`, with the oauth escape hatch); this
// is the SSH-key / GitHub-token analog, with no such hatch.
function isGlobalCredential(entry) {
  return !!(entry && entry.global === true && entry.scope === 'system' && isServiceIdentity(entry));
}

module.exports = { resolveGlobalFlag, isGlobalEnvironment, isGlobalCredential };
