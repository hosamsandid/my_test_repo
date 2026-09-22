// Pure decisions for the Agent Chat team-header membership indicator (#2381).
//
// The team header row used to carry the team's Working Environment name (#1529);
// that line is now repurposed to say *who is behind the team* instead. This
// module turns the SAME data the Sharing tab reads — `GET /api/admin/memberships`
// + `GET /api/users/directory` (see `ShareTeamPanel.jsx`) — into the small
// descriptor the header renders:
//
//   { kind: 'own' }                    — a team-of-one whose sole member is you
//   { kind: 'admins', names, title }   — otherwise: the team's Team Admin name(s)
//   { kind: 'none' }                   — a team with no visible members (#1957)
//
// It deliberately reuses `memberRows` / `ROLE_ADMIN` from `team-share-view.js`
// rather than re-deriving membership shape, so the header and the Sharing tab can
// never disagree about who administers a team (Dependencies note in #2381).
//
// Pure and React-free so it unit-tests without a DOM (per the #651 convention),
// mirroring `agent-list-model.js` / `team-share-view.js`.

import { memberRows, ROLE_ADMIN } from './team-share-view.js';

/**
 * Index a flat `GET /api/admin/memberships` payload (all of the caller's teams,
 * no `teamId` filter) by `teamId`, so a per-team lookup is O(1) for every team
 * group the rail renders. A membership with no `teamId` is dropped — it cannot
 * be attributed to a team header.
 */
export function membershipsByTeam(memberships) {
  const byTeam = new Map();
  for (const m of Array.isArray(memberships) ? memberships : []) {
    if (!m || !m.teamId) continue;
    if (!byTeam.has(m.teamId)) byTeam.set(m.teamId, []);
    byTeam.get(m.teamId).push(m);
  }
  return byTeam;
}

/**
 * The header indicator for one team, from its own access list.
 *
 *  - **Own/Private** (#2387 AC1, #2381 AC2): exactly one member AND that member
 *    is the viewer. "Private" (rendered from `kind: 'own'`) is specifically the
 *    *viewing user's* sole-member team, never just any team-of-one — a System
 *    Admin looking at someone else's team-of-one sees that person's name
 *    instead (AC4 / the edge case).
 *  - **Members** (#2387 AC2/AC3/AC4): the display name(s) of *everyone* with
 *    access to the team, Team Admins first (in `memberRows`' already-sorted
 *    order), then the remaining Team Members (same stable, alphabetical order).
 *    `memberRows` sorts by label, so partitioning it by role keeps each group's
 *    order stable while putting admins ahead of members. An unresolved member
 *    keeps `memberRows`' own fallback label rather than a new "unknown user"
 *    treatment (the edge case). The `kind` stays `'admins'` for continuity with
 *    #2381's renderer, which is content-agnostic (it just fits a name list).
 *  - **None** (#2381 AC9): a team with zero visible members renders no line at
 *    all, rather than a misleading badge. A team that has members but no Team
 *    Admin still lists those members (#2387 AC6) — the list is everyone, so it
 *    only falls through to `none` when there is truly nobody to show.
 */
export function teamMembershipIndicator({ memberships, directory, viewerId } = {}) {
  const rows = memberRows(memberships, directory, viewerId || null);
  if (rows.length === 0) return { kind: 'none', names: [], title: '' };
  if (rows.length === 1 && rows[0].you) return { kind: 'own', names: [], title: '' };
  const admins = rows.filter(r => r.role === ROLE_ADMIN).map(r => r.label);
  const members = rows.filter(r => r.role !== ROLE_ADMIN).map(r => r.label);
  const names = [...admins, ...members];
  if (names.length === 0) return { kind: 'none', names: [], title: '' };
  return { kind: 'admins', names, title: names.join(', ') };
}

/**
 * Fit an ordered list of admin names onto one line of the given width (AC5).
 *
 * The names line must never wrap and must never ellipsis-cut a name mid-string:
 * when the full list would overflow, the *tail* is dropped and replaced by a
 * compact `+N` remainder count (e.g. `Alice, Bob +2`). The full, untruncated
 * list is always returned as `title` for the header's hover tooltip.
 *
 * `measure(str) => number` reports the rendered width of a candidate string in
 * the same unit as `maxWidth` (pixels at the call site; a stand-in like
 * `s => s.length` in tests). The greedy scan accounts for the `+N` suffix's own
 * width at each step, so the suffix itself can never be what pushes the line
 * over. The first name is always shown even when it alone overflows — a single
 * over-long name (the edge case) then falls back to the CSS ellipsis on its own
 * span, which is the one place a mid-string cut is unavoidable and acceptable.
 *
 * @param {string[]} names   ordered admin display names
 * @param {number}   maxWidth available width; non-finite/≤0 means "unbounded"
 * @param {(s:string)=>number} measure width probe
 * @returns {{ text:string, hiddenCount:number, title:string }}
 */
export function fitAdminNames(names, maxWidth, measure) {
  const list = (Array.isArray(names) ? names : []).filter(Boolean);
  const title = list.join(', ');
  if (list.length === 0) return { text: '', hiddenCount: 0, title: '' };
  const width = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Infinity;
  const probe = typeof measure === 'function' ? measure : (s => s.length);
  for (let k = list.length; k >= 1; k--) {
    const hidden = list.length - k;
    const base = list.slice(0, k).join(', ');
    const suffix = hidden > 0 ? ` +${hidden}` : '';
    if (k === 1 || probe(base + suffix) <= width) {
      return { text: base, hiddenCount: hidden, title };
    }
  }
  // Unreachable (the k === 1 arm always returns), but keep the shape total.
  return { text: list[0], hiddenCount: list.length - 1, title };
}
