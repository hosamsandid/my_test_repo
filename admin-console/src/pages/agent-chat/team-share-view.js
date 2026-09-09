// Pure decisions for the Agent Chat team Share panel (#2082, #2041 P4 / AC8–AC10).
//
// Sharing an Agent Team is decentralised (D3): a Team Admin manages their own
// team's members from the chat, with no admin console in the loop. Nothing here
// is a new authorization mechanism — `POST`/`DELETE /api/admin/memberships` have
// been gated on `canManageTeam` since #2081 and the D4 last-admin rule lives in
// the orchestrator's store, so every helper below only *describes* what the
// server is going to do, early enough that the panel does not offer a control
// that is going to be refused.
//
// Two rules are load-bearing and easy to get wrong:
//
//  1. **Read and write are different rights.** `GET /api/admin/memberships` is
//     filtered by `visibleTeam`, so a plain Team Member may already read their
//     own team's member list including who administers it (D9 — "a Team Member
//     may read and chat"). The panel must therefore gate its controls on
//     `canManageTeam`, never on whether the fetch succeeded.
//  2. **`POST` takes `teamId` in the BODY, `DELETE` in the QUERY.** A DELETE
//     that sends it in a body arrives at `canManageTeam(scope, undefined)`,
//     which fails closed — a 403 for everyone but a System Admin. That is why
//     both requests are built here rather than inline at the call site.
//
// Pure and React-free so it unit-tests without a DOM (per the #651 convention).

export const ROLE_ADMIN = 'team-admin';
export const ROLE_MEMBER = 'team-member';

/** The two roles, in the order the picker offers them (least power first). */
export const ROLE_OPTIONS = Object.freeze([ROLE_MEMBER, ROLE_ADMIN]);

export const ROLE_LABELS = Object.freeze({
  [ROLE_ADMIN]: 'Team Admin',
  [ROLE_MEMBER]: 'Team Member',
});

/** What each role may do, in the words D9 uses. Shown as the option's title. */
export const ROLE_HINTS = Object.freeze({
  [ROLE_ADMIN]: 'Can open and chat with the team, change its agents and settings, and manage who has access',
  [ROLE_MEMBER]: 'Can open and chat with the team, and see who has access — but change nothing',
});

/** The read-only footer for a caller who may see the list but not change it. */
export const READ_ONLY_NOTICE =
  'You can see who has access to this team. Only a Team Admin can add, change or remove people.';

/** D4 — the last admin may not simply leave; somebody has to take over. */
export const SUCCESSOR_NOTICE =
  'You are about to remove the last Team Admin. Choose who takes over as Team Admin in the same step.';

/** …and when there is nobody to take over, the honest dead end. */
export const SOLE_MEMBER_NOTICE =
  'This is the team\'s only member, so there is nobody to hand it over to. '
  + 'Add somebody first, or delete the team instead.';

/** D3 — sharing offers existing accounts only; new people are an admin step. */
export const NO_CANDIDATES_NOTICE =
  'Everyone with an account is already on this team. A colleague without an account '
  + 'has to be created by a System Admin first.';

/**
 * The client mirror of `canManageTeam` (`admin-console/api/scope.js`), used for
 * the whole panel rather than per control: full-visibility admin, or Team Admin
 * of *this* team. Same shape as `Teams.jsx`'s `canManage`, and — like it — the
 * UI only trims controls; the API is what enforces.
 *
 * `user` is the session (`describeAuthz`), whose `teams` is `[{teamId, role}]`.
 */
export function canManageMembers(user, teamId) {
  if (!user || !teamId) return false;
  if (user.admin) return true;
  return (user.teams || []).some(t => t && t.teamId === teamId && t.role === ROLE_ADMIN);
}

/** D2/D11 — one directory entry, projected to what the picker may show. The
 *  route already strips everything else; this is the client-side re-assertion,
 *  so a widened payload cannot reach the DOM by accident. */
function directoryEntry(u) {
  return { id: u.id, displayName: u.displayName || u.id, email: u.email || '' };
}

/** The open directory, name+email only, indexed for the rows below. */
export function directoryIndex(directory) {
  const byId = new Map();
  for (const u of Array.isArray(directory) ? directory : []) {
    if (u && u.id) byId.set(u.id, directoryEntry(u));
  }
  return byId;
}

/**
 * One row of the member list: who, their role, and whether it is you.
 *
 * `you` is what makes "remove yourself = leave the team" readable; it is not a
 * privilege marker. A membership whose user record is gone is shown rather than
 * dropped (the `resolveAccessList` precedent) — a row nobody can name is still
 * a row that holds access, and hiding it would hide the reason a hand-over is
 * being demanded.
 */
export function memberRows(memberships, directory, viewerId) {
  const byId = directoryIndex(directory);
  return (Array.isArray(memberships) ? memberships : [])
    .filter(m => m && m.userId)
    .map((m) => {
      const u = byId.get(m.userId);
      return {
        membershipId: m.id || m.userId,
        userId: m.userId,
        role: m.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_MEMBER,
        label: u ? u.displayName : 'Unknown user',
        email: u ? u.email : '',
        known: !!u,
        you: !!(viewerId && m.userId === viewerId),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.userId.localeCompare(b.userId));
}

/** D3/AC10 — the picker offers existing accounts, minus the ones already in. */
export function shareCandidates(directory, rows) {
  const held = new Set((Array.isArray(rows) ? rows : []).map(r => r.userId));
  return [...directoryIndex(directory).values()]
    .filter(u => !held.has(u.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
}

/** A search box over the directory: name and email, case-insensitively. Never
 *  the id — an id is not something a colleague knows about themselves. */
export function filterCandidates(candidates, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return Array.isArray(candidates) ? candidates : [];
  return (Array.isArray(candidates) ? candidates : []).filter(u => (
    (u.displayName || '').toLowerCase().includes(q)
    || (u.email || '').toLowerCase().includes(q)
  ));
}

/** The label for one picker option — display name + email, and nothing else
 *  (AC10: never the `systemAdmin` flag, never the GitHub handle). */
export function candidateLabel(u) {
  if (!u) return '';
  return u.email ? `${u.displayName} — ${u.email}` : u.displayName;
}

/** State of the Add row: what the empty option says, and whether Add can fire. */
export function addControlState({
  candidates = [], selectedId = '', busy = false, query = '',
} = {}) {
  const total = candidates.length;
  const matching = filterCandidates(candidates, query).length;
  let placeholder = 'Select a colleague to add…';
  if (total === 0) placeholder = 'Everyone already has access';
  else if (matching === 0) placeholder = 'No match for that name or email';
  return {
    placeholder,
    disabled: busy || total === 0 || matching === 0 || !selectedId,
    notice: total === 0 ? NO_CANDIDATES_NOTICE : '',
  };
}

/** How many Team Admins the team currently has. */
export function adminCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r.role === ROLE_ADMIN).length;
}

/**
 * D4 — does removing (or demoting) this person need a successor named in the
 * same operation, and who may be named?
 *
 * The successor must ALREADY be a member of this team: naming an outsider would
 * make this a second, unaudited invitation path, which is exactly what
 * `team-admin-succession.js` refuses. Returns one of:
 *
 *   `{ kind: 'none' }`       — go ahead, the store will not refuse
 *   `{ kind: 'successor' }`  — sole admin, others present: pick who takes over
 *   `{ kind: 'blocked' }`    — sole admin AND sole member: nothing to hand over to
 *   `{ kind: 'absent' }`     — not a member of this team (stale list)
 */
export function handoverRequirement({ rows = [], userId = '', action = 'remove' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const target = list.find(r => r.userId === userId);
  if (!target) return { kind: 'absent', notice: '', candidates: [] };
  // Only a Team Admin can be the last one, and a promotion is never gated.
  if (target.role !== ROLE_ADMIN) return { kind: 'none', notice: '', candidates: [] };
  if (action !== 'remove' && action !== 'demote') return { kind: 'none', notice: '', candidates: [] };
  if (adminCount(list) > 1) return { kind: 'none', notice: '', candidates: [] };
  const candidates = list.filter(r => r.userId !== userId);
  if (candidates.length === 0) {
    return { kind: 'blocked', notice: SOLE_MEMBER_NOTICE, candidates: [] };
  }
  return { kind: 'successor', notice: SUCCESSOR_NOTICE, candidates };
}

/** The Remove button's state, before the server gets a chance to refuse. */
export function removeState({ rows = [], userId = '', canManage = false, busy = false } = {}) {
  if (!canManage) return { disabled: true, hint: READ_ONLY_NOTICE, needsSuccessor: false };
  if (busy) return { disabled: true, hint: '', needsSuccessor: false };
  const req = handoverRequirement({ rows, userId, action: 'remove' });
  if (req.kind === 'blocked') return { disabled: true, hint: req.notice, needsSuccessor: false };
  return {
    disabled: req.kind === 'absent',
    hint: req.kind === 'successor' ? req.notice : '',
    needsSuccessor: req.kind === 'successor',
  };
}

/** The role select's state for one row. A promotion is never gated; a demotion
 *  of the last admin needs the same hand-over a removal does. */
export function roleChangeState({
  rows = [], userId = '', nextRole = ROLE_MEMBER, canManage = false, busy = false,
} = {}) {
  if (!canManage) return { disabled: true, hint: READ_ONLY_NOTICE, needsSuccessor: false };
  if (busy) return { disabled: true, hint: '', needsSuccessor: false };
  if (nextRole === ROLE_ADMIN) return { disabled: false, hint: '', needsSuccessor: false };
  const req = handoverRequirement({ rows, userId, action: 'demote' });
  if (req.kind === 'blocked') return { disabled: true, hint: req.notice, needsSuccessor: false };
  return {
    disabled: req.kind === 'absent',
    hint: req.kind === 'successor' ? req.notice : '',
    needsSuccessor: req.kind === 'successor',
  };
}

/**
 * `POST /api/admin/memberships` — the upsert that both ADDS somebody and
 * changes an existing member's role. `teamId` goes in the BODY here.
 */
export function setRoleRequest({ teamId, userId, role, successorUserId } = {}) {
  const body = { userId, teamId, role };
  if (successorUserId) body.successorUserId = successorUserId;
  return { method: 'POST', url: '/api/admin/memberships', body };
}

/**
 * `DELETE /api/admin/memberships` — `teamId` goes in the QUERY, because that is
 * where the route's own `canManageTeam` gate reads it from (`req.query.teamId`).
 * The D4 successor rides along the same way (`adminQuery` forwards every
 * non-empty param verbatim).
 */
export function removeRequest({ teamId, userId, successorUserId } = {}) {
  const qs = new URLSearchParams({ userId: userId || '', teamId: teamId || '' });
  if (successorUserId) qs.set('successorUserId', successorUserId);
  return { method: 'DELETE', url: `/api/admin/memberships?${qs.toString()}`, body: null };
}

/** The subtitle under the panel title: how many people, and how many admins. */
export function shareSubtitle(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return 'Nobody has access yet.';
  const admins = adminCount(list);
  const people = `${list.length} ${list.length === 1 ? 'person' : 'people'}`;
  return `${people} · ${admins} ${admins === 1 ? 'Team Admin' : 'Team Admins'}`;
}

/**
 * The message for a failed membership write.
 *
 * The store's refusals (409 `last-team-admin` / `successor-required` /
 * `successor-is-self` / `successor-not-a-member`) carry a message that IS the
 * instruction, and the console relays it verbatim — so the server's own words
 * win over anything phrased here. A 403 is the one case worth rewording: it
 * means the caller's rights changed under an open panel, and "Forbidden" does
 * not say that.
 */
export function membershipWriteError(err, fallback = 'The change could not be saved.') {
  if (err && err.status === 403) {
    return 'You are no longer a Team Admin for this team, so this change was refused. '
      + 'Close and reopen the panel to see the current list.';
  }
  if (err && err.serverMessage) return err.serverMessage;
  return (err && err.message) || fallback;
}

export default memberRows;
