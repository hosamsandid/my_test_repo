/**
 * import-agent-view.js — the pure decisions behind the Import Agent and Clone
 * Agent dialogs (#2684), kept out of the JSX per the #651 convention.
 *
 * Both dialogs used to offer "Standalone agent (no team)", which minted a bare
 * `role: 'agent'` the rail never lists (#2234): no row, no context menu. The
 * orchestrator now folds such a clone/import into a team of one, exactly like
 * create does (#2229/#2231), so the option says what it now does.
 */

// The <option value=""> label in both dialogs' team picker.
export const OWN_TEAM_OPTION_LABEL = 'Its own team (team of one)';

/**
 * What to put into the id and name fields after a 409 id-conflict.
 *
 * The id: whatever the user already typed wins; otherwise the server's
 * `suggestedId` — free by the same rule the resubmit is checked against,
 * including the `<id>-team` a team of one also claims. The bare `<id>-2`
 * fallback only covers an older server that sends no suggestion.
 *
 * The name: importing under a new id would otherwise keep the source's display
 * name, putting two identically-labelled agents side by side. Seed a
 * distinguishable one from the exported name, the same "(Copy)" Clone uses.
 *
 * @returns {{ newId: string, displayName: string }}
 */
export function importConflictSeed(data, typedId, typedName) {
  const id = (typedId || '').trim();
  const name = (typedName || '').trim();
  const source = data && typeof data.displayName === 'string' ? data.displayName.trim() : '';
  return {
    newId: id || (data && data.suggestedId) || (data && data.agentId ? `${data.agentId}-2` : ''),
    displayName: name || (source ? `${source} (Copy)` : ''),
  };
}

/**
 * The success notice after an import. `parentTeamId` is the team the agent
 * landed in — for a team-of-one import that is its own, freshly made team.
 */
export function importSuccessNotice(data) {
  const id = data && data.agentId;
  const warnings = data && Array.isArray(data.warnings) && data.warnings.length
    ? ` Warning: ${data.warnings.join('; ')}.`
    : '';
  if (data && data.teamOfOne) return `Agent '${id}' imported as its own team and started.${warnings}`;
  if (data && data.parentTeamId) return `Agent '${id}' imported into team '${data.parentTeamId}' and started.${warnings}`;
  return `Agent '${id}' imported and started.${warnings}`;
}
