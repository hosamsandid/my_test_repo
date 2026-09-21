'use strict';

// One-time migration of legacy secret-bearing records onto the unified resource
// access model (concept §11, decisions §12.5/§12.8/§12.9; epic #2361 PR6 #2359).
//
// The redesign removes the `system` + `assignedTeamIds` axis and stamps every
// record with an immutable `identity` ∈ {human, service}. Records written before
// PR1–PR3 carry neither. This module is the PURE classifier: it decides which
// records still need a home, AUTO-SUGGESTS an identity + tier for each, and — on
// apply — writes the admin's confirmed decision. It NEVER changes a record on its
// own: the dry-run report is read-only, and nothing moves until a System Admin
// POSTs a per-record decision (decision §12.8). The route layer (api.js) supplies
// the store reads/writes and the flag/System-Admin gate.
//
// Read-compatibility is unchanged: an un-migrated legacy record keeps resolving
// through `normalizeTier` / `credentialVisibleToTeam` exactly as today, so this
// migration is never a hard cutover — it only tidies records off the removed axis
// at the operator's pace.

const IDENTITY_HUMAN = 'human';
const IDENTITY_SERVICE = 'service';
const KINDS = Object.freeze(['provider', 'ssh-key', 'github-token']);

// ── Identity inference (matches the PR2/PR3 create-time stamps) ──────────────
//
// provider: a subscription seat (oauth) acts as one person → human; an api-key
//           gateway is infrastructure → service (§5).
// ssh-key / github-token: a `personal` credential is one person's identity →
//           human; a team/system credential is a shared machine/deploy identity
//           → service (§5). Correctable by the admin in review (§11).
function inferIdentity(kind, record) {
  if (!record || typeof record !== 'object') return IDENTITY_SERVICE;
  if (kind === 'provider') {
    return record.authType === 'oauth-token' ? IDENTITY_HUMAN : IDENTITY_SERVICE;
  }
  return record.scope === 'personal' ? IDENTITY_HUMAN : IDENTITY_SERVICE;
}

// A record still needs migration when it carries no explicit `identity`, OR it
// sits on the removed `system` + assignedTeamIds axis (a non-global system
// record). A record already stamped AND on a new-model tier (personal / team /
// global) is done — it never appears in the report and cannot be re-classified.
function needsMigration(record) {
  if (!record || typeof record !== 'object') return false;
  const onRemovedAxis = record.scope === 'system' && record.global !== true;
  const unstamped = record.identity !== IDENTITY_HUMAN && record.identity !== IDENTITY_SERVICE;
  return !!(onRemovedAxis || unstamped);
}

// Suggest the identity + tier for one legacy record. Pure; returns a suggestion
// the admin confirms, edits, or overrides with `delete`. `flags` surface the
// cases that genuinely need a human eye.
//
// Tier logic (§11):
//   • global: true (provider)         → Global (service). Already reachable by
//                                        all; just formalise it.
//   • scope 'personal'                → Personal (keep the owner). Identity is
//                                        inferred per kind (a personal api-key
//                                        provider is still `service`).
//   • scope 'team'                    → Team (service), keep the teamId.
//   • scope 'system', 1 assigned team → Team (service) of that team.
//   • scope 'system', >1 assigned     → Global candidate (flagged, §12.9) — never
//                                        auto-split into per-team duplicates.
//   • scope 'system', 0 assigned      → orphan; Global candidate, flagged (an
//                                        admin confirms or deletes).
function suggestMigration(kind, record) {
  const identity = (record.identity === IDENTITY_HUMAN || record.identity === IDENTITY_SERVICE)
    ? record.identity
    : inferIdentity(kind, record);
  const flags = [];
  let suggested;

  if (record.global === true && record.scope === 'system') {
    suggested = { identity, scope: 'global' };
  } else if (record.scope === 'personal') {
    suggested = { identity, scope: 'personal', userId: record.userId || null };
    if (!record.userId) flags.push('needs-owner');
  } else if (record.scope === 'team') {
    suggested = { identity, scope: 'team', teamId: record.teamId || null };
    if (!record.teamId) flags.push('needs-team');
  } else if (record.scope === 'system') {
    const assigned = Array.isArray(record.assignedTeamIds) ? [...new Set(record.assignedTeamIds.map(String))] : [];
    if (assigned.length === 1) {
      suggested = { identity, scope: 'team', teamId: assigned[0] };
    } else {
      // 0 or >1 assigned teams → a Global candidate (§12.9): never auto-split.
      suggested = { identity, scope: 'global' };
      flags.push('global-candidate');
      if (assigned.length === 0) flags.push('orphan');
    }
  } else {
    // No/unknown scope (a pre-#798 record) → treat as team-service of its stamped
    // team, else a Global candidate for the admin to place.
    if (record.teamId) suggested = { identity, scope: 'team', teamId: String(record.teamId) };
    else { suggested = { identity, scope: 'global' }; flags.push('global-candidate'); }
  }

  // A `human` secret can never be shared (§4 core invariant). If inference lands
  // human on a team/global suggestion, that is a conflict only a human can
  // resolve (e.g. an oauth provider that was system-assigned): flag it and fall
  // back to Personal-needs-owner so the report never proposes an illegal combo.
  if (identity === IDENTITY_HUMAN && (suggested.scope === 'team' || suggested.scope === 'global')) {
    // A subscription (oauth) provider MAY be global via the single-user escape
    // hatch — leave that to the admin, but flag it; every other human secret is
    // downgraded to a personal suggestion.
    flags.push('identity-tier-conflict');
    if (!(kind === 'provider' && record.authType === 'oauth-token' && suggested.scope === 'global')) {
      suggested = { identity, scope: 'personal', userId: record.userId || null };
      if (!record.userId) flags.push('needs-owner');
    }
  }

  return {
    id: record.id,
    kind,
    name: record.name || record.id,
    current: {
      scope: record.scope || null,
      teamId: record.teamId || null,
      assignedTeamIds: Array.isArray(record.assignedTeamIds) ? record.assignedTeamIds : [],
      global: record.global === true,
      identity: (record.identity === IDENTITY_HUMAN || record.identity === IDENTITY_SERVICE) ? record.identity : null,
      ...(kind === 'provider' ? { authType: record.authType || 'api-key' } : {}),
    },
    suggested,
    flags,
  };
}

// The dry-run report over all three stores: every record that still needs a home,
// with its suggestion. Read-only — nothing is written (AC: no reach/visibility
// change without an apply).
function planResourceMigration({ providers = [], sshKeys = [], githubTokens = [] } = {}) {
  const records = [];
  const scan = (list, kind) => {
    for (const r of Array.isArray(list) ? list : []) {
      if (r && r.id && needsMigration(r)) records.push(suggestMigration(kind, r));
    }
  };
  scan(providers, 'provider');
  scan(sshKeys, 'ssh-key');
  scan(githubTokens, 'github-token');
  const summary = {
    total: records.length,
    byKind: {
      provider: records.filter(r => r.kind === 'provider').length,
      'ssh-key': records.filter(r => r.kind === 'ssh-key').length,
      'github-token': records.filter(r => r.kind === 'github-token').length,
    },
    globalCandidates: records.filter(r => r.flags.includes('global-candidate')).length,
    conflicts: records.filter(r => r.flags.includes('identity-tier-conflict')).length,
  };
  return { records, summary };
}

// Apply one admin-confirmed decision to a record. Returns { record, deleted }.
// PURE — the route saves the store. Enforces the two hard rules:
//   • `identity` is IMMUTABLE once set (§12.5): a decision that would change an
//     already-stamped identity is refused (correct via delete + recreate).
//   • the result must be an ALLOWED identity×tier combo (§4): a `human` secret
//     may only be personal, or — for an oauth provider — global via the hatch.
// Throws a tagged Error (`{ status: 400 }`) the route relays.
function applyMigrationDecision(kind, record, decision) {
  if (!record || typeof record !== 'object') throw tagged('record not found', 400);
  if (!decision || typeof decision !== 'object') throw tagged('a decision is required', 400);
  if (decision.delete === true) return { record: null, deleted: true };

  const identity = decision.identity;
  if (identity !== IDENTITY_HUMAN && identity !== IDENTITY_SERVICE) {
    throw tagged(`identity must be '${IDENTITY_HUMAN}' or '${IDENTITY_SERVICE}'`, 400);
  }
  const stamped = record.identity === IDENTITY_HUMAN || record.identity === IDENTITY_SERVICE;
  if (stamped && record.identity !== identity) {
    throw tagged('identity is immutable once set — delete and recreate the resource to reclassify it', 400);
  }

  const scope = decision.scope;
  const next = { ...record, identity };

  if (scope === 'personal') {
    if (!decision.userId) throw tagged('a personal resource needs an owner (userId)', 400);
    Object.assign(next, { scope: 'personal', userId: String(decision.userId), teamId: null, assignedTeamIds: [] });
    delete next.global;
  } else if (scope === 'team') {
    if (identity === IDENTITY_HUMAN) throw tagged('a human-identity secret cannot be a team credential (§4)', 400);
    if (!decision.teamId) throw tagged('a team resource needs a teamId', 400);
    Object.assign(next, { scope: 'team', teamId: String(decision.teamId), assignedTeamIds: [] });
    delete next.global;
  } else if (scope === 'global') {
    const oauthProvider = kind === 'provider' && record.authType === 'oauth-token';
    if (identity === IDENTITY_HUMAN && !oauthProvider) {
      throw tagged('a human-identity secret cannot be global (§4); only a single-user subscription may, via the escape hatch', 400);
    }
    Object.assign(next, { scope: 'system', global: true, teamId: null, assignedTeamIds: [] });
  } else {
    throw tagged(`scope must be 'personal', 'team' or 'global'`, 400);
  }
  return { record: next, deleted: false };
}

function tagged(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  IDENTITY_HUMAN,
  IDENTITY_SERVICE,
  KINDS,
  inferIdentity,
  needsMigration,
  suggestMigration,
  planResourceMigration,
  applyMigrationDecision,
};
