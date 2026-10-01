'use strict';

// "Release claim" on the Flow Control board (#2754, follow-up to #2734).
//
// A row flagged "stuck — no progress, needs help" carries an orphaned
// `<wake>:wip` claim: the run that claimed it died, was disabled or reaped,
// and nothing alive will ever finish it. Releasing swaps the claim back to its
// wake label ON GITHUB — the label on GitHub stays the single source of truth,
// so the poller sees the re-applied wake and re-dispatches the item to its
// consumer on its next poll, exactly as if a person had re-applied it by hand.
// No in-process wake: one delivery path, nothing to dedup.
//
// Only ever on an explicit click: the board computes the release list, the
// route re-reads a FRESH board and refuses unless that row is still flagged
// needs-help, and every swap is written to the GitHub Event Log with the
// acting user (the console's audit trail records the request too).
//
// Pure apart from the injected `fetch`, so it unit-tests without a network.

const flowBoard = require('./flow-board');

// Event Log key for a release. Rendered by the console's
// INTERNAL_EVENT_LABELS (`admin-console/src/pages/agent-chat/trigger-summary.js`)
// — keep the two byte-identical.
const CLAIM_RELEASED_EVENT = 'flow-control.claim-released';

// Which claims a fresh board row lets a person release, or why not. The row
// is the server's own, re-read just before the swap, so a claim a live run
// picked up again (or a row that moved on) is never released.
function planClaimRelease(board, rowId) {
  if (!board || board.stale) {
    return { ok: false, status: 503, error: 'GitHub could not be read just now — try again in a moment' };
  }
  const row = (Array.isArray(board.rows) ? board.rows : []).find((r) => r && r.id === rowId);
  if (!row) return { ok: false, status: 404, error: 'That item is not on the board' };
  const block = row.needsHuman;
  if (!block || block.reason !== flowBoard.REASONS.needsHelp) {
    return { ok: false, status: 409, error: 'Only an item stuck on an orphaned claim can be released' };
  }
  const claims = Array.isArray(block.release) ? block.release : [];
  if (!claims.length) return { ok: false, status: 409, error: 'This item has no claim label to release' };
  return { ok: true, row, claims };
}

// Swap one claim back to its wake on GitHub. The claim goes first: if the
// wake were added first, the woken agent could claim it again before the old
// claim is deleted — and the delete would then remove the NEW claim. A 404 on
// the delete is fine (someone removed it already). The add mirrors
// `stampMirrorLabel`: on a failed add, create the label and retry once.
// Never throws; returns `{ ok, removed, applied, warning? }`.
async function swapClaimLabel({ fetchImpl, base, token, repo, number, claim, wake }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const issueUrl = `${base}/repos/${repo}/issues/${Number(number)}`;
  let removed = false;
  try {
    const del = await fetchImpl(`${issueUrl}/labels/${encodeURIComponent(claim)}`, { method: 'DELETE', headers });
    if (!del.ok && del.status !== 404) {
      return { ok: false, removed, applied: false, warning: `could not remove ${claim} from ${repo}#${number}: GitHub returned ${del.status}` };
    }
    removed = true;
  } catch (err) {
    return { ok: false, removed, applied: false, warning: `could not remove ${claim} from ${repo}#${number}: ${err.message}` };
  }
  const add = () => fetchImpl(`${issueUrl}/labels`, { method: 'POST', headers, body: JSON.stringify({ labels: [wake] }) });
  try {
    let resp = await add();
    if (!resp.ok) {
      await fetchImpl(`${base}/repos/${repo}/labels`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: wake, color: 'ededed', description: 'label applied by the platform' }),
      }).catch(() => {});
      resp = await add();
    }
    if (resp.ok) return { ok: true, removed, applied: true };
    return {
      ok: false, removed, applied: false,
      warning: `${claim} was removed from ${repo}#${number} but ${wake} could not be applied (GitHub returned ${resp.status}) — add ${wake} by hand to wake its agent`,
    };
  } catch (err) {
    return {
      ok: false, removed, applied: false,
      warning: `${claim} was removed from ${repo}#${number} but ${wake} could not be applied (${err.message}) — add ${wake} by hand to wake its agent`,
    };
  }
}

// The GitHub Event Log line for one release — the "logged" half of the
// acceptance criterion. Repo-scoped like a poller row so it lands next to the
// item's own events; `outcomes` stays empty (the console reader resolves an
// agent per outcome) and `noMatchingTrigger` false (nothing was dropped — the
// poller's own row records the delivery that follows).
function buildClaimReleaseLogEntry({ teamId, rowId, actor, claim, result, now = new Date() }) {
  const ts = now.toISOString();
  return {
    ts,
    eventId: `claim-release:${claim.repo}#${claim.number}:${now.getTime()}`,
    repo: claim.repo,
    event: CLAIM_RELEASED_EVENT,
    actor: actor || null,
    createdAt: ts,
    label: claim.wake,
    ref: null,
    workItem: { kind: claim.kind === 'pr' ? 'pr' : 'issue', number: claim.number, title: null, url: null },
    noMatchingTrigger: false,
    outcomes: [],
    source: 'flow-control',
    claimRelease: {
      teamId, rowId, claim: claim.claim, wake: claim.wake,
      ok: !!(result && result.ok),
      ...(result && result.warning ? { warning: result.warning } : {}),
    },
  };
}

module.exports = {
  CLAIM_RELEASED_EVENT,
  planClaimRelease,
  swapClaimLabel,
  buildClaimReleaseLogEntry,
};
