// sync-repos-view.js — pure, dependency-free view logic for the "Sync
// repositories" progress UI (#1342), shared by the per-agent control on the
// Agents page and the per-environment control on the Working Environments page.
// Kept out of the JSX (per the #651 convention) so it can be node:test covered.
//
// The server (POST /api/agents/:id/sync-repositories and
// POST /api/environments/:id/sync-agents) streams NDJSON lines — the
// /api/teams/stream mould — with these event types:
//   { type:'plan', agentCount, repoCount?, agents? }
//   { type:'agent', agentId, displayName }
//   { type:'repo', agentId, name, url, status, reason?, error?, fromCache? }
//   { type:'agent-skip', agentId, reason }      (no workspace → nothing cloned)
//   { type:'agent-error', agentId, error }      (orchestrator/transport failure)
//   { type:'agent-done', agentId, summary }
//   { type:'complete', agentCount, totals }
//   { type:'error', status, error }             (fatal — aborts the run)

/**
 * Consume an OK NDJSON sync response: forward each parsed event to `onEvent`,
 * resolve with the terminal `complete` payload (or null if none arrived).
 * Throws (with `.status` when present) on a terminal `error` event.
 */
export async function consumeSyncStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let complete = null;
  let errorEv = null;
  const handle = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'error') errorEv = ev;
    else if (ev.type === 'complete') complete = ev;
    if (onEvent) onEvent(ev);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* skip a corrupt line */ }
    }
  }
  const tail = buf.trim();
  if (tail) { try { handle(JSON.parse(tail)); } catch { /* ignore */ } }
  if (errorEv) {
    const err = new Error(errorEv.error || `HTTP ${errorEv.status || 502}`);
    if (errorEv.status) err.status = errorEv.status;
    throw err;
  }
  return complete;
}

// The wording for each D1 safety skip (#2066). Keyed on the stable `reason`
// code cloneAdjustSafety() returns, with the orchestrator's own `detail` — which
// names the specific thing blocking THIS clone — appended by repoStatusText, so
// the reader is told what to do rather than merely that something is wrong.
const BLOCKED_REASON_LEAD = {
  'path-occupied': 'Left alone',
  'uncommitted-changes': 'Left alone — uncommitted work',
  'unpushed-commits': 'Left alone — unpushed work',
  'no-upstream': 'Left alone — unpushed work',
  'upstream-unknown': 'Left alone — could not verify',
  'detached-head': 'Left alone — no branch checked out',
  'foreign-remote': 'Left alone — remote was changed by hand',
  'no-remote': 'Left alone — no remote to verify against',
  'status-unreadable': 'Left alone — git state unreadable',
};

/** Human label for a single repo result line. */
export function repoStatusText(status, reason, detail) {
  if (status === 'cloned') return 'Cloned';
  if (status === 'adjusted') return 'Brought up to date';
  if (status === 'failed') return 'Failed';
  if (status === 'retained') return 'Kept — no longer declared, nothing deleted';
  if (status === 'skipped') {
    const lead = BLOCKED_REASON_LEAD[reason];
    if (lead) return detail ? `${lead}: ${detail}` : lead;
    return 'Already up to date';
  }
  return status || 'Unknown';
}

/**
 * Symbol prefix for a repo line, keyed on outcome.
 *
 * A D1 safety skip gets its own `!` rather than sharing `✗` with a failure or
 * `·` with an already-up-to-date repository: the three need different things
 * from the reader — nothing, push-or-commit-then-catch-up, and fix the
 * credentials or the URL — so they must not look alike.
 */
export function repoStatusSymbol(status, blocked = false) {
  if (status === 'cloned' || status === 'adjusted') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'skipped' && blocked) return '!';
  return '·';
}

/**
 * One-line human summary of a completed run's totals.
 * e.g. "3 cloned, 1 brought up to date, 1 left alone" — omits zero buckets, and
 * returns a friendly message when there was nothing to do.
 */
export function summaryText(totals) {
  const t = totals || {};
  const cloned = t.cloned || 0;
  const adjusted = t.adjusted || 0;
  const skipped = t.skipped || 0;
  const blocked = t.blocked || 0;
  const failed = t.failed || 0;
  const retained = t.retained || 0;
  if (cloned === 0 && adjusted === 0 && skipped === 0 && failed === 0 && retained === 0) {
    return 'Nothing to do — no repositories are declared on this environment.';
  }
  const parts = [];
  if (cloned) parts.push(`${cloned} cloned`);
  if (adjusted) parts.push(`${adjusted} brought up to date`);
  // `blocked` is a subset of `skipped`, so the already-up-to-date bucket is the
  // remainder: lumping the two together would hide the one that needs action.
  if (skipped - blocked > 0) parts.push(`${skipped - blocked} already up to date`);
  if (blocked) parts.push(`${blocked} left alone`);
  if (failed) parts.push(`${failed} failed`);
  if (retained) parts.push(`${retained} kept`);
  return parts.join(', ') + '.';
}

/**
 * Turn one stream event into a display row, or null for an event that has no
 * row of its own (`plan`, `agent-done`, `complete`).
 *
 * Extracted from SyncReposPanel (#2066) so the per-agent panel and the
 * save-time propagation dialog cannot end up describing the same outcome
 * differently — the two surfaces render this, they do not each interpret the
 * stream.
 *
 * @returns {{kind:'agent'|'repo'|'note', text: string, symbol?: string,
 *            status?: string, blocked?: boolean}|null}
 */
export function syncEventRow(ev, { showAgentHeaders = false } = {}) {
  if (!ev) return null;
  if (ev.type === 'agent') {
    if (!showAgentHeaders) return null;
    return { kind: 'agent', text: ev.displayName || ev.agentId };
  }
  if (ev.type === 'repo') {
    const label = repoStatusText(ev.status, ev.reason, ev.detail);
    const applied = Array.isArray(ev.applied) && ev.applied.length ? ` (${ev.applied.join('; ')})` : '';
    return {
      kind: 'repo',
      symbol: repoStatusSymbol(ev.status, ev.blocked),
      status: ev.status,
      blocked: !!ev.blocked,
      text: `${ev.name} — ${label}${applied}${ev.error ? `: ${ev.error}` : ''}`,
    };
  }
  if (ev.type === 'agent-skip') {
    // AC24: an un-materialized member has no workspace, and saying so is more
    // use than a bare "skipped" — the fix is to start the agent.
    return { kind: 'note', text: 'Workspace not provisioned yet — start the agent, then catch up.' };
  }
  if (ev.type === 'agent-error') {
    return { kind: 'repo', symbol: '✗', status: 'failed', text: `Could not reach this agent: ${ev.error}` };
  }
  return null;
}

/**
 * Row colour by outcome. A D1 safety skip is warning-toned rather than red:
 * nothing failed and nothing was lost — a person has to push or commit first.
 */
export function repoRowTone(status, blocked = false) {
  if (status === 'failed') return 'var(--eb-status-error)';
  if (status === 'skipped' && blocked) return 'var(--eb-status-warning)';
  if (status === 'cloned' || status === 'adjusted') return 'var(--eb-status-success)';
  return 'var(--eb-text-secondary)';
}
