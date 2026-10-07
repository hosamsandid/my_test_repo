import React from 'react';
import SuffixedLabelInput from '../../components/SuffixedLabelInput';
import { DEFAULT_FAILURE_LABEL, DEFAULT_TIMEOUT_MINUTES, TIMEOUT_LABEL } from './readiness-gate';

// Readiness gate on a PR hand-off (#2795): hold the wake until CI is green and
// the PR merges cleanly. `value` is a readinessForm() state. Shared by the Flow
// editor's hand-off dialogs and Agent Chat → Triggers (#2912), so both offer
// the same toggles with the same wording. `when` names what wakes the agent
// while the gate is off (a label hand-off by default).
export default function ReadinessGateFields({ value, onChange, toLabel, error, when = 'the label is set' }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const on = value.ci || value.conflict;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)' }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Before {toLabel} is woken</span>
      <label style={check}>
        <input type="checkbox" checked={!!value.ci} onChange={e => set({ ci: e.target.checked })} />
        Wait for CI — hold the wake until the PR's checks pass
      </label>
      <label style={check}>
        <input type="checkbox" checked={!!value.conflict} onChange={e => set({ conflict: e.target.checked })} />
        Block on merge conflict — hold the wake until the PR merges cleanly
      </label>
      {on && (
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <Field label="On failure, set label">
            <SuffixedLabelInput value={value.failureLabel} onChange={v => set({ failureLabel: v })}
              placeholder={DEFAULT_FAILURE_LABEL} style={input} />
          </Field>
          <Field label="Timeout (minutes)">
            <input value={value.timeoutMinutes} onChange={e => set({ timeoutMinutes: e.target.value })}
              inputMode="numeric" placeholder={String(DEFAULT_TIMEOUT_MINUTES)} style={input} />
          </Field>
        </div>
      )}
      <small style={small}>
        {on
          ? <>Failing checks or a conflict remove the hand-off label, set the failure label and comment on the PR. After the timeout the label is removed and <code>{TIMEOUT_LABEL}</code> is set.</>
          : <>Off: {toLabel} is woken as soon as {when}, whatever the PR's checks say.</>}
      </small>
      {error && <small style={errStyle}>{error}</small>}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}

const small = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' };
const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
const check = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' };
const errStyle = { fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' };
