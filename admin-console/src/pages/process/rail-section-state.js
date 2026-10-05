/**
 * Pure state of one Flows rail list section — Teams or Drafts (#2847).
 *
 * The rail used to collapse the in-flight `null` from `useApi` into `[]` and so
 * read "No teams yet." / "No drafts…" while the lists were still loading. This
 * keeps the four states apart:
 *
 *   'loading' — nothing loaded yet and no error (first load in flight)
 *   'error'   — the first load failed; never the empty copy, never endless loading
 *   'empty'   — loaded, genuinely nothing to show
 *   'list'    — loaded, rows to render
 *
 * Once data has arrived it wins over `loading`/`error`: `useApi` keeps the last
 * data across a refetch (and across a failed refetch), so the list stays visible
 * instead of dropping back to loading or the empty copy.
 *
 * `items` is the already-derived row list (e.g. teams filtered from agents);
 * `data` is the raw `useApi` payload, `null` until the first successful load.
 */

export const RAIL_SECTION_LOADING_TEXT = 'Loading…';

export const RAIL_SECTION_ERROR_TEXT = {
  teams: 'Couldn’t load teams.',
  drafts: 'Couldn’t load drafts.',
};

export function railSectionState({ data, error, items }) {
  if (data == null) return error ? 'error' : 'loading';
  return items && items.length > 0 ? 'list' : 'empty';
}
