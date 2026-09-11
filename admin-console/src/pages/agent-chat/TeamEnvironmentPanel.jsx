import React, { useState } from 'react';
import { Plus, X, AlertTriangle, Info, Loader2 } from 'lucide-react';
import { useApi, apiCall } from '../../hooks/useApi';
// One repository card for the whole console (#2067): rendering it here rather
// than a second, differently-worded card is what stops this surface and the
// Working Environments form from drifting apart on the same field.
import RepositoryCard from '../../components/RepositoryCard';
import RepoPropagationDialog from '../../components/RepoPropagationDialog';
import IconButton from '../../components/IconButton';
import { toolchainOptions, toolchainEmptyState, toolchainChangeWarning } from '../toolchain-select-view.js';
import { mcpRowHint, mcpChangeNotice, mcpServerLabel } from '../working-env-mcp-view.js';
import { classifyRepositoryChanges, hasRepositoryChanges } from '../working-env-repo-diff.js';
import { describeWorkingEnvSubmitState } from '../working-env-submit-state.js';
import { TEAM_ENV_TABS, initialTeamEnvForm, teamEnvSubmitBody } from './team-environment-view.js';

/**
 * Team Settings — Environment tabs (#2167).
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
 * Deliberately NOT rendered here: the ownership/team picker. The environment
 * already belongs to this team — editing its content is not a re-tier.
 */
export default function TeamEnvironmentPanel({ agent }) {
  const envId = agent?.environmentId || null;
  const { data: env, loading, error, refetch } = useApi(
    envId ? `/api/environments/${encodeURIComponent(envId)}` : null,
  );

  if (!envId) {
    return (
      <div style={helpTextStyle}>
        This team has no Working Environment bound yet — repositories, model provider,
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

  return <TeamEnvironmentFields env={env} onSaved={refetch} />;
}

function TeamEnvironmentFields({ env, onSaved }) {
  // The record last confirmed by the server — form gating and change notices
  // compare against this, not the initial prop, so a second save in the same
  // session still detects what actually changed.
  const [baseline, setBaseline] = useState(env);
  const [tab, setTab] = useState(TEAM_ENV_TABS[0].id);
  const [form, setForm] = useState(() => initialTeamEnvForm(env));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [notice, setNotice] = useState('');
  // The save-time propagation offer (#2066), same shape as the Working
  // Environments page's own.
  const [offer, setOffer] = useState(null);

  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const { data: sshKeysData } = useApi('/api/ssh-keys');
  const { data: endpointsData } = useApi('/api/llm-endpoints');
  const { data: toolchainData } = useApi('/api/toolchains');
  const { data: mcpServerData, loading: mcpServersLoading } = useApi('/api/mcp-servers');
  const { data: mcpCredentialData } = useApi('/api/mcp-credentials');

  const sshKeys = sshKeysData || [];
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
      <div style={{
        display: 'flex', gap: 'var(--eb-space-1)', flexWrap: 'wrap',
        borderBottom: '1px solid var(--eb-border-default)', paddingBottom: 'var(--eb-space-2)',
      }}>
        {TEAM_ENV_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              padding: 'var(--eb-space-1-5) var(--eb-space-3)',
              background: tab === t.id ? 'var(--eb-accent-muted)' : 'transparent',
              color: tab === t.id ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
              border: 'none', borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)',
              fontWeight: tab === t.id ? 'var(--eb-font-medium)' : 'var(--eb-font-normal)',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

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
            the list here offers to bring already-materialized members up to date, the same way
            the Working Environments form does.
          </div>
          {form.repositories.map((repo, idx) => (
            <RepositoryCard
              key={idx}
              idx={idx}
              repo={repo}
              sshKeys={sshKeys}
              githubTokenId={baseline?.githubTokenId || null}
              tokenTarget="environment"
              hasEnvironmentToken={!!baseline?.githubTokenId}
              onChange={(key, val) => updateRepo(idx, key, val)}
              onRemove={() => removeRepo(idx)}
            />
          ))}
          <button type="button" onClick={addRepo} style={dashedButtonStyle}>
            <Plus size={13} /> Add repository
          </button>
        </div>
      )}

      {tab === 'provider' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <div>
            <div style={labelStyle}>Provider</div>
            <select value={form.llmEndpointId} onChange={e => updateEndpoint(e.target.value)} style={inputStyle}>
              <option value="">— inherit from .env —</option>
              {llmEndpoints.map(ep => (
                <option key={ep.id} value={ep.id}>{ep.name} ({ep.baseUrl})</option>
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
          {form.mcpServers.map((row, idx) => {
            const hint = mcpRowHint(row, mcpServers);
            const unknownServer = row.serverId && !mcpServers.some(s => s.id === row.serverId);
            return (
              <div key={idx} style={mcpRowStyle}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
                  <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
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
                  </div>
                  {hint && (
                    <div style={{
                      display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
                      fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
                    }}>
                      <AlertTriangle
                        size={13}
                        style={{ flexShrink: 0, marginTop: 1, color: hint.tone === 'warn' ? 'var(--eb-status-warning)' : 'var(--eb-text-muted)' }}
                      />
                      <span>{hint.message}</span>
                    </div>
                  )}
                </div>
                <div style={{ flexShrink: 0, paddingTop: 18 }}>
                  <IconButton icon={X} label="Remove MCP server" danger onClick={() => removeMcp(idx)} size={12} />
                </div>
              </div>
            );
          })}
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

const mcpRowStyle = {
  display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
};

const warnBoxStyle = {
  display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
  padding: 'var(--eb-space-2)',
  background: 'var(--eb-status-warning-bg)',
  borderRadius: 'var(--eb-radius-md)',
};
