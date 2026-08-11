import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { Github, ArrowRight, AlertCircle, CheckCircle, Sparkles } from 'lucide-react';
import { useApi } from '../hooks/useApi';

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

// A two-option segmented control choosing the QuickStart entry mode (#1624).
function ModeToggle({ mode, setMode, disabled }) {
  const options = [
    { id: 'repo', icon: Github, label: 'From a GitHub repository' },
    { id: 'llm', icon: Sparkles, label: 'LLM only / no repository' },
  ];
  return (
    <div role="tablist" aria-label="QuickStart mode" style={{
      display: 'flex', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-1)',
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
    }}>
      {options.map(o => {
        const active = mode === o.id;
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => setMode(o.id)}
            style={{
              flex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: active ? 'var(--eb-accent-primary)' : 'transparent',
              color: active ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)',
              border: 'none',
              borderRadius: 'var(--eb-radius-sm)',
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              fontFamily: 'inherit',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            <Icon size={16} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function QuickStart() {
  const navigate = useNavigate();
  const { data: tokens, loading: tokensLoading } = useApi('/api/github-tokens');
  const { data: sshKeys, loading: sshKeysLoading } = useApi('/api/ssh-keys');
  const { data: llmEndpoints, loading: llmEndpointsLoading } = useApi('/api/llm-endpoints');

  const [mode, setMode] = useState('repo');
  const [url, setUrl] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [sshKeyId, setSshKeyId] = useState('');
  // LLM-only mode fields.
  const [displayName, setDisplayName] = useState('My Assistant');
  const [llmEndpointId, setLlmEndpointId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null);
  const [result, setResult] = useState(null);

  const hasTokens = !tokensLoading && Array.isArray(tokens) && tokens.length > 0;
  const showTokenPicker = Array.isArray(tokens) && tokens.length > 1;
  const hasSshKeys = !sshKeysLoading && Array.isArray(sshKeys) && sshKeys.length > 0;
  const showSshKeyPicker = Array.isArray(sshKeys) && sshKeys.length > 1;
  const hasLlmEndpoints = !llmEndpointsLoading && Array.isArray(llmEndpoints) && llmEndpoints.length > 0;
  const ready = hasTokens && hasSshKeys;

  const isLlm = mode === 'llm';
  // Effective provider selection: honour an explicit pick, else the first one.
  const selectedLlmId = llmEndpointId || (hasLlmEndpoints ? llmEndpoints[0].id : '');
  const canSubmit = isLlm
    ? (hasLlmEndpoints && displayName.trim() && selectedLlmId)
    : (ready && url.trim());

  function switchMode(next) {
    if (next === mode) return;
    setMode(next);
    setError(null);
    setErrorCode(null);
    setResult(null);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setErrorCode(null);
    setResult(null);
    setSubmitting(true);
    try {
      const endpoint = isLlm ? '/api/quickstart/llm' : '/api/quickstart';
      const body = isLlm
        ? { displayName: displayName.trim(), llmEndpointId: selectedLlmId }
        : { url: url.trim(), githubTokenId: tokenId || undefined, sshKeyId: sshKeyId || undefined };
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
        <h1 style={{
          fontSize: 'var(--eb-text-2xl)',
          fontWeight: 'var(--eb-font-semibold)',
          margin: 0,
          color: 'var(--eb-text-primary)',
        }}>Single Agent</h1>
        <p style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-secondary)',
          marginTop: 'var(--eb-space-2)',
          marginBottom: 0,
        }}>
          {isLlm
            ? 'Pick a model provider, name your agent, and start chatting — no repository, no GitHub token, no SSH key required.'
            : ready
              ? 'Paste a GitHub URL, hit Enter, start chatting. The Working Environment and Agent are created automatically.'
              : <>Point an agent at a repository and start chatting — you first need an{' '}
                  <Link to="/ssh-keys" style={{ color: 'var(--eb-accent-primary)' }}>SSH key</Link> and a{' '}
                  <Link to="/github-tokens" style={{ color: 'var(--eb-accent-primary)' }}>GitHub token</Link>{' '}
                  (see below). Then paste a URL and the Working Environment and Agent are created automatically.</>}
        </p>
      </div>

      <ModeToggle mode={mode} setMode={switchMode} disabled={submitting} />

      {isLlm ? (
        <p style={{
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-secondary)',
          margin: 0,
          lineHeight: 1.6,
        }}>
          Creates a single chat agent backed only by the model you choose. It has no repository and clones no code — a
          quick helpful assistant you can chat with right away. Attach a repository later under{' '}
          <Link to="/environments" style={{ color: 'var(--eb-accent-primary)' }}>Working Environments</Link>, or use the{' '}
          <Link to="/team-setup" style={{ color: 'var(--eb-accent-primary)' }}>Agent Team Wizard</Link> for a full team.
        </p>
      ) : (
        <p style={{
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-secondary)',
          margin: 0,
          lineHeight: 1.6,
        }}>
          Creates a single chat agent bound to your repository. The agent can answer questions, read code, and help
          you work. It does not include automated code review, issue triage, or a development workflow — use the{' '}
          <Link to="/team-setup" style={{ color: 'var(--eb-accent-primary)' }}>Agent Team Wizard</Link> for that.
        </p>
      )}

      {!isLlm && !tokensLoading && !hasTokens && (
        <Card accent="var(--eb-status-warning)">
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <AlertCircle size={20} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-1)' }}>
                No GitHub token configured
              </div>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                A single agent needs a GitHub PAT for API actions (PR creation, event polling).{' '}
                <Link to="/github-tokens" style={{ color: 'var(--eb-accent-primary)' }}>
                  Create token →
                </Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      {!isLlm && !sshKeysLoading && !hasSshKeys && (
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

      {!llmEndpointsLoading && !hasLlmEndpoints && (
        <Card accent="var(--eb-status-warning)">
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <AlertCircle size={20} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-1)' }}>
                No model provider configured
              </div>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                {isLlm
                  ? 'An LLM-only agent needs a model provider — it is the only thing it runs on. '
                  : 'The agent will fail on its first message without a model provider. '}
                <Link to="/models" style={{ color: 'var(--eb-accent-primary)' }}>
                  Add provider →
                </Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          {isLlm ? (
            <>
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
            </>
          ) : (
            <>
              <div>
                <label htmlFor="quickstart-url" style={labelStyle}>
                  GitHub Repository URL
                </label>
                <div style={{ position: 'relative' }}>
                  <Github size={18} style={{
                    position: 'absolute', left: 'var(--eb-space-3)', top: '50%', transform: 'translateY(-50%)',
                    color: 'var(--eb-text-muted)', pointerEvents: 'none',
                  }} />
                  <input
                    id="quickstart-url"
                    type="text"
                    placeholder="https://github.com/org/repo"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    disabled={submitting || !ready}
                    autoFocus
                    style={{ ...inputStyle, paddingLeft: 'var(--eb-space-10)' }}
                  />
                </div>
                <div style={{
                  fontSize: 'var(--eb-text-xs)',
                  color: 'var(--eb-text-muted)',
                  marginTop: 'var(--eb-space-2)',
                }}>
                  HTTPS or SSH — we normalise to SSH (<code>git@github.com:…</code>) and clone with the SSH key.
                </div>
              </div>

              {showSshKeyPicker && (
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

              {showTokenPicker && (
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
            </>
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

      <div style={{
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
        lineHeight: 1.6,
      }}>
        {isLlm ? (
          <>
            <strong>What happens here:</strong> A new repo-less Working Environment is created and bound to the model
            provider you selected, then a single standalone chat agent is created on top of it — no repository is
            cloned. Both can be fine-tuned later under{' '}
            <Link to="/environments" style={{ color: 'var(--eb-accent-primary)' }}>Working Environments</Link> and{' '}
            <Link to="/agents" style={{ color: 'var(--eb-accent-primary)' }}>Agents</Link>.
          </>
        ) : (
          <>
            <strong>What happens here:</strong> If no Working Environment exists yet for this repository, a new one is created
            using the repository's default branch (resolved from its remote HEAD), the selected SSH key (for cloning), the current GitHub token (for API actions),
            and no additional skills. A default agent is then created on top of it. Both can be fine-tuned later under{' '}
            <Link to="/environments" style={{ color: 'var(--eb-accent-primary)' }}>Working Environments</Link> and{' '}
            <Link to="/agents" style={{ color: 'var(--eb-accent-primary)' }}>Agents</Link>.
          </>
        )}
      </div>

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
      }}>
        Need a full development team instead?{' '}
        <Link to="/team-setup" style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-medium)' }}>
          → Agent Team Wizard
        </Link>
      </div>
    </div>
  );
}
