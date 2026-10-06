import React, { useState } from 'react';
import { useApi, apiCall } from '../../hooks/useApi';
import { labelStyle, helpTextStyle, SecondaryBtn } from './form-kit.jsx';
import { missingLabelRows, unreadableNote } from './missing-labels-view.js';

// Team Settings: wake labels the team's triggers listen on that do not exist
// on their repository (#2878) — such a hand-off can never fire. Renders
// nothing while loading, on a read error, or when every label exists.
// "Create label" creates it on GitHub (server-gated to a Team Admin).
export default function MissingWakeLabelsSection({ teamId }) {
  const { data, refetch } = useApi(`/api/teams/${encodeURIComponent(teamId)}/missing-labels`);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const rows = missingLabelRows(data);
  const note = unreadableNote(data);
  if (!rows.length && !note) return null;

  async function create(row) {
    if (busy != null) return;
    setBusy(row.key);
    setError('');
    try {
      await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/repo-labels`, { repo: row.repo, label: row.label });
      refetch();
    } catch (err) {
      setError(err.message || 'Could not create the label');
    }
    setBusy(null);
  }

  return (
    <div>
      <div style={labelStyle}>Wake labels on GitHub</div>
      {rows.map((r) => (
        <div key={r.key} style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-1)',
          padding: 'var(--eb-space-2)', borderLeft: '3px solid var(--eb-status-warning, #d97706)',
          background: 'var(--eb-bg-app)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
        }}>
          <span style={{ flex: 1 }}>{r.text}</span>
          <SecondaryBtn onClick={() => create(r)}>{busy === r.key ? 'Creating…' : 'Create label'}</SecondaryBtn>
        </div>
      ))}
      {note && <div style={helpTextStyle}>{note}</div>}
      {error && <div style={{ ...helpTextStyle, color: 'var(--eb-status-error)' }}>{error}</div>}
      <div style={helpTextStyle}>
        A trigger can only be woken by a label that exists on its repository. Create the missing label here, or point the trigger at one that exists.
      </div>
    </div>
  );
}
