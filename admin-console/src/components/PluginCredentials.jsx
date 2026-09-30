import React from 'react';
import { KeyRound, ChevronDown, ChevronRight } from 'lucide-react';
import { apiCall } from '../hooks/useApi';
import ConfirmDialog from './ConfirmDialog';
import {
  fieldDescriptors,
  groupDescriptors,
  scopeStatusLabel,
  scopeStatusTone,
  buildCredentialSubmit,
  isCredentialDraftDirty,
  selectScopes,
  hasStoredCredential,
  clearConfirmation,
  credentialTestTone,
  credentialTestLine,
  CREDENTIAL_ACTION_LABELS,
} from '../pages/plugin-credentials-view.js';

// Per-team Credentials section for an installed plugin that declares
// `credentials[]` (Jira plan §5, D1/D2). One field-set per team the plugin is
// granted to; a Team Admin of that team fills it. Values are written 0600
// server-side and never read back — a stored field shows only a preview, and
// blank means "leave unchanged". Applies immediately (no restart): the
// orchestrator re-pushes the per-scope map to the broker on save. Every
// render/shape decision comes from the pure plugin-credentials-view.js.
//
// #2640: "Clear" asks first (it removes every stored value, possibly one
// someone else set), and "Test connection" — also run right after a Save — has
// the broker make one cheap read with the stored credential and shows whether
// it works. The broker answers a status line; the value never comes back.
//
// Two surfaces share this one component:
//   - the Plugins registry page (default): every team scope the viewer can see.
//   - the Team-Settings service-account section (#2608): `onlyScopeId` pins it
//     to the one team being edited, so a Team Admin sees just their own account.

const TONE = {
  ok: 'var(--eb-success-fg, #0a7)',
  warn: 'var(--eb-warn-fg, #8a6d00)',
  muted: 'var(--eb-text-muted)',
  danger: 'var(--eb-danger-fg, #a00)',
};

function ScopeFields({ pluginId, pluginName, credentials, scope, onSaved }) {
  const [draft, setDraft] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [okMsg, setOkMsg] = React.useState('');
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [test, setTest] = React.useState(null); // { result, auto }

  const descriptors = React.useMemo(
    () => fieldDescriptors(credentials, (scope && scope.keys) || {}),
    [credentials, scope],
  );
  const groups = React.useMemo(
    () => groupDescriptors(credentials, (scope && scope.keys) || {}),
    [credentials, scope],
  );
  const dirty = isCredentialDraftDirty(draft, descriptors);
  const canManage = !!(scope && scope.canManage);
  const stored = hasStoredCredential(scope);
  const scopeUrl = `/api/plugins/${encodeURIComponent(pluginId)}/credentials/${encodeURIComponent(scope.scopeId)}`;

  async function runTest({ auto = false } = {}) {
    setTesting(true);
    try {
      const r = await apiCall('POST', `${scopeUrl}/test`);
      setTest({ result: (r && r.result) || null, auto });
    } catch (e) {
      setTest({ result: { ok: false, state: 'error', message: e.message || 'Test failed' }, auto });
    } finally { setTesting(false); }
  }

  async function save() {
    if (!dirty || busy) return;
    setBusy(true); setErr(''); setOkMsg('');
    try {
      const body = buildCredentialSubmit(draft, descriptors);
      const r = await apiCall('PUT', scopeUrl, body);
      setDraft({});
      setTest(null);
      setOkMsg(r && r.complete ? 'Saved — the broker has the credential.' : 'Saved — still incomplete.');
      if (onSaved) await onSaved();
    } catch (e) {
      setErr(e.message || 'Save failed');
      return;
    } finally { setBusy(false); }
    // Saved is not the same as working: check it straight away.
    await runTest({ auto: true });
  }

  // Only ever reached from the confirmation dialog's confirm button.
  async function clearAll() {
    if (busy) return;
    setBusy(true); setErr(''); setOkMsg('');
    try {
      await apiCall('DELETE', scopeUrl);
      setDraft({});
      setTest(null);
      setOkMsg('Cleared.');
      if (onSaved) await onSaved();
    } catch (e) {
      setErr(e.message || 'Clear failed');
    } finally { setBusy(false); setConfirmClear(false); }
  }

  const confirm = clearConfirmation(scope, descriptors, pluginName);
  const testLine = test ? credentialTestLine(test.result, { auto: test.auto }) : null;

  return (
    <div style={{ marginTop: 'var(--eb-space-2)', padding: 'var(--eb-space-3)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-app)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 600 }}>{scope.teamName || scope.scopeId}</span>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: TONE[scopeStatusTone(scope, credentials)] }}>{scopeStatusLabel(scope, credentials)}</span>
      </div>

      {!canManage ? (
        <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Only a Team Admin of this team can set its {pluginId} credential.
        </div>
      ) : (
        <>
          <div style={{ marginTop: 'var(--eb-space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
            {groups.map((g) => (
              <div key={g.group || '_'} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
                {g.group ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 600, color: 'var(--eb-text-secondary)' }}>{g.heading}</span>
                    <span style={{ fontSize: 'var(--eb-text-xs)', color: g.necessity.tone === 'req' ? 'var(--eb-text-secondary)' : 'var(--eb-text-muted)' }}>{g.necessity.text}</span>
                  </div>
                ) : null}
                {g.fields.map((d) => (
                  <label key={d.key} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--eb-text-xs)' }}>
                    <span style={{ color: 'var(--eb-text-secondary)' }}>
                      {d.label}{d.required ? ' *' : ''}{d.description ? <span style={{ color: 'var(--eb-text-muted)' }}> — {d.description}</span> : null}
                    </span>
                    <input
                      type={d.type}
                      autoComplete="off"
                      value={draft[d.key] !== undefined ? draft[d.key] : (d.secret ? '' : d.storedValue)}
                      placeholder={d.placeholder}
                      disabled={busy}
                      onChange={(e) => setDraft((p) => ({ ...p, [d.key]: e.target.value }))}
                      style={{
                        padding: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
                        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
                        background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-primary)',
                      }}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 'var(--eb-space-2)', display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || busy}
              style={{
                padding: 'var(--eb-space-1) var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
                borderRadius: 'var(--eb-radius-sm)', border: '1px solid var(--eb-border-default)',
                background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-primary)',
                cursor: (!dirty || busy) ? 'not-allowed' : 'pointer', opacity: (!dirty || busy) ? 0.5 : 1,
              }}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {stored && (
              <button
                type="button"
                onClick={() => runTest()}
                disabled={busy || testing}
                style={{
                  padding: 'var(--eb-space-1) var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
                  borderRadius: 'var(--eb-radius-sm)', border: '1px solid var(--eb-border-default)',
                  background: 'none', color: 'var(--eb-text-primary)',
                  cursor: (busy || testing) ? 'not-allowed' : 'pointer', opacity: (busy || testing) ? 0.5 : 1,
                }}
              >
                {testing ? CREDENTIAL_ACTION_LABELS.testing : CREDENTIAL_ACTION_LABELS.test}
              </button>
            )}
            {stored && (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={busy}
                style={{
                  padding: 'var(--eb-space-1) var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
                  borderRadius: 'var(--eb-radius-sm)', border: '1px solid var(--eb-border-default)',
                  background: 'none', color: 'var(--eb-danger-fg, #a00)', cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                {CREDENTIAL_ACTION_LABELS.clear}
              </button>
            )}
            {okMsg && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-success-fg, #0a7)' }}>{okMsg}</span>}
            {err && <span role="alert" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-danger-fg, #a00)' }}>{err}</span>}
          </div>
          {testLine && (
            <div role="status" style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: TONE[credentialTestTone(test.result)] }}>
              {testLine}
            </div>
          )}

          <ConfirmDialog
            open={confirmClear}
            title={confirm.title}
            message={confirm.message}
            confirmLabel={CREDENTIAL_ACTION_LABELS.clearConfirm}
            variant="danger"
            busy={busy}
            onConfirm={clearAll}
            onCancel={() => setConfirmClear(false)}
          />
        </>
      )}
    </div>
  );
}

export default function PluginCredentials({ row, onlyScopeId = null, label = null, defaultOpen = false }) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await apiCall('GET', `/api/plugins/${encodeURIComponent(row.id)}/credentials`);
      setData(r);
    } catch (e) {
      setErr(e.message || 'Could not load credentials');
    } finally { setLoading(false); }
  }, [row.id]);

  React.useEffect(() => { if (open && !data && !loading) load(); }, [open, data, loading, load]);

  const scopes = selectScopes(data && data.scopes, onlyScopeId);
  const credentials = (data && Array.isArray(data.credentials)) ? data.credentials : [];

  return (
    <div style={{ marginTop: 'var(--eb-space-3)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <KeyRound size={14} style={{ color: 'var(--eb-text-muted)', flex: '0 0 auto' }} />
        <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-muted)' }}>
          Credentials
        </span>
      </div>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
          marginTop: 'var(--eb-space-2)', padding: 0, border: 'none', background: 'none',
          fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)', fontWeight: 500,
          color: 'var(--eb-accent-primary)', cursor: 'pointer',
        }}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {open
          ? 'Hide credentials'
          : (label || `Set the ${row.credentialKeys.join(' / ')} per team`)}
      </button>

      {open && (
        <div style={{ marginTop: 'var(--eb-space-2)' }}>
          {loading && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Loading…</div>}
          {err && <div role="alert" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-danger-fg, #a00)' }}>{err}</div>}
          {!loading && !err && scopes.length === 0 && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              {onlyScopeId
                ? 'Grant this plugin to the team above first, then its service account can be set here.'
                : 'This plugin is not granted to any team you can see. Assign it to a team first.'}
            </div>
          )}
          {scopes.map((scope) => (
            <ScopeFields
              key={scope.scopeId}
              pluginId={row.id}
              pluginName={row.name || row.id}
              credentials={credentials}
              scope={scope}
              onSaved={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
