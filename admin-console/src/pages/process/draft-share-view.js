// Pure decisions for draft sharing on the Flows rail (#2068).
//
// Under DD2 everyone who can see a draft is fully equal — open, edit, rename,
// export, create a team, share on, remove anyone, delete — so there is no
// "owner" branch anywhere in this file and no disabled state that depends on
// who created the draft. What IS refused is emptying the access set (AC9), and
// that refusal is the server's; the helpers here only describe it early so the
// dialog does not offer a button that is going to be rejected.
//
// Pure and React-free so it unit-tests without a DOM (per the #651 convention).

/** The one server-side invariant worth mirroring client-side (AC9). */
export const LAST_HOLDER_HINT =
  'You are the only person with access, so you cannot remove yourself. Delete the draft instead.';

/** AC16 — private vs shared, in the rail's one-line `sub` slot.
 *
 *  The entry comes from `GET /api/process/drafts`, which resolves the creator's
 *  display name server-side: the rail never sees a user id, so it cannot render
 *  one by accident. `createdByName` is null for a draft created before any user
 *  record existed (the env single-admin path), and reads *Deleted user* when the
 *  creator's record is gone — both of which the caller just prints. */
export function draftSubtitle(entry) {
  const e = entry || {};
  const roleCount = Number.isFinite(e.roleCount) ? e.roleCount : 0;
  const parts = [`${roleCount} agent${roleCount === 1 ? '' : 's'}`];
  // #2870 AC12 — a global draft says so INSTEAD of private/shared: for most
  // viewers the explicit list is not what decides whether they can see it.
  if (e.visibleToEveryone === true) {
    parts.push(VISIBLE_TO_EVERYONE_LABEL);
    if (e.canEdit === false) parts.push('read-only');
  } else if (e.shared) {
    const n = Number.isFinite(e.accessCount) ? e.accessCount : 0;
    parts.push(`shared with ${n} people`);
  } else {
    parts.push('private');
  }
  // Only name a creator the viewer is not: "created by you" on your own drafts
  // would be noise on the common case.
  if (!e.createdByYou && e.createdByName) parts.push(`by ${e.createdByName}`);
  return parts.join(' · ');
}

/** The `title` on the same row — the long form of the badge above. */
export function draftAccessTitle(entry) {
  const e = entry || {};
  if (e.visibleToEveryone === true) {
    return e.canEdit === false
      ? 'Visible to everyone: you can open, export, create a team from or duplicate this draft, but not change it.'
      : 'Visible to everyone on the platform (read-only for them). Everyone it is shared with can still edit it.';
  }
  if (!e.shared) return 'Private to you. Use Share… to give a colleague access.';
  const n = Number.isFinite(e.accessCount) ? e.accessCount : 0;
  return `Shared: ${n} people can open, edit and delete this draft.`;
}

/** One row of the Share dialog's current-access list. `you` is what makes the
 *  "remove yourself = leave" case readable; it is NOT a privilege marker. */
export function accessRows(users, viewerId) {
  return (Array.isArray(users) ? users : []).map(u => ({
    id: u.id,
    label: u.displayName || u.id,
    email: u.email || '',
    you: !!(viewerId && u.id === viewerId),
  }));
}

/** D3 — the picker offers existing accounts only, minus the ones already in. */
export function shareCandidates(directory, accessUsers) {
  const held = new Set((Array.isArray(accessUsers) ? accessUsers : []).map(u => u.id));
  return (Array.isArray(directory) ? directory : []).filter(u => u && u.id && !held.has(u.id));
}

/** #2870 AC2 — the picker's text filter: case-insensitive substring on the
 *  display name or the email, the only two fields the picker knows (D2/D11). */
export function filterCandidates(candidates, query) {
  const list = Array.isArray(candidates) ? candidates : [];
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return list;
  return list.filter(u => String(u.displayName || '').toLowerCase().includes(q)
    || String(u.email || '').toLowerCase().includes(q));
}

/** #2870 AC3 — "Select all" adds every colleague CURRENTLY LISTED (i.e. the
 *  filtered result) to the selection, keeping what was already ticked. */
export function selectAllIds(selected, visible) {
  const next = new Set(selected instanceof Set ? selected : []);
  for (const u of Array.isArray(visible) ? visible : []) if (u && u.id) next.add(u.id);
  return next;
}

/** Edge case: a ticked colleague who is no longer a candidate — they were
 *  shared with in the meantime, or their account was deleted — drops out of
 *  the selection, so the count on the button never includes a ghost. */
export function pruneSelection(selected, candidates) {
  const ids = new Set((Array.isArray(candidates) ? candidates : []).map(u => u.id));
  return new Set([...(selected instanceof Set ? selected : [])].filter(id => ids.has(id)));
}

/** #2870 AC1/AC3/AC4 — the picker's controls in one place: the Share button
 *  names the count and is inert with nobody selected; Select all / Clear are
 *  inert when they would do nothing; the empty state says why. */
export function pickerState({ candidates = [], visible = [], selected = new Set(), busy = false, query = '' } = {}) {
  const sel = selected instanceof Set ? selected : new Set();
  const n = sel.size;
  const allVisibleSelected = visible.length > 0 && visible.every(u => sel.has(u.id));
  let emptyText = '';
  if (candidates.length === 0) emptyText = 'Everyone already has access.';
  else if (visible.length === 0) emptyText = `No colleague matches “${String(query).trim()}”.`;
  return {
    shareLabel: n > 0 ? `Share with ${n}` : 'Share',
    shareDisabled: busy || n === 0,
    selectAllDisabled: busy || visible.length === 0 || allVisibleSelected,
    clearDisabled: busy || n === 0,
    filterDisabled: candidates.length === 0,
    emptyText,
  };
}

/** #2870 AC5 — what to say after a successful bulk share. Already-present
 *  colleagues are skipped by the server, so the sentence counts what actually
 *  changed instead of echoing the selection. */
export function shareResultNotice(res) {
  const added = Number.isFinite(res?.added) ? res.added : 0;
  const skipped = Number.isFinite(res?.skipped) ? res.skipped : 0;
  const head = added === 1 ? 'Shared with 1 person.' : `Shared with ${added} people.`;
  if (skipped === 0) return head;
  return `${head} ${skipped} already had access.`;
}

/** #2870 AC6 — a refused bulk share. The server changes nothing on a refusal,
 *  so the message must say so; an unknown-user refusal also asks the panel to
 *  reload the directory, because someone in the selection is gone. */
export function bulkShareError(err) {
  if (err && err.code === 'unknown_user') {
    return { message: `${err.message || 'Someone you selected no longer has an account.'} The list has been refreshed — check the selection and try again.`, reload: true };
  }
  return { message: draftWriteError(err, 'Could not share. Nothing was changed.'), reload: false };
}

// ── #2870 Part B — "Visible to everyone" ─────────────────────────────────────

export const VISIBLE_TO_EVERYONE_LABEL = 'Visible to everyone';

/** AC8 — the confirmation names the reach in full: current AND future users. */
export const VISIBLE_TO_EVERYONE_CONFIRM =
  'Every user of the platform — everyone who has an account today, and everyone who gets one later — '
  + 'will see this draft and can open it, export it, create a team from it and duplicate it. '
  + 'They cannot edit, rename, delete or share it; only the people listed under "Has access" can.';

/** AC10 — the editor's hint for a global-only reader. */
export const READ_ONLY_DRAFT_HINT =
  'Read-only: this draft is visible to everyone, but only the people it is shared with can change it. '
  + 'Duplicate it to make your own editable copy.';

/** AC10 — the editor opens read-only only when the server said so explicitly;
 *  an older server that never sends the flag keeps today's editable canvas. */
export function isReadOnlyDraft(bundle) {
  return !!bundle && bundle.viewerCanEdit === false;
}

/** AC10 — "Duplicate to my drafts": the body for `POST /api/process/drafts`.
 *  The copy is an ordinary private draft of the caller — the server strips any
 *  access fields anyway; the Copilot history is storage metadata of the
 *  original and stays behind. */
export function duplicateDraftBody(bundle) {
  const src = bundle && typeof bundle === 'object' ? bundle : {};
  const { copilot, createdBy, accessUserIds, visibleToEveryone, viewerCanEdit, id, createdAt, updatedAt, ...rest } = src;
  const base = typeof src.name === 'string' && src.name.trim() ? src.name.trim() : 'Untitled flow';
  const name = `${base} (copy)`;
  return { name, processTemplate: { ...rest, name } };
}

/** AC9 — is removing THIS person going to be refused? The rule is on the set,
 *  not on "self": an emptied access set is equally unreachable however it got
 *  that way, so a one-person set refuses the removal whoever asks. */
export function removeState(accessUsers, userId) {
  const list = Array.isArray(accessUsers) ? accessUsers : [];
  const present = list.some(u => u.id === userId);
  if (!present) return { disabled: true, hint: '' };
  if (list.length <= 1) return { disabled: true, hint: LAST_HOLDER_HINT };
  return { disabled: false, hint: '' };
}

/** AC13 — the delete confirmation has to name the other people who lose the
 *  draft, because under DD2 every holder may delete and the dialog is the only
 *  thing standing between a mis-click and someone else's work. Returns null when
 *  there is nobody else to warn about, so the caller renders nothing extra. */
export function deleteImpactNotice(accessUsers, viewerId) {
  const others = (Array.isArray(accessUsers) ? accessUsers : [])
    .filter(u => u && u.id && u.id !== viewerId)
    .map(u => u.displayName || u.id);
  if (others.length === 0) return null;
  if (others.length === 1) return `${others[0]} also has access and will lose this draft.`;
  const head = others.slice(0, -1).join(', ');
  return `${head} and ${others[others.length - 1]} also have access and will lose this draft.`;
}

/** AC17 — a draft removed from under you must read as a sentence, not as a bare
 *  404 and not as silence. `status` comes off the `apiCall` error. */
export function isDraftGone(err) {
  return !!(err && err.status === 404);
}

export const DRAFT_GONE_MESSAGE =
  'This draft is no longer available to you — it was deleted, or your access to it was removed. '
  + 'Your changes were not saved.';

/** The message for any failed draft write: the gone case gets its own sentence,
 *  everything else keeps the server's own words. */
export function draftWriteError(err, fallback = 'Save failed.') {
  if (isDraftGone(err)) return DRAFT_GONE_MESSAGE;
  return (err && err.message) || fallback;
}

export default draftSubtitle;
