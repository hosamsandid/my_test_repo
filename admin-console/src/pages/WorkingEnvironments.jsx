import React, { useState, useEffect, useRef } from 'react';
import { Edit, Trash2, Plus, GitBranch, Key, Github, X, Check, AlertTriangle, Loader2, Cpu, Users } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import IconButton from '../components/IconButton';
import SyncReposPanel from '../components/SyncReposPanel';
import useAutoDerivedId from '../hooks/useAutoDerivedId';

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

function useRepoCheck(url, sshKeyId, githubTokenId) {
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

function RepoStatusIcon({ status, error, empty }) {
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

function RepositoryCard({ idx, repo, sshKeys, githubTokenId, onChange, onRemove }) {
  const check = useRepoCheck(repo.url, repo.sshKeyId, githubTokenId);
  const isHttpsUrl = /^https:\/\//i.test((repo.url || '').trim());
  // A private HTTPS repo fails the reachability check when no GitHub Token is set;
  // SSH keys don't apply to HTTPS URLs, so point the user at the token section below.
  const showTokenHint = check.status === 'error' && isHttpsUrl && !githubTokenId;

  return (
    <div style={{
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-bg-surface)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
      position: 'relative',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)' }}>
          Repository #{idx + 1}
        </span>
        <IconButton icon={X} label="Remove repository" danger onClick={onRemove} size={12} />
      </div>

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
          Required for SSH-based URLs (e.g. <code>git@github.com:…</code>). Leave empty for HTTPS URLs — private HTTPS repositories authenticate with the <em>GitHub Token</em> set below, not an SSH key. Manage SSH keys on the <em>SSH Keys</em> page.
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
            If this is a private HTTPS repository, select a <em>GitHub Token</em> in the section below to authenticate — SSH keys don't apply to HTTPS URLs.
          </div>
        )}
        {check.status !== 'error' && (
          <div style={helpTextStyle}>
            The repository is checked for reachability in real time. Use an SSH URL with an SSH key, or an HTTPS URL with the <em>GitHub Token</em> set below, for private repositories.
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
    </div>
  );
}

function initialRepositories(initial) {
  if (Array.isArray(initial?.repositories) && initial.repositories.length > 0) {
    return initial.repositories.map(r => ({
      url: r.url || '',
      branch: r.branch || '',
      sshKeyId: r.sshKeyId || '',
    }));
  }
  if (initial?.repository?.url) {
    return [{
      url: initial.repository.url,
      branch: initial.repository.branch || '',
      sshKeyId: initial.repository.sshKeyId || '',
    }];
  }
  return [];
}

function EnvironmentForm({ initial, onSave, onCancel, saving, error, isEdit }) {
  const [form, setForm] = useState(() => ({
    id: initial?.id || '',
    name: initial?.name || '',
    description: initial?.description || '',
    additionalContext: initial?.additionalContext || '',
    repositories: initialRepositories(initial),
    githubTokenId: initial?.githubTokenId || '',
    llmEndpointId: initial?.llmEndpointId || '',
    defaultModelId: initial?.defaultModelId || '',
  }));

  const { data: keysData } = useApi('/api/ssh-keys');
  const { data: tokensData } = useApi('/api/github-tokens');
  const { data: endpointsData } = useApi('/api/llm-endpoints');

  const sshKeys = keysData || [];
  const ghTokens = tokensData || [];
  const llmEndpoints = endpointsData || [];
  const selectedEndpoint = llmEndpoints.find(e => e.id === form.llmEndpointId) || null;
  const endpointModels = selectedEndpoint?.models || [];

  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName: v => update('name', v),
    setId:   v => update('id', v),
    getName: () => form.name,
    initiallyAuto: !isEdit,
  });

  // When the endpoint changes, prefer the endpoint's registry-level default —
  // the user opted into "use whatever is chosen for this proxy". If they had
  // already pinned a different model that's still in the new catalogue, keep
  // it; otherwise fall back to the endpoint default (or blank as a backstop).
  const updateEndpoint = (newId) => {
    setForm(f => {
      if (newId === f.llmEndpointId) return f;
      const ep = llmEndpoints.find(e => e.id === newId);
      const stillValid = ep && (ep.models || []).some(m => m.id === f.defaultModelId);
      const epDefault = ep?.defaultModelId
        && (ep.models || []).some(m => m.id === ep.defaultModelId)
        ? ep.defaultModelId : '';
      return {
        ...f,
        llmEndpointId: newId,
        defaultModelId: stillValid ? f.defaultModelId : epDefault,
      };
    });
  };

  const updateRepo = (idx, key, val) => {
    setForm(f => {
      const next = f.repositories.slice();
      next[idx] = { ...next[idx], [key]: val };
      return { ...f, repositories: next };
    });
  };
  const addRepo = () => {
    setForm(f => ({ ...f, repositories: [...f.repositories, { url: '', branch: '', sshKeyId: '' }] }));
  };
  const removeRepo = (idx) => {
    setForm(f => ({ ...f, repositories: f.repositories.filter((_, i) => i !== idx) }));
  };

  const submit = () => {
    onSave({
      id: form.id,
      name: form.name,
      description: form.description,
      additionalContext: form.additionalContext,
      repositories: form.repositories
        .filter(r => r.url.trim())
        .map(r => ({
          url: r.url.trim(),
          branch: r.branch.trim() || null,
          sshKeyId: r.sshKeyId || null,
        })),
      githubTokenId: form.githubTokenId || null,
      llmEndpointId: form.llmEndpointId || null,
      defaultModelId: form.defaultModelId || null,
    });
  };

  const reposValid = form.repositories.every(r => r.url.trim());
  const canSubmit = form.id && form.name && reposValid;

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
        <FormInput
          label="Name *"
          value={form.name}
          onChange={isEdit ? v => update('name', v) : handleNameChange}
          placeholder="COBOL Migration"
        />
        <div style={helpTextStyle}>
          A short, human-readable label shown in the agent list and this overview (e.g. <em>COBOL Migration Project</em>).
        </div>
      </div>

      <IdField
        value={form.id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        disabled={isEdit}
        placeholder="e.g. cobol-migration"
        helpText={isEdit
          ? <>A unique identifier for this environment. <strong>Cannot be changed after creation.</strong></>
          : <>Auto-derived from Name; edit to override. {ID_FORMAT_HINT} <strong>Cannot be changed after creation.</strong></>}
      />

      {isEdit && (
        <div style={{
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          padding: 'var(--eb-space-3)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            <Users size={14} />
            <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
              Agents using this environment
            </span>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              ({(initial?.agents || []).length})
            </span>
          </div>
          {(initial?.agents || []).length === 0 ? (
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
              No agents use this environment.
            </div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
              {initial.agents.map(a => (
                <li
                  key={a.id}
                  style={{
                    fontSize: 'var(--eb-text-xs)',
                    fontFamily: 'var(--eb-font-mono)',
                    color: 'var(--eb-text-secondary)',
                    padding: 'var(--eb-space-1) var(--eb-space-2)',
                    background: 'var(--eb-bg-elevated)',
                    borderRadius: 'var(--eb-radius-sm)',
                  }}
                >
                  {a.displayName && a.displayName !== a.id ? `${a.displayName} (${a.id})` : a.id}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <div style={labelStyle}>Description</div>
        <textarea
          value={form.description}
          onChange={e => update('description', e.target.value)}
          placeholder="Briefly describe what this environment is for — for your own reference."
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
        <div style={helpTextStyle}>
          Optional. Shown only in this console — not passed to the agent.
        </div>
      </div>

      <div style={{ ...helpTextStyle, marginTop: 0 }}>
        Skills are managed on the team (or agent) itself — see the Agents page, the Team-Setup wizard, or the Knowledge page.
        Working Environments carry only infrastructure: repository, credentials, MCP servers, context.
      </div>

      <div style={{
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-3)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <GitBranch size={14} />
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            Git Repositories
          </span>
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            ({form.repositories.length})
          </span>
        </div>

        <div style={helpTextStyle}>
          Repositories listed here are cloned into the agent's workspace when the agent is first created.
          You can add multiple repositories — for example the main codebase and a separate documentation repo.
          For a private SSH URL, select an SSH key on the repository card; for a private HTTPS URL, set the <em>GitHub Token</em> below instead.
        </div>

        {form.repositories.map((repo, idx) => (
          <RepositoryCard
            key={idx}
            idx={idx}
            repo={repo}
            sshKeys={sshKeys}
            githubTokenId={form.githubTokenId || null}
            onChange={(key, val) => updateRepo(idx, key, val)}
            onRemove={() => removeRepo(idx)}
          />
        ))}

        <button
          type="button"
          onClick={addRepo}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px dashed var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-secondary)',
            cursor: 'pointer',
            fontSize: 'var(--eb-text-sm)',
            fontFamily: 'inherit',
          }}
        >
          <Plus size={13} /> Add repository
        </button>

        {isEdit && initial?.id && form.repositories.length > 0 && (initial.agents || []).length > 0 && (
          <div style={{ marginTop: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px dashed var(--eb-border-default)' }}>
            <SyncReposPanel
              endpoint={`/api/environments/${encodeURIComponent(initial.id)}/sync-agents`}
              actionLabel="Sync all agents"
              description={`Clone the repositories above into every agent already using this environment (${(initial.agents || []).length} agent${(initial.agents || []).length === 1 ? '' : 's'}) — repositories are otherwise only cloned when an agent is first created. Already-cloned repositories are left untouched.`}
              showAgentHeaders
            />
          </div>
        )}
      </div>

      <div style={{
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-3)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Github size={14} />
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            GitHub Token
          </span>
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            (optional)
          </span>
        </div>
        <div style={helpTextStyle}>
          A GitHub personal access token that allows agents to interact with the GitHub API — for example to open pull requests, create issues, or push via HTTPS.
          The token is injected into the agent's environment as <code>GH_TOKEN</code> and <code>GITHUB_TOKEN</code>.
          Only needed if agents use the <code>gh</code> CLI or push to GitHub over HTTPS. Manage tokens on the <em>GitHub Tokens</em> page.
        </div>
        <select
          value={form.githubTokenId}
          onChange={e => update('githubTokenId', e.target.value)}
          style={inputStyle}
        >
          <option value="">— no token —</option>
          {ghTokens.map(t => (
            <option key={t.id} value={t.id}>{t.name} ({t.preview})</option>
          ))}
        </select>
      </div>

      <div style={{
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-3)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Cpu size={14} />
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            Model provider
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
          <div style={labelStyle}>Provider</div>
          <select
            value={form.llmEndpointId}
            onChange={e => updateEndpoint(e.target.value)}
            style={inputStyle}
          >
            <option value="">— inherit from .env —</option>
            {llmEndpoints.map(ep => (
              <option key={ep.id} value={ep.id}>
                {ep.name} ({ep.baseUrl})
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
          <div style={labelStyle}>Default model</div>
          <select
            value={form.defaultModelId}
            onChange={e => update('defaultModelId', e.target.value)}
            disabled={!form.llmEndpointId}
            style={{ ...inputStyle, opacity: form.llmEndpointId ? 1 : 0.5 }}
          >
            <option value="">
              {form.llmEndpointId
                ? endpointModels.length ? '— pick a model —' : '— no models in catalog —'
                : '— select a provider first —'}
            </option>
            {endpointModels.map(m => (
              <option key={m.id} value={m.id}>
                {m.displayName || m.id}{m.kind ? ` · ${m.kind}` : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Agents in this environment use this provider and start on the chosen default model. Leave the model blank to inherit the provider's default; without a provider they fall back to <code>ANTHROPIC_BASE_URL</code> from <code>.env</code>. Manage providers and their default model on the Model Providers page.
        </div>
      </div>

      <div>
        <div style={labelStyle}>Additional instructions for agents (CLAUDE.md)</div>
        <div style={helpTextStyle}>
          Optional. The text you enter here is appended to the agent's CLAUDE.md — the instruction file Claude reads at startup.
          Use it to provide project-specific context, coding conventions, domain terminology, or constraints that every agent in this environment should follow.
          You can use Markdown formatting.
        </div>
        <textarea
          value={form.additionalContext}
          onChange={e => update('additionalContext', e.target.value)}
          placeholder={`## Project context\n\nThis environment targets the COBOL migration project.\nAlways write commit messages in English.\nNever modify files in the 10-legacy/ directory.`}
          rows={5}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', marginTop: 'var(--eb-space-2)' }}
        />
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={submit}
          disabled={saving || !canSubmit}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: (saving || !canSubmit) ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create environment')}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
            cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function WorkingEnvironments() {
  const { data: envs, loading, error, refetch } = useApi('/api/environments');
  const [panelMode, setPanelMode] = useState(null);
  const [selected, setSelected] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    {
      key: 'repositories',
      label: 'Repositories',
      sortable: false,
      render: (_, row) => {
        const repos = Array.isArray(row.repositories) && row.repositories.length > 0
          ? row.repositories
          : (row.repository?.url ? [row.repository] : []);
        if (repos.length === 0) return <span style={{ color: 'var(--eb-text-muted)' }}>—</span>;
        if (repos.length === 1) {
          return (
            <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <GitBranch size={12} /> {repos[0].url.split('/').pop().replace(/\.git$/, '')}
            </span>
          );
        }
        return (
          <span
            title={repos.map(r => r.url).join('\n')}
            style={{ fontSize: 'var(--eb-text-xs)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <GitBranch size={12} /> {repos.length} repos
          </span>
        );
      },
    },
    {
      key: 'agentCount',
      label: 'Agents',
      render: (v, row) => {
        const count = Array.isArray(row.agents) ? row.agents.length : (v || 0);
        return (
          <span
            title={count > 0 ? row.agents.map(a => a.displayName || a.id).join('\n') : 'No agents use this environment'}
            style={{ fontSize: 'var(--eb-text-xs)', color: count > 0 ? 'var(--eb-text-secondary)' : 'var(--eb-text-muted)' }}
          >
            {count}
          </span>
        );
      },
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <div className="eb-wrap-md" style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <IconButton icon={Edit} label="Edit" onClick={() => { setSelected(row); setPanelMode('edit'); setFormError(null); }} />
          <IconButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(row)} />
        </div>
      ),
    },
  ];

  async function handleSave(form) {
    setSaving(true); setFormError(null);
    try {
      if (panelMode === 'edit') {
        await apiCall('PUT', `/api/environments/${selected.id}`, form);
      } else {
        await apiCall('POST', '/api/environments', form);
      }
      setPanelMode(null); setSelected(null);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/environments/${deleteTarget.id}`);
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
          Working Environments
        </h1>
        <button
          onClick={() => { setPanelMode('create'); setSelected(null); setFormError(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Plus size={15} /> New Environment
        </button>
      </div>

      <div style={{
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--eb-space-2)',
      }}>
        <p style={{ margin: 0, fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
          What is a Working Environment?
        </p>
        <p style={{ margin: 0 }}>
          A <strong>Working Environment</strong> is a reusable workspace recipe that defines what every agent created from it receives:
        </p>
        <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
          <li><strong>Git repositories</strong> — one or more repos that are automatically cloned into the agent's workspace when it is created. Private repos use SSH keys you manage on the SSH Keys page.</li>
          <li><strong>GitHub token</strong> — optional access token for the <code>gh</code> CLI and HTTPS pushes.</li>
          <li><strong>Additional instructions</strong> — custom text appended to the agent's CLAUDE.md, giving it project-specific context or constraints.</li>
        </ul>
        <p style={{ margin: 0 }}>
          When you create an agent, you pick one Working Environment. All agents sharing the same environment get the same tools and repositories — but each agent has its own isolated workspace.
        </p>
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={envs ?? []}
        emptyText="No Working Environments yet. Click 'New Environment' to create the first one."
      />

      <SidePanel
        open={panelMode === 'create' || panelMode === 'edit'}
        onClose={() => { setPanelMode(null); setSelected(null); }}
        title={panelMode === 'edit' ? `Edit: ${selected?.name || selected?.id}` : 'New Working Environment'}
        width="560px"
      >
        {(panelMode === 'create' || (panelMode === 'edit' && selected)) && (
          <EnvironmentForm
            initial={panelMode === 'edit' ? selected : null}
            isEdit={panelMode === 'edit'}
            onSave={handleSave}
            onCancel={() => { setPanelMode(null); setSelected(null); }}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Working Environment"
        message={`Really delete "${deleteTarget?.name || deleteTarget?.id}"? Agents using this environment must be removed first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

