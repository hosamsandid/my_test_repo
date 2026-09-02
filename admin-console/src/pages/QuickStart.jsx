import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { Github, ArrowRight, AlertCircle, CheckCircle, Info } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import PageHelpButton from '../components/PageHelpButton';
import {
  quickstartEndpoint,
  quickstartBody,
  showRepoPrerequisites,
  quickstartSubmitReasons,
  QUICKSTART_COPY,
} from './quickstart-view';

const inputStyle = {
  width: '100%',
  padding: 'var(--eb-space-3) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-md)',
  fontFamily: 'var(--eb-font-mono)',
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle = {
  display: 'block',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
  marginBottom: 'var(--eb-space-2)',
};

const optionalHintStyle = {
  fontWeight: 'var(--eb-font-normal)',
  color: 'var(--eb-text-muted)',
};

function Card({ children, accent }) {
  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: `1px solid ${accent || 'var(--eb-border-default)'}`,
      borderRadius: 'var(--eb-radius-lg)',
      padding: 'var(--eb-space-6)',
    }}>
      {children}
    </div>
  );
}

export default function QuickStart() {
  const navigate = useNavigate();
  const { data: tokens, loading: tokensLoading } = useApi('/api/github-tokens');
  const { data: sshKeys, loading: sshKeysLoading } = useApi('/api/ssh-keys');
  const { data: llmEndpoints, loading: llmEndpointsLoading } = useApi('/api/llm-endpoints');

  const [displayName, setDisplayName] = useState('My Assistant');
  const [llmEndpointId, setLlmEndpointId] = useState('');
  const [url, setUrl] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [sshKeyId, setSshKeyId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null);
  const [result, setResult] = useState(null);

  const hasTokens = !tokensLoading && Array.isArray(tokens) && tokens.length > 0;
  const showTokenPicker = Array.isArray(tokens) && tokens.length > 1;
  const hasSshKeys = !sshKeysLoading && Array.isArray(sshKeys) && sshKeys.length > 0;
  const showSshKeyPicker = Array.isArray(sshKeys) && sshKeys.length > 1;
  const hasLlmEndpoints = !llmEndpointsLoading && Array.isArray(llmEndpoints) && llmEndpoints.length > 0;

  // Whether the user has entered a repository URL — the single fork that decides
  // endpoint, body, and which prerequisites apply (no more mode toggle).
  const showRepoPrereqs = showRepoPrerequisites(url);

  // Effective provider selection: honour an explicit pick, else the first one.
  const selectedLlmId = llmEndpointId || (hasLlmEndpoints ? llmEndpoints[0].id : '');
  // Same submit gate as before, but broken out into the specific unmet
  // requirements so the disabled button can explain itself (#1302 pattern).
  const { canSubmit, reasons: submitBlockers } = quickstartSubmitReasons({
    url, hasTokens, hasSshKeys, hasLlmEndpoints, displayName, selectedLlmId,
  });

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setErrorCode(null);
    setResult(null);
    setSubmitting(true);
    try {
      const endpoint = quickstartEndpoint(url);
      const body = quickstartBody({ url, tokenId, sshKeyId, displayName, llmEndpointId: selectedLlmId });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setErrorCode(data.code || null);
        return;
      }
      setResult(data);
      // Delay redirect; give the user extra time to read the LLM warning if present.
      setTimeout(() => navigate(`/chats/${data.agent.id}`), data.llmWarning ? 4000 : 800);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
      <div>
        <h2 style={{
          fontSize: 'var(--eb-text-2xl)',
          fontWeight: 'var(--eb-font-semibold)',
          margin: 0,
          color: 'var(--eb-text-primary)',
        }}>{QUICKSTART_COPY.heading}</h2>
        {/* One-line description + "?" (E14, #1888). The second paragraph that
            re-described the same thing is gone; what each submit path creates
            lives in the `create` help topic. */}
        <p style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-secondary)',
          marginTop: 'var(--eb-space-2)',
          marginBottom: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
        }}>
          <span>{QUICKSTART_COPY.intro}</span>
          <PageHelpButton label="What gets created here?" size={14} style={{ padding: 0, flexShrink: 0 }} />
        </p>
      </div>

      {!llmEndpointsLoading && !hasLlmEndpoints && (
        <Card accent="var(--eb-status-warning)">
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <AlertCircle size={20} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-1)' }}>
                No model provider configured
              </div>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                An agent needs a model provider — it is the only thing it runs on.{' '}
                <Link to="/models" style={{ color: 'var(--eb-accent-primary)' }}>
                  Add provider →
                </Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      {showRepoPrereqs && !tokensLoading && !hasTokens && (
        <Card accent="var(--eb-status-warning)">
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <AlertCircle size={20} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-1)' }}>
                No GitHub token configured
              </div>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                A repository-backed agent needs a GitHub PAT for API actions (PR creation, event polling).{' '}
                <Link to="/github-tokens" style={{ color: 'var(--eb-accent-primary)' }}>
                  Create token →
                </Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      {showRepoPrereqs && !sshKeysLoading && !hasSshKeys && (
        <Card accent="var(--eb-status-warning)">
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <AlertCircle size={20} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-1)' }}>
                No SSH key configured
              </div>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                Cloning uses SSH (<code>git@github.com:…</code>).{' '}
                <Link to="/ssh-keys" style={{ color: 'var(--eb-accent-primary)' }}>
                  Add SSH key →
                </Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          <div>
            <label htmlFor="quickstart-name" style={labelStyle}>
              Agent Name
            </label>
            <input
              id="quickstart-name"
              type="text"
              placeholder="My Assistant"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              disabled={submitting}
              autoFocus
              style={inputStyle}
            />
          </div>

          <div>
            <label htmlFor="quickstart-llm" style={labelStyle}>
              Model Provider
            </label>
            <select
              id="quickstart-llm"
              value={selectedLlmId}
              onChange={e => setLlmEndpointId(e.target.value)}
              disabled={submitting || !hasLlmEndpoints}
              style={{ ...inputStyle, fontFamily: 'inherit' }}
            >
              {hasLlmEndpoints
                ? llmEndpoints.map(ep => (
                    <option key={ep.id} value={ep.id}>{ep.name}</option>
                  ))
                : <option value="">No model provider available</option>}
            </select>
            <div style={{
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
              marginTop: 'var(--eb-space-2)',
            }}>
              The agent chats using this provider. Manage providers under{' '}
              <Link to="/models" style={{ color: 'var(--eb-accent-primary)' }}>Model Providers</Link>.
            </div>
          </div>

          <div>
            <label htmlFor="quickstart-url" style={labelStyle}>
              GitHub Repository URL <span style={optionalHintStyle}>(optional)</span>
            </label>
            <div style={{ position: 'relative' }}>
              <Github size={18} style={{
                position: 'absolute', left: 'var(--eb-space-3)', top: '50%', transform: 'translateY(-50%)',
                color: 'var(--eb-text-muted)', pointerEvents: 'none',
              }} />
              <input
                id="quickstart-url"
                type="text"
                placeholder="https://github.com/org/repo — leave empty for a repo-less agent"
                value={url}
                onChange={e => setUrl(e.target.value)}
                disabled={submitting}
                style={{ ...inputStyle, paddingLeft: 'var(--eb-space-10)' }}
              />
            </div>
            <div style={{
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
              marginTop: 'var(--eb-space-2)',
            }}>
              Leave empty for a repo-less assistant. If provided, HTTPS or SSH — we
              normalise to SSH (<code>git@github.com:…</code>) and clone with the SSH key.
            </div>
          </div>

          {showRepoPrereqs && showSshKeyPicker && (
            <div>
              <label htmlFor="quickstart-ssh-key" style={labelStyle}>
                SSH Key
              </label>
              <select
                id="quickstart-ssh-key"
                value={sshKeyId}
                onChange={e => setSshKeyId(e.target.value)}
                disabled={submitting}
                style={{ ...inputStyle, fontFamily: 'inherit' }}
              >
                <option value="">{sshKeys[0].name} (default)</option>
                {sshKeys.map(k => (
                  <option key={k.id} value={k.id}>{k.name} — {k.fingerprint}</option>
                ))}
              </select>
            </div>
          )}

          {showRepoPrereqs && showTokenPicker && (
            <div>
              <label htmlFor="quickstart-token" style={labelStyle}>
                GitHub Token
              </label>
              <select
                id="quickstart-token"
                value={tokenId}
                onChange={e => setTokenId(e.target.value)}
                disabled={submitting}
                style={{ ...inputStyle, fontFamily: 'inherit' }}
              >
                <option value="">{tokens[0].name} (default)</option>
                {tokens.map(t => (
                  <option key={t.id} value={t.id}>{t.name} — {t.preview}</option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <div style={{
              display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
              padding: 'var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-status-error)',
              borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)',
              color: 'var(--eb-text-primary)',
            }}>
              <AlertCircle size={16} style={{ color: 'var(--eb-status-error)', flexShrink: 0, marginTop: 2 }} />
              <div>
                {error}
                {errorCode === 'no_token' && (
                  <div style={{ marginTop: 'var(--eb-space-2)' }}>
                    <Link to="/github-tokens" style={{ color: 'var(--eb-accent-primary)' }}>
                      Create token →
                    </Link>
                  </div>
                )}
                {errorCode === 'no_ssh_key' && (
                  <div style={{ marginTop: 'var(--eb-space-2)' }}>
                    <Link to="/ssh-keys" style={{ color: 'var(--eb-accent-primary)' }}>
                      Add SSH key →
                    </Link>
                  </div>
                )}
                {errorCode === 'no_llm_endpoint' && (
                  <div style={{ marginTop: 'var(--eb-space-2)' }}>
                    <Link to="/models" style={{ color: 'var(--eb-accent-primary)' }}>
                      Add provider →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          )}

          {result && (
            <div style={{
              display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
              padding: 'var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: `1px solid ${result.llmWarning ? 'var(--eb-status-warning)' : 'var(--eb-status-success)'}`,
              borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)',
              color: 'var(--eb-text-primary)',
            }}>
              {result.llmWarning
                ? <AlertCircle size={16} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
                : <CheckCircle size={16} style={{ color: 'var(--eb-status-success)', flexShrink: 0, marginTop: 2 }} />}
              <div>
                <div style={{ fontWeight: 'var(--eb-font-medium)' }}>
                  {result.reused ? 'Agent reused' : 'Agent created'}: {result.agent.displayName}
                </div>
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 2 }}>
                  Working Environment: {result.environment.name}
                  {result.environment.reused ? ' (reused)' : ' (new)'} · redirecting to chat …
                </div>
                {result.llmWarning && (
                  <div style={{ marginTop: 'var(--eb-space-2)', color: 'var(--eb-status-warning)' }}>
                    ⚠ {result.llmWarning}{' '}
                    <Link to="/models" style={{ color: 'var(--eb-accent-primary)' }}>
                      Add provider →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Spell out exactly what is still missing so a first-time user isn't
              left staring at a greyed-out button with no idea why (the same
              "explain a disabled submit" discipline as the Model Provider form). */}
          {!submitting && submitBlockers.length > 0 && (
            <div style={{
              display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
              padding: 'var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)',
              color: 'var(--eb-text-secondary)',
            }}>
              <Info size={16} style={{ color: 'var(--eb-text-muted)', flexShrink: 0, marginTop: 2 }} />
              <span>
                Before you can start, please:
                <ul style={{ margin: 'var(--eb-space-1) 0 0', paddingLeft: 'var(--eb-space-4)' }}>
                  {submitBlockers.map(r => (
                    <li key={r.field}>{r.message}</li>
                  ))}
                </ul>
              </span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !canSubmit}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-3) var(--eb-space-4)',
              background: 'var(--eb-accent-primary)',
              color: 'var(--eb-text-inverted)',
              border: 'none',
              borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-md)',
              fontWeight: 'var(--eb-font-medium)',
              fontFamily: 'inherit',
              cursor: (submitting || !canSubmit) ? 'not-allowed' : 'pointer',
              opacity: (submitting || !canSubmit) ? 0.5 : 1,
            }}
          >
            {submitting ? 'Creating agent…' : 'Create agent & start chatting'}
            {!submitting && <ArrowRight size={16} />}
          </button>
        </form>
      </Card>

      {/* The "What happens here" block (both branches) moved to the `create`
          help topic in E14 (#1888) — including what the box never said: an
          existing environment AND an existing standalone agent for the same
          repository are reused, and on the repository path the Name / Model
          Provider fields above are not used at all. */}

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
      }}>
        {QUICKSTART_COPY.teamOfOneNote}{' '}
        <Link to="/team-setup" style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-medium)' }}>
          {QUICKSTART_COPY.growCtaLabel} →
        </Link>
      </div>
    </div>
  );
}
