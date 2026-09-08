'use strict';

// The work item (PR or issue) an event happened on — extracted from a GitHub
// event payload, once, for everybody (#2101 AC2).
//
// This lived inside github-event-log.js (#1827), which is the *writer* of the
// event-transparency log and therefore touches `fs`. The pending-queue
// projection needs the identical extraction (`orchestrator/pending-queue.js`,
// which advertises itself as fs-free), so the function moved down here into a
// module that is pure by construction: no `fs`, no `require` beyond this file,
// no disk side effects on import. Both callers require it from here, so
// "which PR is waiting" and "which PR did we process" can never disagree.
//
// github-event-log.js re-exports `extractWorkItem` unchanged, so its existing
// importers and tests keep working.

// Pull the work item (PR or issue) out of an event payload, best-effort and
// null-safe (#1827). PR events carry `payload.pull_request` (the poller enriches
// it with `title`/`html_url` before this runs — see
// github-poller._enrichPullRequestPayload); issue events carry `payload.issue`
// natively. An `issue_comment` on a PR arrives as `payload.issue` with a nested
// `pull_request` marker and is classified `kind: 'pr'` accordingly (#1848). A
// payload with neither (e.g. `push`), or an oddly-shaped one, yields null — this
// must never throw, since it feeds both the strictly best-effort event-log
// writer and the pending-queue list projection.
// `title`/`url` may individually be null when the payload is partial.
//
// `closesIssues` (#1833 item 3) is carried only for a PR whose enriched
// `pull_request.closesIssues` holds the issue number(s) it resolves (parsed
// from the PR body + head branch by the poller — see
// github-poller._enrichPullRequestPayload). Omitted entirely when there is no
// parseable linkage, so issue rows and un-enriched PR rows are unaffected.
function extractWorkItem(payload) {
  try {
    const p = payload || {};
    const src = (p.pull_request && typeof p.pull_request === 'object')
      ? { kind: 'pr', item: p.pull_request }
      : (p.issue && typeof p.issue === 'object')
        // GitHub fires `issue_comment` for both issues and PRs; a PR's issue
        // object carries a nested `pull_request` marker (#1848). Classify it as
        // a PR so a comment on a pull request reads `PR`, not `Issue`.
        ? { kind: p.issue.pull_request ? 'pr' : 'issue', item: p.issue }
        : null;
    if (!src || src.item.number == null) return null;
    const workItem = {
      kind: src.kind,
      number: src.item.number,
      title: typeof src.item.title === 'string' ? src.item.title : null,
      url: typeof src.item.html_url === 'string' ? src.item.html_url : null,
    };
    if (src.kind === 'pr' && Array.isArray(src.item.closesIssues)) {
      const closes = src.item.closesIssues.filter((n) => Number.isInteger(n) && n > 0);
      if (closes.length) workItem.closesIssues = closes;
    }
    return workItem;
  } catch {
    return null;
  }
}

module.exports = {
  extractWorkItem,
};
