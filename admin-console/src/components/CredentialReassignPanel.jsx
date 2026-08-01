import React, { useState } from 'react';
import CredentialOwnership from './CredentialOwnership';
import { normalizeCredential, ownershipPayload } from '../pages/credential-scope-view';

// Edit form shared by the SSH Keys and GitHub Tokens pages (#798): rename a
// credential and — for System Admins only — change its scope / team assignment
// (AC7). A Team Admin may rename a team-scoped credential they own but cannot
// reassign it, so the ownership editor is shown read-only for them. The secret
// itself is never editable (create-only), matching the raw-secret-never-returned
// guarantee.
//
// `onSave` receives { name, ...ownershipPayload } (ownership omitted for a
// non-reassigning caller so the server keeps the existing assignment).

const labelStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-secondary)',
  marginBottom: 'var(--eb-space-1)',
};

const inputStyle = {
  width: '100%',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

export default function CredentialReassignPanel({ cred, teams = [], isSysAdmin, adminTeamIds = [], canReassign, onSave, onCancel, saving, error }) {
  const norm = normalizeCredential(cred || {});
  const [name, setName] = useState(cred?.name || '');
  const [ownership, setOwnership] = useState({
    scope: norm.scope,
    teamId: norm.teamId || '',
    assignedTeamIds: norm.assignedTeamIds || [],
  });

  function handleSave() {
    const body = { name: name.trim() || cred?.name };
    // Only a System Admin may reassign; for everyone else we omit ownership so
    // the server leaves the existing scope/team untouched (and would 403 anyway).
    if (canReassign) Object.assign(body, ownershipPayload(ownership));
    onSave(body);
  }

  const ownershipReady = !canReassign || ownership.scope === 'system' || !!ownership.teamId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <div>
        <div style={labelStyle}>Name</div>
        <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
      </div>

      {canReassign ? (
        <CredentialOwnership
          value={ownership}
          onChange={setOwnership}
          teams={teams}
          isSysAdmin={isSysAdmin}
          adminTeamIds={adminTeamIds}
        />
      ) : (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Only a System Admin can change which team owns a credential or reassign a system-scoped one.
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={handleSave}
          disabled={saving || !name.trim() || !ownershipReady}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: (saving || !name.trim() || !ownershipReady) ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button onClick={onCancel} style={{
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
          cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
        }}>Cancel</button>
      </div>
    </div>
  );
}
