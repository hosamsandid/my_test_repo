import React, { useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle, CheckCircle, Circle, Check, XCircle } from 'lucide-react';
import {
  reposForEnv,
  isRepoLessEnv,
  validateLaunch,
  launchBlockReason,
  buildLaunchBody,
  launchSubmitLabel,
  launchResultMessage,
  runLaunchStream,
  slugify,
  sanitizeTeamIdInput,
  normalizeTeamId,
  sanitizeLabelSuffixInput,
  teamIdError,
  labelSuffixError,
  TEAM_ID_HINT,
  SUFFIX_HINT,
  TEAM_ID_MAX,
  SUFFIX_MAX,
} from './launch-team.js';
import { describeMaterializeError } from './materialize-error.js';
import { PROVISION_NOW_LABEL, PROVISION_NOW_HINT } from './create-team-copy.js';

// LaunchStep — the ONE shared "turn a design into running agents" step (#1668,
// epic #1661 Phase E). Both front doors render this: the Flows-canvas
// "Materialize as team" dialog (all controls inline) and the Team-Setup wizard's
// final step (identity collected on earlier steps, only extend/materialize-now
// shown here). It owns one consistent set of launch controls (team name/id,
// Working Environment, create-vs-extend, optional label suffix, materialize-now),
// the streaming submit against POST /api/teams/stream, and the shared
// plan/step/collision/complete/warning/error feedback — so the two entry points
// can never diverge (AC1–AC5, AC7, AC8). Repo-less environments are launchable
// (AC6) via the shared `validateLaunch`, which never consults a repository.
//
// Controlled component: the caller owns `values` (the six launch fields) and
// updates them via `onChange(patch)`; `fields` selects which controls render
// inline; `extraBody` carries entry-point-specific POST fields.
export default function LaunchStep({
  bundle,
  environments = [],
  values,
  onChange,
  fields = ['name', 'id', 'environment', 'labelSuffix', 'extend', 'materializeNow'],
  extraBody = {},
  onComplete,
  onCreateEnvironment,
  summary = null,
  leftAction = null,
  // Shown inside the success card and beside it (#2053 AC12). Optional, so the
  // Team-Setup wizard — which navigates away on completion — is unchanged.
  completionNotice = '',
  completionAction = null,
  describeError = describeMaterializeError,
  onBusyChange,
}) {
  const [submitting, setSubmitting] = useState(false);
  const [progressSteps, setProgressSteps] = useState(null);
  const [progressError, setProgressError] = useState(null);
  const [collisionInfo, setCollisionInfo] = useState(null);
  const [result, setResult] = useState(null);
  const [matWarnings, setMatWarnings] = useState([]);
  const [error, setError] = useState(null);
  const [errorDetail, setErrorDetail] = useState(null);
  const [suggestingLabel, setSuggestingLabel] = useState(false);

  const has = (f) => fields.includes(f);
  const set = (patch) => onChange?.(patch);

  // `environments` may be null/undefined while still loading — distinguish that
  // from a genuinely empty list so we don't flash the "no environments" box.
  const envsLoaded = Array.isArray(environments);
  const envList = envsLoaded ? environments : [];
  const selectedEnv = envList.find(e => e.id === values.environmentId) || null;
  const selectedRepos = selectedEnv ? reposForEnv(selectedEnv) : [];
  const noEnvs = envsLoaded && envList.length === 0;

  function handleEvent(ev) {
    if (ev.type === 'plan') {
      setProgressSteps(ev.steps.map(s => ({ ...s, status: 'pending' })));
    } else if (ev.type === 'step') {
      setProgressSteps(prev => prev
        ? prev.map(s => (s.id === ev.id ? { ...s, status: ev.status, error: ev.error || s.error } : s))
        : prev);
    } else if (ev.type === 'collision') {
      // The process-template flow has no role-card UI to fall back to — offer
      // "Add missing agents" (mode: extend re-submits, adding only the members
      // that don't already exist).
      setCollisionInfo({ existing: ev.existing, suggestion: ev.suggestion });
      setProgressSteps(null);
    } else if (ev.type === 'complete') {
      setResult(ev.result);
      onComplete?.(ev.result);
    } else if (ev.type === 'warning') {
      setMatWarnings(prev => [...prev, ev.message]);
    } else if (ev.type === 'error') {
      const msg = ev.error || `HTTP ${ev.status || 500}`;
      setProgressError(msg);
      setError(msg);
      setErrorDetail(null);
    }
  }

  async function submit(mode) {
    // Settle a mid-edit team id first: a dash typed last is legal while typing
    // but not at submit position (#1934 AC1). `normalizeTeamId` is idempotent,
    // so this is a no-op for a value that is already fine (the wizard, which
    // doesn't render the id field here, included).
    const settledId = normalizeTeamId(values.teamId);
    if (settledId !== values.teamId) set({ teamId: settledId });
    const settled = { ...values, teamId: settledId };
    const err = validateLaunch(settled);
    if (err) { setError(err); setErrorDetail(null); return; }
    setError(null); setErrorDetail(null);
    setCollisionInfo(null); setProgressError(null); setProgressSteps(null); setMatWarnings([]);
    setSubmitting(true); onBusyChange?.(true);
    const body = buildLaunchBody({
      teamId: settled.teamId,
      teamName: settled.teamName,
      environmentId: settled.environmentId,
      mode,
      labelSuffix: settled.labelSuffix,
      materializeNow: settled.materializeNow,
      processTemplate: bundle,
      extra: extraBody,
    });
    try {
      await runLaunchStream({ body, onEvent: handleEvent });
    } catch (e) {
      const { message, detail } = describeError(e, {
        action: mode === 'extend' ? 'extend the team' : 'create the team',
      });
      setError(message); setErrorDetail(detail);
    } finally {
      setSubmitting(false); onBusyChange?.(false);
    }
  }

  const primaryLabel = launchSubmitLabel({ saving: submitting, extend: values.extend, materializeNow: values.materializeNow });
  // Single source for the disabled state AND its reason (#2157 AC4) — replaces
  // the old `envBlocking`, which decided disabled-ness with no connection to the
  // message a caller might show. `launchBlockReason` settles the team id first,
  // so a trailing dash mid-edit never flickers the reason (see its own comment).
  const launchReason = launchBlockReason(values);
  const launchBlocked = !!launchReason;
  // The no-environment empty state (below) already carries this exact reason —
  // do not repeat it a second time next to the button (#2157 AC3: the two must
  // not contradict, not that they must both say it).
  const showLaunchReasonHint = launchBlocked && !submitting && !(has('environment') && noEnvs);
  // Inline, immediate format feedback so a rule violation is visible while
  // typing instead of surfacing as an opaque 400 from the API (#1934).
  const idFieldError = teamIdError(values.teamId);
  const suffixFieldError = labelSuffixError(values.labelSuffix);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      {summary}

      {!result && (
        <>
          {has('name') && (
            <Field label="Team name">
              <input
                value={values.teamName}
                onChange={e => {
                  const teamName = e.target.value;
                  set({ teamName, ...(values.teamIdManuallyEdited ? {} : { teamId: slugify(teamName) }) });
                }}
                style={input}
              />
            </Field>
          )}
          {has('id') && (
            <Field
              label="Team id (slug)"
              hint={`Auto-generated from the name; edit to override. ${TEAM_ID_HINT}`}
              error={idFieldError}
            >
              <input
                value={values.teamId}
                maxLength={TEAM_ID_MAX}
                // Gentle live sanitising only — a dash you just typed stays put
                // (#1934 AC1); the value is settled on blur.
                onChange={e => set({ teamId: sanitizeTeamIdInput(e.target.value), teamIdManuallyEdited: true })}
                onBlur={e => set({ teamId: normalizeTeamId(e.target.value) })}
                style={input}
              />
            </Field>
          )}
          {has('labelSuffix') && (
            <Field
              label={<>Label suffix <span style={{ fontWeight: 'normal', opacity: 0.7 }}>(optional)</span></>}
              hint={`Appended to every label — isolates parallel stacks on one repo. Leave blank for the template's default names. ${SUFFIX_HINT}`}
              error={suffixFieldError}
            >
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={values.labelSuffix || ''}
                  maxLength={SUFFIX_MAX}
                  placeholder="e.g. team-1"
                  onChange={e => set({ labelSuffix: sanitizeLabelSuffixInput(e.target.value) })}
                  style={{ ...input, flex: 1 }}
                />
                <button
                  type="button"
                  disabled={suggestingLabel}
                  onClick={async () => {
                    setSuggestingLabel(true);
                    try {
                      const r = await fetch('/api/teams/suggest-suffix');
                      if (r.ok) { const { suffix } = await r.json(); set({ labelSuffix: suffix }); }
                    } catch { /* ignore */ } finally { setSuggestingLabel(false); }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    ...input, width: 'auto', padding: '0 10px',
                    cursor: suggestingLabel ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                  }}
                  title="Suggest a random 4-char suffix"
                >
                  <RefreshCw size={12} style={suggestingLabel ? { animation: 'spin 0.9s linear infinite' } : {}} />
                  Suggest
                </button>
              </div>
            </Field>
          )}

          {has('environment') && (
            noEnvs ? (
              <div style={emptyBox}>
                <span>
                  No working environment exists yet. A team materialises onto an existing
                  environment — it supplies the repository and the credentials (SSH key +
                  GitHub token).
                </span>
                {onCreateEnvironment && (
                  <button type="button" onClick={onCreateEnvironment} style={linkBtn}>
                    Create a working environment →
                  </button>
                )}
              </div>
            ) : (
              <Field label="Working environment">
                <select value={values.environmentId || ''} onChange={e => set({ environmentId: e.target.value })} style={input} disabled={!envsLoaded}>
                  <option value="">{envsLoaded ? '— select —' : 'Loading…'}</option>
                  {envList.map(env => (
                    <option key={env.id} value={env.id}>{env.name || env.id}</option>
                  ))}
                </select>
              </Field>
            )
          )}

          {has('environment') && selectedRepos.length > 0 && (
            <div style={{ ...infoBox, maxHeight: 220, overflowY: 'auto' }}>
              {selectedRepos.map((repo, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 2,
                    ...(i > 0 ? { marginTop: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-2)', borderTop: '1px solid var(--eb-border-default)' } : {}),
                  }}
                >
                  <div style={{ wordBreak: 'break-all' }}><strong>Repository:</strong> {repo.url}</div>
                  <div><strong>Branch:</strong> {repo.branch || 'main'}</div>
                </div>
              ))}
            </div>
          )}
          {has('environment') && isRepoLessEnv(selectedEnv) && (
            <div style={{ ...infoBox, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
              This environment has no repository — the team will run without one. Its
              agents can still chat and use their skills, but GitHub hand-offs (PR /
              issue channels) won't be available.
            </div>
          )}
          {has('environment') && !noEnvs && onCreateEnvironment && (
            <button type="button" onClick={onCreateEnvironment} style={{ ...linkBtn, alignSelf: 'flex-start' }}>
              Need a different setup? Create a working environment →
            </button>
          )}

          {has('extend') && (
            <label style={checkboxRow}>
              <input type="checkbox" checked={!!values.extend} onChange={e => set({ extend: e.target.checked })} />
              Add to an existing team (extend) — only the missing agents are created
            </label>
          )}
          {has('materializeNow') && (
            <label style={{ ...checkboxRow, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={!!values.materializeNow} onChange={e => set({ materializeNow: e.target.checked })} style={{ marginTop: 3 }} />
              {/* #2053 AC13: this said *Materialize agents now* one step away
                  from a button that used *Materialize* for the other act — one
                  word, two meanings, in one dialog. Creating the TEAM is
                  "Create team"; taking one member to a running agent with a
                  cloned repository is "provision". The Agent-Chat section that
                  lists un-provisioned members is quoted by name rather than
                  renamed (#2053 Non-goals) so the pointer still lands. */}
              <span>
                {PROVISION_NOW_LABEL} — {PROVISION_NOW_HINT}
              </span>
            </label>
          )}
        </>
      )}

      {progressSteps && !result && <ProgressList steps={progressSteps} error={progressError} />}

      {progressError && !result && !collisionInfo && (
        <div style={{ ...cardBox, borderColor: 'var(--eb-status-error)' }}>
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <AlertTriangle size={18} style={{ color: 'var(--eb-status-error)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
                Team creation failed
              </div>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 4 }}>
                No partial team was left behind — every resource created during this attempt
                (members, then the team, then the working environment) was rolled back. Fix the
                issue above and try again.
              </div>
              <div style={{ marginTop: 'var(--eb-space-3)' }}>
                <button type="button" onClick={() => submit('create')} disabled={submitting} style={primaryStyle(submitting)}>
                  {submitting ? 'Retrying…' : <><RefreshCw size={14} /> Retry</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {collisionInfo && !result && (
        <div style={{ ...cardBox, borderColor: 'var(--eb-status-warning)' }}>
          <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-2)' }}>
            Some resources for team <code>{values.teamId}</code> already exist.
          </div>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-3)' }}>
            {collisionInfo.existing?.env && <>Env: <code>{collisionInfo.existing.env}</code><br /></>}
            {collisionInfo.existing?.team && <>Team: <code>{collisionInfo.existing.team}</code><br /></>}
            {collisionInfo.existing?.members?.length > 0 && <>Members: {collisionInfo.existing.members.join(', ')}</>}
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <button type="button" onClick={() => submit('extend')} disabled={submitting} style={primaryStyle(submitting)}>
              {submitting ? 'Adding…' : 'Add missing agents'}
            </button>
            <button type="button" onClick={() => setCollisionInfo(null)} style={ghost}>Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div style={{ ...cardBox, borderColor: 'var(--eb-status-success)' }}>
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <CheckCircle size={18} style={{ color: 'var(--eb-status-success)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
                {launchResultMessage(result)}
              </div>
              {completionNotice && (
                <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 4 }}>
                  {completionNotice}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {result && completionAction && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {completionAction}
        </div>
      )}

      {error && !progressError && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
          {error}
          {errorDetail && (
            <span style={{ marginLeft: 6, color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>({errorDetail})</span>
          )}
        </div>
      )}

      {matWarnings.length > 0 && (
        <div style={{ background: 'var(--eb-bg-app)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          <strong style={{ color: 'var(--eb-text-primary)' }}>Label suffix — coverage warnings</strong>
          <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px' }}>
            {matWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {!result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)', marginTop: 'var(--eb-space-1)' }}>
          {/* #2157 AC3: readable without hovering — a `title` alone would not
              satisfy that, so this is a persistent line, not a tooltip. */}
          {showLaunchReasonHint && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', textAlign: 'right' }}>
              {launchReason}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: leftAction ? 'space-between' : 'flex-end', gap: 'var(--eb-space-2)' }}>
            {leftAction}
            <button
              type="button"
              onClick={() => submit(values.extend ? 'extend' : 'create')}
              disabled={submitting || launchBlocked}
              style={primaryStyle(submitting || launchBlocked)}
              title={launchBlocked ? launchReason : undefined}
            >
              {submitting ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
              {submitting ? ` ${primaryLabel}` : primaryLabel}
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function ProgressList({ steps, error }) {
  return (
    <div style={{ ...infoBox, gap: 'var(--eb-space-2)' }}>
      {steps.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          <StepIcon status={s.status} />
          <span>{s.label || s.id}</span>
          {s.error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-xs)' }}>{s.error}</span>}
        </div>
      ))}
      {error && <div style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-xs)' }}>{error}</div>}
    </div>
  );
}

function StepIcon({ status }) {
  if (status === 'done') return <Check size={14} style={{ color: 'var(--eb-status-success)' }} />;
  if (status === 'error') return <XCircle size={14} style={{ color: 'var(--eb-status-error)' }} />;
  if (status === 'running') return <Loader2 size={14} style={{ color: 'var(--eb-accent-primary)', animation: 'spin 1s linear infinite' }} />;
  return <Circle size={14} style={{ color: 'var(--eb-text-muted)' }} />;
}

function Field({ label, hint, error, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
      {error
        ? <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>{error}</span>
        : hint && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{hint}</span>}
    </label>
  );
}

const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
const emptyBox = {
  display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
  background: 'var(--eb-bg-app)', border: '1px dashed var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-3)',
  fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
};
const infoBox = {
  display: 'flex', flexDirection: 'column', gap: 2,
  background: 'var(--eb-bg-app)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
  fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
};
const cardBox = {
  background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-4)',
};
const checkboxRow = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
};
const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--eb-accent-primary)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
  textAlign: 'left', textDecoration: 'underline',
};
const ghost = {
  background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
const primaryBase = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
};
const primaryStyle = (disabled) => ({
  ...primaryBase,
  opacity: disabled ? 0.5 : 1,
  cursor: disabled ? 'not-allowed' : 'pointer',
});
