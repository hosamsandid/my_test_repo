'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  MERGE_STATE_MAP,
  issuesClosedByPr,
  checkRollup,
  reviewDecision,
  addedFilesOf,
  baseFileIndex,
  issueToTicketObject,
  prToTicketObject,
  linkIssuesToPrs,
  resolveTicketThresholds,
} = require('./ticket-reconcile-sweep');
const { DEFAULT_TICKET_THRESHOLDS, checkSuperseded } = require('./ticket-reconciler');

// --- issue ↔ PR linkage, the strict direction -------------------------------

test('issuesClosedByPr reads every closing keyword GitHub honours', () => {
  assert.deepStrictEqual(issuesClosedByPr({ body: 'Closes #2115' }), [2115]);
  assert.deepStrictEqual(issuesClosedByPr({ body: 'fixes #7\nresolved #8' }), [7, 8]);
  assert.deepStrictEqual(issuesClosedByPr({ title: 'Close #12', body: '' }), [12]);
  assert.deepStrictEqual(issuesClosedByPr({ body: 'Closes: #99' }), [99]);
});

test('issuesClosedByPr ignores a bare mention — attribution must not guess', () => {
  assert.deepStrictEqual(issuesClosedByPr({ body: 'See #2115 for background' }), []);
  assert.deepStrictEqual(issuesClosedByPr({ body: 'part of the #2112 epic' }), []);
  assert.deepStrictEqual(issuesClosedByPr({}), []);
});

test('issuesClosedByPr dedupes a repeated reference', () => {
  assert.deepStrictEqual(issuesClosedByPr({ title: 'Closes #5', body: 'Closes #5' }), [5]);
});

test('linkIssuesToPrs attaches the loose direction from the raw PR items', () => {
  const issues = [{ number: 100 }, { number: 200 }];
  const rawPrs = [
    { number: 7, title: 'Work', body: 'Closes #100', head: { ref: 'feat/100-x' } },
    { number: 8, title: 'Other', body: '', head: { ref: 'feat/200-y' } },
  ];
  const linked = linkIssuesToPrs(issues, rawPrs);
  assert.deepStrictEqual(linked[0].linkedPrNumbers, [7]);
  // The branch-name half of the loose link — lost if shaped PRs are passed in.
  assert.deepStrictEqual(linked[1].linkedPrNumbers, [8]);
});

// --- CI rollup --------------------------------------------------------------

test('checkRollup asserts failure only on a CONCLUDED negative conclusion', () => {
  assert.strictEqual(checkRollup([{ status: 'completed', conclusion: 'failure', name: 'api' }]).state, 'failure');
  assert.strictEqual(checkRollup([{ status: 'in_progress' }]).state, 'pending');
  assert.strictEqual(checkRollup([{ status: 'queued' }]).state, 'pending');
  assert.strictEqual(checkRollup([{ status: 'completed', conclusion: 'success' }]).state, 'success');
});

test('checkRollup treats neutral and skipped as neither pass nor fail', () => {
  const r = checkRollup([
    { status: 'completed', conclusion: 'skipped', name: 'a' },
    { status: 'completed', conclusion: 'neutral', name: 'b' },
  ]);
  assert.strictEqual(r.state, 'none');
  assert.deepStrictEqual(r.failed, []);
});

test('checkRollup keeps "no CI at all" apart from "CI is green"', () => {
  // `approved-not-merged` must not read an unconfigured repo as verified.
  assert.strictEqual(checkRollup([], []).state, 'none');
});

test('checkRollup names the failing checks and folds in commit statuses', () => {
  const r = checkRollup(
    [{ status: 'completed', conclusion: 'timed_out', name: 'e2e' }],
    [{ state: 'error', context: 'CodeQL' }, { state: 'success', context: 'lint' }],
  );
  assert.strictEqual(r.state, 'failure');
  assert.deepStrictEqual(r.failed, ['e2e', 'CodeQL']);
});

// --- review decision --------------------------------------------------------

test('reviewDecision counts only each reviewer latest non-COMMENTED review', () => {
  const r = reviewDecision([
    { user: { login: 'a' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-01T00:00:00Z' },
    { user: { login: 'a' }, state: 'APPROVED', submitted_at: '2026-09-02T00:00:00Z' },
    { user: { login: 'b' }, state: 'COMMENTED', submitted_at: '2026-09-03T00:00:00Z' },
  ]);
  assert.strictEqual(r.decision, 'APPROVED');
  assert.strictEqual(r.approvedAt, '2026-09-02T00:00:00.000Z');
});

test('reviewDecision: one outstanding CHANGES_REQUESTED outranks any approvals', () => {
  const r = reviewDecision([
    { user: { login: 'a' }, state: 'APPROVED', submitted_at: '2026-09-01T00:00:00Z' },
    { user: { login: 'b' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-01T00:00:00Z' },
  ]);
  assert.strictEqual(r.decision, 'CHANGES_REQUESTED');
  assert.strictEqual(r.approvedAt, null);
});

test('reviewDecision ignores a dismissed review', () => {
  const r = reviewDecision([
    { user: { login: 'a' }, state: 'DISMISSED', submitted_at: '2026-09-01T00:00:00Z' },
  ]);
  assert.strictEqual(r.decision, null);
});

test('reviewDecision on no reviews is null, never APPROVED', () => {
  assert.strictEqual(reviewDecision([]).decision, null);
  assert.strictEqual(reviewDecision(undefined).decision, null);
});

// --- file sets --------------------------------------------------------------

test('addedFilesOf keeps only status:added', () => {
  assert.deepStrictEqual(
    addedFilesOf([
      { filename: 'a.js', status: 'added' },
      { filename: 'b.js', status: 'modified' },
      { filename: 'c.js', status: 'removed' },
      { filename: 'd.js', status: 'renamed' },
    ]),
    ['a.js'],
  );
});

test('baseFileIndex indexes blobs and reports truncation honestly', () => {
  const full = baseFileIndex({ tree: [{ type: 'blob', path: 'a.js' }, { type: 'tree', path: 'dir' }] });
  assert.ok(full.paths.has('a.js'));
  assert.ok(!full.paths.has('dir'));
  assert.strictEqual(full.complete, true);
  assert.strictEqual(baseFileIndex({ tree: [], truncated: true }).complete, false);
  assert.strictEqual(baseFileIndex(null).complete, true);
});

// --- shaping ----------------------------------------------------------------

test('issueToTicketObject carries the label application times from the timeline', () => {
  const obj = issueToTicketObject(
    {
      number: 100, title: 'T', body: 'Part of epic #9', state: 'open',
      html_url: 'u', created_at: 'c', updated_at: 'u2',
      labels: [{ name: 'ready-2' }, { name: 'enhancement' }],
    },
    {
      repo: 'acme/app',
      timeline: [{ event: 'labeled', label: { name: 'ready-2' }, created_at: '2026-09-08T10:00:00Z' }],
      linkedPrNumbers: [7],
    },
  );
  assert.strictEqual(obj.kind, 'issue');
  assert.strictEqual(obj.repo, 'acme/app');
  assert.strictEqual(obj.labels[0].appliedAt, '2026-09-08T10:00:00Z');
  assert.strictEqual(obj.labels[1].appliedAt, null);
  assert.deepStrictEqual(obj.linkedPrNumbers, [7]);
});

test('prToTicketObject maps GitHub mergeable_state onto one vocabulary', () => {
  for (const [rest, want] of Object.entries(MERGE_STATE_MAP)) {
    const pr = prToTicketObject({ number: 1, mergeable: true, mergeable_state: rest });
    assert.strictEqual(pr.mergeStateStatus, want, `${rest} → ${want}`);
  }
  assert.strictEqual(prToTicketObject({ number: 1, mergeable_state: 'nonsense' }).mergeStateStatus, 'UNKNOWN');
});

test('prToTicketObject keeps mergeable three-valued — null is UNKNOWN, not clean', () => {
  // GitHub computes mergeability asynchronously and answers null until it is done.
  assert.strictEqual(prToTicketObject({ number: 1, mergeable: null }).mergeable, 'UNKNOWN');
  assert.strictEqual(prToTicketObject({ number: 1, mergeable: true }).mergeable, 'MERGEABLE');
  assert.strictEqual(prToTicketObject({ number: 1, mergeable: false }).mergeable, 'CONFLICTING');
});

test('prToTicketObject intersects added files against the base index', () => {
  const pr = prToTicketObject(
    { number: 1, mergeable: true, base: { ref: 'main' } },
    {
      files: [{ filename: 'a.js', status: 'added' }, { filename: 'new.js', status: 'added' }],
      baseFileIndex: baseFileIndex({ tree: [{ type: 'blob', path: 'a.js' }] }),
    },
  );
  assert.deepStrictEqual(pr.addedFiles, ['a.js', 'new.js']);
  assert.deepStrictEqual(pr.addedFilesInBase, ['a.js']);
  assert.strictEqual(pr.baseFileIndexComplete, true);
  // …and the reconciler therefore declines: `new.js` is genuinely new.
  assert.strictEqual(checkSuperseded(pr), null);
});

test('a PR whose base tree could not be read never accuses anyone', () => {
  const pr = prToTicketObject(
    { number: 1, mergeable: true, state: 'open' },
    { files: [{ filename: 'a.js', status: 'added' }] }, // no baseFileIndex — the fetch failed
  );
  assert.strictEqual(pr.baseFileIndexComplete, false);
  assert.strictEqual(checkSuperseded(pr), null);
});

test('prToTicketObject records merged from either merged flag', () => {
  assert.strictEqual(prToTicketObject({ number: 1, merged: true }).merged, true);
  assert.strictEqual(prToTicketObject({ number: 1, merged_at: '2026-09-08T00:00:00Z' }).merged, true);
  assert.strictEqual(prToTicketObject({ number: 1 }).merged, false);
});

test('prToTicketObject derives closesIssues when the caller supplies none', () => {
  assert.deepStrictEqual(prToTicketObject({ number: 1, body: 'Closes #42' }).closesIssues, [42]);
  assert.deepStrictEqual(
    prToTicketObject({ number: 1, body: 'Closes #42' }, { closesIssues: [7] }).closesIssues,
    [7],
  );
});

// --- thresholds -------------------------------------------------------------

test('resolveTicketThresholds ignores a non-positive or non-finite override', () => {
  assert.deepStrictEqual(resolveTicketThresholds(null), { ...DEFAULT_TICKET_THRESHOLDS });
  assert.deepStrictEqual(resolveTicketThresholds({ claimedDoneMs: 0 }), { ...DEFAULT_TICKET_THRESHOLDS });
  assert.deepStrictEqual(resolveTicketThresholds({ claimedDoneMs: NaN }), { ...DEFAULT_TICKET_THRESHOLDS });
  assert.strictEqual(resolveTicketThresholds({ claimedDoneMs: 60000 }).claimedDoneMs, 60000);
});

test('resolveTicketThresholds never lets an unknown key through', () => {
  const t = resolveTicketThresholds({ somethingElse: 5 });
  assert.deepStrictEqual(Object.keys(t).sort(), Object.keys(DEFAULT_TICKET_THRESHOLDS).sort());
});
