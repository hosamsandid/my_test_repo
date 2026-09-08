import React, { useState, useEffect, useRef } from 'react';
import { X, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { apiCall } from '../hooks/useApi';
import IconButton from './IconButton';
import { tokenIsElsewhere, shouldShowTokenHint } from './repository-fields-view.js';

// RepositoryCard — the ONE repository configuration card in this console.
//
// It was the Working Environments page's own until #2067 needed the identical
// form for a repository attached to a single agent (D2: "the same fields, no
// reduced or invented form"). Rather than write a second card that would drift
// — differently worded about SSH vs HTTPS, differently strict about the branch
// — it was extracted here and both surfaces render it, the same call #1928/
// #1929 made for the agent dialogs and the agent edit form.
//
// Two props carry the whole difference between the hosts:
//   • `tokenTarget` — 'form' (the environment form, whose GitHub Token field is
//     literally below the card) or 'environment' (the agent surfaces, which
//     have no token field: an agent-scoped repository carries no credential of
//     its own and uses the environment's, D5). Only the pointer clause changes.
//   • `onRemove` — omitted on a single-repository form, which then renders no
//     header row at all (a lone card needs neither "Repository #1" nor an X).
//
// `useRepoCheck` and `RepoStatusIcon` are exported too: the debounced probe and
// its three distinguishable results (reachable / not reachable / reachable but
// empty) are what AC3 asks the agent form to reproduce, and reproducing them
// means reusing them.

const labelStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  fontWeight: 'var(--eb-font-medium)',
  marginBottom: 'var(--eb-space-0-5)',
};

const helpTextStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  marginTop: 'var(--eb-space-1)',
  lineHeight: '1.4',
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
  outline: 'none',
  boxSizing: 'border-box',
};

// Debounced reachability probe. Advisory by contract — it never blocks a
// submission on either surface (the environment form's submit gate does not
// consult it, and neither does the agent form's).
export function useRepoCheck(url, sshKeyId, githubTokenId) {
  const [state, setState] = useState({ status: 'idle', error: null });
  const reqIdRef = useRef(0);
  const trimmedUrl = url ? url.trim() : '';

  useEffect(() => {
    if (!trimmedUrl) {
      setState({ status: 'idle', error: null });
      return;
    }
    const myReqId = ++reqIdRef.current;
    setState({ status: 'pending', error: null });
    const handle = setTimeout(async () => {
      try {
        const result = await apiCall('POST', '/api/repositories/check', {
          url: trimmedUrl,
          sshKeyId: sshKeyId || null,
          githubTokenId: githubTokenId || null,
        });
        if (reqIdRef.current !== myReqId) return; // a newer request is in flight
        if (result.ok) setState({ status: 'ok', error: null, empty: !!result.empty });
        else setState({ status: 'error', error: result.error || 'Repository unreachable' });
      } catch (err) {
        if (reqIdRef.current !== myReqId) return;
        setState({ status: 'error', error: err.message || 'Check failed' });
      }
    }, 700);
    return () => clearTimeout(handle);
  }, [trimmedUrl, sshKeyId, githubTokenId]);

  return state;
}

export function RepoStatusIcon({ status, error, empty }) {
  if (status === 'pending') {
    return (
      <span title="Checking repository…" style={{ display: 'inline-flex', color: 'var(--eb-text-muted)' }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
      </span>
    );
  }
  if (status === 'ok') {
    const title = empty
      ? 'Repository reachable — but empty (no commits yet). Add an initial commit before agents can clone it.'
      : 'Repository reachable';
    return (
      <span title={title} style={{ display: 'inline-flex', color: 'var(--eb-status-success, #16a34a)' }}>
        <Check size={14} />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span title={error || 'Repository unreachable'} style={{ display: 'inline-flex', color: 'var(--eb-status-error)' }}>
        <AlertTriangle size={14} />
      </span>
    );
  }
  return null;
}

export default function RepositoryCard({
  idx = 0,
  repo,
  sshKeys,
  githubTokenId,
  onChange,
  onRemove = null,
  tokenTarget = 'form',
}) {
  const check = useRepoCheck(repo.url, repo.sshKeyId, githubTokenId);
  const showTokenHint = shouldShowTokenHint(check, repo.url, githubTokenId);
  const elsewhere = tokenIsElsewhere(tokenTarget);

  return (
    <div style={{
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-bg-surface)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
      position: 'relative',
    }}>
      {onRemove && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)' }}>
            Repository #{idx + 1}
          </span>
          <IconButton icon={X} label="Remove repository" danger onClick={onRemove} size={12} />
        </div>
      )}

      <div>
        <div style={labelStyle}>SSH key</div>
        <select
          value={repo.sshKeyId}
          onChange={e => onChange('sshKeyId', e.target.value)}
          style={inputStyle}
        >
          <option value="">— no key (HTTPS only) —</option>
          {sshKeys.map(k => (
            <option key={k.id} value={k.id}>{k.name} ({k.id})</option>
          ))}
        </select>
        <div style={helpTextStyle}>
          Required for SSH-based URLs (e.g. <code>git@github.com:…</code>). Leave empty for HTTPS URLs — private HTTPS repositories authenticate with the <em>GitHub Token</em> {elsewhere ? 'on the Working Environment' : 'set below'}, not an SSH key. Manage SSH keys on the <em>SSH Keys</em> page.
        </div>
      </div>

      <div>
        <div style={labelStyle}>Repository URL <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <div style={{ position: 'relative' }}>
          <input
            style={{
              ...inputStyle,
              fontFamily: 'var(--eb-font-mono)',
              paddingRight: 'var(--eb-space-8)',
            }}
            value={repo.url}
            onChange={e => onChange('url', e.target.value)}
            placeholder="git@github.com:org/repo.git"
          />
          <div style={{
            position: 'absolute',
            right: 'var(--eb-space-2)',
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            pointerEvents: 'none',
          }}>
            <RepoStatusIcon status={check.status} error={check.error} empty={check.empty} />
          </div>
        </div>
        {check.status === 'error' && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 'var(--eb-space-1)' }}>
            {check.error}
          </div>
        )}
        {check.status === 'ok' && check.empty && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning, #b45309)', marginTop: 'var(--eb-space-1)' }}>
            Reachable, but the repository is empty (no commits yet). Add an initial commit before agents can clone it.
          </div>
        )}
        {showTokenHint && (
          <div style={{ ...helpTextStyle, color: 'var(--eb-text-secondary)' }}>
            {elsewhere ? (
              <>If this is a private HTTPS repository, its <em>Working Environment</em> needs a <em>GitHub Token</em> to authenticate — SSH keys don't apply to HTTPS URLs, and an agent-scoped repository carries no credential of its own.</>
            ) : (
              <>If this is a private HTTPS repository, select a <em>GitHub Token</em> in the section below to authenticate — SSH keys don't apply to HTTPS URLs.</>
            )}
          </div>
        )}
        {check.status !== 'error' && (
          <div style={helpTextStyle}>
            The repository is checked for reachability in real time. Use an SSH URL with an SSH key, or an HTTPS URL with the <em>GitHub Token</em> {elsewhere ? 'on the Working Environment' : 'set below'}, for private repositories.
          </div>
        )}
      </div>

      <div>
        <div style={labelStyle}>Branch (optional)</div>
        <input
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }}
          value={repo.branch}
          onChange={e => onChange('branch', e.target.value)}
          placeholder="main"
        />
        <div style={helpTextStyle}>
          Leave empty to clone the repository's default branch (usually <code>main</code> or <code>master</code>).
        </div>
      </div>

      <div>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={repo.readOnly === true}
            onChange={e => onChange('readOnly', e.target.checked)}
            style={{ marginTop: '2px' }}
          />
          <span style={{ fontSize: 'var(--eb-text-sm)' }}>
            Read-only (clone for reference — the agent must not push to this repo)
          </span>
        </label>
        <div style={helpTextStyle}>
          The repository is still cloned into the workspace, but the agent is told it is reference-only and must not commit or push to it.
        </div>
      </div>
    </div>
  );
}
