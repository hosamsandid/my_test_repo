import React, { useState, useEffect, useRef } from 'react';
import { Trash2, Plus, Pencil, Check, X, RefreshCw, PlugZap, Star, Lock, LogIn, Copy, ShieldAlert, ExternalLink } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import useAutoDerivedId from '../hooks/useAutoDerivedId';

/* ───────────────────────── shared styles ───────────────────────── */

const buttonPrimary = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)',
  color: 'var(--eb-text-inverted)',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const buttonSecondary = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
};

const buttonGhost = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  background: 'transparent',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-xs)',
  fontFamily: 'inherit',
};

/* ─────────────────── Sub: per-endpoint model editor ─────────────────── */

function ModelEditor({ models, defaultModelId, onChange, onDefaultChange }) {
  const update = (i, patch) => {
    const next = models.map((m, idx) => idx === i ? { ...m, ...patch } : m);
    onChange(next);
  };
  const remove = (i) => {
    const removedId = models[i]?.id;
    onChange(models.filter((_, idx) => idx !== i));
    if (removedId && removedId === defaultModelId) onDefaultChange('');
  };
  const add = () => onChange([...models, { id: '', displayName: '', kind: '' }]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr 1fr 110px 32px',
        gap: 'var(--eb-space-2)',
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}>
        <div title="Default">Def</div>
        <div>Model ID</div>
        <div>Display name</div>
        <div>Kind</div>
        <div></div>
      </div>

      {models.length === 0 && (
        <div style={{
          padding: 'var(--eb-space-3)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-muted)',
          background: 'var(--eb-bg-elevated)',
          borderRadius: 'var(--eb-radius-md)',
          textAlign: 'center',
        }}>
          No models yet. Add one or import from the proxy.
        </div>
      )}

      {models.map((m, i) => {
        const isDefault = !!m.id && m.id === defaultModelId;
        return (
        <div key={i} style={{
          display: 'grid',
          gridTemplateColumns: '32px 1fr 1fr 110px 32px',
          gap: 'var(--eb-space-2)',
          alignItems: 'center',
        }}>
          <button
            type="button"
            onClick={() => onDefaultChange(isDefault ? '' : (m.id || ''))}
            disabled={!m.id || !m.id.trim()}
            aria-label={isDefault ? 'Clear default' : 'Make default'}
            title={
              !m.id || !m.id.trim()
                ? 'Set a model ID before marking it as the default'
                : isDefault ? 'Clear default (click to unset)' : 'Make this the default model'
            }
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32,
              background: isDefault ? 'var(--eb-accent-primary)' : 'transparent',
              border: `1px solid ${isDefault ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
              color: isDefault ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
              borderRadius: 'var(--eb-radius-md)',
              cursor: (!m.id || !m.id.trim()) ? 'not-allowed' : 'pointer',
              opacity: (!m.id || !m.id.trim()) ? 0.4 : 1,
            }}
          >
            <Star size={14} fill={isDefault ? 'currentColor' : 'none'} />
          </button>
          <input
            value={m.id || ''}
            onChange={e => update(i, { id: e.target.value })}
            placeholder="claude-sonnet-4-6"
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)',
              outline: 'none',
            }}
          />
          <input
            value={m.displayName || ''}
            onChange={e => update(i, { displayName: e.target.value })}
            placeholder="Sonnet 4.6"
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)',
              outline: 'none',
            }}
          />
          <select
            value={m.kind || ''}
            onChange={e => update(i, { kind: e.target.value || undefined })}
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          >
            <option value="">—</option>
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
          </select>
          <button
            onClick={() => remove(i)}
            aria-label="Remove model"
            title="Remove"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32,
              background: 'transparent',
              border: '1px solid var(--eb-status-error)',
              color: 'var(--eb-status-error)',
              borderRadius: 'var(--eb-radius-md)',
              cursor: 'pointer',
            }}
          >
            <X size={14} />
          </button>
        </div>
      );})}

      <button
        type="button"
        onClick={add}
        style={{ ...buttonGhost, alignSelf: 'flex-start' }}
      >
        <Plus size={13} /> Add model
      </button>
    </div>
  );
}

/* ────────────── Sub: subscription OAuth login wizard ────────────── */
//
// Walks the operator through `claude setup-token`, executed by the
// orchestrator: start → open the authorize URL in the browser → paste the
// confirmation code → the orchestrator captures the long-lived token. The
// token itself never reaches the browser — on success we only hand the
// flowId back to the form, and the server claims the token while saving.
function OAuthLoginWizard({ onToken, onClose }) {
  const [flow, setFlow] = useState(null);   // { flowId, status, authUrl, error }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const doneNotified = useRef(false);

  function absorb(view) {
    setFlow(view);
    // Mirror the server's error verbatim (and clear it once the server does —
    // e.g. after a successful code re-submission).
    setErr(view?.error || null);
    if (view?.status === 'done' && !doneNotified.current) {
      doneNotified.current = true;
      onToken(view.flowId);
    }
  }

  // Kick off the flow on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const r = await apiCall('POST', '/api/llm-auth/flows');
        if (!cancelled) absorb(r);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while the orchestrator is working (waiting for the URL, or
  // exchanging the pasted code for the token).
  useEffect(() => {
    if (!flow?.flowId) return;
    const polling = flow.status === 'starting' || flow.status === 'exchanging';
    if (!polling) return;
    const t = setInterval(async () => {
      try {
        const r = await apiCall('GET', `/api/llm-auth/flows/${flow.flowId}`);
        absorb(r);
      } catch (e) {
        setErr(e.message);
      }
    }, 1500);
    return () => clearInterval(t);
  }, [flow?.flowId, flow?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function sendCode() {
    if (!code.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await apiCall('POST', `/api/llm-auth/flows/${flow.flowId}/code`, { code: code.trim() });
      absorb(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (flow?.flowId && flow.status !== 'done') {
      try { await apiCall('DELETE', `/api/llm-auth/flows/${flow.flowId}`); } catch { /* best effort */ }
    }
    onClose();
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(flow.authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — the link is still clickable */ }
  }

  const status = flow?.status;
  // An error while the flow still awaits a code (e.g. "OAuth error: Invalid
  // code") is recoverable — keep the paste form visible instead of failing.
  const failed = ['error', 'expired', 'cancelled'].includes(status)
    || (!!err && !['done', 'awaiting-code'].includes(status));

  return (
    <div style={{
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-accent-primary)',
      borderRadius: 'var(--eb-radius-md)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      fontSize: 'var(--eb-text-sm)',
    }}>
      {(!flow || status === 'starting') && !failed && (
        <div>Starting the login flow (<code style={{ fontFamily: 'var(--eb-font-mono)' }}>claude setup-token</code>)…</div>
      )}

      {status === 'awaiting-code' && flow.authUrl && (
        <>
          {err && (
            <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
              {err}
            </div>
          )}
          <div style={{ fontWeight: 'var(--eb-font-medium)' }}>1. Open this link, sign in with your Claude subscription and approve:</div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
            <a
              href={flow.authUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
                wordBreak: 'break-all', color: 'var(--eb-accent-primary)',
                display: 'inline-flex', alignItems: 'flex-start', gap: 4,
              }}
            >
              <ExternalLink size={12} style={{ flexShrink: 0, marginTop: 2 }} />
              {flow.authUrl}
            </a>
            <button type="button" onClick={copyUrl} style={{ ...buttonGhost, flexShrink: 0 }}>
              <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ fontWeight: 'var(--eb-font-medium)' }}>2. Paste the confirmation code shown after approval (copy it completely, including any <code style={{ fontFamily: 'var(--eb-font-mono)' }}>#…</code> suffix):</div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <input
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder="Paste code…"
              style={{
                flex: 1,
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'var(--eb-bg-surface)',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                color: 'var(--eb-text-primary)',
                fontFamily: 'var(--eb-font-mono)',
                fontSize: 'var(--eb-text-xs)',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={sendCode}
              disabled={busy || !code.trim()}
              style={{ ...buttonPrimary, opacity: busy || !code.trim() ? 0.6 : 1 }}
            >
              {busy ? 'Submitting…' : 'Submit code'}
            </button>
          </div>
        </>
      )}

      {status === 'exchanging' && (
        <div>Exchanging the code for a token…</div>
      )}

      {status === 'done' && (
        <div style={{ color: 'var(--eb-status-success)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Check size={14} /> Login successful — the token will be stored when you save this provider.
        </div>
      )}

      {failed && (
        <div role="alert" style={{ color: 'var(--eb-status-error)' }}>
          {err || flow?.error || 'The login flow failed.'} You can retry, or paste a token generated with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>claude setup-token</code> manually.
        </div>
      )}

      {status !== 'done' && (
        <button type="button" onClick={cancel} style={{ ...buttonSecondary, alignSelf: 'flex-start' }}>
          Cancel login
        </button>
      )}
    </div>
  );
}

/* ─────────────────── Sub: endpoint form (create + edit) ─────────────────── */

function EndpointForm({ endpoint, onSave, onCancel, saving, error }) {
  const isEdit = Boolean(endpoint?.id);
  const [name, setName] = useState(endpoint?.name ?? '');
  const [id, setId] = useState(endpoint?.id ?? '');
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? '');
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName,
    setId,
    getName: () => name,
    initiallyAuto: !isEdit,
  });
  const [authToken, setAuthToken] = useState('');         // empty = leave as-is on edit
  const [clearToken, setClearToken] = useState(false);
  const [models, setModels] = useState(endpoint?.models ?? []);
  const [defaultModelId, setDefaultModelId] = useState(endpoint?.defaultModelId ?? '');

  // Auth type: classic api-key/proxy vs Claude subscription OAuth token.
  const wasOauth = endpoint?.authType === 'oauth-token';
  const [authType, setAuthType] = useState(endpoint?.authType ?? 'api-key');
  const isOauth = authType === 'oauth-token';
  // Compliance confirmation is demanded whenever subscription auth is being
  // (re-)established for this provider — i.e. on create, or when switching an
  // api-key provider over. Existing oauth providers carry their recorded ack.
  const requireCompliance = isOauth && (!isEdit || !wasOauth);
  const [complianceOk, setComplianceOk] = useState(false);
  // Completed login flow — the server claims the actual token on save.
  const [oauthFlowId, setOauthFlowId] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  // If the user removes the default model from the list (without using the
  // star toggle), drop the dangling pointer so we don't ship a server-rejected
  // value on save.
  useEffect(() => {
    if (defaultModelId && !models.some(m => m.id === defaultModelId)) {
      setDefaultModelId('');
    }
  }, [models, defaultModelId]);

  // test / discover state
  const [probing, setProbing] = useState(null);            // 'test' | 'discover' | null
  const [probeMsg, setProbeMsg] = useState(null);          // { ok, text }
  const [discovered, setDiscovered] = useState(null);      // suggestion list pending merge

  // A subscription provider must end up with a token: an already-stored one
  // (edit), a completed login flow, or a manually pasted setup-token value.
  const oauthTokenReady = (isEdit && wasOauth && endpoint.hasToken && !clearToken)
    || !!oauthFlowId
    || !!authToken.trim();
  const canSubmit = name.trim() && (isOauth
    ? ((!requireCompliance || complianceOk) && oauthTokenReady)
    : !!baseUrl.trim());
  // Probing an oauth provider needs a token the server can reach: the stored
  // one, or a pasted value. A wizard-obtained token is only claimable on save,
  // so it can't be probed pre-save.
  const canProbe = isOauth
    ? ((isEdit && wasOauth && endpoint.hasToken && !authToken.trim()) || !!authToken.trim())
    : !!baseUrl.trim();

  // Pick the probe target: when the user is editing an existing endpoint and
  // hasn't typed a new token, hit the stored-id route so the server's persisted
  // token is used (we never round-trip the raw token through the UI). In every
  // other case — create mode, or edit with an unsaved token change — call the
  // stateless probe route with the form's auth type, baseUrl + typed token.
  function probeRequest(kind) {
    const sameAuthType = authType === (endpoint?.authType ?? 'api-key');
    const useStored = isEdit && !authToken.trim() && !clearToken && sameAuthType;
    if (useStored) {
      const suffix = kind === 'test' ? 'test' : 'discover-models';
      return { path: `/api/llm-endpoints/${endpoint.id}/${suffix}`, body: undefined };
    }
    const suffix = kind === 'test' ? 'probe-test' : 'probe-discover-models';
    return {
      path: `/api/llm-endpoints/${suffix}`,
      body: {
        authType,
        baseUrl: isOauth ? '' : baseUrl.trim(),
        authToken: clearToken ? '' : authToken.trim(),
      },
    };
  }

  async function runTest() {
    if (!canProbe) {
      setProbeMsg({ ok: false, text: isOauth ? 'No token available to test — paste one, or save and test afterwards.' : 'Enter a Base URL first.' });
      return;
    }
    setProbing('test'); setProbeMsg(null);
    try {
      const { path, body } = probeRequest('test');
      const r = await apiCall('POST', path, body);
      setProbeMsg({
        ok: r.ok,
        text: r.ok
          ? `OK (HTTP ${r.status}) — ${r.url}`
          : `Failed: ${r.error || 'HTTP ' + r.status} — ${r.url}`,
      });
    } catch (e) {
      setProbeMsg({ ok: false, text: e.message });
    } finally {
      setProbing(null);
    }
  }

  async function runDiscover() {
    if (!canProbe) {
      setProbeMsg({ ok: false, text: isOauth ? 'No token available — paste one, or save and discover afterwards.' : 'Enter a Base URL first.' });
      return;
    }
    setProbing('discover'); setProbeMsg(null);
    try {
      const { path, body } = probeRequest('discover');
      const r = await apiCall('POST', path, body);
      setDiscovered(r.models || []);
      setProbeMsg({ ok: true, text: `Found ${r.count ?? r.models?.length ?? 0} model(s) at ${r.url}` });
    } catch (e) {
      setProbeMsg({ ok: false, text: e.message });
    } finally {
      setProbing(null);
    }
  }

  function applyDiscovered(mode) {
    if (!discovered) return;
    if (mode === 'replace') {
      setModels(discovered);
    } else {
      // merge: keep existing rows by id, add unknown ones from suggestion
      const existingIds = new Set(models.map(m => m.id));
      const additions = discovered.filter(m => !existingIds.has(m.id));
      setModels([...models, ...additions]);
    }
    setDiscovered(null);
  }

  function submit() {
    const cleanedModels = models
      .filter(m => m.id && m.id.trim())
      .map(m => ({
        id: m.id.trim(),
        displayName: (m.displayName || m.id).trim(),
        ...(m.kind ? { kind: m.kind } : {}),
      }));
    const payload = {
      name: name.trim(),
      authType,
      baseUrl: isOauth ? '' : baseUrl.trim(),
      models: cleanedModels,
      // Always send defaultModelId — '' clears it on the server, a real id
      // sets/updates it. Skipping the field would leave the server's cached
      // value alone, which is wrong when the user just unstarred a model.
      defaultModelId: defaultModelId && cleanedModels.some(m => m.id === defaultModelId)
        ? defaultModelId
        : '',
    };
    if (!isEdit && id.trim()) payload.id = id.trim();
    if (isOauth && complianceOk) payload.complianceAck = true;
    // Token sources, in precedence order: manual paste > completed login flow
    // (claimed server-side) > keep/clear existing.
    if (authToken.trim())      payload.authToken = authToken.trim();
    else if (isOauth && oauthFlowId) payload.oauthFlowId = oauthFlowId;
    else if (clearToken)       payload.authToken = '';
    // else: undefined → server keeps existing token (only relevant on edit)
    onSave(payload);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <FormInput
        label="Name"
        required
        value={name}
        onChange={isEdit ? setName : handleNameChange}
        placeholder="e.g. LiteLLM Prod"
      />

      <IdField
        value={id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        disabled={isEdit}
        placeholder="e.g. litellm-prod"
        helpText={isEdit
          ? <>Cannot be changed after creation.</>
          : <>Auto-derived from Name; edit to override. Lowercase letters, digits and hyphens only. <strong>Cannot be changed after creation.</strong></>}
      />

      {/* Auth type — classic API key / proxy vs Claude subscription OAuth */}
      <div>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
          marginBottom: 'var(--eb-space-1)',
        }}>
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
              fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
            }}>
              <input
                type="radio"
                name="llm-auth-type"
                value={opt.value}
                checked={authType === opt.value}
                onChange={() => { setAuthType(opt.value); setProbeMsg(null); }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      {!isOauth && (
        <div>
          <FormInput
            label="Base URL"
            required
            type="url"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://litellm.example/v1"
          />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Must speak the Anthropic Messages API — e.g. the Anthropic API directly, a LiteLLM proxy, or an internal gateway that exposes it.
          </div>
        </div>
      )}

      {isOauth && (
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
            {requireCompliance ? (
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
            ) : (
              endpoint?.complianceAck?.confirmedAt && (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                  Single-user operation confirmed by <strong>{endpoint.complianceAck.confirmedBy}</strong> on {new Date(endpoint.complianceAck.confirmedAt).toLocaleString()}.
                </div>
              )
            )}
          </div>

          <div>
            <div style={{
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              color: 'var(--eb-text-secondary)',
              marginBottom: 'var(--eb-space-1)',
            }}>
              Subscription login
            </div>
            {isEdit && wasOauth && endpoint.hasToken && !oauthFlowId && (
              <div style={{
                fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
                marginBottom: 'var(--eb-space-2)', fontFamily: 'var(--eb-font-mono)',
              }}>
                Current token: {endpoint.tokenPreview} · {endpoint.tokenFingerprint}
              </div>
            )}
            {oauthFlowId ? (
              <div style={{
                fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)',
                display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                marginBottom: 'var(--eb-space-2)',
              }}>
                <Check size={14} /> Login completed — the token is stored when you save.
                <button
                  type="button"
                  onClick={() => { setOauthFlowId(null); setWizardOpen(false); }}
                  style={buttonGhost}
                >
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
                style={{ ...buttonPrimary, display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}
              >
                <LogIn size={14} /> {isEdit && wasOauth && endpoint.hasToken ? 'Re-authenticate…' : 'Sign in with Anthropic…'}
              </button>
            )}
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-2)' }}>
              Runs <code style={{ fontFamily: 'var(--eb-font-mono)' }}>claude setup-token</code> on the orchestrator and issues a long-lived (~1 year) token.
              Alternatively, run it on any machine yourself and paste the resulting <code style={{ fontFamily: 'var(--eb-font-mono)' }}>sk-ant-oat…</code> token below.
            </div>
          </div>
        </>
      )}

      {/* Token field — different copy for create vs edit */}
      <div>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
          marginBottom: 'var(--eb-space-1)',
        }}>
          {isOauth
            ? <>Setup token <span style={{ color: 'var(--eb-text-muted)', fontWeight: 'normal' }}>(manual alternative to the login above)</span></>
            : <>Auth token {!isEdit && <span style={{ color: 'var(--eb-text-muted)', fontWeight: 'normal' }}>(optional)</span>}</>}
        </div>
        {!isOauth && isEdit && endpoint.hasToken && (
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            marginBottom: 'var(--eb-space-2)',
            fontFamily: 'var(--eb-font-mono)',
          }}>
            Current: {endpoint.tokenPreview} · {endpoint.tokenFingerprint}
          </div>
        )}
        {!isOauth && isEdit && !endpoint.hasToken && (
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-status-warning)',
            marginBottom: 'var(--eb-space-2)',
          }}>
            No token stored — Test/Discover will hit the proxy unauthenticated. Paste the token below and save.
          </div>
        )}
        <textarea
          value={authToken}
          disabled={clearToken}
          onChange={e => setAuthToken(e.target.value)}
          rows={2}
          placeholder={
            isOauth
              ? 'sk-ant-oat… (output of `claude setup-token`)'
              : isEdit
                ? endpoint.hasToken
                  ? 'Leave empty to keep current token'
                  : 'Paste auth token (sent as Bearer to the proxy)'
                : 'sk-… (sent as Bearer token to the proxy)'
          }
          style={{
            width: '100%',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: 'var(--eb-text-xs)',
            resize: 'vertical',
            outline: 'none',
            opacity: clearToken ? 0.5 : 1,
            boxSizing: 'border-box',
          }}
        />
        {!isOauth && isEdit && endpoint.hasToken && (
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
            marginTop: 'var(--eb-space-1)', cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={clearToken}
              onChange={e => setClearToken(e.target.checked)}
            />
            Remove stored token on save
          </label>
        )}
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Stored in <code style={{ fontFamily: 'var(--eb-font-mono)' }}>/workspace/llm-endpoints/_keys/</code> (chmod 600). API never returns the raw value — only a preview and fingerprint.
        </div>
      </div>

      {/* Test + Discover */}
      <div style={{
        display: 'flex',
        gap: 'var(--eb-space-2)',
        flexWrap: 'wrap',
        alignItems: 'center',
        paddingTop: 'var(--eb-space-2)',
        borderTop: '1px solid var(--eb-border-default)',
      }}>
        <button
          type="button"
          onClick={runTest}
          disabled={!canProbe || probing === 'test'}
          style={{ ...buttonGhost, opacity: !canProbe || probing === 'test' ? 0.6 : 1 }}
          title={canProbe ? 'Send GET /v1/models to verify connectivity' : 'Enter a Base URL first'}
        >
          <PlugZap size={13} /> {probing === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          onClick={runDiscover}
          disabled={!canProbe || probing === 'discover'}
          style={{ ...buttonGhost, opacity: !canProbe || probing === 'discover' ? 0.6 : 1 }}
          title={canProbe ? 'Fetch /v1/models from the proxy' : 'Enter a Base URL first'}
        >
          <RefreshCw size={13} /> {probing === 'discover' ? 'Loading…' : 'Discover models'}
        </button>
        {probeMsg && (
          <span style={{
            fontSize: 'var(--eb-text-xs)',
            color: probeMsg.ok ? 'var(--eb-status-success)' : 'var(--eb-status-error)',
          }}>{probeMsg.text}</span>
        )}
      </div>

      {discovered && (
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-accent-primary)',
          borderRadius: 'var(--eb-radius-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <div style={{ fontSize: 'var(--eb-text-sm)' }}>
            {discovered.length} model(s) returned by the proxy. Apply to the catalog below?
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => applyDiscovered('merge')} style={buttonPrimary}>
              <Check size={13} /> Merge into catalog
            </button>
            <button type="button" onClick={() => applyDiscovered('replace')} style={buttonSecondary}>
              Replace catalog
            </button>
            <button type="button" onClick={() => setDiscovered(null)} style={buttonSecondary}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          marginBottom: 'var(--eb-space-2)', gap: 'var(--eb-space-3)',
        }}>
          <div style={{
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)',
            color: 'var(--eb-text-secondary)',
          }}>
            Models
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {defaultModelId
              ? <>Default: <code style={{ fontFamily: 'var(--eb-font-mono)' }}>{defaultModelId}</code></>
              : 'No default — new agents fall back to the first model.'}
          </div>
        </div>
        <ModelEditor
          models={models}
          defaultModelId={defaultModelId}
          onChange={setModels}
          onDefaultChange={setDefaultModelId}
        />
        <div style={{
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          marginTop: 'var(--eb-space-2)',
        }}>
          Click the star to mark one model as the provider's default. New environments and agents bound to this provider start on that model unless they override it explicitly.
        </div>
      </div>

      <div style={{
        display: 'flex',
        gap: 'var(--eb-space-2)',
        paddingTop: 'var(--eb-space-3)',
        borderTop: '1px solid var(--eb-border-default)',
      }}>
        <button
          onClick={submit}
          disabled={saving || !canSubmit}
          style={{ ...buttonPrimary, cursor: saving ? 'wait' : 'pointer', opacity: (saving || !canSubmit) ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create provider'}
        </button>
        <button onClick={onCancel} style={buttonSecondary}>Cancel</button>
      </div>
    </div>
  );
}

/* ─────────────── Sub: read-only view for the .env fallback ─────────────── */

function EnvProviderPanel({ provider, onClose }) {
  const readOnlyField = {
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    background: 'var(--eb-bg-elevated)',
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)',
    color: 'var(--eb-text-primary)',
    fontSize: 'var(--eb-text-sm)',
    minHeight: 'calc(var(--eb-text-sm) * 1.5)',
  };
  const labelStyle = {
    fontSize: 'var(--eb-text-sm)',
    fontWeight: 'var(--eb-font-medium)',
    color: 'var(--eb-text-secondary)',
    marginBottom: 'var(--eb-space-1)',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{
        padding: 'var(--eb-space-3)',
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
        display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
      }}>
        <Lock size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          Read-only mirror of the <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ANTHROPIC_*</code> variables in <code style={{ fontFamily: 'var(--eb-font-mono)' }}>.env</code>. Working Environments that pick <em>“inherit from .env”</em> resolve to these values. To change them, edit <code style={{ fontFamily: 'var(--eb-font-mono)' }}>.env</code> and restart the stack (<code style={{ fontFamily: 'var(--eb-font-mono)' }}>make restart</code>).
        </span>
      </div>

      <div>
        <div style={labelStyle}>Name</div>
        <div style={readOnlyField}>{provider.name}</div>
      </div>

      <div>
        <div style={labelStyle}>Base URL</div>
        <div style={{ ...readOnlyField, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
          {provider.baseUrl || <span style={{ color: 'var(--eb-text-muted)' }}>(not set)</span>}
        </div>
      </div>

      <div>
        <div style={labelStyle}>Auth token</div>
        {provider.hasToken ? (
          <div style={{ ...readOnlyField, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
            {provider.tokenPreview} · {provider.tokenFingerprint}
          </div>
        ) : (
          <div style={{ ...readOnlyField, color: 'var(--eb-text-muted)' }}>
            (none — <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ANTHROPIC_AUTH_TOKEN</code> not set)
          </div>
        )}
      </div>

      <div>
        <div style={labelStyle}>Models</div>
        {provider.models?.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            {provider.models.map(m => {
              const isDefault = m.id === provider.defaultModelId;
              return (
                <div key={m.id} style={{
                  ...readOnlyField,
                  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                }}>
                  <Star
                    size={13}
                    fill={isDefault ? 'currentColor' : 'none'}
                    style={{ color: isDefault ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }}
                  />
                  <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{m.id}</code>
                  {m.kind && (
                    <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>· {m.kind}</span>
                  )}
                  {isDefault && (
                    <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginLeft: 'auto' }}>
                      default
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ ...readOnlyField, color: 'var(--eb-text-muted)' }}>(no model defaults configured)</div>
        )}
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-2)' }}>
          Derived from <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ANTHROPIC_DEFAULT_SONNET_MODEL</code> and <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ANTHROPIC_DEFAULT_HAIKU_MODEL</code>.
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 'var(--eb-space-2)',
        paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)',
      }}>
        <button onClick={onClose} style={buttonSecondary}>Close</button>
      </div>
    </div>
  );
}

/* ───────────────────────────── Page ───────────────────────────── */

export default function ModelRegistry() {
  const { data: endpoints, loading, error, refetch } = useApi('/api/llm-endpoints');
  const { data: envFallback } = useApi('/api/llm-env-fallback');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing]   = useState(null);    // endpoint object
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  // When the endpoint list refetches after a successful edit, sync the open
  // panel with the fresh masked record (token preview/fingerprint, etc.).
  useEffect(() => {
    if (!editing || editing.readOnly || !endpoints) return;
    const fresh = endpoints.find(e => e.id === editing.id);
    if (fresh && fresh !== editing) setEditing(fresh);
  }, [endpoints]); // eslint-disable-line react-hooks/exhaustive-deps

  const COLUMNS = [
    {
      key: 'id',
      label: 'ID',
      render: (v, row) => row.readOnly
        ? <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '0 var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
            background: 'var(--eb-bg-elevated)',
            color: 'var(--eb-text-muted)',
            fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
          }} title="Synthetic record reflecting .env"><Lock size={11} />.env</span>
        : <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span>,
    },
    {
      key: 'name',
      label: 'Name',
      render: (v, row) => row.readOnly
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            <span>{v}</span>
            <span style={{
              fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
              padding: '0 var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
              border: '1px solid var(--eb-border-default)',
            }}>read-only</span>
          </span>
        : v,
    },
    {
      key: 'baseUrl',
      label: 'Base URL',
      render: (v, row) => row.authType === 'oauth-token'
        ? <span title="Anthropic subscription (OAuth) — talks directly to api.anthropic.com" style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '0 var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
            background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
            fontSize: 'var(--eb-text-xs)',
          }}><LogIn size={11} /> Subscription (OAuth)</span>
        : <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span>,
    },
    {
      key: 'tokenPreview',
      label: 'Token',
      render: (v, row) => row.hasToken
        ? <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span>
        : <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>(none)</span>,
    },
    {
      key: 'models',
      label: 'Models',
      render: (v, row) => {
        const count = Array.isArray(v) ? v.length : 0;
        const def = row.defaultModelId;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)' }}>
            <span>{count}</span>
            {def
              ? <span title={`Default model: ${def}`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '0 var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
                  background: 'var(--eb-bg-elevated)',
                  color: 'var(--eb-text-secondary)',
                  fontFamily: 'var(--eb-font-mono)',
                }}>
                  <Star size={11} fill="currentColor" /> {def}
                </span>
              : <span style={{ color: 'var(--eb-text-muted)' }}>(no default)</span>}
          </span>
        );
      },
    },
    { key: 'createdAt', label: 'Added', render: (v, row) => row.readOnly ? '—' : (v ? new Date(v).toLocaleString() : '—') },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => row.readOnly ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', color: 'var(--eb-text-muted)' }} title="Edit .env and restart to change">
          <Lock size={13} />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <button
            aria-label="Edit"
            title="Edit"
            onClick={() => { setEditing(row); setFormError(null); }}
            style={{
              display: 'flex', alignItems: 'center',
              padding: 'var(--eb-space-1) var(--eb-space-2)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer', fontSize: 'var(--eb-text-xs)',
            }}
          >
            <Pencil size={13} />
          </button>
          <button
            aria-label="Delete"
            title="Delete"
            onClick={() => setDeleteTarget(row)}
            style={{
              display: 'flex', alignItems: 'center',
              padding: 'var(--eb-space-1) var(--eb-space-2)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-status-error)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-status-error)',
              cursor: 'pointer', fontSize: 'var(--eb-text-xs)',
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ),
    },
  ];

  async function handleCreate(payload) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/llm-endpoints', payload);
      setCreating(false);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(payload) {
    if (!editing) return;
    setSaving(true); setFormError(null);
    try {
      await apiCall('PUT', `/api/llm-endpoints/${editing.id}`, payload);
      setEditing(null);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/llm-endpoints/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (error) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load: {error}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Model Providers
        </h1>
        <button
          onClick={() => { setCreating(true); setFormError(null); }}
          style={{ ...buttonPrimary, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}
        >
          <Plus size={15} /> New provider
        </button>
      </div>

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
      }}>
        Model providers are where Agent Studio routes model traffic. Each provider has a URL, an auth token and a catalog of available models. Working Environments and individual agents bind to one provider and pick a default model from its catalog.
      </div>

      {actionError && (
        <div role="alert" style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)',
          border: '1px solid var(--eb-status-error)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)',
        }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={envFallback ? [envFallback, ...(endpoints ?? [])] : (endpoints ?? [])}
        emptyText="No model providers registered yet."
        onRowClick={row => { setEditing(row); setFormError(null); }}
      />

      <SidePanel
        open={creating}
        onClose={() => setCreating(false)}
        title="New model provider"
        width="640px"
      >
        {creating && (
          <EndpointForm
            endpoint={null}
            onSave={handleCreate}
            onCancel={() => setCreating(false)}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <SidePanel
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? (editing.readOnly ? editing.name : `Edit "${editing.name}"`) : ''}
        width="640px"
      >
        {editing && editing.readOnly && (
          <EnvProviderPanel provider={editing} onClose={() => setEditing(null)} />
        )}
        {editing && !editing.readOnly && (
          <EndpointForm
            endpoint={editing}
            onSave={handleUpdate}
            onCancel={() => setEditing(null)}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete model provider"
        message={`Really delete "${deleteTarget?.name || deleteTarget?.id}"? Working Environments using this provider must detach it first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
