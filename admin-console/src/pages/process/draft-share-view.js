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
  if (e.shared) {
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

/** State of the Add control: what the empty option should say, and whether the
 *  button can fire. Mirrors ManageTeamPanel's add-member row. */
export function addControlState({ candidates = [], selectedId = '', busy = false } = {}) {
  const hasCandidates = candidates.length > 0;
  return {
    placeholder: hasCandidates ? 'Select a colleague to share with…' : 'Everyone already has access',
    disabled: busy || !hasCandidates || !selectedId,
  };
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
