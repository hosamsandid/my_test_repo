import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard (no pure module — the columns are inline component config, same
// as github-event-log-when.test.js). Locks in the #1827 rework of the Processed
// events table: surface the work item (PR/issue #number + title), drop the raw
// event-key sub-line, and de-emphasise Repository.
const src = readFileSync(
  fileURLToPath(new URL('./GithubEventLog.jsx', import.meta.url)),
  'utf8',
);

test('AC3: the Event cell no longer renders the raw event-key sub-line', () => {
  // The old view rendered the raw key `v` in a muted mono sub-line guarded by
  // `showRaw`. Both must be gone — the friendly name + (label) is all that's left.
  assert.doesNotMatch(src, /showRaw/);
});

test('AC4: a Work item column links the PR/issue via WorkItemCell', () => {
  assert.match(src, /label: 'Work item', render: \(_v, row\) => <WorkItemCell workItem={row\.workItem} repo={row\.repo} \/>/);
  // The link opens in a new tab with rel="noopener".
  assert.match(src, /target="_blank"\s*\n\s*rel="noopener noreferrer"/);
});

test('AC5: a Title column renders via TitleCell with hover-truncation', () => {
  assert.match(src, /label: 'Title', render: v => <TitleCell title={v} \/>/);
  assert.match(src, /textOverflow: 'ellipsis'/);
});

test('AC6: Repository is de-emphasised via RepoCell but stays sortable/filterable', () => {
  // Still a real column keyed on the full `repo` value (so sort + filter work),
  // rendered as the muted short name.
  assert.match(src, /key: 'repo', label: 'Repository', render: v => <RepoCell repo={v} \/>/);
  assert.match(src, /String\(repo\)\.split\('\/'\)\.pop\(\)/);
});

test('AC7: work-item number and title are filterable/sortable via flat row keys', () => {
  assert.match(src, /workItemNumber:/);
  assert.match(src, /workItemTitle:/);
  assert.match(src, /key: 'workItemNumber'/);
  assert.match(src, /key: 'workItemTitle'/);
});
