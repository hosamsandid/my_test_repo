/**
 * data-table-view.js — pure, React-free decision helpers for DataTable.
 *
 * Extracted per the #651 convention so the "which empty state" logic is
 * unit-testable without mounting the component.
 */

/**
 * Decide which "no rows to show" state a DataTable body should render.
 *
 * There are two very different reasons a table has no rows, and they need
 * different copy:
 *
 *   - The dataset itself is empty  → show the caller's `emptyText`, which
 *     typically guides a first-time user to the create action
 *     ("No GitHub tokens stored yet. Click 'New Token' to add one.").
 *
 *   - The dataset has rows but the active filter matches none of them →
 *     showing the create-CTA emptyText is misleading (it reads as "there is
 *     nothing here", when really the filter just excluded everything). Show a
 *     distinct "no matches" message that names the query and offers a way back.
 *
 * @param {object} args
 * @param {number} args.dataLength   total rows before filtering
 * @param {number} args.resultLength rows remaining after filtering
 * @param {string} args.filter       current filter text (raw)
 * @param {string} args.emptyText    caller-supplied empty-dataset copy
 * @returns {null | { kind: 'empty'|'no-match', text: string, showClear: boolean }}
 *          null when there are rows to render (no empty state needed).
 */
export function resolveEmptyState({ dataLength = 0, resultLength = 0, filter = '', emptyText = 'No data found' }) {
  if (resultLength > 0) return null;

  const query = typeof filter === 'string' ? filter.trim() : '';
  if (query && dataLength > 0) {
    return { kind: 'no-match', text: noMatchText(query), showClear: true };
  }
  return { kind: 'empty', text: emptyText, showClear: false };
}

/** Human-readable "nothing matched your filter" line, quoting the query. */
export function noMatchText(query) {
  return `No matches for “${query}”.`;
}
