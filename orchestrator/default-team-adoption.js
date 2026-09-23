'use strict';

// ============================================================
// Default Team adoption (#1457, epic #2076 P0)
// ============================================================
//
// When a single-user stack activates multi-user mode, the **Default Team** has
// to adopt everything that was created before ownership existed — otherwise a
// resource with no `teamId` is invisible to every non-admin caller. The stamp
// itself has been running since #299 (`backfillResourceOwnership` in
// orchestrator.js); what lives here are the *decisions* that pass makes, so
// they can be unit-tested. `bootstrapTeams`/`backfillResourceOwnership` are not
// exported from that 14k-line module and therefore cannot be reached by a test
// — the `initial-admin-seed.js` discipline.
//
// The one decision here, easy to get subtly wrong:
//
//   WHICH records still need the stamp. The predicate is `teamId === undefined`
//   and not a falsy check, because `teamId: null` is a *deliberate* value: the
//   personal credential tier (#1567) carries `teamId: null` + a `userId` and is
//   not team-owned at all. Stamping those would hand every System Admin a view
//   of credentials the personal tier exists to keep private.
//
// A second decision used to live here — whether the bootstrap admin still needed
// a Default-Team `team-admin` membership (#1457). It is RETIRED: a System Admin
// is a global flag with `scope.all`, not a membership (decentralised-access
// -concept.md 2.1/2.2), and seeding that membership fed the D6 fan-out that
// re-enrolled admins into every team on each boot. `planBootstrapMembership`
// and its boot caller are gone.

const DEFAULT_TEAM_ID = 'default';

// Does this record predate the ownership model? `undefined` only — see note 1.
// An array is rejected explicitly: it is an object whose `teamId` is `undefined`,
// so a bare `typeof` check would "adopt" it by setting a property on an array.
function needsAdoption(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  return record.teamId === undefined;
}

// Which of these records still need the default-team stamp?
//
// `entries` is `[{ key, record }]` — `key` being whatever the caller needs to
// write the record back (an index position, an MCP server id, a file path). The
// same shape serves the credential indexes and the per-directory MCP server
// registry, so the two cannot drift in what counts as unowned. Returns the
// subset that needs stamping, in input order; a malformed entry is skipped
// rather than throwing, since this runs on every boot over operator-edited JSON.
function planAdoption(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(e => e && needsAdoption(e.record));
}

// Count only what actually changed. The pre-#1457 pass added `list.length` to
// its total whenever *any* entry in an index changed, so the "adopted N
// resources" line — the operator's only evidence that the migration ran —
// over-reported an index with one unowned entry among fifty owned ones.
function adoptionCount(entries = []) {
  return planAdoption(entries).length;
}

module.exports = {
  DEFAULT_TEAM_ID,
  needsAdoption,
  planAdoption,
  adoptionCount,
};
