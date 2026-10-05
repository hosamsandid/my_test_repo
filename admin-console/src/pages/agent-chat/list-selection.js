/**
 * Pure model for the Agent Chat rail's multi-select team filter (#2740).
 *
 * The rail filter used to be a single-choice `<select>` (`{ kind: 'all' |
 * 'team' | 'agent', id }`). It is now a set of checkable **entries** — one per
 * visible team plus one "Individual agents" block for the rail's ungrouped
 * rows — and the selection is stored as the entries the user has **hidden**:
 *
 *     { hidden: ['team:<id>', 'singles', …] }
 *
 * Storing the hidden side rather than the shown side is what makes AC7 fall
 * out for free: a team that becomes visible after the selection was saved has
 * no key in `hidden`, so it is shown by default whatever else is selected.
 * Keys use `groupKey`'s `team:<id>` namespace (agent-list-model.js — not
 * imported, because that module imports this one) so the rail's order /
 * collapse maps and the filter all talk about a team the same way.
 *
 * Membership-based quick filters reuse the team header's derivation
 * (`memberRows` / `teamMembershipIndicator`), so "Private" here and the
 * header's Private badge can never disagree (#2740 Constraints).
 *
 * Dependency-free so it runs under `node --test` (the #651 convention); the
 * JSX control lives in `ListFilterControl.jsx`.
 */

import { memberRows, ROLE_ADMIN } from './team-share-view.js';
import { teamMembershipIndicator, membershipsByTeam } from './team-membership-view.js';

/** The one entry that stands for every ungrouped ("Individual agents") row. */
export const INDIVIDUAL_KEY = 'singles';
export const INDIVIDUAL_LABEL = 'Individual agents';

/** Everything shown — the default for a user who never narrowed the list. */
export const SHOW_ALL = Object.freeze({ hidden: Object.freeze([]) });

/** The rail's empty-state copy when the selection hides every entry (AC3). */
export const NO_SELECTION_HINT = 'No teams selected — pick some in the filter above.';

/**
 * Coerce a stored / received value into a selection. Anything malformed reads
 * as "everything shown" rather than an error — a broken preference must never
 * be what hides a user's agents.
 */
export function normalizeSelection(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.hidden)) return SHOW_ALL;
  const hidden = [...new Set(raw.hidden.filter(k => typeof k === 'string' && k))];
  return hidden.length ? { hidden } : SHOW_ALL;
}

/**
 * Which entry an agent row belongs to. Mirrors `buildGroups`: a team row and
 * every member carrying a `parentTeamId` land in that team's group; everything
 * else is an ungrouped row.
 */
export function agentEntryKey(agent) {
  if (!agent) return INDIVIDUAL_KEY;
  if (agent.role === 'team') return `team:${agent.id}`;
  if (agent.role === 'team-member' && agent.parentTeamId) return `team:${agent.parentTeamId}`;
  return INDIVIDUAL_KEY;
}

// One Set per selection object, so the per-row predicate stays O(1) without
// the caller having to carry a second representation around.
const hiddenSets = new WeakMap();
function hiddenSet(selection) {
  const sel = selection && Array.isArray(selection.hidden) ? selection : SHOW_ALL;
  let set = hiddenSets.get(sel);
  if (!set) { set = new Set(sel.hidden); hiddenSets.set(sel, set); }
  return set;
}

/** Is this entry key shown under the selection? */
export function isEntryShown(selection, key) {
  return !hiddenSet(selection).has(key);
}

/** Does the selection let this agent row through? */
export function matchesSelection(agent, selection) {
  return isEntryShown(selection, agentEntryKey(agent));
}

/**
 * The checkable entries, in rail order: every team (by display name, as
 * `buildGroups` sorts them) and — only when there are ungrouped rows — the
 * Individual agents block last (AC1).
 *
 * Each team carries a `subtitle` with the same wording as its header line
 * ("Private" or the member names), so two teams sharing a display name stay
 * distinguishable (edge case: duplicate names).
 */
export function selectionEntries(groups, singles, { memberships = [], directory = [], viewerId = null } = {}) {
  const byTeam = membershipsByTeam(memberships);
  const entries = (groups || []).map((g) => {
    const indicator = teamMembershipIndicator({ memberships: byTeam.get(g.id) || [], directory, viewerId });
    const subtitle = indicator.kind === 'own' ? 'Private' : indicator.kind === 'admins' ? indicator.title : '';
    return { key: `${g.kind || 'team'}:${g.id}`, teamId: g.id, label: g.displayName || g.id, subtitle, kind: 'team' };
  });
  if ((singles || []).length > 0) {
    entries.push({ key: INDIVIDUAL_KEY, teamId: null, label: INDIVIDUAL_LABEL, subtitle: '', kind: 'individual' });
  }
  return entries;
}

/** Case-insensitive substring search over the entry labels (AC4). */
export function searchEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(e => e.label.toLowerCase().includes(q));
}

function withHidden(set) {
  return set.size ? { hidden: [...set].sort() } : SHOW_ALL;
}

/** Check or uncheck one entry (AC2). */
export function toggleEntry(selection, key) {
  const set = new Set(hiddenSet(selection));
  if (set.has(key)) set.delete(key); else set.add(key);
  return withHidden(set);
}

/**
 * Show or hide a batch of entries — "Select all" / "Deselect all" over the
 * entries currently *listed*, so with a search active they touch only the
 * matching ones (AC3/AC4).
 */
export function setEntriesShown(selection, keys, shown) {
  const set = new Set(hiddenSet(selection));
  for (const k of keys) { if (shown) set.delete(k); else set.add(k); }
  return withHidden(set);
}

/**
 * Drop keys that name no current entry (AC8): a deleted or no-longer-visible
 * team silently leaves the saved selection. Applied when a selection is
 * written, not on every roster tick, so a team that blinks out of a single
 * payload does not lose its hidden state.
 */
export function pruneSelection(selection, entries) {
  const known = new Set((entries || []).map(e => e.key));
  return withHidden(new Set([...hiddenSet(selection)].filter(k => known.has(k))));
}

/** The shown entries, in entry order. */
export function shownEntries(entries, selection) {
  return (entries || []).filter(e => isEntryShown(selection, e.key));
}

/** Is every entry shown — the equivalent of the former "All agents"? */
export function isEverythingShown(entries, selection) {
  return (entries || []).every(e => isEntryShown(selection, e.key));
}

/** The collapsed control's one-line summary (AC6). */
export function selectionSummary(entries, selection) {
  const list = entries || [];
  const shown = shownEntries(list, selection);
  if (shown.length === list.length) return 'All agents';
  if (shown.length === 1) return shown[0].label;
  return `${shown.length} of ${list.length} teams`;
}

export const QUICK_FILTERS = Object.freeze([
  { id: 'private', label: 'Only my private teams' },
  { id: 'member', label: 'Teams I am a member of' },
  { id: 'admin', label: 'Teams where I am Team Admin' },
  { id: 'regular', label: 'Teams where I am a regular member' },
]);

/**
 * Does a team match a membership quick filter for the viewer? Reads the team's
 * own access list through `memberRows` (role normalisation) and
 * `teamMembershipIndicator` (the Private badge) — the team header's own
 * derivation. A team the viewer only sees without a membership (a System Admin
 * looking at someone else's team) matches none of them.
 */
export function teamMatchesQuickFilter(filterId, teamMemberships, directory, viewerId) {
  if (!viewerId) return false;
  const rows = memberRows(teamMemberships, directory, viewerId);
  const mine = rows.find(r => r.you);
  if (!mine) return false;
  switch (filterId) {
    case 'private': return teamMembershipIndicator({ memberships: teamMemberships, directory, viewerId }).kind === 'own';
    case 'member': return true;
    case 'admin': return mine.role === ROLE_ADMIN;
    case 'regular': return mine.role !== ROLE_ADMIN;
    default: return false;
  }
}

/**
 * Activate a quick filter (AC5): the selection becomes *exactly* the matching
 * teams — Individual agents and every other team hidden. A one-shot preset;
 * the result is an ordinary selection the user can adjust afterwards. A
 * filter that matches nothing yields an empty selection, not an error.
 */
export function applyQuickFilter(filterId, entries, { memberships = [], directory = [], viewerId = null } = {}) {
  const byTeam = membershipsByTeam(memberships);
  const hidden = new Set();
  for (const e of entries || []) {
    const match = e.kind === 'team'
      && teamMatchesQuickFilter(filterId, byTeam.get(e.teamId) || [], directory, viewerId);
    if (!match) hidden.add(e.key);
  }
  return withHidden(hidden);
}

/**
 * The control's actions, as one reducer so the page wiring stays a single
 * call. Every result is pruned to the current entries (AC8), so a write never
 * carries a deleted or no-longer-visible team forward.
 *
 *   { type: 'toggle', key }            check / uncheck one entry
 *   { type: 'set', keys, shown }       Select all / Deselect all (listed keys)
 *   { type: 'quick', filterId }        replace with a membership preset
 *   { type: 'reveal', key }            tick one entry back in (AC10)
 */
export function applySelectionAction(selection, action, entries, membershipContext = {}) {
  let next = selection;
  switch (action && action.type) {
    case 'toggle': next = toggleEntry(selection, action.key); break;
    case 'set': next = setEntriesShown(selection, action.keys || [], !!action.shown); break;
    case 'reveal': next = setEntriesShown(selection, [action.key], true); break;
    case 'quick': next = applyQuickFilter(action.filterId, entries, membershipContext); break;
    default: return selection;
  }
  return pruneSelection(next, entries);
}

/**
 * Quick filters need the viewer's memberships; until those have loaded (or
 * when they failed) a preset would compute a wrong selection, so it is
 * disabled with this reason instead (edge case). `null` = available.
 */
export function quickFiltersDisabledReason({ membershipsLoaded, viewerId }) {
  if (!viewerId) return 'Quick filters need a signed-in user account.';
  if (!membershipsLoaded) return 'Team memberships have not loaded yet.';
  return null;
}

/**
 * One-time migration of the old browser-local single-choice filter
 * (`agentChat.listFilter`, AC9):
 *   all          → everything shown
 *   team:<id>    → only that team
 *   agent:<id>   → the Individual agents block when that agent is ungrouped,
 *                  otherwise everything shown
 * Anything unreadable (or a team that is gone) migrates to everything shown.
 */
export function migrateLegacyFilter(legacy, entries, singles) {
  const list = entries || [];
  const only = (key) => withHidden(new Set(list.map(e => e.key).filter(k => k !== key)));
  if (!legacy || typeof legacy !== 'object') return SHOW_ALL;
  if (legacy.kind === 'team' && list.some(e => e.key === `team:${legacy.id}`)) {
    return only(`team:${legacy.id}`);
  }
  if (legacy.kind === 'agent' && (singles || []).some(a => a.id === legacy.id)) {
    return only(INDIVIDUAL_KEY);
  }
  return SHOW_ALL;
}

/** Parse the legacy localStorage value; `null` when absent or unreadable. */
export function parseLegacyFilter(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && typeof parsed.kind === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reveal (AC10): the entry to tick so a routed agent becomes visible, or
 * `null` when it already is. Only that one entry is added — the rest of the
 * user's selection is kept.
 */
export function revealEntryKey(agent, selection) {
  if (!agent) return null;
  const key = agentEntryKey(agent);
  return isEntryShown(selection, key) ? null : key;
}

/**
 * Reorder gates (AC11): group/single drag-and-drop needs every entry shown —
 * with an entry hidden, a move between visible neighbours would be ambiguous.
 * Member reorder inside a team only needs that team shown: the filter picks
 * whole teams and never hides a shown team's members, so each visible team
 * holds its complete, ordered member set however many other teams are shown
 * (#1725, #2846). Hidden teams are not rendered, so one boolean suffices.
 */
export function reorderAllowed(entries, selection) {
  const everything = isEverythingShown(entries, selection);
  const shown = shownEntries(entries, selection);
  return {
    groups: everything,
    members: everything || shown.some(e => e.kind === 'team'),
  };
}
