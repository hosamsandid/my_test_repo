import React, { useState } from 'react';
import CredentialOwnership from './CredentialOwnership';
import { normalizeCredential, ownershipPayload, ownershipFromRecord } from '../pages/credential-scope-view';

// Edit form shared by the SSH Keys and GitHub Tokens pages (#798): rename a
// credential and — for System Admins only — change its scope / team assignment
// (AC7). A Team Admin may rename a team-scoped credential they own but cannot
// reassign it, so the ownership editor is shown read-only for them. The secret
// itself is never editable (create-only), matching the raw-secret-never-returned
// guarantee.
//
// `onSave` receives { name, ...ownershipPayload } (ownership omitted for a
// non-reassigning caller so the server keeps the existing assignment).
//
// `secretHelp` (optional ReactNode) is rendered under the Name field — used to
// explain that the secret is create-only and how to rotate it (e.g. the GitHub
// Tokens page surfaces the rotation-via-environment + agent-respawn note there).

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

export default function CredentialReassignPanel({ cred, teams = [], isSysAdmin, adminTeamIds = [], canReassign, onSave, onCancel, saving, error, secretHelp, v2 = false }) {
  const norm = normalizeCredential(cred || {});
  const [name, setName] = useState(cred?.name || '');
  // #2360: under v2 open the edit form on the SAME identity+scope control the
  // create form uses (via `ownershipFromRecord`, which carries the record's
  // immutable `identity`), so edit and create are one taxonomy. Off the flag the
  // legacy scope-only state is byte-identical to before.
  const [ownership, setOwnership] = useState(() => (
    v2
      ? ownershipFromRecord(cred, { isSysAdmin, adminTeamIds, v2, kind: 'credential' })
      : { scope: norm.scope, teamId: norm.teamId || '', assignedTeamIds: norm.assignedTeamIds || [] }
  ));

  function handleSave() {
    const body = { name: name.trim() || cred?.name };
    // Only a System Admin may reassign; for everyone else we omit ownership so
    // the server leaves the existing scope/team untouched (and would 403 anyway).
    // Personal is never reassignable (the caller gates canReassign on that), so a
    // personal edit is always a name-only rename.
    if (canReassign) Object.assign(body, ownershipPayload(ownership, { v2 }));
    onSave(body);
  }

  const ownershipReady = !canReassign || ownership.scope === 'system' || ownership.scope === 'personal' || !!ownership.teamId;

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

      {secretHelp && (
        <div style={{
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
          lineHeight: 1.5,
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
        }}>{secretHelp}</div>
      )}

      {v2 ? (
        // #2360: always render the identity+scope control so the edit dialog shows
        // the same taxonomy as create. `isEdit` fixes the immutable identity
        // read-only; `disabled` when the caller can't reassign (a non-System-Admin,
        // or a personal credential — never reassignable) makes it a read-only view
        // of the current ownership rather than the old bare "only a System Admin…"
        // line. A name-only rename still saves (handleSave omits ownership).
        <CredentialOwnership
          value={ownership}
          onChange={setOwnership}
          teams={teams}
          isSysAdmin={isSysAdmin}
          adminTeamIds={adminTeamIds}
          v2
          isEdit
          disabled={!canReassign}
        />
      ) : canReassign ? (
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
