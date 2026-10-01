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
 *     "No … issues in this repository." listing empty state (AC10). Worded for
 *     the selected item type (#2746): issues, pull requests, or both.
 *   - normType / typeNoun / isPullRequestItem: the Show selector (#2746) — the
 *     list can show pull requests so a PR-level gate label can be applied here.
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

  // The Show selector's value: issues (default) | prs | all — the same set the
  // broker accepts (github-client.js normType).
  function normType(type) {
    var t = String(type || 'issues').toLowerCase();
    return t === 'prs' || t === 'all' ? t : 'issues';
  }

  function typeNoun(type) {
    var t = normType(type);
    if (t === 'prs') return 'pull requests';
    if (t === 'all') return 'issues or pull requests';
    return 'issues';
  }

  // A shaped broker item is a pull request when the broker flagged it so.
  function isPullRequestItem(item) {
    return !!(item && item.isPullRequest);
  }

  // The empty-state line: distinct copy for a search that matched nothing vs an
  // empty repository listing.
  function emptyMessage(query, state, type) {
    var q = normalizeQuery(query);
    var noun = typeNoun(type);
    if (q) return 'No ' + noun + ' match “' + q + '”.';
    var prefix = state === 'all' ? '' : (state || 'open') + ' ';
    return 'No ' + prefix + noun + ' in this repository.';
  }

  return {
    normalizeQuery: normalizeQuery,
    isSearching: isSearching,
    pagerState: pagerState,
    emptyMessage: emptyMessage,
    normType: normType,
    typeNoun: typeNoun,
    isPullRequestItem: isPullRequestItem,
  };
}));
