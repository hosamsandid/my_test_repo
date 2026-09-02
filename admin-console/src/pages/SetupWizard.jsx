import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  Check, PlugZap, RefreshCw, Plus, X, ArrowRight, SkipForward,
  Copy, KeyRound, ClipboardPaste, ExternalLink, LogIn, ShieldAlert,
} from 'lucide-react';
import { apiCall } from '../hooks/useApi';
import FormInput from '../components/FormInput';
import OAuthLoginWizard from '../components/OAuthLoginWizard';
import { buildLlmProviderPayload, canSaveLlmProvider } from './setup-wizard-payload';

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

/* ─── Shared credential rationale (E10 #1884) ──────────────────────
   The SSH-key and GitHub-token steps used to restate the "why two
   credentials" rationale in their own words, on top of the three copies the
   credential *pages* carried. The long form now lives once in the Credentials
   help topic (api/helper-chat/help-topics/credentials.md); the wizard reads a
   single shared summary from here, so there is exactly one wording left in the
   product. Panel-based help for the wizard's own steps is #1892. */

function TwoCredentialsNote() {
  return (
    <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
      <strong>Two credentials by design.</strong> The SSH key handles repository transport — clone and
      fetch — and can be narrowed to a per-repo read-only deploy key; the GitHub token handles API
      actions and writes (push, PR creation, event polling). Keeping them apart means a leak of either
      costs you only half. Both steps are optional and can be filled in later on the{' '}
      <strong>SSH Keys</strong> and <strong>GitHub Tokens</strong> pages, whose Help panel explains the
      split in full.
    </div>
  );
}

/* ─── Progress Stepper ─────────────────────────────────────────── */

const STEPS = [
  { id: 'llm',      label: 'Model Provider', required: true },
  { id: 'ssh-key',  label: 'SSH Key',        required: false },
  { id: 'gh-token', label: 'GitHub Token',   required: false },
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

/* ─── Step 1: Model Provider ────────────────────────────────────── */

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

function StepLlm({ onNext }) {
  const [name, setName]         = useState('Default');
  // Auth type: classic api-key/proxy vs Claude subscription OAuth token.
  const [authType, setAuthType] = useState('api-key');
  const isOauth = authType === 'oauth-token';
  const [baseUrl, setBaseUrl]   = useState('');
  const [authToken, setAuthToken] = useState('');
  const [models, setModels]     = useState([]);
  const [saving, setSaving]     = useState(false);
  const [probing, setProbing]   = useState(null);
  const [probeMsg, setProbeMsg] = useState(null);
  const [error, setError]       = useState(null);
  const [savedId, setSavedId]   = useState(null);
  // OAuth (subscription) auth — the single-user compliance ack plus a token
  // source: a completed login flow (claimed server-side on save) or a manually
  // pasted setup-token value.
  const [complianceOk, setComplianceOk] = useState(false);
  const [oauthFlowId, setOauthFlowId]   = useState(null);
  const [wizardOpen, setWizardOpen]     = useState(false);

  const canSave = canSaveLlmProvider({ name, authType, baseUrl, authToken, complianceAck: complianceOk, oauthFlowId });

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const payload = buildLlmProviderPayload({
        name, authType, baseUrl, authToken, models,
        complianceAck: complianceOk, oauthFlowId,
      });
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
      // persist discovered models (keep the saved auth type + baseUrl intact)
      await apiCall('PUT', `/api/llm-endpoints/${savedId}`, {
        name, authType, baseUrl: isOauth ? '' : baseUrl,
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
          Model Provider
        </h2>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
          Tell Agent Studio where to send model traffic — an API key against the Anthropic API, a LiteLLM proxy or an
          internal gateway, or an Anthropic subscription (Max / Enterprise seat) via <code style={{ fontFamily: 'var(--eb-font-mono)' }}>claude setup-token</code>.
          This is the only required step; everything else can be configured later.
        </p>
      </div>

      <ErrorBanner msg={error} />

      <FormInput label="Name" required value={name} onChange={setName} placeholder="e.g. LiteLLM Prod" />

      {/* Auth type — classic API key / proxy vs Claude subscription OAuth */}
      <div>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
          Authentication
        </div>
        <div style={{ display: 'flex', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
          {[
            { value: 'api-key', label: 'API key / proxy', hint: 'Bearer token against a Base URL (Anthropic API, LiteLLM, gateway)' },
            { value: 'oauth-token', label: 'Anthropic subscription (OAuth)', hint: 'Claude Max / Enterprise seat via claude setup-token' },
          ].map(opt => (
            <label key={opt.value} title={opt.hint} style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: authType === opt.value ? 'var(--eb-bg-elevated)' : 'transparent',
              border: `1px solid ${authType === opt.value ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
              borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)', cursor: savedId ? 'default' : 'pointer',
            }}>
              <input
                type="radio"
                name="setup-llm-auth-type"
                value={opt.value}
                checked={authType === opt.value}
                disabled={!!savedId}
                onChange={() => { setAuthType(opt.value); setProbeMsg(null); }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      {!isOauth && (
        <div>
          <FormInput label="Base URL" required type="url" value={baseUrl} onChange={setBaseUrl} placeholder="https://api.anthropic.com" />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Must speak the Anthropic Messages API — e.g. the Anthropic API, a LiteLLM proxy, or an internal gateway that exposes it.
          </div>
        </div>
      )}

      {isOauth && !savedId && (
        <>
          <div style={{
            padding: 'var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)',
            color: 'var(--eb-text-secondary)',
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
          }}>
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start' }}>
              <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-status-warning)' }} />
              <span>
                <strong>Single-user operation only.</strong> Anthropic's Consumer Terms permit OAuth tokens from
                Free/Pro/Max subscriptions solely for the subscription owner's own use — they must not serve
                other users or third parties. For team setups use per-seat Enterprise tokens (one provider per seat)
                or an API key. Agents bound to this provider talk directly to <code style={{ fontFamily: 'var(--eb-font-mono)' }}>api.anthropic.com</code> and
                share the subscription's rate limits with your interactive Claude sessions.
              </span>
            </div>
            <label style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={complianceOk}
                onChange={e => setComplianceOk(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                I confirm that every agent using this provider runs exclusively for me, the owner of this
                Claude subscription (single-user operation). <span style={{ color: 'var(--eb-status-error)' }}>*</span>
              </span>
            </label>
          </div>

          <div>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
              Subscription login
            </div>
            {oauthFlowId ? (
              <div style={{
                fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)',
                display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)',
              }}>
                <Check size={14} /> Login completed — the token is stored when you save.
                <button type="button" onClick={() => { setOauthFlowId(null); setWizardOpen(false); }} style={btnGhost}>
                  Discard
                </button>
              </div>
            ) : wizardOpen ? (
              <OAuthLoginWizard
                onToken={(flowId) => { setOauthFlowId(flowId); setWizardOpen(false); }}
                onClose={() => setWizardOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                style={{ ...btnPrimary, alignSelf: 'flex-start' }}
              >
                <LogIn size={14} /> Sign in with Anthropic…
              </button>
            )}
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-2)' }}>
              Runs <code style={{ fontFamily: 'var(--eb-font-mono)' }}>claude setup-token</code> on the orchestrator and issues a long-lived (~1 year) token.
              Alternatively, run it on any machine yourself and paste the resulting <code style={{ fontFamily: 'var(--eb-font-mono)' }}>sk-ant-oat…</code> token below.
            </div>
          </div>
        </>
      )}

      {!savedId && (
        <div>
          <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
            {isOauth
              ? <>Setup token <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)' }}>(manual alternative to the login above)</span></>
              : <>Auth token <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)' }}>(optional)</span></>}
          </div>
          <textarea
            value={authToken} onChange={e => setAuthToken(e.target.value)} rows={2}
            placeholder={isOauth ? 'sk-ant-oat… (output of `claude setup-token`)' : 'sk-… (sent as Bearer token)'}
            style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', resize: 'vertical' }}
          />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Stored in <code style={{ fontFamily: 'var(--eb-font-mono)' }}>/workspace/llm-endpoints/_keys/</code> (chmod 600). Never returned by the API.
          </div>
        </div>
      )}

      {!savedId ? (
        <button onClick={handleSave} disabled={saving || !canSave}
          style={{ ...btnPrimary, cursor: saving ? 'wait' : 'pointer', opacity: (saving || !canSave) ? 0.6 : 1, alignSelf: 'flex-start' }}>
          {saving ? 'Saving…' : 'Save provider'}
        </button>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
          padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-status-success)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            <Check size={15} /> Provider saved
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

function PublicKeyReveal({ publicKey }) {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copyResetTimerRef.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable (insecure context); fall back is the
      // textarea selection — the user can still ctrl+c manually.
    }
  }
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-status-success)',
      borderRadius: 'var(--eb-radius-md)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
        <Check size={15} /> Keypair generated — copy the public key to GitHub
      </div>
      <textarea
        readOnly value={publicKey} rows={3}
        onFocus={e => e.target.select()}
        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
      />
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" onClick={copy} style={btnGhost}>
          <Copy size={13} /> {copied ? 'Copied' : 'Copy public key'}
        </button>
        <a
          href="https://github.com/settings/ssh/new"
          target="_blank" rel="noreferrer"
          style={{ ...btnGhost, textDecoration: 'none' }}
        >
          <ExternalLink size={13} /> Open GitHub SSH settings
        </a>
      </div>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.6 }}>
        The matching private key is stored in the workspace (mode 600) and is never returned by the API.
        For GitHub Enterprise, paste the key into <strong>your-host/settings/ssh/new</strong> instead.
        <div style={{ marginTop: 4 }}>
          <strong>SAML SSO orgs:</strong> click <strong>Configure SSO</strong> next to the new key in the GitHub SSH key list and
          authorise it for the relevant orgs — SSO-protected repos otherwise reject the SSH connection.
        </div>
      </div>
    </div>
  );
}

function ModeTabs({ mode, onChange }) {
  const tab = (id, label, Icon) => {
    const active = mode === id;
    return (
      <button
        type="button"
        onClick={() => onChange(id)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: active ? 'var(--eb-bg-elevated)' : 'transparent',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
          fontSize: 'var(--eb-text-sm)', fontWeight: active ? 'var(--eb-font-medium)' : 'normal',
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <Icon size={13} /> {label}
      </button>
    );
  };
  return (
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
      {tab('generate', 'Generate new keypair', KeyRound)}
      {tab('paste', 'Paste existing key', ClipboardPaste)}
    </div>
  );
}

function StepSshKey({ onNext, onSkip }) {
  const [mode, setMode]           = useState('generate');
  const [name, setName]           = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState(null);
  const [saved, setSaved]         = useState(false);
  const [publicKey, setPublicKey] = useState(null);

  const canGenerate = mode === 'generate' && name.trim();
  const canPaste    = mode === 'paste' && name.trim() && privateKey.trim();

  async function handleGenerate() {
    setSaving(true); setError(null);
    try {
      const r = await apiCall('POST', '/api/ssh-keys/generate', { name: name.trim() });
      setPublicKey(r.publicKey);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handlePaste() {
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

      <TwoCredentialsNote />

      <ErrorBanner msg={error} />

      {!saved && <ModeTabs mode={mode} onChange={setMode} />}

      {!saved && mode === 'generate' && (
        <>
          <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
            We'll create a fresh ed25519 keypair on the server. The private key stays in the workspace; you'll get the public
            key once to paste into <strong>GitHub → Settings → SSH and GPG keys → New SSH key</strong> (or your enterprise instance).
            <div style={{ marginTop: 4 }}>
              <strong>SAML SSO orgs:</strong> after adding the public key on GitHub, click <strong>Configure SSO</strong> next to it
              and authorise it for the orgs the agents need to clone from.
            </div>
          </div>

          <FormInput label="Name" required value={name} onChange={setName} placeholder="e.g. GitHub Deploy Key" />

          <button onClick={handleGenerate} disabled={saving || !canGenerate}
            style={{ ...btnPrimary, opacity: (saving || !canGenerate) ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer', alignSelf: 'flex-start' }}>
            <KeyRound size={14} /> {saving ? 'Generating…' : 'Generate keypair'}
          </button>
        </>
      )}

      {!saved && mode === 'paste' && (
        <>
          <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
            Generate a key pair with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ssh-keygen -t ed25519 -C "agent-studio-deploy-key"</code> (no passphrase),
            add the <strong>.pub</strong> file to your GitHub instance, then paste the private key below.
            <div style={{ marginTop: 4 }}>
              <strong>SAML SSO orgs:</strong> after uploading the public key, click <strong>Configure SSO</strong> next to it in
              GitHub's SSH key list and authorise it for every org you want to clone from.
            </div>
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

          <button onClick={handlePaste} disabled={saving || !canPaste}
            style={{ ...btnPrimary, opacity: (saving || !canPaste) ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer', alignSelf: 'flex-start' }}>
            {saving ? 'Saving…' : 'Save key'}
          </button>
        </>
      )}

      {saved && publicKey && <PublicKeyReveal publicKey={publicKey} />}
      {saved && !publicKey && (
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

function StepGhToken({ onNext, onSkip, isLast }) {
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

      <TwoCredentialsNote />

      <ErrorBanner msg={error} />

      {!saved ? (
        <>
          <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
            GitHub → <strong>Settings</strong> → <strong>Developer settings</strong> → <strong>Personal access tokens</strong>.
            <div style={{ marginTop: 4 }}>
              Pick <strong>Tokens (classic)</strong> — that's the path we test against — and tick these scopes:{' '}
              <code>repo</code>, <code>workflow</code>, and <code>read:org</code> (under <code>admin:org</code>).
            </div>
            <div style={{ marginTop: 4, color: 'var(--eb-text-muted)' }}>
              Fine-grained tokens also work — grant <strong>Contents</strong> (read &amp; write), <strong>Metadata</strong> (read),
              <strong> Pull requests</strong> (read &amp; write), <strong>Workflows</strong> (read &amp; write), and <strong>Members</strong> (read).
            </div>
            <div style={{ marginTop: 4 }}>
              <strong>SAML SSO orgs:</strong> after creating the token, click <strong>Configure SSO</strong> next to it in the
              GitHub list and authorise it for every org you want the agents to reach. Without that, SSO-protected repos reject the token.
            </div>
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
          {isLast ? <><Check size={15} /> Finish setup</> : <>Continue <ArrowRight size={15} /></>}
        </button>
        <button onClick={onSkip} style={btnSecondary}>
          <SkipForward size={14} /> {isLast ? 'Skip & finish' : 'Skip for now'}
        </button>
      </div>
    </div>
  );
}

/* ─── Main Wizard ──────────────────────────────────────────────── */

export default function SetupWizard({ onComplete }) {
  const navigate = useNavigate();
  const [current, setCurrent] = useState(0);
  const [done, setDone]       = useState([]);

  // Leaving the wizard: dismiss it and route to Team Setup, the natural next
  // step once the infrastructure credentials exist (the wizard no longer
  // creates a standalone agent).
  function finishWizard() {
    onComplete();
    navigate('/team-setup');
  }

  function markDone(id) {
    setDone(prev => prev.includes(id) ? prev : [...prev, id]);
  }

  function advance(id) {
    markDone(id);
    if (current < STEPS.length - 1) setCurrent(current + 1);
    else finishWizard();
  }

  function skip() {
    if (current < STEPS.length - 1) setCurrent(current + 1);
    else finishWizard();
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
          Agent Studio Setup
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
          {stepId === 'llm'      && <StepLlm     onNext={() => advance('llm')} />}
          {stepId === 'ssh-key'  && <StepSshKey  onNext={() => advance('ssh-key')}  onSkip={skip} />}
          {stepId === 'gh-token' && <StepGhToken onNext={() => advance('gh-token')} onSkip={skip} isLast />}
        </div>
      </div>
    </div>
  );
}
