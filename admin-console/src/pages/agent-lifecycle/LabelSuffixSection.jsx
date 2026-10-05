import React, { useState } from 'react';
import { apiCall } from '../../hooks/useApi';
import ConfirmDialog from '../../components/ConfirmDialog';
import { labelStyle, inputStyle, helpTextStyle, SecondaryBtn } from './form-kit.jsx';
import {
  SUFFIX_HINT, sanitizeLabelSuffixInput, labelSuffixError,
} from '../process/launch-team.js';
import { suffixChangeSummary, suffixChangeError } from '../process/label-suffix-view.js';

// #2858 — the team's label suffix as one central setting (Team Settings →
// General). Changing it previews the rewrite (dry run), asks for confirmation
// with the label/agent counts and the GitHub rename warning, then applies it
// through POST /api/agents/:teamId/label-suffix. GitHub renames that failed are
// kept on the team and can be retried here.
export default function LabelSuffixSection({ team, onApplied }) {
  const current = typeof team.labelSuffix === 'string' ? team.labelSuffix : '';
  const pending = Array.isArray(team.labelSuffixPendingRenames) ? team.labelSuffixPendingRenames : [];
  const [value, setValue] = useState(current);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const url = `/api/agents/${encodeURIComponent(team.id)}/label-suffix`;
  const fieldError = labelSuffixError(value);
  const changed = value !== current;

  async function post(body) {
    try {
      return { ok: true, body: await apiCall('POST', url, body) };
    } catch (e) {
      return { ok: false, status: e.status, body: { error: e.message } };
    }
  }

  async function openPreview() {
    setBusy(true); setError(null); setNotice(null);
    const r = await post({ suffix: value, dryRun: true });
    setBusy(false);
    if (r.ok) setPreview(r.body);
    else setError(suffixChangeError(r.status, r.body));
  }

  function reportGithub(github) {
    const failed = github && Array.isArray(github.failed) ? github.failed : [];
    setNotice(failed.length
      ? `${failed.length} GitHub label rename${failed.length === 1 ? '' : 's'} failed — the team is updated; retry the GitHub rename below.`
      : 'Label suffix changed. GitHub labels were renamed in place.');
  }

  async function apply() {
    setBusy(true); setError(null);
    const r = await post({ suffix: value });
    setBusy(false);
    setPreview(null);
    if (!r.ok) { setError(suffixChangeError(r.status, r.body)); return; }
    reportGithub(r.body.github);
    if (onApplied) onApplied({ kind: 'label-suffix' });
  }

  async function retry() {
    setBusy(true); setError(null);
    const r = await post({ retry: true });
    setBusy(false);
    if (!r.ok) { setError(suffixChangeError(r.status, r.body)); return; }
    reportGithub(r.body.github);
    if (onApplied) onApplied({ kind: 'label-suffix' });
  }

  const summary = preview ? suffixChangeSummary(preview) : null;

  return (
    <div>
      <div style={labelStyle}>Label suffix</div>
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
        <input
          value={value}
          onChange={e => { setValue(sanitizeLabelSuffixInput(e.target.value)); setError(null); }}
          placeholder="no suffix"
          aria-label="Label suffix"
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)', maxWidth: 160 }}
        />
        <SecondaryBtn onClick={() => { if (!busy && changed && !fieldError) openPreview(); }}>
          {busy && !preview ? 'Checking…' : 'Change…'}
        </SecondaryBtn>
      </div>
      <div style={helpTextStyle}>
        Appended to every label this team uses, so parallel teams on one repository never wake each other.
        Empty = no suffix. {SUFFIX_HINT}
      </div>
      {fieldError && <div style={{ ...helpTextStyle, color: 'var(--eb-status-error)' }}>{fieldError}</div>}
      {error && <div role="alert" style={{ ...helpTextStyle, color: 'var(--eb-status-error)' }}>{error}</div>}
      {notice && <div role="status" style={helpTextStyle}>{notice}</div>}
      {pending.length > 0 && (
        <div style={{ ...helpTextStyle, color: 'var(--eb-status-warning)', display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>
            {pending.length} GitHub label rename{pending.length === 1 ? '' : 's'} still pending
            ({pending.map(p => `${p.from} → ${p.to}`).join(', ')}).
          </span>
          <SecondaryBtn onClick={() => { if (!busy) retry(); }}>Retry GitHub rename</SecondaryBtn>
        </div>
      )}
      <ConfirmDialog
        open={!!preview}
        title={summary ? summary.headline : ''}
        variant="warning"
        confirmLabel="Change suffix"
        busy={busy}
        maxWidth={520}
        onConfirm={apply}
        onCancel={() => { if (!busy) setPreview(null); }}
        message={summary && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            <p style={{ margin: 0 }}>{summary.body}</p>
            {preview.renames.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: 'auto', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
                {preview.renames.map(r => <li key={r.from}>{r.from} → {r.to}</li>)}
              </ul>
            )}
            <p style={{ margin: 0 }}>{summary.warning}</p>
          </div>
        )}
      />
    </div>
  );
}
