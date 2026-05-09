import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Github, ArrowRight, AlertCircle, CheckCircle } from 'lucide-react';
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

export default function QuickStart() {
  const navigate = useNavigate();
  const { data: tokens, loading: tokensLoading } = useApi('/api/github-tokens');

  const [url, setUrl] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null);
  const [result, setResult] = useState(null);

  const hasTokens = !tokensLoading && Array.isArray(tokens) && tokens.length > 0;
  const showTokenPicker = Array.isArray(tokens) && tokens.length > 1;

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setErrorCode(null);
    setResult(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/quickstart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          githubTokenId: tokenId || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setErrorCode(data.code || null);
        return;
      }
      setResult(data);
      // Tiny delay so the user sees the success card before redirect.
      setTimeout(() => navigate(`/chats/${data.agent.id}`), 800);
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
        }}>Quick Start</h1>
        <p style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-secondary)',
          marginTop: 'var(--eb-space-2)',
          marginBottom: 0,
        }}>
          Paste a GitHub URL, hit Enter, start chatting. The Working Environment and Agent are created automatically.
        </p>
      </div>

      {!tokensLoading && !hasTokens && (
        <Card accent="var(--eb-status-warning)">
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <AlertCircle size={20} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-1)' }}>
                No GitHub token configured
              </div>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                Quick Start needs a GitHub PAT to clone the repository.{' '}
                <Link to="/github-tokens" style={{ color: 'var(--eb-accent-primary)' }}>
                  Create token →
                </Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
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
                disabled={submitting || !hasTokens}
                autoFocus
                style={{ ...inputStyle, paddingLeft: 'var(--eb-space-10)' }}
              />
            </div>
            <div style={{
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
              marginTop: 'var(--eb-space-2)',
            }}>
              HTTPS or SSH — we normalise to HTTPS and clone with the GitHub token.
            </div>
          </div>

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
              </div>
            </div>
          )}

          {result && (
            <div style={{
              display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
              padding: 'var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-status-success)',
              borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)',
              color: 'var(--eb-text-primary)',
            }}>
              <CheckCircle size={16} style={{ color: 'var(--eb-status-success)', flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontWeight: 'var(--eb-font-medium)' }}>
                  {result.reused ? 'Agent reused' : 'Agent created'}: {result.agent.displayName}
                </div>
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 2 }}>
                  Working Environment: {result.environment.name}
                  {result.environment.reused ? ' (reused)' : ' (new)'} · redirecting to chat …
                </div>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !hasTokens || !url.trim()}
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
              cursor: (submitting || !hasTokens || !url.trim()) ? 'not-allowed' : 'pointer',
              opacity: (submitting || !hasTokens || !url.trim()) ? 0.5 : 1,
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
        <strong>What happens here:</strong> If no Working Environment exists yet for this repository, a new one is created
        with branch <code>main</code>, the current GitHub token, and no additional skills. A default agent is then
        created on top of it. Both can be fine-tuned later under{' '}
        <Link to="/environments" style={{ color: 'var(--eb-accent-primary)' }}>Working Environments</Link> and{' '}
        <Link to="/agents" style={{ color: 'var(--eb-accent-primary)' }}>Agents</Link>.
      </div>
    </div>
  );
}
