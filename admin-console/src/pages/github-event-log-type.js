/* Pure helper for the GitHub Event Log "Type" column (#1848).
 *
 * The PR/issue kind is already persisted on each entry as `workItem.kind`
 * (#1827). This maps it to the short, always-visible label the Type column
 * shows — `PR` for a pull request, `Issue` for an issue — driven purely by the
 * stored kind, so it is correct even when the Event column shows a raw fallback
 * key (e.g. `pull_request_review.created`).
 *
 * Returns `null` for a row with no work item (push / create / delete / release)
 * or a legacy row written before `workItem` was persisted (no `kind`) — the
 * caller renders a neutral `—`. Never guesses a type from anything but `kind`.
 */
export function workItemTypeLabel(workItem) {
  if (!workItem || typeof workItem !== 'object') return null;
  if (workItem.kind === 'pr') return 'PR';
  if (workItem.kind === 'issue') return 'Issue';
  return null;
}
