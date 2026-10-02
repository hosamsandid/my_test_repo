/**
 * Pure decision for "does the Flows page's `?proc=` name something real?" (#2696).
 *
 * `?proc=` arrives from the rail, but also from an old `/process/<team>`
 * bookmark (forwarded unchanged by `ProcessTeamRedirect`), a shared link, or a
 * team/draft deleted since the link was made. The page used to mount the graph
 * panel for any value, so an unknown one showed an empty canvas with no
 * explanation. The last-selected restore already validated its value; this
 * gives the URL param the same check.
 *
 * Statuses:
 *   'none'      — no selection
 *   'ok'        — a team, a draft the viewer can see, or the transient 'import'
 *   'loading'   — teams or drafts not loaded yet; never say "not found" yet
 *   'verify'    — absent from the lists we hold, which may just be stale (a
 *                 draft or team created a moment ago, before its list refetch
 *                 landed): the page refetches both lists once for this scope
 *   'not-found' — still absent after a refetch made for this very scope
 *
 * 'loading' and 'verify' keep rendering the panel as before, so a slow load or
 * a fresh create never flashes the not-found state.
 */

// A URL param is typo/attacker-controlled; keep the echoed id readable.
export const MAX_ECHOED_SCOPE_LENGTH = 80;

// Scopes the page owns that are not a team or a draft.
const PAGE_SCOPES = new Set(['import']);

export function flowScopeStatus({ proc, teams, drafts, verifiedScope = null }) {
  if (!proc) return 'none';
  if (PAGE_SCOPES.has(proc)) return 'ok';
  if (!Array.isArray(teams) || !Array.isArray(drafts)) return 'loading';
  const known = proc.startsWith('draft:')
    ? drafts.some(d => d && `draft:${d.id}` === proc)
    : teams.some(t => t && t.id === proc);
  if (known) return 'ok';
  return verifiedScope === proc ? 'not-found' : 'verify';
}

/** Copy for the not-found state, naming the requested id. */
export function flowNotFoundCopy(proc) {
  const isDraft = typeof proc === 'string' && proc.startsWith('draft:');
  const raw = isDraft ? proc.slice('draft:'.length) : String(proc ?? '');
  const shown = raw.length > MAX_ECHOED_SCOPE_LENGTH
    ? `${raw.slice(0, MAX_ECHOED_SCOPE_LENGTH)}…`
    : raw;
  // "not found or no access" on purpose: the lists only hold what the viewer
  // may see, so a shared link must not reveal whether a hidden flow exists.
  return {
    title: isDraft ? `Draft "${shown}" not found` : `Flow "${shown}" not found`,
    hint: 'It may have been deleted, or you don\'t have access to it. Pick a team or draft on the left, or go back to the overview.',
    backLabel: 'Back to Flows',
  };
}
