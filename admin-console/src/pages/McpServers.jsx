import React, { useState } from 'react';
import { Trash2, Plus, KeyRound, Server, Info } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import WhenCell from '../components/WhenCell';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import IconButton from '../components/IconButton';
import InfoTip from '../components/InfoTip';
import { describeServerSubmitState, describeCredentialSubmitState } from './mcp-server-submit-state.js';

const inputStyle = {
  width: '100%',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};

const monoStyle = { fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' };

// When a Save button is disabled (and not merely mid-save), spell out exactly
// which required field is still empty so a user new to the console isn't left
// guessing why the form looks broken. Mirrors the AgentCreateForm hint (#1773).
function SubmitBlockers({ label, reasons }) {
  if (reasons.length === 0) return null;
  return (
    <div style={{
      display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
      fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
    }}>
      <Info size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
      <span>
        {label} is disabled until you:
        <ul style={{ margin: 'var(--eb-space-1) 0 0', paddingLeft: 'var(--eb-space-4)' }}>
          {reasons.map(r => <li key={r.field}>{r.message}</li>)}
        </ul>
      </span>
    </div>
  );
}

function CreateServerForm({ onSave, onCancel, saving, error }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName,
    setId,
    getName: () => name,
  });
  const [transport, setTransport] = useState('stdio');
  const [command, setCommand] = useState('node');
  const [argsText, setArgsText] = useState('/template-workspace/mcp-servers/wiki/server.js');
  const [url, setUrl] = useState('');
  // Stdio servers use process env (KEY=value); http/sse servers use HTTP
  // headers (Header: value). Same template + ${credential} substitution
  // semantics, but the wire format differs, so we keep two parsers and let
  // the user enter whichever idiom matches the transport.
  const [envText, setEnvText] = useState('WIKI_BASE_URL=https://wiki.example/api\nWIKI_TOKEN=${credential}');
  const [headersText, setHeadersText] = useState('Authorization: Bearer ${credential}\nContent-Type: application/json');

  const isHttp = transport === 'http' || transport === 'sse';

  function parseKeyValue(text, sep) {
    const out = {};
    for (const line of (text || '').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf(sep);
      if (idx < 1) continue;
      out[t.slice(0, idx).trim()] = t.slice(idx + sep.length).trim();
    }
    return out;
  }

  const { canSave, reasons: submitBlockers } = describeServerSubmitState({ id, name, transport, command, url });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <FormInput label="Name *" value={name} onChange={handleNameChange} placeholder="Wiki search" />

      <IdField
        value={id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        placeholder="wiki"
        helpText={<>Auto-derived from Name; edit to override. {ID_FORMAT_HINT} Used as the key in <code>.claude/settings.json</code> <code>mcpServers</code>.</>}
      />

      <FormInput label="Description" value={description} onChange={setDescription} placeholder="What agents use this server for" />

      <div>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
          Transport
        </div>
        <select value={transport} onChange={e => setTransport(e.target.value)} style={inputStyle}>
          <option value="stdio">stdio (local subprocess)</option>
          <option value="http">http (remote endpoint, streamable HTTP)</option>
          <option value="sse">sse (remote endpoint, Server-Sent Events)</option>
        </select>
      </div>

      {!isHttp ? (
        <>
          <FormInput label="Command *" value={command} onChange={setCommand} placeholder="node" />
          <div>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
              Args (one per line)
            </div>
            <textarea
              value={argsText}
              onChange={e => setArgsText(e.target.value)}
              rows={3}
              style={{ ...inputStyle, ...monoStyle, resize: 'vertical' }}
            />
          </div>
        </>
      ) : (
        <FormInput label="URL *" value={url} onChange={setUrl} placeholder="https://mcp.example/api" />
      )}

      <div>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
          {isHttp ? 'HTTP headers template' : 'Environment template'}
        </div>
        <textarea
          value={isHttp ? headersText : envText}
          onChange={e => (isHttp ? setHeadersText(e.target.value) : setEnvText(e.target.value))}
          rows={5}
          placeholder={isHttp ? 'Header: value (one per line)' : 'KEY=value (one per line)'}
          style={{ ...inputStyle, ...monoStyle, resize: 'vertical' }}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Use <code style={monoStyle}>${'${credential}'}</code> as the placeholder for the bound credential's secret —
          the orchestrator substitutes it per-agent at seed time. {isHttp
            ? <>For http/sse the rendered values become HTTP request headers (e.g. <code style={monoStyle}>Authorization: Bearer …</code>).</>
            : <>For stdio they're injected as process environment variables.</>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        {!saving && <SubmitBlockers label="Save server" reasons={submitBlockers} />}
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
        <button
          onClick={() => onSave({
            id: id.trim(),
            name: name.trim(),
            description: description.trim(),
            transport,
            ...(isHttp
              ? { url: url.trim(), headers: parseKeyValue(headersText, ':') }
              : {
                  command: command.trim(),
                  args: argsText.split('\n').map(s => s.trim()).filter(Boolean),
                  env: parseKeyValue(envText, '='),
                }),
          })}
          disabled={saving || !canSave}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: (saving || !canSave) ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save server'}
        </button>
        <button onClick={onCancel} style={{
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
          cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
        }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function CreateCredentialForm({ servers, onSave, onCancel, saving, error }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [serverId, setServerId] = useState('');
  const [secret, setSecret] = useState('');
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName,
    setId,
    getName: () => name,
  });

  const { canSave, reasons: submitBlockers } = describeCredentialSubmitState({ name, secret });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <FormInput label="Name *" value={name} onChange={handleNameChange} placeholder="Confluence team-A bot token" hint="A descriptive label so operators can identify which credential is bound where." />

      <IdField
        value={id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        placeholder="confluence-team-a"
        helpText={<>Auto-derived from Name; edit to override. {ID_FORMAT_HINT} Used as the filename of the stored secret.</>}
      />

      <div>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
          Default server (optional)
        </div>
        <select value={serverId} onChange={e => setServerId(e.target.value)} style={inputStyle}>
          <option value="">— unbound —</option>
          {(servers || []).map(s => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
        </select>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          A hint only. Environments may pair this credential with any compatible server.
        </div>
      </div>

      <div>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
          Secret <span style={{ color: 'var(--eb-status-error)' }}>*</span>
        </div>
        <textarea
          value={secret}
          onChange={e => setSecret(e.target.value)}
          rows={4}
          placeholder="API token, bearer token, etc."
          style={{ ...inputStyle, ...monoStyle, resize: 'vertical' }}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Stored at <code style={monoStyle}>/workspace/mcp-credentials/_keys/&lt;id&gt;</code> with mode 0600.
          The value is never returned by the API — only its fingerprint.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        {!saving && <SubmitBlockers label="Save credential" reasons={submitBlockers} />}
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
        <button
          onClick={() => onSave({ name: name.trim(), id: id.trim() || undefined, serverId: serverId || null, secret: secret.trim() })}
          disabled={saving || !canSave}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: (saving || !canSave) ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save credential'}
        </button>
        <button onClick={onCancel} style={{
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
          cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
        }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function McpServers() {
  const { data: servers, loading: serversLoading, error: serversError, refetch: refetchServers } = useApi('/api/mcp-servers');
  const { data: credentials, loading: credsLoading, error: credsError, refetch: refetchCreds } = useApi('/api/mcp-credentials');
  const [creatingServer, setCreatingServer] = useState(false);
  const [creatingCred, setCreatingCred] = useState(false);
  const [deleteServer, setDeleteServer] = useState(null);
  const [deleteCred, setDeleteCred] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function handleSaveServer(data) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/mcp-servers', data);
      setCreatingServer(false);
      refetchServers();
    } catch (e) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  async function handleSaveCred(data) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/mcp-credentials', data);
      setCreatingCred(false);
      refetchCreds();
    } catch (e) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  async function doDeleteServer() {
    try {
      await apiCall('DELETE', `/api/mcp-servers/${deleteServer.id}`);
      setDeleteServer(null);
      refetchServers();
    } catch (e) { setActionError(e.message); setDeleteServer(null); }
  }

  async function doDeleteCred() {
    try {
      await apiCall('DELETE', `/api/mcp-credentials/${deleteCred.id}`);
      setDeleteCred(null);
      refetchCreds();
    } catch (e) { setActionError(e.message); setDeleteCred(null); }
  }

  const SERVER_COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={monoStyle}>{v}</span> },
    { key: 'name', label: 'Name' },
    { key: 'transport', label: 'Transport' },
    { key: 'command', label: 'Command/URL', render: (_, r) => (
      <span style={monoStyle}>
        {(r.transport === 'http' || r.transport === 'sse') ? r.url : [r.command, ...(r.args || [])].join(' ')}
      </span>
    )},
    { key: 'requiresCredential', label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
        Credential
        <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex' }}>
          <InfoTip
            title="Where does “required” come from?"
            text={<>Shows <strong>required</strong> automatically when this server's template references <code>{'${credential}'}</code> in its env/headers. At seed time the orchestrator fills that placeholder with the secret from the credential the Working Environment binds to this server.</>}
          />
        </span>
      </span>
    ), render: v => v
      ? <span title="Required because this server's template references ${credential} — bind a credential in the Working Environment.">required</span>
      : '—' },
    { key: '_actions', label: '', sortable: false, render: (_, row) => (
      <div onClick={e => e.stopPropagation()}><IconButton icon={Trash2} label="Delete" danger onClick={() => setDeleteServer(row)} /></div>
    )},
  ];

  const CRED_COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={monoStyle}>{v}</span> },
    { key: 'name', label: 'Name' },
    { key: 'serverId', label: 'Default server', render: v => v ? <span style={monoStyle}>{v}</span> : '—' },
    { key: 'fingerprint', label: 'Fingerprint', render: v => <span style={{ ...monoStyle, color: 'var(--eb-text-secondary)' }}>{v}</span> },
    { key: 'createdAt', label: 'Added', render: v => <WhenCell iso={v} /> },
    { key: '_actions', label: '', sortable: false, render: (_, row) => (
      <div onClick={e => e.stopPropagation()}><IconButton icon={Trash2} label="Delete" danger onClick={() => setDeleteCred(row)} /></div>
    )},
  ];

  if (serversLoading || credsLoading) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  const loadError = serversError || credsError;
  if (loadError) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load: {loadError}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-6)' }}>
      <div>
        <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 0, marginBottom: 0, lineHeight: 1.6 }}>
          Configure runtime knowledge sources (wiki, vector store, graph DB, …) that agents can query through the
          Model Context Protocol. It's a three-part model: <strong>servers</strong> describe <em>how</em> to launch a
          backend and mark where a secret goes with the <code style={monoStyle}>${'${credential}'}</code> placeholder;
          <strong> credentials</strong> carry the secrets; a <strong>Working Environment</strong> pairs a server with a
          credential. A server whose template uses that placeholder shows <em>required</em> in the Credential column
          below until an environment binds one. The orchestrator then substitutes the secret and materializes the merged
          config into each agent's own <code style={monoStyle}>.claude/settings.json</code> at workspace seed time.
        </p>
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
            <Server size={16} /> Servers
          </h2>
          <button
            onClick={() => { setCreatingServer(true); setFormError(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            <Plus size={15} /> New server
          </button>
        </div>
        <DataTable columns={SERVER_COLUMNS} data={servers ?? []} emptyText="No MCP servers configured yet. Click 'New server' to add one." />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
            <KeyRound size={16} /> Credentials
          </h2>
          <button
            onClick={() => { setCreatingCred(true); setFormError(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            <Plus size={15} /> New credential
          </button>
        </div>
        <DataTable columns={CRED_COLUMNS} data={credentials ?? []} emptyText="No credentials stored yet. Click 'New credential' to add one." />
      </section>

      <SidePanel
        open={creatingServer}
        onClose={() => { setCreatingServer(false); setFormError(null); }}
        title="New MCP server"
        width="640px"
      >
        {creatingServer && (
          <CreateServerForm
            onSave={handleSaveServer}
            onCancel={() => { setCreatingServer(false); setFormError(null); }}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <SidePanel
        open={creatingCred}
        onClose={() => { setCreatingCred(false); setFormError(null); }}
        title="New MCP credential"
        width="560px"
      >
        {creatingCred && (
          <CreateCredentialForm
            servers={servers}
            onSave={handleSaveCred}
            onCancel={() => { setCreatingCred(false); setFormError(null); }}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteServer}
        title="Delete MCP server"
        message={`Really delete "${deleteServer?.name || deleteServer?.id}"? Working Environments using it must detach it first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={doDeleteServer}
        onCancel={() => setDeleteServer(null)}
      />
      <ConfirmDialog
        open={!!deleteCred}
        title="Delete MCP credential"
        message={`Really delete "${deleteCred?.name || deleteCred?.id}"? Working Environments using it must detach it first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={doDeleteCred}
        onCancel={() => setDeleteCred(null)}
      />
    </div>
  );
}
