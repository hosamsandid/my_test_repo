import React, { useState } from 'react';
import { Plus, X, AlertTriangle, Info, Loader2, Github } from 'lucide-react';
import { useApi, apiCall } from '../../hooks/useApi';
// One repository card for the whole console (#2067): rendering it here rather
// than a second, differently-worded card is what stops this surface and the
// Working Environments form from drifting apart on the same field.
import RepositoryCard from '../../components/RepositoryCard';
import RepoPropagationDialog from '../../components/RepoPropagationDialog';
import IconButton from '../../components/IconButton';
import OptionList from '../../components/OptionList';
import OptionRow from '../../components/OptionRow';
import { toolchainOptions, toolchainEmptyState, toolchainChangeWarning } from '../toolchain-select-view.js';
import { mcpRowHint, mcpChangeNotice, mcpServerLabel } from '../working-env-mcp-view.js';
import { classifyRepositoryChanges, hasRepositoryChanges } from '../working-env-repo-diff.js';
import { describeWorkingEnvSubmitState } from '../working-env-submit-state.js';
import { providerOptionLabel } from '../provider-option-view.js';
import { initialTeamEnvForm, teamEnvSubmitBody } from './team-environment-view.js';

/**
 * Team Settings — the five environment tabs of the flat configuration row
 * (#2167, re-hosted as top-level tabs by #2236).
 *
 * A `role: 'team'` agent has no configuration of its own beyond its bound
 * Working Environment (`cfg.environmentId` → `loadEnvironment`) — until now
 * reachable only from the separate Working Environments page. This panel
 * edits that SAME environment record in place, through the SAME
 * `PUT /api/environments/:id` that page's own form uses (no data-model
 * change): repositories render the console's one shared `RepositoryCard`
 * (#2067), and the MCP/toolchain/submit-gate decisions reuse the exact pure
 * modules that form does, so the two surfaces cannot silently disagree about
 * what a change here does — repo changes still get the #2066 save-time
 * propagation offer, and a provider/toolchain change still respawns the
 * team's running agents.
 *
 * `tab` selects which single environment field-group to render — the
 * top-level tab strip lives one level up now (`AgentEditForm`'s flat row,
 * #2236); this component owns no tab strip of its own any more.
 *
 * Deliberately NOT rendered here: the ownership/team picker. The environment
 * already belongs to this team — editing its content is not a re-tier.
 */
export default function TeamEnvironmentPanel({ agent, tab }) {
  const envId = agent?.environmentId || null;
  const { data: env, loading, error, refetch } = useApi(
    envId ? `/api/environments/${encodeURIComponent(envId)}` : null,
  );

  if (!envId) {
    return (
      <div style={helpTextStyle}>
        This team has no Environment bound yet — repositories, model provider,
        toolchain, MCP servers and additional context have nothing to attach to.
      </div>
    );
  }
  if (loading && !env) {
    return (
      <div style={{ ...helpTextStyle, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Loading environment…
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
        {error}
      </div>
    );
  }
  if (!env) return null;

  // A shared environment the caller can see (it backs one of their agents) but
  // does not administer is read-only here: editing it would change
  // infrastructure other teams depend on, and `PUT /api/environments/:id` would
  // 403 anyway (`canManageEnvironment`). This is the common shape after #2052 —
  // a single agent on a reused shared environment, converted into a team of one.
  if (env.canManage === false) {
    return <ReadOnlyEnvSummary env={env} tab={tab} />;
  }

  return <TeamEnvironmentFields env={env} onSaved={refetch} tab={tab} />;
}

// Read-only view of an environment the caller may see but not manage — one
// field group at a time, matching whichever of the five environment tabs is
// selected (#2236; each tab renders its own explanation rather than one
// combined read-only page).
function ReadOnlyEnvSummary({ env, tab }) {
  const repositories = Array.isArray(env.repositories) ? env.repositories : [];
  const mcpServers = Array.isArray(env.mcpServers) ? env.mcpServers : [];
  const rowStyle = {
    fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
    padding: 'var(--eb-space-1) 0',
  };
  const section = (label, children) => (
    <div>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  );
  const none = <div style={{ ...rowStyle, color: 'var(--eb-text-muted)' }}>—</div>;

  const banner = (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
      fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-md)',
    }}>
      <Info size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
      <span>
        This team runs on a shared environment managed by another team.
        You can view it here but not edit it — ask a System Admin or the owning
        team's admin to change its repositories, credentials or model provider.
      </span>
    </div>
  );

  let content = null;
  if (tab === 'repositories') {
    content = section('Repositories', repositories.length === 0 ? none : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-0-5)' }}>
        {repositories.map((r, i) => (
          <div key={i} style={rowStyle}>
            <code>{r.url || '(no url)'}</code>
            {r.branch ? <span style={{ color: 'var(--eb-text-muted)' }}> @ {r.branch}</span> : null}
            {r.readOnly ? <span style={{ color: 'var(--eb-text-muted)' }}> · read-only</span> : null}
          </div>
        ))}
      </div>
    ));
  } else if (tab === 'provider') {
    content = section('Model provider', (
      <div style={rowStyle}>
        {env.llmEndpointId
          ? <>{env.llmEndpointId}{env.defaultModelId ? <span style={{ color: 'var(--eb-text-muted)' }}> · {env.defaultModelId}</span> : null}</>
          : <span style={{ color: 'var(--eb-text-muted)' }}>Built-in default</span>}
      </div>
    ));
  } else if (tab === 'toolchain') {
    content = section('Toolchain', (
      <div style={rowStyle}>
        {env.toolchainId || <span style={{ color: 'var(--eb-text-muted)' }}>Default image</span>}
      </div>
    ));
  } else if (tab === 'mcp') {
    content = section('MCP servers', mcpServers.length === 0 ? none : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-0-5)' }}>
        {mcpServers.map((m, i) => (
          <div key={i} style={rowStyle}><code>{m.serverId}</code></div>
        ))}
      </div>
    ));
  } else if (tab === 'context') {
    content = section('Additional context', (
      <div style={{ ...rowStyle, whiteSpace: 'pre-wrap', color: 'var(--eb-text-secondary)' }}>
        {env.additionalContext || <span style={{ color: 'var(--eb-text-muted)' }}>—</span>}
      </div>
    ));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      {banner}
      {content}
    </div>
  );
}

function TeamEnvironmentFields({ env, onSaved, tab }) {
  // The record last confirmed by the server — form gating and change notices
  // compare against this, not the initial prop, so a second save in the same
  // session still detects what actually changed.
  const [baseline, setBaseline] = useState(env);
  const [form, setForm] = useState(() => initialTeamEnvForm(env));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [notice, setNotice] = useState('');
  // The save-time propagation offer (#2066), same shape as the Working
  // Environments page's own.
  const [offer, setOffer] = useState(null);

  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const { data: sshKeysData } = useApi('/api/ssh-keys');
  const { data: tokensData } = useApi('/api/github-tokens');
  const { data: endpointsData } = useApi('/api/llm-endpoints');
  const { data: toolchainData } = useApi('/api/toolchains');
  const { data: mcpServerData, loading: mcpServersLoading } = useApi('/api/mcp-servers');
  const { data: mcpCredentialData } = useApi('/api/mcp-credentials');

  const sshKeys = sshKeysData || [];
  const ghTokens = tokensData || [];
  const llmEndpoints = endpointsData || [];
  const mcpServers = mcpServerData || [];
  const mcpCredentials = mcpCredentialData || [];

  const toolchainRows = toolchainOptions(toolchainData?.toolchains, toolchainData?.runtime);
  const toolchainNotice = toolchainEmptyState(toolchainData?.toolchains, {
    canManage: !!toolchainData?.canManage,
    defaultImage: toolchainData?.defaultImage,
  });
  const toolchainWarning = toolchainChangeWarning({
    isEdit: true,
    initialToolchainId: baseline?.toolchainId || null,
    toolchainId: form.toolchainId || null,
    agentCount: baseline?.agentCount || 0,
  });
  const selectedEndpoint = llmEndpoints.find(e => e.id === form.llmEndpointId) || null;
  const endpointModels = selectedEndpoint?.models || [];

  const mcpNotice = mcpChangeNotice({
    isEdit: true,
    initial: baseline,
    rows: form.mcpServers,
    agentCount: baseline?.agentCount || 0,
  });

  const updateRepo = (idx, key, val) => {
    setForm(f => {
      const next = f.repositories.slice();
      next[idx] = { ...next[idx], [key]: val };
      return { ...f, repositories: next };
    });
  };
  const addRepo = () => {
    setForm(f => ({ ...f, repositories: [...f.repositories, { url: '', branch: '', sshKeyId: '', readOnly: false }] }));
  };
  const removeRepo = (idx) => {
    setForm(f => ({ ...f, repositories: f.repositories.filter((_, i) => i !== idx) }));
  };

  const updateMcp = (idx, key, val) => {
    setForm(f => {
      const next = f.mcpServers.slice();
      next[idx] = key === 'serverId'
        ? { serverId: val, credentialId: '' }
        : { ...next[idx], [key]: val };
      return { ...f, mcpServers: next };
    });
  };
  const addMcp = () => {
    setForm(f => ({ ...f, mcpServers: [...f.mcpServers, { serverId: '', credentialId: '' }] }));
  };
  const removeMcp = (idx) => {
    setForm(f => ({ ...f, mcpServers: f.mcpServers.filter((_, i) => i !== idx) }));
  };

  const updateEndpoint = (newId) => {
    setForm(f => {
      if (newId === f.llmEndpointId) return f;
      const ep = llmEndpoints.find(e => e.id === newId);
      const stillValid = ep && (ep.models || []).some(m => m.id === f.defaultModelId);
      const epDefault = ep?.defaultModelId && (ep.models || []).some(m => m.id === ep.defaultModelId)
        ? ep.defaultModelId : '';
      return { ...f, llmEndpointId: newId, defaultModelId: stillValid ? f.defaultModelId : epDefault };
    });
  };

  const { canSubmit, reasons: submitBlockers } = describeWorkingEnvSubmitState({
    name: baseline?.name,
    id: baseline?.id,
    repositories: form.repositories,
    mcpServers: form.mcpServers,
  });

  async function save() {
    setSaving(true); setSaveError(null); setNotice('');
    try {
      const body = teamEnvSubmitBody(baseline, form);
      const saved = await apiCall('PUT', `/api/environments/${encodeURIComponent(baseline.id)}`, body);
      setBaseline(saved);
      setForm(initialTeamEnvForm(saved));
      setNotice('Saved.');
      const agents = Array.isArray(saved?.agents) ? saved.agents : (Array.isArray(baseline?.agents) ? baseline.agents : []);
      const diff = classifyRepositoryChanges(saved?.previousRepositories, saved?.repositories);
      if (agents.length > 0 && hasRepositoryChanges(diff)) {
        setOffer({ env: saved, diff, catchUp: false });
      }
      if (onSaved) onSaved();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      {saveError && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>
          {saveError}
        </div>
      )}
      {notice && !saveError && (
        <div style={{ ...helpTextStyle, color: 'var(--eb-status-success)' }}>{notice}</div>
      )}

      {tab === 'repositories' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <div style={helpTextStyle}>
            Repositories are cloned into a member's workspace when it is first created. Editing
            the list here offers to bring already-materialized members up to date.
          </div>
          {form.repositories.map((repo, idx) => (
            <RepositoryCard
              key={idx}
              idx={idx}
              repo={repo}
              sshKeys={sshKeys}
              githubTokenId={form.githubTokenId || null}
              tokenTarget="environment"
              hasEnvironmentToken={!!form.githubTokenId}
              onChange={(key, val) => updateRepo(idx, key, val)}
              onRemove={() => removeRepo(idx)}
            />
          ))}
          <button type="button" onClick={addRepo} style={dashedButtonStyle}>
            <Plus size={13} /> Add repository
          </button>

          {/* GitHub Token (#2170): the only surface this could be set from —
              the standalone Working Environments page — was retired, so this
              joined the Repositories tab rather than being left unreachable. */}
          <div style={{
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-3)',
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <Github size={14} />
              <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>GitHub Token</span>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>(optional)</span>
            </div>
            <div style={helpTextStyle}>
              Injected into agents as <code>GH_TOKEN</code> / <code>GITHUB_TOKEN</code>. Needed for the <code>gh</code>{' '}
              CLI, HTTPS pushes and the GitHub poller. Only needed for a private HTTPS URL above — a private SSH
              URL uses the repository's own SSH key instead. Manage tokens on the <em>GitHub Tokens</em> page.
            </div>
            <select value={form.githubTokenId} onChange={e => update('githubTokenId', e.target.value)} style={inputStyle}>
              <option value="">— no token —</option>
              {ghTokens.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({t.preview})</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {tab === 'provider' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <div>
            <div style={labelStyle}>Provider</div>
            <select value={form.llmEndpointId} onChange={e => updateEndpoint(e.target.value)} style={inputStyle}>
              <option value="">— inherit from .env —</option>
              {llmEndpoints.map(ep => (
                <option key={ep.id} value={ep.id}>{providerOptionLabel(ep)}</option>
              ))}
            </select>
          </div>
          <div>
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
                <option key={m.id} value={m.id}>{m.displayName || m.id}{m.kind ? ` · ${m.kind}` : ''}</option>
              ))}
            </select>
          </div>
          <div style={helpTextStyle}>
            The team's members use this provider and start on the chosen default model. Saving a
            change here restarts the team's running agents — a container's credentials are fixed
            for its lifetime.
          </div>
        </div>
      )}

      {tab === 'toolchain' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <select
            value={form.toolchainId}
            onChange={e => update('toolchainId', e.target.value)}
            disabled={toolchainRows.length === 0}
            style={{ ...inputStyle, opacity: toolchainRows.length ? 1 : 0.5 }}
          >
            <option value="">
              — default agent image{toolchainData?.defaultImage ? ` (${toolchainData.defaultImage})` : ''} —
            </option>
            {toolchainRows.map(t => (
              <option key={t.id} value={t.id} disabled={!t.available}>{t.label}{t.hint ? ` — ${t.hint}` : ''}</option>
            ))}
          </select>
          {toolchainNotice && <div style={helpTextStyle}>{toolchainNotice}</div>}
          {toolchainWarning && (
            <div role="alert" style={warnBoxStyle}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
              <span>{toolchainWarning}</span>
            </div>
          )}
        </div>
      )}

      {tab === 'mcp' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {form.mcpServers.length > 0 && (
            <OptionList>
              {form.mcpServers.map((row, idx) => {
                const hint = mcpRowHint(row, mcpServers);
                const unknownServer = row.serverId && !mcpServers.some(s => s.id === row.serverId);
                return (
                  <OptionRow
                    key={idx}
                    expandedContent={hint ? <div>{hint.message}</div> : null}
                    header={
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)' }}>
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
                          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                            <div style={labelStyle}>Server</div>
                            <select value={row.serverId} onChange={e => updateMcp(idx, 'serverId', e.target.value)} style={inputStyle}>
                              <option value="">— choose a server —</option>
                              {mcpServers.map(s => <option key={s.id} value={s.id}>{mcpServerLabel(s.id, mcpServers)}</option>)}
                              {unknownServer && <option value={row.serverId}>{mcpServerLabel(row.serverId, mcpServers)}</option>}
                            </select>
                          </div>
                          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                            <div style={labelStyle}>Credential</div>
                            <select
                              value={row.credentialId}
                              onChange={e => updateMcp(idx, 'credentialId', e.target.value)}
                              disabled={!row.serverId}
                              style={{ ...inputStyle, opacity: row.serverId ? 1 : 0.5 }}
                            >
                              <option value="">— no credential —</option>
                              {mcpCredentials.map(c => (
                                <option key={c.id} value={c.id}>
                                  {c.name}{c.serverId === row.serverId ? ' (default for this server)' : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                          {hint && (
                            <AlertTriangle
                              size={13}
                              title={hint.message}
                              style={{ flexShrink: 0, marginTop: 20, color: hint.tone === 'warn' ? 'var(--eb-status-warning)' : 'var(--eb-text-muted)' }}
                            />
                          )}
                        </div>
                        <div style={{ flexShrink: 0, paddingTop: 18 }}>
                          <IconButton icon={X} label="Remove MCP server" danger onClick={() => removeMcp(idx)} size={12} />
                        </div>
                      </div>
                    }
                  />
                );
              })}
            </OptionList>
          )}
          {mcpServersLoading ? null : mcpServers.length === 0 ? (
            <div style={helpTextStyle}>No MCP servers are registered yet.</div>
          ) : (
            <button type="button" onClick={addMcp} style={dashedButtonStyle}>
              <Plus size={13} /> Add MCP server
            </button>
          )}
          {mcpNotice && (
            <div role="alert" style={warnBoxStyle}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
              <span>{mcpNotice}</span>
            </div>
          )}
        </div>
      )}

      {tab === 'context' && (
        <div>
          <div style={labelStyle}>Additional instructions for agents (CLAUDE.md)</div>
          <div style={helpTextStyle}>
            Appended to every member's CLAUDE.md — project context, coding conventions, domain
            terminology, or constraints the whole team should follow.
          </div>
          <textarea
            value={form.additionalContext}
            onChange={e => update('additionalContext', e.target.value)}
            rows={8}
            style={{
              ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)', marginTop: 'var(--eb-space-2)',
            }}
          />
        </div>
      )}

      {!saving && submitBlockers.length > 0 && (
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          <Info size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
          <span>
            Save is disabled until you:
            <ul style={{ margin: 'var(--eb-space-1) 0 0', paddingLeft: 'var(--eb-space-4)' }}>
              {submitBlockers.map(r => <li key={r.field}>{r.message}</li>)}
            </ul>
          </span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={save}
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
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <RepoPropagationDialog
        open={!!offer}
        envId={offer?.env?.id}
        envName={offer?.env?.name}
        diff={offer?.diff || null}
        agents={offer?.env?.agents || []}
        catchUp={!!offer?.catchUp}
        onClose={() => setOffer(null)}
        onFinished={() => {}}
      />
    </div>
  );
}

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

const dashedButtonStyle = {
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
};

const warnBoxStyle = {
  display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
  padding: 'var(--eb-space-2)',
  background: 'var(--eb-status-warning-bg)',
  borderRadius: 'var(--eb-radius-md)',
};
