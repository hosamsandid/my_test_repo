/* Pure view helpers for the GitHub Issues plugin's issue-list pane (issue #1658).
 *
 * The pager (Previous / Next) and the title-filter empty state are small,
 * decision-only pieces of logic that the DOM controller (app.js) should not own
 * inline — extracting them keeps app.js a thin renderer and lets node:test cover
 * the rules, mirroring ui/markdown.js (UMD) + ui/markdown.test.js.
 *
 *   - normalizeQuery: the single definition of "is the user searching?" — trims
 *     the raw input; an empty / whitespace-only box means the normal listing
 *     (AC9). The server sanitises further (strips qualifier colons); this is only
 *     the UI's search-vs-list switch and the text echoed in the empty state.
 *   - pagerState: Previous enabled only past page 1, Next only while the server
 *     says more pages exist (AC2) — used for both the listing and search results
 *     (AC7).
 *   - emptyMessage: the "no matches" search empty state, kept DISTINCT from the
 *     "No … issues in this repository." listing empty state (AC10).
 *
 * Dual use: required as CommonJS by the broker's node:test suite, and loaded in
 * the browser as `window.AEEIssueList`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AEEIssueList = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalizeQuery(text) {
    return String(text == null ? '' : text).trim();
  }

  function isSearching(text) {
    return normalizeQuery(text).length > 0;
  }

  // Given the current 1-based page and the server's hasMore flag, decide the
  // pager. A non-integer / < 1 page defensively clamps to 1.
  function pagerState(page, hasMore) {
    var p = Number(page);
    if (!Number.isInteger(p) || p < 1) p = 1;
    return { page: p, hasPrev: p > 1, hasNext: !!hasMore, label: 'Page ' + p };
  }

  // The empty-state line: distinct copy for a search that matched nothing vs an
  // empty repository listing.
  function emptyMessage(query, state) {
    var q = normalizeQuery(query);
    if (q) return 'No issues match “' + q + '”.';
    var prefix = state === 'all' ? '' : (state || 'open') + ' ';
    return 'No ' + prefix + 'issues in this repository.';
  }

  return {
    normalizeQuery: normalizeQuery,
    isSearching: isSearching,
    pagerState: pagerState,
    emptyMessage: emptyMessage,
  };
}));
