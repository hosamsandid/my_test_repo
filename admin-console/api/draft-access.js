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
//   DD8  (#2870) A draft may additionally be "Visible to everyone": every
//        authenticated platform user — including users created later — may
//        READ it (open, export, create a team, duplicate), but not write it.
//        The flag is NOT an access holder: it never counts toward the
//        never-empty rule (AC9 of #2068) and never grants edit, rename,
//        delete or share. Without that split the DD2 "full equals" rule would
//        let any platform user delete the draft. So there are two predicates:
//        `canAccessDraft` (holder, full rights) and `canViewDraft` (read).
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
const ACCESS_FIELDS = ['createdBy', 'accessUserIds', 'visibleToEveryone'];

/** Response-only annotations the read route adds for the editor (#2870). Never
 *  stored: stripped from every incoming body alongside ACCESS_FIELDS so a
 *  client that writes back the bundle it read cannot persist them. */
const VIEW_FIELDS = ['viewerCanEdit'];

/** AC7 — a draft the caller may not reach must be indistinguishable from one
 *  that does not exist, so both refusals are this single response. */
const NOT_FOUND = Object.freeze({ ok: false, status: 404, error: 'Draft not found' });

/** AC9 — the access set can never be emptied. Names *Delete draft* as the
 *  intended action, because without that the only remaining reader is a
 *  System Admin and the user has no way back. */
/** #2870 AC10/AC11 — a reader who reaches the draft only through "Visible to
 *  everyone" tried to write it. They already know the draft exists, so this is
 *  an honest 403 rather than the AC7 404. */
const READ_ONLY = Object.freeze({
  ok: false, status: 403, code: 'read_only',
  error: 'This draft is visible to everyone, but only the people it is shared with can change it. '
    + 'Use "Duplicate to my drafts" to make your own copy.',
});

/** Upper bound on one bulk share — far above any real directory, low enough
 *  that a single request cannot be used to write an unbounded array. */
const MAX_BULK_SHARE = 1000;

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

/** #2870 — is the "Visible to everyone" flag set? Strictly `true`: anything
 *  else (absent, "yes", 1) is off, so a malformed record fails closed. */
function isVisibleToEveryone(draft) {
  return !!draft && typeof draft === 'object' && draft.visibleToEveryone === true;
}

/** #2870 AC9 — the READ predicate: a holder, or any authenticated user while
 *  the draft is visible to everyone. Resolved per request against the flag, so
 *  a user created after the switch was turned on is included without any
 *  write. An ownerless non-admin caller still fails closed. */
function canViewDraft(scope, draft) {
  if (canAccessDraft(scope, draft)) return true;
  return !!(scope && scope.userId) && isVisibleToEveryone(draft);
}

/** Gate for the WRITE by-id routes (save, delete, share, unshare, visibility,
 *  and reading the access list). Returns the record on success and the AC7
 *  indistinguishable-404 on both "absent" and "not yours". A global-only
 *  reader gets READ_ONLY instead (#2870 AC11). */
function authorizeDraft(scope, draft) {
  if (!draft) return NOT_FOUND;
  if (canAccessDraft(scope, draft)) return { ok: true, status: 200, draft };
  if (canViewDraft(scope, draft)) return READ_ONLY;
  return NOT_FOUND;
}

/** Gate for the READ by-id route (#2870). `canEdit` tells the editor whether to
 *  open read-only; the write routes enforce it independently. */
function authorizeDraftRead(scope, draft) {
  if (!draft || !canViewDraft(scope, draft)) return NOT_FOUND;
  return { ok: true, status: 200, draft, canEdit: canAccessDraft(scope, draft) };
}

/** AC6 — the list filter, same read predicate as the by-id read gate. */
function filterVisibleDrafts(scope, drafts) {
  return (Array.isArray(drafts) ? drafts : []).filter(d => canViewDraft(scope, d));
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
  for (const f of [...ACCESS_FIELDS, ...VIEW_FIELDS]) delete out[f];
  return out;
}

/** AC4/AC5 — carry the stored access forward on every write, the way
 *  `createdAt` already is. This is also what makes sharing survive a rename
 *  (the rename path rewrites the record under a new id). */
function carryAccessFields(existing) {
  const { createdBy, accessUserIds } = normalizeAccess(existing);
  // #2870 AC15 — the visibility flag is carried the same way; only a set flag
  // is written, so a draft that never had it stays byte-identical.
  return isVisibleToEveryone(existing)
    ? { createdBy, accessUserIds, visibleToEveryone: true }
    : { createdBy, accessUserIds };
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

/** #2870 AC5/AC6 — add several users in one step, all-or-nothing.
 *
 *  Every id is checked against `knownUserIds` (D3 — existing accounts only)
 *  BEFORE anything is decided: a single unknown id (e.g. a user deleted while
 *  the picker was open) refuses the whole request, so the caller never writes
 *  a partial set and never reports a partial result as success. Ids already in
 *  the set are skipped without error. */
function addAccessMany(draft, userIds, { knownUserIds = new Set() } = {}) {
  const ids = uniqueIds(userIds);
  if (ids.length === 0) return { ok: false, status: 400, error: 'Select at least one colleague to share with' };
  if (ids.length > MAX_BULK_SHARE) {
    return { ok: false, status: 400, error: `You can share with at most ${MAX_BULK_SHARE} people at once` };
  }
  const known = knownUserIds instanceof Set ? knownUserIds : new Set(knownUserIds || []);
  const unknown = ids.filter(id => !known.has(id));
  if (unknown.length > 0) {
    const n = unknown.length;
    return {
      ok: false, status: 400, code: 'unknown_user', unknownCount: n,
      error: `${n === 1 ? '1 selected person no longer has' : `${n} selected people no longer have`} an account. `
        + 'Nothing was shared.',
    };
  }
  const { accessUserIds } = normalizeAccess(draft);
  const added = ids.filter(id => !accessUserIds.includes(id));
  return {
    ok: true, status: 200,
    accessUserIds: [...accessUserIds, ...added],
    changed: added.length > 0,
    added: added.length,
    skipped: ids.length - added.length,
  };
}

/** #2870 AC8/AC13 — the record after the "Visible to everyone" switch. Writes
 *  ONLY the flag: the access set is untouched in both directions (AC13), and
 *  "off" removes the field rather than storing `false`. */
function setVisibility(draft, value) {
  if (typeof value !== 'boolean') {
    return { ok: false, status: 400, error: 'visibleToEveryone must be true or false' };
  }
  const next = { ...(draft && typeof draft === 'object' ? draft : {}) };
  if (value) next.visibleToEveryone = true; else delete next.visibleToEveryone;
  return { ok: true, status: 200, draft: next, changed: isVisibleToEveryone(draft) !== value };
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
function draftAccessView(draft, { viewerId = null, usersById = new Map(), canEdit = true } = {}) {
  const { createdBy, accessUserIds } = normalizeAccess(draft);
  const known = createdBy ? usersById.get(createdBy) : null;
  return {
    shared: accessUserIds.length > 1,
    accessCount: accessUserIds.length,
    createdByYou: !!(viewerId && createdBy && createdBy === viewerId),
    createdByName: createdBy ? ((known && known.displayName) || 'Deleted user') : null,
    // #2870 AC12 — the list marks a global draft, and tells a global-only
    // reader up front that it will open read-only.
    visibleToEveryone: isVisibleToEveryone(draft),
    canEdit: canEdit !== false,
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
  VIEW_FIELDS,
  NOT_FOUND,
  READ_ONLY,
  MAX_BULK_SHARE,
  LAST_HOLDER_ERROR,
  normalizeAccess,
  canAccessDraft,
  canViewDraft,
  isVisibleToEveryone,
  authorizeDraft,
  authorizeDraftRead,
  filterVisibleDrafts,
  newDraftAccess,
  stripAccessFields,
  carryAccessFields,
  addAccess,
  addAccessMany,
  setVisibility,
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
