import React, { useState } from 'react';
import {
  Check, ChevronRight, PlugZap, RefreshCw, Plus, X, ArrowRight, SkipForward,
} from 'lucide-react';
import { apiCall } from '../hooks/useApi';
import FormInput from '../components/FormInput';

/* ─── Shared button styles ─────────────────────────────────────── */

const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-5)',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer', fontFamily: 'inherit',
};

const btnSecondary = {
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
  cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
};

const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  background: 'transparent', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
  cursor: 'pointer', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
};

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none',
};

/* ─── Progress Stepper ─────────────────────────────────────────── */

const STEPS = [
  { id: 'llm',         label: 'LLM Endpoint',       required: true },
  { id: 'ssh-key',     label: 'SSH Key',             required: false },
  { id: 'gh-token',    label: 'GitHub Token',        required: false },
  { id: 'environment', label: 'Working Environment', required: false },
  { id: 'agent',       label: 'First Agent',         required: false },
];

function Stepper({ current, done }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      marginBottom: 'var(--eb-space-8)',
    }}>
      {STEPS.map((s, i) => {
        const isDone    = done.includes(s.id);
        const isCurrent = i === current;
        const isPast    = i < current;
        return (
          <React.Fragment key={s.id}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--eb-space-1)', minWidth: 100 }}>
              <div style={{
                width: 32, height: 32,
                borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)',
                background: isDone || isPast
                  ? 'var(--eb-status-success)'
                  : isCurrent
                    ? 'var(--eb-accent-primary)'
                    : 'var(--eb-bg-elevated)',
                color: isDone || isPast || isCurrent ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
                border: isCurrent ? 'none' : '1px solid var(--eb-border-default)',
                transition: 'background 0.2s',
              }}>
                {isDone || isPast ? <Check size={15} /> : i + 1}
              </div>
              <div style={{
                fontSize: 'var(--eb-text-xs)',
                color: isCurrent ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
                fontWeight: isCurrent ? 'var(--eb-font-medium)' : 'normal',
                textAlign: 'center', whiteSpace: 'nowrap',
              }}>
                {s.label}
                {s.required && <span style={{ color: 'var(--eb-status-error)', marginLeft: 2 }}>*</span>}
              </div>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{
                flex: 1, height: 1, background: isPast || isDone ? 'var(--eb-status-success)' : 'var(--eb-border-default)',
                marginBottom: 'var(--eb-space-5)',
                transition: 'background 0.2s',
              }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ─── Error banner ─────────────────────────────────────────────── */

function ErrorBanner({ msg }) {
  if (!msg) return null;
  return (
    <div role="alert" style={{
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)',
      borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-error)',
      fontSize: 'var(--eb-text-sm)',
    }}>{msg}</div>
  );
}

/* ─── Step 1: LLM Endpoint ─────────────────────────────────────── */

function ModelEditor({ models, onChange }) {
  const update = (i, patch) => onChange(models.map((m, idx) => idx === i ? { ...m, ...patch } : m));
  const remove = (i) => onChange(models.filter((_, idx) => idx !== i));
  const add    = () => onChange([...models, { id: '', displayName: '', kind: '' }]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      {models.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 110px 32px', gap: 'var(--eb-space-2)',
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.04em',
        }}>
          <div>Model ID</div><div>Display name</div><div>Kind</div><div />
        </div>
      )}
      {models.map((m, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 110px 32px', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <input value={m.id} onChange={e => update(i, { id: e.target.value })} placeholder="claude-sonnet-4-6"
            style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }} />
          <input value={m.displayName} onChange={e => update(i, { displayName: e.target.value })} placeholder="Sonnet 4.6"
            style={inputStyle} />
          <select value={m.kind} onChange={e => update(i, { kind: e.target.value })} style={{ ...inputStyle }}>
            <option value="">—</option>
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
          </select>
          <button onClick={() => remove(i)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, background: 'transparent', border: '1px solid var(--eb-status-error)', color: 'var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', cursor: 'pointer' }}>
            <X size={14} />
          </button>
        </div>
      ))}
      <button type="button" onClick={add} style={{ ...btnGhost, alignSelf: 'flex-start' }}>
        <Plus size={13} /> Add model
      </button>
    </div>
  );
}

function StepLlm({ onNext, onSkip }) {
  const [name, setName]         = useState('Default');
  const [baseUrl, setBaseUrl]   = useState('');
  const [authToken, setAuthToken] = useState('');
  const [models, setModels]     = useState([]);
  const [saving, setSaving]     = useState(false);
  const [probing, setProbing]   = useState(null);
  const [probeMsg, setProbeMsg] = useState(null);
  const [error, setError]       = useState(null);
  const [savedId, setSavedId]   = useState(null);

  const canSave = name.trim() && baseUrl.trim();

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const payload = {
        name: name.trim(), baseUrl: baseUrl.trim(),
        models: models.filter(m => m.id?.trim()).map(m => ({
          id: m.id.trim(), displayName: (m.displayName || m.id).trim(),
          ...(m.kind ? { kind: m.kind } : {}),
        })),
      };
      if (authToken.trim()) payload.authToken = authToken.trim();
      const ep = await apiCall('POST', '/api/llm-endpoints', payload);
      setSavedId(ep.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function runDiscover() {
    if (!savedId) return;
    setProbing('discover'); setProbeMsg(null);
    try {
      const r = await apiCall('POST', `/api/llm-endpoints/${savedId}/discover-models`);
      setModels(r.models || []);
      setProbeMsg({ ok: true, text: `Found ${r.count ?? r.models?.length ?? 0} model(s)` });
      // persist discovered models
      await apiCall('PUT', `/api/llm-endpoints/${savedId}`, {
        name, baseUrl,
        models: (r.models || []).filter(m => m.id?.trim()),
      });
    } catch (e) {
      setProbeMsg({ ok: false, text: e.message });
    } finally {
      setProbing(null);
    }
  }

  async function runTest() {
    if (!savedId) return;
    setProbing('test'); setProbeMsg(null);
    try {
      const r = await apiCall('POST', `/api/llm-endpoints/${savedId}/test`);
      setProbeMsg({ ok: r.ok, text: r.ok ? `OK (HTTP ${r.status})` : `Failed: ${r.error || 'HTTP ' + r.status}` });
    } catch (e) {
      setProbeMsg({ ok: false, text: e.message });
    } finally {
      setProbing(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div>
        <h2 style={{ margin: '0 0 var(--eb-space-1)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)' }}>
          LLM Endpoint
        </h2>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
          Connect the system to an Anthropic-compatible API — the Anthropic API directly or a LiteLLM proxy.
          This is the only required step; everything else can be configured later.
        </p>
      </div>

      <ErrorBanner msg={error} />

      <FormInput label="Name" required value={name} onChange={setName} placeholder="e.g. LiteLLM Prod" />
      <FormInput label="Base URL" required type="url" value={baseUrl} onChange={setBaseUrl} placeholder="https://api.anthropic.com" />

      <div>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
          Auth token <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)' }}>(optional)</span>
        </div>
        <textarea
          value={authToken} onChange={e => setAuthToken(e.target.value)} rows={2}
          placeholder="sk-… (sent as Bearer token)"
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', resize: 'vertical' }}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Stored in <code style={{ fontFamily: 'var(--eb-font-mono)' }}>/workspace/llm-endpoints/_keys/</code> (chmod 600). Never returned by the API.
        </div>
      </div>

      {!savedId ? (
        <button onClick={handleSave} disabled={saving || !canSave}
          style={{ ...btnPrimary, cursor: saving ? 'wait' : 'pointer', opacity: (saving || !canSave) ? 0.6 : 1, alignSelf: 'flex-start' }}>
          {saving ? 'Saving…' : 'Save endpoint'}
        </button>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
          padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-status-success)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            <Check size={15} /> Endpoint saved
          </div>

          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" onClick={runTest} disabled={probing === 'test'} style={{ ...btnGhost, opacity: probing === 'test' ? 0.6 : 1 }}>
              <PlugZap size={13} /> {probing === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" onClick={runDiscover} disabled={!!probing} style={{ ...btnGhost, opacity: probing ? 0.6 : 1 }}>
              <RefreshCw size={13} /> {probing === 'discover' ? 'Discovering…' : 'Discover models'}
            </button>
            {probeMsg && (
              <span style={{ fontSize: 'var(--eb-text-xs)', color: probeMsg.ok ? 'var(--eb-status-success)' : 'var(--eb-status-error)' }}>
                {probeMsg.text}
              </span>
            )}
          </div>

          {models.length > 0 && (
            <div>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)' }}>
                Model catalog — edit if needed, then continue:
              </div>
              <ModelEditor models={models} onChange={setModels} />
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={onNext} disabled={!savedId}
          style={{ ...btnPrimary, cursor: savedId ? 'pointer' : 'not-allowed', opacity: savedId ? 1 : 0.5 }}>
          Continue <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

/* ─── Step 2: SSH Key ──────────────────────────────────────────── */

function StepSshKey({ onNext, onSkip }) {
  const [name, setName]           = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState(null);
  const [saved, setSaved]         = useState(false);

  const canSave = name.trim() && privateKey.trim();

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      await apiCall('POST', '/api/ssh-keys', { name: name.trim(), privateKey: privateKey.trim() });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div>
        <h2 style={{ margin: '0 0 var(--eb-space-1)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)' }}>
          SSH Key
        </h2>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
          An SSH key lets agents clone private Git repositories. Skip this step if you don't need Git access yet.
        </p>
      </div>

      <ErrorBanner msg={error} />

      {!saved ? (
        <>
          <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
            Generate a key pair with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ssh-keygen -t ed25519 -C "aee-deploy-key"</code> (no passphrase),
            add the <strong>.pub</strong> file to your GitHub instance, then paste the private key below.
          </div>

          <FormInput label="Name" required value={name} onChange={setName} placeholder="e.g. GitHub Deploy Key" />

          <div>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
              Private SSH key <span style={{ color: 'var(--eb-status-error)' }}>*</span>
            </div>
            <textarea value={privateKey} onChange={e => setPrivateKey(e.target.value)} rows={10}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
            />
          </div>

          <button onClick={handleSave} disabled={saving || !canSave}
            style={{ ...btnPrimary, opacity: (saving || !canSave) ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer', alignSelf: 'flex-start' }}>
            {saving ? 'Saving…' : 'Save key'}
          </button>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-status-success)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)' }}>
          <Check size={15} /> SSH key saved — only the fingerprint is retained, the private key value is not stored in plaintext.
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={onNext} disabled={!saved}
          style={{ ...btnPrimary, opacity: saved ? 1 : 0.5, cursor: saved ? 'pointer' : 'not-allowed' }}>
          Continue <ArrowRight size={15} />
        </button>
        <button onClick={onSkip} style={btnSecondary}>
          <SkipForward size={14} /> Skip for now
        </button>
      </div>
    </div>
  );
}

/* ─── Step 3: GitHub Token ─────────────────────────────────────── */

function StepGhToken({ onNext, onSkip }) {
  const [name, setName]   = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);
  const [saved, setSaved]   = useState(false);

  const canSave = name.trim() && token.trim();

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      await apiCall('POST', '/api/github-tokens', { name: name.trim(), token: token.trim() });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div>
        <h2 style={{ margin: '0 0 var(--eb-space-1)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)' }}>
          GitHub Token
        </h2>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
          A Personal Access Token allows agents to push commits, open pull requests, and use the <code>gh</code> CLI.
          Skip if you don't need GitHub API access yet.
        </p>
      </div>

      <ErrorBanner msg={error} />

      {!saved ? (
        <>
          <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
            GitHub → Settings → Developer settings → Personal access tokens. For fine-grained tokens, grant <strong>Contents (read &amp; write)</strong>, <strong>Metadata (read)</strong>, and optionally <strong>Pull requests (read &amp; write)</strong>.
          </div>

          <FormInput label="Name" required value={name} onChange={setName} placeholder="e.g. AccentureCodeFoundry PAT" />

          <div>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
              Token <span style={{ color: 'var(--eb-status-error)' }}>*</span>
            </div>
            <textarea value={token} onChange={e => setToken(e.target.value)} rows={3}
              placeholder="github_pat_… or ghp_…"
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
            />
          </div>

          <button onClick={handleSave} disabled={saving || !canSave}
            style={{ ...btnPrimary, opacity: (saving || !canSave) ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer', alignSelf: 'flex-start' }}>
            {saving ? 'Saving…' : 'Save token'}
          </button>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-status-success)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)' }}>
          <Check size={15} /> Token saved — only a short preview and fingerprint are retained.
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={onNext} disabled={!saved}
          style={{ ...btnPrimary, opacity: saved ? 1 : 0.5, cursor: saved ? 'pointer' : 'not-allowed' }}>
          Continue <ArrowRight size={15} />
        </button>
        <button onClick={onSkip} style={btnSecondary}>
          <SkipForward size={14} /> Skip for now
        </button>
      </div>
    </div>
  );
}

/* ─── Step 4: Working Environment ─────────────────────────────── */

function StepEnvironment({ onNext, onSkip }) {
  const [name, setName]   = useState('');
  const [desc, setDesc]   = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);
  const [saved, setSaved]   = useState(false);

  const canSave = name.trim();

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const id = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      await apiCall('POST', '/api/environments', {
        id, name: name.trim(), description: desc.trim(),
        skills: [], repositories: [],
      });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div>
        <h2 style={{ margin: '0 0 var(--eb-space-1)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)' }}>
          Working Environment
        </h2>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
          A Working Environment is a workspace recipe that agents are assigned to — it defines which skills, repositories, and LLM endpoint they use.
          You can fully configure it later in <strong>Workspaces → Working Environments</strong>.
        </p>
      </div>

      <ErrorBanner msg={error} />

      {!saved ? (
        <>
          <FormInput label="Name" required value={name} onChange={setName} placeholder="e.g. Default Environment" />
          <FormInput label="Description" value={desc} onChange={setDesc} placeholder="Optional short description" />

          <button onClick={handleSave} disabled={saving || !canSave}
            style={{ ...btnPrimary, opacity: (saving || !canSave) ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer', alignSelf: 'flex-start' }}>
            {saving ? 'Saving…' : 'Create environment'}
          </button>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-status-success)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)' }}>
          <Check size={15} /> Environment created — add skills and repositories any time via Working Environments.
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={onNext} disabled={!saved}
          style={{ ...btnPrimary, opacity: saved ? 1 : 0.5, cursor: saved ? 'pointer' : 'not-allowed' }}>
          Continue <ArrowRight size={15} />
        </button>
        <button onClick={onSkip} style={btnSecondary}>
          <SkipForward size={14} /> Skip for now
        </button>
      </div>
    </div>
  );
}

/* ─── Step 5: First Agent ──────────────────────────────────────── */

function StepAgent({ onFinish, onSkip }) {
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState(null);
  const [saved, setSaved]     = useState(false);

  const canSave = displayName.trim();

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const id = displayName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      await apiCall('POST', '/api/agents', {
        id, displayName: displayName.trim(), role: 'expert', enabled: false,
      });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div>
        <h2 style={{ margin: '0 0 var(--eb-space-1)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)' }}>
          First Agent
        </h2>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
          Create your first agent. It will be created as <strong>disabled</strong> — you can configure its prompt, assign a Working Environment, and enable it via <strong>Agents</strong>.
        </p>
      </div>

      <ErrorBanner msg={error} />

      {!saved ? (
        <>
          <FormInput label="Agent name" required value={displayName} onChange={setDisplayName} placeholder="e.g. My First Agent" />

          <button onClick={handleSave} disabled={saving || !canSave}
            style={{ ...btnPrimary, opacity: (saving || !canSave) ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer', alignSelf: 'flex-start' }}>
            {saving ? 'Creating…' : 'Create agent'}
          </button>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-status-success)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)' }}>
          <Check size={15} /> Agent created (disabled) — configure it in Agents when ready.
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={onFinish} style={btnPrimary}>
          <Check size={15} /> Go to Dashboard
        </button>
        {!saved && (
          <button onClick={onSkip} style={btnSecondary}>
            <SkipForward size={14} /> Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main Wizard ──────────────────────────────────────────────── */

export default function SetupWizard({ onComplete }) {
  const [current, setCurrent] = useState(0);
  const [done, setDone]       = useState([]);

  function markDone(id) {
    setDone(prev => prev.includes(id) ? prev : [...prev, id]);
  }

  function advance(id) {
    markDone(id);
    if (current < STEPS.length - 1) setCurrent(current + 1);
    else onComplete();
  }

  function skip() {
    if (current < STEPS.length - 1) setCurrent(current + 1);
    else onComplete();
  }

  const stepId = STEPS[current].id;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'var(--eb-bg-app)',
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto',
    }}>
      {/* Header */}
      <div style={{
        padding: 'var(--eb-space-4) var(--eb-space-8)',
        borderBottom: '1px solid var(--eb-border-default)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
          Agentic Studio Setup
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Step {current + 1} of {STEPS.length}
        </div>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        display: 'flex', flexDirection: 'column',
        maxWidth: 720, width: '100%',
        margin: '0 auto',
        padding: 'var(--eb-space-8) var(--eb-space-6)',
      }}>
        <Stepper current={current} done={done} />

        <div style={{
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)',
          padding: 'var(--eb-space-6)',
        }}>
          {stepId === 'llm'         && <StepLlm         onNext={() => advance('llm')}         onSkip={skip} />}
          {stepId === 'ssh-key'     && <StepSshKey       onNext={() => advance('ssh-key')}     onSkip={skip} />}
          {stepId === 'gh-token'    && <StepGhToken      onNext={() => advance('gh-token')}    onSkip={skip} />}
          {stepId === 'environment' && <StepEnvironment  onNext={() => advance('environment')} onSkip={skip} />}
          {stepId === 'agent'       && <StepAgent        onFinish={() => { markDone('agent'); onComplete(); }} onSkip={onComplete} />}
        </div>
      </div>
    </div>
  );
}
