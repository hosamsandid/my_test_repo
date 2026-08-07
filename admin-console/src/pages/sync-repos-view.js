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

/** Human label for a single repo result line. */
export function repoStatusText(status, reason) {
  if (status === 'cloned') return 'Cloned';
  if (status === 'failed') return 'Failed';
  if (status === 'skipped') {
    if (reason === 'path-occupied') return 'Skipped — a non-git folder occupies that path';
    return 'Already present';
  }
  return status || 'Unknown';
}

/** Symbol prefix for a repo line, keyed on outcome. */
export function repoStatusSymbol(status) {
  if (status === 'cloned') return '✓';
  if (status === 'failed') return '✗';
  return '·';
}

/**
 * One-line human summary of a completed run's totals.
 * e.g. "3 cloned, 2 already present, 1 failed" — omits zero buckets, and
 * returns a friendly message when there was nothing to do.
 */
export function summaryText(totals) {
  const t = totals || {};
  const cloned = t.cloned || 0;
  const skipped = t.skipped || 0;
  const failed = t.failed || 0;
  if (cloned === 0 && skipped === 0 && failed === 0) {
    return 'Nothing to sync — no repositories are declared on this environment.';
  }
  const parts = [];
  if (cloned) parts.push(`${cloned} cloned`);
  if (skipped) parts.push(`${skipped} already present`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(', ') + '.';
}
