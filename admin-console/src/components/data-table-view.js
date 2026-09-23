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

/**
 * The searchable text a single column contributes for one row.
 *
 * By default a column is filtered on its raw row value (`row[col.key]`), which
 * is correct for every column that shows that value verbatim (or merely styles
 * it). But a column whose `render` maps the raw value to a *different* displayed
 * string — e.g. a raw account id shown as a person's name, or a raw event key
 * shown as a friendly label — must be searched on what the user actually sees,
 * or typing the visible text matches nothing (the false-negative in #2442).
 *
 * Such a column supplies an optional `filterValue(rawValue, row) => string`
 * accessor returning the text to search. It may return the display string alone,
 * or the display string *plus* the raw value (space-joined) when both should stay
 * searchable — e.g. Token Usage keeps the raw account id matchable alongside the
 * resolved name. When no `filterValue` is present the raw value is used, so every
 * existing consumer is unaffected.
 *
 * @param {{ key?: string, filterValue?: (raw: any, row: object) => any }} col
 * @param {object} row
 * @returns {string} lowercased searchable text ('' when the column has none)
 */
export function columnFilterText(col, row) {
  if (!col || row == null) return '';
  let val;
  if (typeof col.filterValue === 'function') {
    val = col.filterValue(row[col.key], row);
  } else {
    val = row[col.key];
  }
  return val == null ? '' : String(val).toLowerCase();
}

/**
 * Whether a row matches the free-text filter across any of its columns.
 *
 * An empty/whitespace-only query matches every row. Otherwise the row matches
 * when any column's searchable text (see `columnFilterText`) contains the query
 * — the query is compared verbatim (only lower-cased), matching the previous
 * predicate so numeric-column and substring filtering behave exactly as before.
 *
 * @param {object} row
 * @param {Array} columns
 * @param {string} query raw filter text
 * @returns {boolean}
 */
export function rowMatchesFilter(row, columns, query) {
  const q = typeof query === 'string' ? query.toLowerCase() : '';
  if (!q.trim()) return true;
  const cols = Array.isArray(columns) ? columns : [];
  return cols.some((col) => {
    const text = columnFilterText(col, row);
    return text !== '' && text.includes(q);
  });
}

/** How many column names to spell out in the filter placeholder before eliding. */
export const MAX_FILTER_HINT_COLUMNS = 3;

/**
 * Self-describing placeholder for the DataTable filter input.
 *
 * A bare "Filter…" tells a first-time user nothing about what typing there
 * actually does — the table filters across *every* column's values, but that
 * is invisible. Naming the first few visible column headers ("Filter by Name,
 * Environment, Status…") makes the control intuitive: the user sees exactly
 * which fields their text is matched against.
 *
 * Only visible (non-`hidden`) columns with a non-empty text `label` are named
 * — icon-only / action columns (blank label) and search-only hidden columns
 * are skipped so the hint stays short and truthful about what's on screen.
 * Falls back to a plain "Filter…" when no column carries a usable label.
 *
 * @param {Array<{label?: string, hidden?: boolean}>} columns
 * @returns {string}
 */
export function filterPlaceholder(columns = []) {
  const labels = [];
  for (const col of Array.isArray(columns) ? columns : []) {
    if (!col || col.hidden) continue;
    const label = typeof col.label === 'string' ? col.label.trim() : '';
    if (!label) continue;
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) return 'Filter…';
  const shown = labels.slice(0, MAX_FILTER_HINT_COLUMNS);
  const suffix = labels.length > shown.length ? '…' : '';
  return `Filter by ${shown.join(', ')}${suffix}`;
}
