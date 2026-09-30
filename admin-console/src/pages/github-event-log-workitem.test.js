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
  // #1898: the column opts into DataTable `wrap` so the `#<n>` + `→ closes #…`
  // trail wraps within the column instead of widening the table.
  assert.match(src, /label: 'Work item', wrap: true, render: \(_v, row\) => <WorkItemCell workItem={row\.workItem} repo={row\.repo} \/>/);
  // The link opens in a new tab with rel="noopener".
  assert.match(src, /target="_blank"\s*\n\s*rel="noopener noreferrer"/);
});

test('AC5: a Title column renders via TitleCell and wraps (no fixed-width ellipsis)', () => {
  // #1898: Title opts into DataTable `wrap`; the old fixed-width single-line
  // ellipsis truncation is gone so long titles wrap within the column and keep
  // the table at 100% width with no horizontal scrollbar.
  // #2032 threads a per-row `hint` in: a direct-hand-off row has no work item,
  // so this column carries the producer's note instead of a title and the
  // hover has to say which. The title binding itself is unchanged.
  assert.match(src, /label: 'Title', wrap: true, render: \(v, row\) => <TitleCell title={handoffNoteDisplay\(row\) \|\| v} hover={v} hint={handoffTitleHint\(row\)} \/>/);
  // #2614 caps Repository/Actor with an ellipsis, so this guard is scoped to
  // the Title cell itself: a title is never truncated.
  const titleCell = src.slice(src.indexOf('function TitleCell'), src.indexOf('function RepoCell'));
  assert.doesNotMatch(titleCell, /ellipsis|cappedCellStyle/);
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

// ── #1898: table fits 100% width, no horizontal scrollbar ──────────────────
// The wide columns (Work item, Title, Outcomes) opt into the shared DataTable
// per-column `wrap` flag so long content wraps within its column instead of
// pushing the table past the page width. Short columns (Time, Repository, Type,
// Actor) stay single-line, and no other DataTable page is touched (AC9).
test('#1898: the three wide columns opt into per-column wrap', () => {
  assert.match(src, /label: 'Work item', wrap: true/);
  assert.match(src, /label: 'Title', wrap: true/);
  assert.match(src, /label: 'Outcomes', sortable: false, wrap: true/);
});

test('#1898: short columns are NOT wrapped (stay single-line)', () => {
  // Guard against over-wrapping: these column definitions carry no wrap flag.
  assert.match(src, /key: 'ts', label: 'Time',(?![^}]*wrap: true)/);
  assert.match(src, /key: 'repo', label: 'Repository',(?![^}]*wrap: true)/);
  assert.match(src, /key: 'actor', label: 'Actor',(?![^}]*wrap: true)/);
});

// ── #2614: regression of #1898 — every column gets a bounded share ─────────
// Auto table layout gives a nowrap column its full text width, while a wrap
// column may shrink to ~one character. Once the nowrap columns alone filled
// the container, Title and Outcomes collapsed and the table overflowed again.
// Each guard below was checked to fail when its fix is reverted.
test('#2614: Title, Event and Outcomes carry a width floor', () => {
  assert.match(src, /const COL_FLOOR = \{ title: '\d+(\.\d+)?rem', event: '\d+(\.\d+)?rem', outcomes: '\d+(\.\d+)?rem' \}/);
  const titleCell = src.slice(src.indexOf('function TitleCell'), src.indexOf('function RepoCell'));
  assert.match(titleCell, /display: 'block', minWidth: COL_FLOOR\.title/);
  const eventCol = src.slice(src.indexOf("{ key: 'event', label: 'Event'"), src.indexOf("{ key: 'actor'"));
  assert.match(eventCol, /display: 'block', minWidth: COL_FLOOR\.event/);
  const outcomesCol = src.slice(src.indexOf("{ key: 'outcomes', label: 'Outcomes'"));
  assert.match(outcomesCol, /minWidth: COL_FLOOR\.outcomes/);
  // The floor wraps the no-subscriber line as well, not only the outcome list.
  assert.match(outcomesCol, /row\.noMatchingTrigger \? <NoMatchLine \/> : list\.map/);
});

test('#2614: the Event column wraps instead of claiming its full label width', () => {
  assert.match(src, /key: 'event', label: 'Event', wrap: true/);
});

test('#2614: single-line Repository and Actor are capped with an ellipsis and a hover', () => {
  assert.match(src, /const COL_CAP = \{ repo: '\d+(\.\d+)?rem', actor: '\d+(\.\d+)?rem' \}/);
  const capped = src.slice(src.indexOf('const cappedCellStyle'), src.indexOf('/* ── Outcome line'));
  assert.match(capped, /maxWidth: max/);
  assert.match(capped, /textOverflow: 'ellipsis'/);
  const repoCell = src.slice(src.indexOf('function RepoCell'), src.indexOf('function ActorCell'));
  assert.match(repoCell, /title=\{repo\}/);
  assert.match(repoCell, /cappedCellStyle\(COL_CAP\.repo\)/);
  const actorCell = src.slice(src.indexOf('function ActorCell'), src.indexOf('function shortRef'));
  assert.match(actorCell, /title=\{actor\} style=\{cappedCellStyle\(COL_CAP\.actor\)\}/);
  assert.match(src, /key: 'actor', label: 'Actor', render: v => <ActorCell actor=\{v\} \/>/);
});

test('#1898: an outcome chip breaks long unbroken tokens instead of overflowing (AC5)', () => {
  // The chip label can carry a long agent id; it must be breakable so a single
  // chip can never force a horizontal scrollbar.
  assert.doesNotMatch(src, /border: `1px solid \$\{color\}`,\s*\n\s*whiteSpace: 'nowrap'/);
  assert.match(src, /overflowWrap: 'anywhere'/);
});
