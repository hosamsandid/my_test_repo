import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Send, X, ArrowRight, RefreshCw, GitCommit, GitBranch, AlertTriangle, CheckCircle2, AlertCircle } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';

/**
 * HandoffDialog — Modal for the FreeFlow hand-off action on a bp-instance.
 *
 * On open, loads two things in parallel:
 *   - candidates  : suggested + sibling targets from the BP graph
 *   - git-status  : per-repo commit/push state of the source workspace
 *
 * The git-status drives a pre-flight section above the target list. If any
 * source repo is dirty or ahead of its upstream, submit is disabled until
 * the user either resolves the issue (via "Ask agent to commit/push", which
 * posts a canned prompt into the source DM and re-checks) or explicitly
 * opts into an override and provides a reason. The reason flows server-side
 * into the structured DM body each target receives, so the audit trail
 * survives in chat.
 *
 * On submit, POSTs to /api/agents/:id/handover with targets + note +
 * optional override. The server re-fetches git-status and refuses unless
 * ready or override is set, so a stale browser cannot bypass the gate.
 */
export default function HandoffDialog({ open, agent, onClose, onSent }) {
  const [phase, setPhase]               = useState('loading'); // loading | ready | sending | done | error
  const [error, setError]               = useState(null);
  const [candidates, setCandidates]     = useState(null);
  const [gitStatus, setGitStatus]       = useState(null);
  const [gitRefreshing, setGitRefresh]  = useState(false);
  const [nudging, setNudging]           = useState(null);  // 'commit' | 'push' | null
  const [selected, setSelected]         = useState(new Set());
  const [note, setNote]                 = useState('');
  const [overrideOn, setOverrideOn]     = useState(false);
  const [overrideReason, setOverrideRn] = useState('');
  const [results, setResults]           = useState(null);

  const refreshGitStatus = useCallback(async () => {
    if (!agent?.id) return;
    setGitRefresh(true);
    try {
      const data = await apiCall('GET', `/api/agents/${agent.id}/handover/git-status`);
      setGitStatus(data);
    } catch (err) {
      setGitStatus({ error: err.message || String(err), repos: [], summary: { ready: false } });
    } finally {
      setGitRefresh(false);
    }
  }, [agent?.id]);

  useEffect(() => {
    if (!open || !agent?.id) return;
    let cancelled = false;
    setPhase('loading');
    setError(null);
    setCandidates(null);
    setGitStatus(null);
    setSelected(new Set());
    setNote('');
    setOverrideOn(false);
    setOverrideRn('');
    setResults(null);

    Promise.all([
      apiCall('GET', `/api/agents/${agent.id}/handover/candidates`).catch((err) => ({ __error: err.message || String(err) })),
      apiCall('GET', `/api/agents/${agent.id}/handover/git-status`).catch((err) => ({ __error: err.message || String(err) })),
    ]).then(([cand, git]) => {
      if (cancelled) return;
      if (cand?.__error) {
        setError(cand.__error);
        setPhase('error');
        return;
      }
      setCandidates(cand);
      setGitStatus(git?.__error ? { error: git.__error, repos: [], summary: { ready: false } } : git);
      const preselect = new Set((cand?.suggested || []).map((s) => s.agentId));
      setSelected(preselect);
      setPhase('ready');
    });

    return () => { cancelled = true; };
  }, [open, agent?.id]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape' && phase !== 'sending') onClose?.();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, phase, onClose]);

  if (!open) return null;

  /* ─── Derived state ──────────────────────────────────────────────────── */

  const repos = gitStatus?.repos || [];
  const hasRepos = repos.length > 0;
  const sourceReady = Boolean(gitStatus?.summary?.ready);
  const hasDirty = repos.some((r) => r.exists && !r.clean);
  const hasUnpushed = repos.some((r) => r.exists && r.upstream && (r.ahead || 0) > 0);

  const overrideRequired = !sourceReady && hasRepos;
  const overrideValid = overrideOn && overrideReason.trim().length > 0;
  const canSubmit =
    phase === 'ready' &&
    selected.size > 0 &&
    (sourceReady || overrideValid || !hasRepos);

  const rows = (() => {
    if (!candidates) return [];
    const seen = new Set();
    const out = [];
    for (const s of (candidates.suggested || [])) {
      seen.add(s.agentId);
      out.push({ ...s, suggested: true });
    }
    for (const s of (candidates.siblings || [])) {
      if (seen.has(s.agentId)) continue;
      seen.add(s.agentId);
      out.push({ ...s, suggested: false, reason: null });
    }
    return out;
  })();

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleNudge(kind) {
    if (!agent?.id) return;
    setNudging(kind);
    try {
      const repoNames = repos
        .filter((r) => r.exists && (kind === 'commit' ? !r.clean : (r.ahead || 0) > 0))
        .map((r) => r.name);
      await apiCall('POST', `/api/agents/${agent.id}/handover/nudge`, { kind, repos: repoNames });
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setNudging(null);
    }
  }

  async function handleSubmit() {
    const targets = [...selected];
    if (targets.length === 0) {
      setError('Pick at least one target.');
      return;
    }
    if (overrideRequired && !overrideValid) {
      setError('Please provide a reason for the override.');
      return;
    }
    setPhase('sending');
    setError(null);
    setResults(null);
    try {
      const result = await apiCall('POST', `/api/agents/${agent.id}/handover`, {
        targets,
        note: note.trim(),
        override: overrideValid ? { reason: overrideReason.trim() } : null,
      });
      setResults(result);
      setPhase('done');
      onSent?.(result);
    } catch (err) {
      setError(err.message || String(err));
      setPhase('error');
    }
  }

  const sourceLabel = candidates?.source?.displayName || agent?.displayName || agent?.id;

  return (
    <div role="dialog" aria-modal="true" aria-label="Hand-off" style={overlayStyle}>
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
            <ArrowRight size={18} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <h3 style={titleStyle}>Hand-off from {sourceLabel}</h3>
              <p style={subtitleStyle}>
                Review the source workspace, pick downstream agents to activate, and send them a structured hand-off note.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => phase !== 'sending' && onClose?.()}
            disabled={phase === 'sending'}
            aria-label="Close"
            style={closeBtnStyle(phase === 'sending')}
          >
            <X size={16} />
          </button>
        </div>

        <div style={bodyStyle}>
          {phase === 'loading' && (
            <div style={statusStyle}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading candidates and git status…
            </div>
          )}
          {error && phase !== 'sending' && (
            <div style={errorStyle}>{error}</div>
          )}

          {phase !== 'loading' && (
            <>
              {/* Pre-flight: source workspace git status */}
              <section style={sectionStyle}>
                <div style={sectionHeadStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <GitBranch size={14} />
                    <span style={sectionTitleStyle}>Source workspace</span>
                    {sourceReady && hasRepos && (
                      <span style={badgeStyle('var(--eb-status-success)')}>Ready</span>
                    )}
                    {!sourceReady && hasRepos && (
                      <span style={badgeStyle('var(--eb-status-warning)')}>Not ready</span>
                    )}
                    {!hasRepos && !gitStatus?.error && (
                      <span style={badgeStyle('var(--eb-text-muted)')}>No repos</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={refreshGitStatus}
                    disabled={gitRefreshing}
                    style={ghostBtnStyle(gitRefreshing)}
                    title="Re-check git status"
                  >
                    {gitRefreshing
                      ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                      : <RefreshCw size={12} />}
                    Re-check
                  </button>
                </div>

                {gitStatus?.error && (
                  <div style={errorStyle}>Git status unavailable: {gitStatus.error}</div>
                )}

                {!gitStatus?.error && hasRepos && (
                  <div style={repoListStyle}>
                    {repos.map((r) => (
                      <RepoStatusCard key={r.name} repo={r} />
                    ))}
                  </div>
                )}

                {(hasDirty || hasUnpushed) && (
                  <div style={nudgeRowStyle}>
                    {hasDirty && (
                      <button
                        type="button"
                        onClick={() => handleNudge('commit')}
                        disabled={nudging !== null}
                        style={nudgeBtnStyle(nudging === 'commit')}
                      >
                        {nudging === 'commit'
                          ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                          : <GitCommit size={12} />}
                        Ask agent to commit &amp; push
                      </button>
                    )}
                    {hasUnpushed && !hasDirty && (
                      <button
                        type="button"
                        onClick={() => handleNudge('push')}
                        disabled={nudging !== null}
                        style={nudgeBtnStyle(nudging === 'push')}
                      >
                        {nudging === 'push'
                          ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                          : <Send size={12} />}
                        Ask agent to push pending commits
                      </button>
                    )}
                    <span style={hintStyle}>
                      Posts a prompt into the source agent&apos;s chat so the agent does the git work itself.
                      Re-check after the commits land.
                    </span>
                  </div>
                )}

                {overrideRequired && (
                  <div style={overrideBoxStyle}>
                    <label style={overrideLabelStyle}>
                      <input
                        type="checkbox"
                        checked={overrideOn}
                        onChange={(e) => setOverrideOn(e.target.checked)}
                        disabled={phase === 'sending' || phase === 'done'}
                      />
                      <span>Hand off anyway (not recommended)</span>
                    </label>
                    {overrideOn && (
                      <textarea
                        value={overrideReason}
                        onChange={(e) => setOverrideRn(e.target.value)}
                        placeholder="Why are you bypassing the git checks? This is included in every target's hand-off note."
                        rows={2}
                        disabled={phase === 'sending' || phase === 'done'}
                        style={{ ...textareaStyle, marginTop: 6 }}
                      />
                    )}
                  </div>
                )}
              </section>

              {/* Targets */}
              <section style={{ ...sectionStyle, marginTop: 'var(--eb-space-3)' }}>
                <div style={sectionHeadStyle}>
                  <span style={sectionTitleStyle}>Targets</span>
                  <span style={hintStyle}>
                    {rows.length > 0
                      ? 'Suggested = depends-on / input-artifact dependents from the BP graph.'
                      : 'No sibling bp-instance agents — nothing to hand off to.'}
                  </span>
                </div>

                {rows.length > 0 && (
                  <>
                    <div style={listStyle}>
                      {rows.map((row) => {
                        const checked = selected.has(row.agentId);
                        return (
                          <label key={row.agentId} style={rowStyle(checked)}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggle(row.agentId)}
                              disabled={phase === 'sending' || phase === 'done'}
                              style={{ marginTop: 3 }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
                                  {row.displayName}
                                </span>
                                <code style={idStyle}>{row.agentId}</code>
                                {!row.materialized && <span style={badgeStyle('var(--eb-status-warning)')}>stub</span>}
                                {row.suggested && row.reason === 'depends-on' && (
                                  <span style={badgeStyle('var(--eb-accent-primary)')}>depends-on</span>
                                )}
                                {row.suggested && row.reason === 'input-artifact' && (
                                  <span style={badgeStyle('var(--eb-accent-primary)')}>input-artifact</span>
                                )}
                                {!row.suggested && (
                                  <span style={badgeStyle('var(--eb-text-muted)')}>sibling</span>
                                )}
                              </div>
                              {row.suggested && row.reason === 'input-artifact' && Array.isArray(row.paths) && row.paths.length > 0 && (
                                <div style={pathsStyle}>
                                  {row.paths.map((p) => <code key={p} style={pathChipStyle}>{p}</code>)}
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>

                    <label style={{ display: 'block', marginTop: 'var(--eb-space-3)' }}>
                      <span style={labelStyle}>Hand-off note</span>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        disabled={phase === 'sending' || phase === 'done'}
                        placeholder="What did you finish, what should the downstream agents do? This goes into each target's chat as part of the structured hand-off."
                        rows={5}
                        style={textareaStyle}
                      />
                      <span style={hintStyle}>
                        The note is wrapped with the source-of-work coordinates (repo, branch, head commit) so each target can pull immediately.
                      </span>
                    </label>
                  </>
                )}
              </section>

              {results && (
                <div style={resultsStyle}>
                  <div style={resultsTitleStyle}>
                    Sent to {results.sent}/{results.total} target{results.total === 1 ? '' : 's'}
                  </div>
                  <ul style={resultsListStyle}>
                    {(results.results || []).map((r) => (
                      <li key={r.agentId} style={resultItemStyle(r.ok)}>
                        <code style={idStyle}>{r.agentId}</code>
                        {r.ok ? ' ✓ delivered' : ` ✗ failed (${r.stage}: ${r.error})`}
                        {r.ok && Array.isArray(r.consistencyWarnings) && r.consistencyWarnings.length > 0 && (
                          <ul style={warningSubListStyle}>
                            {r.consistencyWarnings.map((w, i) => (
                              <li key={i} style={warningSubItemStyle}>{w}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={phase === 'sending'}
            style={cancelBtnStyle(phase === 'sending')}
          >
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
          {phase !== 'done' && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              style={confirmBtnStyle(!canSubmit)}
              title={
                !sourceReady && !overrideValid
                  ? 'Source workspace has uncommitted or unpushed changes — resolve them or enable the override'
                  : selected.size === 0
                    ? 'Pick at least one target'
                    : ''
              }
            >
              {phase === 'sending'
                ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Sending…</>
                : <><Send size={13} /> Hand off to {selected.size || 0}</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Repo status card ─────────────────────────────────────────────────── */

function RepoStatusCard({ repo }) {
  const tone = !repo.exists
    ? 'error'
    : repo.error
      ? 'error'
      : repo.ready
        ? 'success'
        : 'warning';
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? AlertCircle : AlertTriangle;
  const color =
    tone === 'success' ? 'var(--eb-status-success)' :
    tone === 'error'   ? 'var(--eb-status-error)' :
                         'var(--eb-status-warning)';

  return (
    <div style={repoCardStyle(color)}>
      <div style={repoCardHeadStyle}>
        <Icon size={14} style={{ color, flexShrink: 0 }} />
        <span style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>{repo.name}</span>
        {repo.branchActual && (
          <code style={idStyle}>{repo.branchActual}{repo.headShort ? ` @ ${repo.headShort}` : ''}</code>
        )}
      </div>

      {!repo.exists && (
        <div style={cardLineStyle}>Not cloned in this workspace.</div>
      )}
      {repo.error && (
        <div style={cardLineStyle}>git error: {repo.error}</div>
      )}
      {repo.exists && !repo.error && (
        <>
          {repo.headSubject && (
            <div style={cardLineStyle} title={repo.headSubject}>
              <em>{repo.headSubject}</em>
            </div>
          )}
          {!repo.clean && (
            <div style={cardLineStyle}>
              Uncommitted: {repo.dirty.staged} staged · {repo.dirty.unstaged} unstaged · {repo.dirty.untracked} untracked
              {repo.dirty.files?.length > 0 && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--eb-text-secondary)' }}>show files</summary>
                  <ul style={fileListStyle}>
                    {repo.dirty.files.map((f) => (
                      <li key={f.path} style={fileItemStyle}>
                        <code style={fileCodeStyle}>{f.status}</code> {f.path}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {repo.upstream && (repo.ahead || 0) > 0 && (
            <div style={cardLineStyle}>
              {repo.ahead} unpushed commit{repo.ahead === 1 ? '' : 's'} (upstream: <code style={fileCodeStyle}>{repo.upstream}</code>)
            </div>
          )}
          {!repo.upstream && (
            <div style={cardLineStyle}>No upstream tracking branch — branch has never been pushed.</div>
          )}
          {repo.ready && (
            <div style={{ ...cardLineStyle, color: 'var(--eb-status-success)' }}>
              Clean, pushed, and on <code style={fileCodeStyle}>{repo.upstream}</code>.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── Styles ─────────────────────────────────────────────────────────── */

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'oklch(0 0 0 / 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
  padding: 'var(--eb-space-4)',
};

const dialogStyle = {
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  width: '100%',
  maxWidth: 720,
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: 'var(--eb-shadow-xl)',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--eb-space-3)',
  padding: 'var(--eb-space-4)',
  borderBottom: '1px solid var(--eb-border-default)',
};

const titleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-md)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const subtitleStyle = {
  margin: '4px 0 0',
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  lineHeight: 1.5,
};

const closeBtnStyle = (disabled) => ({
  background: 'none',
  border: 'none',
  cursor: disabled ? 'not-allowed' : 'pointer',
  color: 'var(--eb-text-muted)',
  padding: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
});

const bodyStyle = {
  flex: 1,
  overflowY: 'auto',
  padding: 'var(--eb-space-4)',
};

const statusStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-muted)',
};

const errorStyle = {
  padding: 'var(--eb-space-3)',
  background: 'var(--eb-status-error-bg)',
  border: '1px solid var(--eb-status-error)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
  marginBottom: 'var(--eb-space-3)',
};

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-2)',
};

const sectionHeadStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--eb-space-2)',
  flexWrap: 'wrap',
};

const sectionTitleStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const repoListStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-2)',
};

const repoCardStyle = (borderColor) => ({
  border: `1px solid ${borderColor}`,
  borderLeftWidth: 3,
  borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
});

const repoCardHeadStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const cardLineStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-secondary)',
  lineHeight: 1.5,
};

const fileListStyle = {
  margin: '4px 0 0',
  paddingLeft: 16,
};

const fileItemStyle = {
  fontSize: 11,
  color: 'var(--eb-text-secondary)',
};

const fileCodeStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 11,
  background: 'var(--eb-bg-surface)',
  padding: '0 4px',
  borderRadius: 3,
};

const nudgeRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--eb-space-2)',
};

const nudgeBtnStyle = (active) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: 'var(--eb-space-1, 4px) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-xs)',
  cursor: active ? 'progress' : 'pointer',
  fontFamily: 'inherit',
});

const ghostBtnStyle = (disabled) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  background: 'transparent',
  color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 11,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: 'inherit',
  opacity: disabled ? 0.6 : 1,
});

const overrideBoxStyle = {
  marginTop: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  border: '1px dashed var(--eb-status-warning)',
  borderRadius: 'var(--eb-radius-md)',
  background: 'var(--eb-bg-elevated)',
};

const overrideLabelStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
  cursor: 'pointer',
};

const listStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-1, 4px)',
};

const rowStyle = (checked) => ({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  border: `1px solid ${checked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
  borderRadius: 'var(--eb-radius-md)',
  background: checked ? 'var(--eb-bg-hover, var(--eb-bg-elevated))' : 'var(--eb-bg-surface)',
  cursor: 'pointer',
});

const idStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  background: 'var(--eb-bg-elevated)',
  padding: '1px 6px',
  borderRadius: 4,
};

const badgeStyle = (color) => ({
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 4,
  border: `1px solid ${color}`,
  color,
  fontWeight: 'var(--eb-font-medium)',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
});

const pathsStyle = {
  marginTop: 4,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

const pathChipStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 11,
  background: 'var(--eb-bg-elevated)',
  padding: '1px 5px',
  borderRadius: 3,
  color: 'var(--eb-text-secondary)',
};

const labelStyle = {
  display: 'block',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
  marginBottom: 4,
};

const textareaStyle = {
  width: '100%',
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  resize: 'vertical',
  minHeight: 90,
  boxSizing: 'border-box',
};

const hintStyle = {
  display: 'block',
  marginTop: 4,
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
};

const resultsStyle = {
  marginTop: 'var(--eb-space-3)',
  padding: 'var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
};

const resultsTitleStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
  marginBottom: 6,
};

const resultsListStyle = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 'var(--eb-text-xs)',
};

const resultItemStyle = (ok) => ({
  color: ok ? 'var(--eb-status-success)' : 'var(--eb-status-error)',
  marginBottom: 2,
});

const warningSubListStyle = {
  marginTop: 2,
  paddingLeft: 14,
  color: 'var(--eb-status-warning)',
};

const warningSubItemStyle = {
  fontSize: 11,
};

const footerStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-3) var(--eb-space-4)',
  borderTop: '1px solid var(--eb-border-default)',
};

const cancelBtnStyle = (disabled) => ({
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  fontFamily: 'inherit',
});

const confirmBtnStyle = (disabled) => ({
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)',
  color: 'var(--eb-text-inverted)',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'inherit',
});
