import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Send, X, ArrowRight, RefreshCw, GitCommit, AlertTriangle, CheckCircle2, AlertCircle, ChevronRight, ChevronLeft } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';

/* ─── STILLED: BP-instance hand-off UI — decision pending in #1968 ──────
 *
 * This component is RETAINED but RENDERED BY NOTHING. Epic #1961 (remove the
 * BriefingPack model) decided in R4 that the hand-off mechanism keeps its code
 * in the tree with the user interface disconnected, so it can be revived rather
 * than rebuilt. Phase #1962 stilled its four backend routes (see the matching
 * header in `admin-console/api/api.js`), and phase #1964 removed the only thing
 * that mounted this dialog: the `role === 'bp-instance'` Hand-off button in the
 * chat session toolbar (`ChatPanel.jsx`). No import of this file remains.
 *
 *   • #1968 is the ticket that decides its future (revive against the
 *     Flow/Team model, or delete).
 *   • #1528 (direct agent-to-agent messaging) is where the idea lives on
 *     conceptually.
 *   • Do NOT re-mount it against a live role, and do NOT "fix" its API calls —
 *     the routes it drives answer 409 for every agent that can exist. Reviving
 *     the feature is a product decision #1968 owns, not a code cleanup.
 *
 * Everything below is unchanged from when it was reachable.
 *
 * HandoffDialog — Guided wizard for the FreeFlow hand-off action on a bp-instance.
 *
 * Three steps:
 *   Step 1: Check workspace (git status, human-readable)
 *   Step 2: Select target agents
 *   Step 3: Add a hand-off note and confirm
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
  const [step, setStep]                 = useState(1); // 1 | 2 | 3

  const TOTAL_STEPS = 3;

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
    setStep(1);

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

  const step1Ready = sourceReady || overrideValid || !hasRepos;
  const step2Ready = selected.size > 0;
  const canSubmit = phase === 'ready' && step1Ready && step2Ready;

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

  const selectedRows = rows.filter((r) => selected.has(r.agentId));
  const selectedRepos = repos.filter((r) => r.exists);

  /* ─── Workspace status message (human-readable) ─────────────────────── */

  function workspaceStatusMessage() {
    if (gitStatus?.error) return null;
    if (!hasRepos) return { tone: 'neutral', text: 'No repositories are linked to this workspace.' };
    if (sourceReady) return { tone: 'success', text: 'Your workspace is clean and all changes have been pushed. You\'re ready to hand off.' };
    const issues = [];
    if (hasDirty) issues.push('unsaved changes');
    if (hasUnpushed) issues.push('unpushed commits');
    return {
      tone: 'warning',
      text: `Your workspace has ${issues.join(' and ')}. Please resolve this before handing off, or explain why you're proceeding anyway.`,
    };
  }

  const wsMsg = workspaceStatusMessage();

  /* ─── Render helpers ─────────────────────────────────────────────────── */

  function renderStep1() {
    return (
      <div style={stepContentStyle}>
        <p style={stepDescStyle}>
          Before handing off, make sure your work is saved and pushed to the remote repository. This ensures the next agent can pick up exactly where you left off.
        </p>

        {phase === 'loading' && (
          <div style={statusStyle}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Checking workspace…
          </div>
        )}

        {wsMsg && (
          <div style={workspaceStatusStyle(wsMsg.tone)}>
            {wsMsg.tone === 'success' && <CheckCircle2 size={16} style={{ color: 'var(--eb-status-success)', flexShrink: 0 }} />}
            {wsMsg.tone === 'warning' && <AlertTriangle size={16} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />}
            {wsMsg.tone === 'neutral' && <AlertCircle size={16} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />}
            <span>{wsMsg.text}</span>
          </div>
        )}

        {gitStatus?.error && (
          <div style={errorStyle}>Workspace check unavailable: {gitStatus.error}</div>
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
                Ask agent to save &amp; push
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
                Ask agent to push changes
              </button>
            )}
            <button
              type="button"
              onClick={refreshGitStatus}
              disabled={gitRefreshing}
              style={ghostBtnStyle(gitRefreshing)}
            >
              {gitRefreshing
                ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                : <RefreshCw size={12} />}
              Re-check
            </button>
          </div>
        )}

        {hasRepos && sourceReady && (
          <div style={nudgeRowStyle}>
            <button
              type="button"
              onClick={refreshGitStatus}
              disabled={gitRefreshing}
              style={ghostBtnStyle(gitRefreshing)}
            >
              {gitRefreshing
                ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                : <RefreshCw size={12} />}
              Re-check
            </button>
          </div>
        )}

        {overrideRequired && (
          <div style={overrideBoxStyle}>
            <label style={overrideLabelStyle}>
              <input
                type="checkbox"
                checked={overrideOn}
                onChange={(e) => setOverrideOn(e.target.checked)}
              />
              <span>Proceed anyway without resolving the issues above</span>
            </label>
            {overrideOn && (
              <div style={{ marginTop: 8 }}>
                <label style={labelStyle}>Why are you skipping this check?</label>
                <textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideRn(e.target.value)}
                  placeholder="Explain why you're handing off with unresolved workspace issues. This will be visible to the receiving agent."
                  rows={3}
                  style={{ ...textareaStyle, marginTop: 4 }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderStep2() {
    return (
      <div style={stepContentStyle}>
        <p style={stepDescStyle}>
          Choose which agents should receive this work. Pre-selected agents are direct successors based on the project plan.
        </p>

        {rows.length === 0 && (
          <div style={emptyStateStyle}>
            No downstream agents found. There is nobody to hand off to.
          </div>
        )}

        {rows.length > 0 && (
          <div style={listStyle}>
            {rows.map((row) => {
              const checked = selected.has(row.agentId);
              return (
                <label key={row.agentId} style={rowStyle(checked)}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(row.agentId)}
                    style={{ marginTop: 3 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
                        {row.displayName}
                      </span>
                      <span
                        title={row.agentId}
                        style={agentIdTooltipStyle}
                      >
                        {row.agentId}
                      </span>
                      {!row.materialized && <span style={badgeStyle('var(--eb-status-warning)')}>not yet active</span>}
                      {row.suggested && row.reason === 'depends-on' && (
                        <span style={badgeStyle('var(--eb-accent-primary)')}>next in plan</span>
                      )}
                      {row.suggested && row.reason === 'input-artifact' && (
                        <span style={badgeStyle('var(--eb-accent-primary)')}>needs your output</span>
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
        )}
      </div>
    );
  }

  function renderStep3() {
    return (
      <div style={stepContentStyle}>
        <p style={stepDescStyle}>
          Add a brief note for the receiving agent — what did you complete, and what should they do next?
        </p>

        {/* Summary */}
        <div style={summaryBoxStyle}>
          <div style={summaryTitleStyle}>Summary</div>
          <div style={summaryLineStyle}>
            <span style={summaryLabelStyle}>Handing off from</span>
            <span style={summaryValueStyle}>{sourceLabel}</span>
          </div>
          <div style={summaryLineStyle}>
            <span style={summaryLabelStyle}>Receiving agent{selectedRows.length !== 1 ? 's' : ''}</span>
            <span style={summaryValueStyle}>
              {selectedRows.length > 0
                ? selectedRows.map((r) => r.displayName).join(', ')
                : <em style={{ color: 'var(--eb-text-muted)' }}>none selected</em>}
            </span>
          </div>
          {selectedRepos.length > 0 && (
            <div style={summaryLineStyle}>
              <span style={summaryLabelStyle}>Repositories</span>
              <span style={summaryValueStyle}>{selectedRepos.map((r) => r.name).join(', ')}</span>
            </div>
          )}
        </div>

        <label style={{ display: 'block', marginTop: 'var(--eb-space-3)' }}>
          <span style={labelStyle}>Hand-off note <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)' }}>(optional)</span></span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={phase === 'sending' || phase === 'done'}
            placeholder="What did you finish? What should the next agent focus on?"
            rows={5}
            style={{ ...textareaStyle, marginTop: 4 }}
          />
          <span style={hintStyle}>
            Your note — along with the repository coordinates — will be sent to each selected agent.
          </span>
        </label>
      </div>
    );
  }

  function renderDone() {
    const successCount = (results?.results || []).filter((r) => r.ok).length;
    const activatedNames = (results?.results || [])
      .filter((r) => r.ok)
      .map((r) => {
        const match = rows.find((row) => row.agentId === r.agentId);
        return match?.displayName || r.agentId;
      });

    return (
      <div style={stepContentStyle}>
        <div style={doneIconStyle}>
          <CheckCircle2 size={40} style={{ color: 'var(--eb-status-success)' }} />
        </div>
        <h4 style={doneTitleStyle}>Hand-off complete</h4>
        <p style={doneDescStyle}>
          {successCount === 1
            ? `${activatedNames[0]} has received the hand-off and will pick up the work.`
            : `${activatedNames.join(', ')} have received the hand-off and will pick up the work.`}
        </p>
        {(results?.results || []).some((r) => !r.ok) && (
          <div style={{ marginTop: 'var(--eb-space-3)' }}>
            <div style={{ ...sectionTitleStyle, marginBottom: 4 }}>Issues</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--eb-text-xs)' }}>
              {(results.results || []).filter((r) => !r.ok).map((r) => {
                const match = rows.find((row) => row.agentId === r.agentId);
                return (
                  <li key={r.agentId} style={{ color: 'var(--eb-status-error)', marginBottom: 2 }}>
                    {match?.displayName || r.agentId}: {r.error}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const stepTitles = [
    'Step 1: Check your workspace',
    'Step 2: Select the receiving agent',
    'Step 3: Add a note and confirm',
  ];

  const canGoNext = step === 1 ? step1Ready : step === 2 ? step2Ready : false;

  return (
    <div role="dialog" aria-modal="true" aria-label="Hand-off" style={overlayStyle}>
      <div style={dialogStyle}>

        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
            <ArrowRight size={18} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <h3 style={titleStyle}>Hand-off from {sourceLabel}</h3>
              {phase !== 'done' && (
                <p style={subtitleStyle}>
                  {stepTitles[step - 1]}
                </p>
              )}
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

        {/* Progress indicator */}
        {phase !== 'done' && (
          <div style={progressBarContainerStyle}>
            {[1, 2, 3].map((s) => (
              <div key={s} style={progressStepStyle(s, step)} />
            ))}
            <span style={progressLabelStyle}>{step} / {TOTAL_STEPS}</span>
          </div>
        )}

        {/* Body */}
        <div style={bodyStyle}>
          {phase === 'loading' && step === 1 && (
            <div style={statusStyle}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading workspace status…
            </div>
          )}
          {error && phase !== 'sending' && (
            <div style={errorStyle}>{error}</div>
          )}

          {phase === 'done'
            ? renderDone()
            : phase !== 'loading' && (
              <>
                {step === 1 && renderStep1()}
                {step === 2 && renderStep2()}
                {step === 3 && renderStep3()}
              </>
            )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <button
            type="button"
            onClick={() => phase === 'done' ? onClose?.() : (step === 1 ? onClose?.() : setStep(step - 1))}
            disabled={phase === 'sending'}
            style={cancelBtnStyle(phase === 'sending')}
          >
            {phase === 'done' ? 'Close' : step === 1 ? 'Cancel' : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <ChevronLeft size={14} /> Back
              </span>
            )}
          </button>

          {phase !== 'done' && (
            step < 3 ? (
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                disabled={!canGoNext || phase === 'loading'}
                style={confirmBtnStyle(!canGoNext || phase === 'loading')}
                title={
                  step === 1 && !step1Ready
                    ? 'Resolve workspace issues or enable the override to continue'
                    : step === 2 && !step2Ready
                      ? 'Select at least one target agent'
                      : ''
                }
              >
                Next <ChevronRight size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                style={confirmBtnStyle(!canSubmit)}
              >
                {phase === 'sending'
                  ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Sending…</>
                  : <><Send size={13} /> Hand off</>}
              </button>
            )
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

  function humanStatus() {
    if (!repo.exists) return 'This repository has not been set up in this workspace.';
    if (repo.error) return `Something went wrong checking this repository: ${repo.error}`;
    if (repo.ready) return `All good — work is saved and synced on ${repo.branchActual}.`;
    const issues = [];
    if (!repo.clean) {
      const { staged = 0, unstaged = 0, untracked = 0 } = repo.dirty || {};
      const parts = [];
      if (staged > 0) parts.push(`${staged} staged`);
      if (unstaged > 0) parts.push(`${unstaged} changed`);
      if (untracked > 0) parts.push(`${untracked} new`);
      issues.push(`Unsaved changes (${parts.join(', ')})`);
    }
    if (repo.upstream && (repo.ahead || 0) > 0) {
      issues.push(`${repo.ahead} commit${repo.ahead === 1 ? '' : 's'} not yet pushed`);
    }
    if (!repo.upstream) {
      issues.push('Branch has never been pushed to remote');
    }
    return issues.join(' · ');
  }

  return (
    <div style={repoCardStyle(color)}>
      <div style={repoCardHeadStyle}>
        <Icon size={14} style={{ color, flexShrink: 0 }} />
        <span style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>{repo.name}</span>
        {repo.branchActual && (
          <code style={idStyle}>{repo.branchActual}{repo.headShort ? ` @ ${repo.headShort}` : ''}</code>
        )}
      </div>
      <div style={cardLineStyle}>{humanStatus()}</div>
      {!repo.clean && repo.dirty?.files?.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)' }}>Show changed files</summary>
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
  maxWidth: 680,
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

const progressBarContainerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '8px var(--eb-space-4)',
  borderBottom: '1px solid var(--eb-border-default)',
  background: 'var(--eb-bg-elevated)',
};

const progressStepStyle = (s, current) => ({
  flex: 1,
  height: 4,
  borderRadius: 2,
  background: s <= current ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
  transition: 'background 0.2s',
});

const progressLabelStyle = {
  fontSize: 11,
  color: 'var(--eb-text-muted)',
  flexShrink: 0,
  marginLeft: 4,
};

const bodyStyle = {
  flex: 1,
  overflowY: 'auto',
  padding: 'var(--eb-space-4)',
};

const stepContentStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-3)',
};

const stepDescStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)',
  lineHeight: 1.6,
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

const workspaceStatusStyle = (tone) => ({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: 'var(--eb-space-3)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
  lineHeight: 1.5,
  background:
    tone === 'success' ? 'var(--eb-status-success-bg, color-mix(in srgb, var(--eb-status-success) 8%, transparent))' :
    tone === 'warning' ? 'var(--eb-status-warning-bg, color-mix(in srgb, var(--eb-status-warning) 10%, transparent))' :
                         'var(--eb-bg-elevated)',
  border: `1px solid ${
    tone === 'success' ? 'var(--eb-status-success)' :
    tone === 'warning' ? 'var(--eb-status-warning)' :
                         'var(--eb-border-default)'}`,
});

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
  padding: 'var(--eb-space-3)',
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

const emptyStateStyle = {
  padding: 'var(--eb-space-4)',
  textAlign: 'center',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-muted)',
  background: 'var(--eb-bg-elevated)',
  borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-border-default)',
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

const agentIdTooltipStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 10,
  color: 'var(--eb-text-muted)',
  background: 'var(--eb-bg-elevated)',
  padding: '1px 6px',
  borderRadius: 4,
  cursor: 'help',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 120,
  whiteSpace: 'nowrap',
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

const summaryBoxStyle = {
  padding: 'var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const summaryTitleStyle = {
  fontSize: 'var(--eb-text-xs)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 2,
};

const summaryLineStyle = {
  display: 'flex',
  gap: 8,
  fontSize: 'var(--eb-text-sm)',
  alignItems: 'baseline',
};

const summaryLabelStyle = {
  color: 'var(--eb-text-muted)',
  flexShrink: 0,
  minWidth: 120,
};

const summaryValueStyle = {
  color: 'var(--eb-text-primary)',
  fontWeight: 'var(--eb-font-medium)',
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

const sectionTitleStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const doneIconStyle = {
  display: 'flex',
  justifyContent: 'center',
  padding: 'var(--eb-space-3) 0',
};

const doneTitleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-lg, var(--eb-text-md))',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
  textAlign: 'center',
};

const doneDescStyle = {
  margin: '8px 0 0',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)',
  textAlign: 'center',
  lineHeight: 1.6,
};

const footerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
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
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
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
