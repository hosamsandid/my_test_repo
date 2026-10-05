/**
 * Pure model for the Flows rail filter (#2859).
 *
 * The Flows rail (`Briefings.jsx`, route `/flows`) lists every team and every
 * draft the viewer can see. This is the Agent Chat rail filter (#2740) applied
 * to that list: one checkable **entry** per team (`team:<id>`) and per draft
 * (`draft:<id>`), a name search, Select all / Deselect all, membership quick
 * filters, and a selection stored as the entries the user has **hidden** —
 *
 *     { hidden: ['team:<id>', 'draft:<id>', …] }
 *
 * — so a flow that appears later (newly created, newly shared, a renamed draft
 * that re-keyed) is shown by default (AC10).
 *
 * The selection mechanics (hidden-side set, search, toggle, batch show/hide)
 * and the team membership predicate are imported from Agent Chat's
 * `list-selection.js` rather than re-implemented, so "Private", "Team Admin"
 * and "member" mean exactly what they mean there and in the team header
 * badges (AC8).
 *
 * Dependency-free so it runs under `node --test` (the #651 convention); the
 * control is the shared `agent-chat/ListFilterControl.jsx`.
 */

import {
  isEntryShown,
  normalizeSelection,
  searchEntries,
  setEntriesShown,
  shownEntries,
  SHOW_ALL,
  teamMatchesQuickFilter,
  toggleEntry,
} from '../agent-chat/list-selection.js';
import { membershipsByTeam } from '../agent-chat/team-membership-view.js';

export { isEntryShown, normalizeSelection, searchEntries, shownEntries, SHOW_ALL };

export const GROUP_TEAMS = 'Teams';
export const GROUP_DRAFTS = 'Drafts';

/** The rail's hint when the selection hides every flow (AC5). */
export const NO_FLOWS_SELECTED_HINT = 'No flows selected — pick some in the filter above.';
/** A section whose entries are all hidden says so instead of vanishing (AC5). */
export const ALL_TEAMS_HIDDEN_HINT = 'All teams hidden by the filter.';
export const ALL_DRAFTS_HIDDEN_HINT = 'All drafts hidden by the filter.';

/** The shared control's wording for this list (its defaults are Agent Chat's). */
export const FLOWS_FILTER_COPY = Object.freeze({
  buttonTitle: 'Filter flows list',
  panelLabel: 'Filter flows list',
  searchLabel: 'Search flows',
  listLabel: 'Flows',
  noEntries: 'No flows to filter.',
  noMatches: 'No flows match your search.',
});

export const FLOWS_QUICK_FILTERS = Object.freeze([
  { id: 'private', label: 'Only my private flows' },
  { id: 'member', label: 'Flows I am a member of' },
  { id: 'admin', label: 'Flows where I am Team Admin' },
  { id: 'regular', label: 'Flows where I am a regular member' },
]);

export const teamKey = id => `team:${id}`;
export const draftKey = id => `draft:${id}`;

/**
 * The entry key of a `?proc=` scope: a team id, `draft:<id>`, or a transient
 * scope (`import`) that has no row and so no key.
 */
export function procEntryKey(proc) {
  if (!proc || proc === 'import' || proc === 'templates') return null;
  return proc.startsWith('draft:') ? proc : teamKey(proc);
}

/**
 * The checkable entries in rail order: teams, then drafts (AC2). Each carries
 * the rail row's own secondary line — the environment for a team,
 * `draftSubtitle` for a draft — so two flows sharing a name stay
 * distinguishable. `subtitleOf` is injected so this module does not depend on
 * the page's view helpers.
 *
 * A draft also carries the access facts the quick filters read (`createdByYou`,
 * `shared`, `viewerHasAccess`) — the rail already holds them.
 */
export function flowsFilterEntries({ teams = [], drafts = [], envNameById = new Map(), draftSubtitle = () => '' } = {}) {
  const entries = [];
  for (const t of teams || []) {
    if (!t || !t.id) continue;
    entries.push({
      key: teamKey(t.id),
      kind: 'team',
      teamId: t.id,
      group: GROUP_TEAMS,
      label: t.displayName || t.id,
      subtitle: envNameById.get(t.environmentId) || t.environmentId || '',
    });
  }
  for (const d of drafts || []) {
    if (!d || !d.id) continue;
    entries.push({
      key: draftKey(d.id),
      kind: 'draft',
      draftId: d.id,
      group: GROUP_DRAFTS,
      label: d.name || d.id,
      subtitle: draftSubtitle(d) || '',
      createdByYou: !!d.createdByYou,
      shared: !!d.shared,
      viewerHasAccess: d.viewerHasAccess === true || !!d.createdByYou,
    });
  }
  return entries;
}

/** The collapsed control's one-line summary (AC1). */
export function flowsSelectionSummary(entries, selection) {
  const list = entries || [];
  const shown = shownEntries(list, selection);
  if (shown.length === list.length) return 'All flows';
  if (shown.length === 1) return shown[0].label;
  return `${shown.length} of ${list.length} flows`;
}

/**
 * Does a draft match a quick filter (AC6)? Drafts have no roles, so the two
 * role filters never match one. "Private" is the viewer's own unshared draft;
 * "member" is any draft the viewer is in the access set of — not merely one a
 * System Admin can see.
 */
export function draftMatchesQuickFilter(filterId, entry, viewerId) {
  if (!viewerId || !entry) return false;
  switch (filterId) {
    case 'private': return !!entry.createdByYou && !entry.shared;
    case 'member': return !!entry.viewerHasAccess;
    default: return false;
  }
}

/**
 * Activate a quick filter: the selection becomes exactly the matching flows,
 * everything else hidden. Teams go through Agent Chat's own predicate (AC8).
 * A filter that matches nothing yields an empty selection, not an error.
 */
export function applyFlowsQuickFilter(filterId, entries, { memberships = [], directory = [], viewerId = null } = {}) {
  const byTeam = membershipsByTeam(memberships);
  const hidden = [];
  for (const e of entries || []) {
    const match = e.kind === 'team'
      ? teamMatchesQuickFilter(filterId, byTeam.get(e.teamId) || [], directory, viewerId)
      : draftMatchesQuickFilter(filterId, e, viewerId);
    if (!match) hidden.push(e.key);
  }
  return hidden.length ? { hidden: hidden.sort() } : SHOW_ALL;
}

/**
 * Drop hidden keys that name no current flow (AC10). Only a section that has
 * actually loaded can vouch that a key is gone: while the drafts list is still
 * loading (or failed), its `draft:` keys are kept rather than silently
 * un-hidden by the next write.
 */
export function pruneFlowsSelection(selection, entries, { teamsLoaded = true, draftsLoaded = true } = {}) {
  const sel = normalizeSelection(selection);
  const known = new Set((entries || []).map(e => e.key));
  const hidden = sel.hidden.filter((k) => {
    if (known.has(k)) return true;
    if (k.startsWith('draft:')) return !draftsLoaded;
    if (k.startsWith('team:')) return !teamsLoaded;
    return false;
  });
  return hidden.length ? { hidden: [...hidden].sort() } : SHOW_ALL;
}

/**
 * The control's actions as one reducer (same action shapes as Agent Chat's
 * `applySelectionAction`). Every result is pruned, so a write never carries a
 * deleted flow forward.
 *
 *   { type: 'toggle', key }            check / uncheck one entry
 *   { type: 'set', keys, shown }       Select all / Deselect all (listed keys)
 *   { type: 'quick', filterId }        replace with a membership preset
 *   { type: 'reveal', key }            tick one entry back in (AC11)
 */
export function applyFlowsFilterAction(selection, action, entries, membershipContext = {}, loaded = {}) {
  const sel = normalizeSelection(selection);
  let next;
  switch (action && action.type) {
    case 'toggle': next = toggleEntry(sel, action.key); break;
    case 'set': next = setEntriesShown(sel, action.keys || [], !!action.shown); break;
    case 'reveal': next = setEntriesShown(sel, [action.key], true); break;
    case 'quick': next = applyFlowsQuickFilter(action.filterId, entries, membershipContext); break;
    default: return selection;
  }
  return pruneFlowsSelection(next, entries, loaded);
}

/**
 * Reveal on open (AC11): the entry to tick back in so the flow open on the
 * canvas — via deep link, last-selected restore, New flow, Create team or a
 * rail menu action — is never invisible in the rail. `null` when nothing needs
 * to change; only that one entry is touched.
 */
export function revealKeyForProc(proc, selection) {
  const key = procEntryKey(proc);
  if (!key) return null;
  return isEntryShown(normalizeSelection(selection), key) ? null : key;
}

/**
 * What the rail renders under the selection (AC5): the shown teams and drafts,
 * a per-section hint when a non-empty section is entirely hidden, and the
 * page-level hint when nothing at all is selected. An empty section keeps its
 * existing empty-state copy, so it gets no filter hint.
 */
export function flowsRailView({ teams = [], drafts = [], selection } = {}) {
  const sel = normalizeSelection(selection);
  const shownTeams = (teams || []).filter(t => isEntryShown(sel, teamKey(t.id)));
  const shownDrafts = (drafts || []).filter(d => isEntryShown(sel, draftKey(d.id)));
  const total = (teams || []).length + (drafts || []).length;
  return {
    teams: shownTeams,
    drafts: shownDrafts,
    teamsHint: teams.length > 0 && shownTeams.length === 0 ? ALL_TEAMS_HIDDEN_HINT : null,
    draftsHint: drafts.length > 0 && shownDrafts.length === 0 ? ALL_DRAFTS_HIDDEN_HINT : null,
    nothingSelected: total > 0 && shownTeams.length + shownDrafts.length === 0,
  };
}
