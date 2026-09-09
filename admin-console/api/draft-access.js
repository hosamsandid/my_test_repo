'use strict';

// Process-draft access model (#2068) — implements and refines #2041 AC4 for the
// one object that exists *before* an Agent Team does.
//
// The shape of the rule, and why it is this shape:
//
//   DD1  Sharing targets individual named users. There is no group resolution
//        step, so this ships independently of #2041 P1's membership re-keying.
//   DD2  Everyone with access is fully equal — open, edit, rename, export,
//        create a team, share on, remove others, delete. That removes the owner
//        as an *authorization* concept entirely: `createdBy` is immutable
//        provenance for display, and NEVER an input to a decision. Every
//        function below that decides something takes `accessUserIds` and the
//        caller, and nothing else; the sibling guard test (AC2) reads this
//        file and the routes back and fails if `createdBy` ever reaches a
//        conditional, so the asymmetry cannot creep back in later.
//   DD7  A System Admin sees everything (`scope.all`), i.e. drafts follow the
//        `visibleAgent` pattern in scope.js, NOT the personal-credential tier
//        (`ownsPersonalCredential`, deliberately checked *before* `scope.all`
//        so not even an admin sees those). Both precedents live in one file, so
//        the choice is made here explicitly rather than inherited by accident.
//
// Pure (no IO, no express) so it is the unit-test surface for logic that would
// otherwise be unreachable inside api.js (#651).

/** Storage metadata, never part of the portable bundle — the same rule the
 *  Copilot history already follows. Export/Import must not be a way to grant
 *  yourself access, or to grant access to someone who never asked for it. */
const ACCESS_FIELDS = ['createdBy', 'accessUserIds'];

/** AC7 — a draft the caller may not reach must be indistinguishable from one
 *  that does not exist, so both refusals are this single response. */
const NOT_FOUND = Object.freeze({ ok: false, status: 404, error: 'Draft not found' });

/** AC9 — the access set can never be emptied. Names *Delete draft* as the
 *  intended action, because without that the only remaining reader is a
 *  System Admin and the user has no way back. */
const LAST_HOLDER_ERROR =
  'You are the only person with access to this draft, so you cannot remove yourself. '
  + 'Use "Delete draft" if you want it gone.';

function uniqueIds(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The access metadata of a stored record, in a shape every caller can rely on.
 *  A record written before this ticket (or dropped on disk by hand) has neither
 *  field: it normalizes to an EMPTY access set, i.e. fail-closed — reachable by
 *  a System Admin only. The startup migration (AC15) is what keeps that from
 *  happening to the drafts that exist on upgrade day. */
function normalizeAccess(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const createdBy = typeof d.createdBy === 'string' && d.createdBy.trim() ? d.createdBy.trim() : null;
  return { createdBy, accessUserIds: uniqueIds(d.accessUserIds) };
}

/** THE predicate (AC3). Written once, called from every route.
 *  Deliberately does not look at `createdBy` (DD2/AC2). */
function canAccessDraft(scope, draft) {
  if (!scope) return false;
  if (scope.all) return true;                    // DD7
  if (!scope.userId) return false;               // ownerless caller → fail closed
  return normalizeAccess(draft).accessUserIds.includes(scope.userId);
}

/** Gate for the by-id routes. Returns the record on success and the AC7
 *  indistinguishable-404 on both "absent" and "not yours". */
function authorizeDraft(scope, draft) {
  if (!draft) return NOT_FOUND;
  if (!canAccessDraft(scope, draft)) return NOT_FOUND;
  return { ok: true, status: 200, draft };
}

/** AC6 — the list filter, same predicate. */
function filterVisibleDrafts(scope, drafts) {
  return (Array.isArray(drafts) ? drafts : []).filter(d => canAccessDraft(scope, d));
}

/** AC1 — the stamp for every draft-creating entry point. `createdBy` is
 *  resolved from the authenticated caller and never from the request body.
 *
 *  The env single-admin login has no user record (`scope.userId === null`,
 *  scope.js:29-31 — the hole #2041 D13/#2059 removes). Refusing the create
 *  would break the unattended e2e bring-up, so it falls back to an ownerless
 *  draft: nobody is in the access set, and it stays reachable through the
 *  `scope.all` path that same caller already has. */
function newDraftAccess(scope) {
  const userId = scope && scope.userId ? scope.userId : null;
  return { createdBy: userId, accessUserIds: userId ? [userId] : [] };
}

/** AC4 — strip the access fields from anything that came in over the wire.
 *  `PUT /api/process/drafts/:id` spreads the whole request body onto the record
 *  and `validateProcessTemplate` is not a whitelist, so without this the
 *  ordinary save route is a way to widen access. Also used on the import/create
 *  paths, so an exported-and-re-imported bundle cannot carry a foreign access
 *  set in. */
function stripAccessFields(body) {
  const out = { ...(body && typeof body === 'object' ? body : {}) };
  for (const f of ACCESS_FIELDS) delete out[f];
  return out;
}

/** AC4/AC5 — carry the stored access forward on every write, the way
 *  `createdAt` already is. This is also what makes sharing survive a rename
 *  (the rename path rewrites the record under a new id). */
function carryAccessFields(existing) {
  const { createdBy, accessUserIds } = normalizeAccess(existing);
  return { createdBy, accessUserIds };
}

/** Add a user to the access set (DD2 — available to everyone already in it).
 *  Idempotent: re-adding someone already there succeeds and changes nothing. */
function addAccess(draft, userId) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id) return { ok: false, status: 400, error: 'A user id is required' };
  const { accessUserIds } = normalizeAccess(draft);
  if (accessUserIds.includes(id)) return { ok: true, status: 200, accessUserIds, changed: false };
  return { ok: true, status: 200, accessUserIds: [...accessUserIds, id], changed: true };
}

/** Remove a user from the access set (DD2 — anyone in the set may remove
 *  anyone, including themselves and including the creator).
 *
 *  AC9: the set can never be emptied. The invariant is on the SET, not on
 *  "self", because an emptied set is equally unreachable however it got that
 *  way. A user who is not the last may remove themselves — that is how leaving
 *  a shared draft works, and it needs no separate affordance. */
function removeAccess(draft, userId) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id) return { ok: false, status: 400, error: 'A user id is required' };
  const { accessUserIds } = normalizeAccess(draft);
  if (!accessUserIds.includes(id)) return { ok: true, status: 200, accessUserIds, changed: false };
  const next = accessUserIds.filter(u => u !== id);
  if (next.length === 0) {
    return { ok: false, status: 409, error: LAST_HOLDER_ERROR, code: 'last_holder' };
  }
  return { ok: true, status: 200, accessUserIds: next, changed: true };
}

/** DD3 — deleting a user record strips them from every draft's access set.
 *  Unlike removeAccess this MAY empty the set (DD3a): the draft is retained and
 *  stays reachable by a System Admin, because silently destroying a document
 *  during a user deletion is not recoverable. `createdBy` is left pointing at
 *  the departed user as history. */
function stripUserFromDraft(draft, userId) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  const { accessUserIds } = normalizeAccess(draft);
  if (!id || !accessUserIds.includes(id)) return { changed: false, accessUserIds };
  return { changed: true, accessUserIds: accessUserIds.filter(u => u !== id) };
}

/** AC15 — a draft that predates this ticket carries no access set at all. It
 *  gets `createdBy` = the first System Admin and an access set of ALL current
 *  users (DD4), which is the literal reading of #2041 D6: today's access is
 *  preserved exactly and nobody loses anything on upgrade day. The original
 *  creators are unrecoverable because nothing was ever recorded.
 *
 *  Presence of an `accessUserIds` array is what marks a record as already
 *  stamped, so re-running the migration is a no-op. */
function needsAccessMigration(draft) {
  return !!draft && typeof draft === 'object' && !Array.isArray(draft.accessUserIds);
}

function migrateDraftAccess(draft, { systemAdminId = null, allUserIds = [] } = {}) {
  if (!needsAccessMigration(draft)) return { changed: false, draft };
  return {
    changed: true,
    draft: {
      ...draft,
      createdBy: typeof systemAdminId === 'string' && systemAdminId.trim() ? systemAdminId.trim() : null,
      accessUserIds: uniqueIds(allUserIds),
    },
  };
}

/** DD4 — "the first System Admin". Ordered by `createdAt`, falling back to the
 *  index order for records that predate the timestamp. Returns null when the
 *  installation has no System-Admin user record (env single-admin only), which
 *  leaves `createdBy` null — honest history rather than an invented one. */
function firstSystemAdminId(users) {
  const admins = (Array.isArray(users) ? users : []).filter(u => u && u.systemAdmin === true && u.id);
  if (admins.length === 0) return null;
  const sorted = [...admins].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return sorted[0].id;
}

/** AC16 — what the Flows list needs to distinguish a private draft from a
 *  shared one and to name the person who created a draft the viewer did not.
 *  No user id is returned: the list has no use for one and cannot render it.
 *  A `createdBy` pointing at a deleted user degrades to a readable label rather
 *  than a raw id (edge case), and a `createdBy` of null (an ownerless env-admin
 *  draft) simply says nothing. */
function draftAccessView(draft, { viewerId = null, usersById = new Map() } = {}) {
  const { createdBy, accessUserIds } = normalizeAccess(draft);
  const known = createdBy ? usersById.get(createdBy) : null;
  return {
    shared: accessUserIds.length > 1,
    accessCount: accessUserIds.length,
    createdByYou: !!(viewerId && createdBy && createdBy === viewerId),
    createdByName: createdBy ? ((known && known.displayName) || 'Deleted user') : null,
  };
}

/** D2/D11 — the Share picker's projection. Display name and email only: never
 *  the `systemAdmin` flag, never the GitHub handle, never the subject or the
 *  password state. Sorted by display name so the picker is stable. */
function userDirectoryEntry(user) {
  return {
    id: user.id,
    displayName: typeof user.displayName === 'string' && user.displayName ? user.displayName : (user.subject || user.id),
    email: typeof user.email === 'string' ? user.email : '',
  };
}

function userDirectory(users) {
  return (Array.isArray(users) ? users : [])
    .filter(u => u && u.id)
    .map(userDirectoryEntry)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The resolved access set for the Share dialog — same projection as the
 *  picker, so the dialog never learns anything about a colleague that the
 *  directory would not have told it. An id with no user record is kept (it is
 *  still holding access) but labelled, rather than silently dropped. */
function resolveAccessList(draft, usersById) {
  const { accessUserIds } = normalizeAccess(draft);
  return accessUserIds.map((id) => {
    const u = usersById && usersById.get ? usersById.get(id) : null;
    return u ? userDirectoryEntry(u) : { id, displayName: 'Deleted user', email: '' };
  });
}

module.exports = {
  ACCESS_FIELDS,
  NOT_FOUND,
  LAST_HOLDER_ERROR,
  normalizeAccess,
  canAccessDraft,
  authorizeDraft,
  filterVisibleDrafts,
  newDraftAccess,
  stripAccessFields,
  carryAccessFields,
  addAccess,
  removeAccess,
  stripUserFromDraft,
  needsAccessMigration,
  migrateDraftAccess,
  firstSystemAdminId,
  draftAccessView,
  userDirectory,
  userDirectoryEntry,
  resolveAccessList,
};
