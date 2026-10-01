import React, { useState, useReducer, useEffect, useRef, useCallback } from 'react';
import { Plus, AlertTriangle, Info, Loader2, Github, Layers } from 'lucide-react';
import { useApi, apiCall } from '../../hooks/useApi';
// One repository card for the whole console (#2067): rendering it here rather
// than a second, differently-worded card is what stops this surface and the
// Working Environments form from drifting apart on the same field.
import RepositoryCard from '../../components/RepositoryCard';
import RepoPropagationDialog from '../../components/RepoPropagationDialog';
import McpServerRows from '../../components/McpServerRows';
import { toolchainOptions, toolchainEmptyState, toolchainChangeWarning } from '../toolchain-select-view.js';
import { mcpChangeNotice, mcpApplySummary } from '../working-env-mcp-view.js';
import { classifyRepositoryChanges, hasRepositoryChanges } from '../working-env-repo-diff.js';
import { describeWorkingEnvSubmitState } from '../working-env-submit-state.js';
import { providerOptionLabel } from '../provider-option-view.js';
import { personalProviderNoticeText } from '../provider-health-view.js';
import { initialTeamEnvForm, teamEnvSubmitBody } from './team-environment-view.js';
import { describeCredentialRef } from '../credential-ref-legibility.js';
import { describeEffectiveCredential } from '../effective-identity-view.js';
import { recheckReducer, initialRecheckState, remainingBusyMs, describeRecheck } from './github-health-recheck.js';

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
    return <ReadOnlyEnvSummary env={env} agent={agent} tab={tab} />;
  }

  return <TeamEnvironmentFields env={env} agent={agent} onSaved={refetch} tab={tab} />;
}

// Read-only view of an environment the caller may see but not manage — one
// field group at a time, matching whichever of the five environment tabs is
// selected (#2236; each tab renders its own explanation rather than one
// combined read-only page).
function ReadOnlyEnvSummary({ env, agent, tab }) {
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
    content = (
      <>
        <EffectiveGithubIdentity agentId={agent?.id} />
        {section('Repositories', repositories.length === 0 ? none : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-0-5)' }}>
        {repositories.map((r, i) => (
          <div key={i} style={rowStyle}>
            <code>{r.url || '(no url)'}</code>
            {r.branch ? <span style={{ color: 'var(--eb-text-muted)' }}> @ {r.branch}</span> : null}
            {r.readOnly ? <span style={{ color: 'var(--eb-text-muted)' }}> · read-only</span> : null}
          </div>
        ))}
      </div>
        ))}
      </>
    );
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

function TeamEnvironmentFields({ env, agent, onSaved, tab }) {
  // The record last confirmed by the server — form gating and change notices
  // compare against this, not the initial prop, so a second save in the same
  // session still detects what actually changed.
  const [baseline, setBaseline] = useState(env);
  const [form, setForm] = useState(() => initialTeamEnvForm(env));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [notice, setNotice] = useState('');
  // #2289: what the save did to the agents' MCP servers (mcpApplySummary), or null.
  const [mcpReport, setMcpReport] = useState(null);
  // #2323: set when a save is blocked for a repo-backed env with no GitHub token;
  // holds the server message and drives the reference-only opt-out prompt.
  const [tokenWarn, setTokenWarn] = useState(null);
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

  // Dropdown-consistency fix (#2360, §7): the team default-provider list is the TEAM-USABLE set (global ∪ own-personal ∪
  // team-service ∪ live member lends), sourced from the team agent's
  // model-options — the SAME endpoint the chat picker uses — so the two compute
  // an identical set by construction (falling back to /api/llm-endpoints until
  // the model-options snapshot arrives). A currently-bound provider that
  // is not in the selectable set is shown read-only ("set — not selectable")
  // rather than blind-cleared (the credential-ref-legibility pattern).
  const { data: modelOptionsData } = useApi(agent?.id ? `/api/agents/${agent.id}/model-options` : null);
  const providerList = Array.isArray(modelOptionsData?.endpoints) ? modelOptionsData.endpoints : llmEndpoints;
  const boundProviderMissing = !!form.llmEndpointId && !providerList.some(e => e.id === form.llmEndpointId);
  // §14 / E10: a non-blocking advisory when the team default is a member's personal
  // provider (a lend). { text, tone } or null; only present for a multi-human squad.
  const personalNotice = personalProviderNoticeText(modelOptionsData?.personalProviderNotice);

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
  const selectedEndpoint = providerList.find(e => e.id === form.llmEndpointId) || null;
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

  async function save(acknowledgeNoToken = false) {
    // #2323: `acknowledgeNoToken` is only ever passed explicitly by the
    // reference-only opt-out below — strict-check it so an `onClick={() => save()}`
    // (event) or any truthy leak can never silently acknowledge.
    const ack = acknowledgeNoToken === true;
    setSaving(true); setSaveError(null); setNotice(''); setMcpReport(null);
    if (!ack) setTokenWarn(null);
    try {
      const body = teamEnvSubmitBody(baseline, form);
      if (ack) body.acknowledgeNoToken = true;
      const saved = await apiCall('PUT', `/api/environments/${encodeURIComponent(baseline.id)}`, body);
      setTokenWarn(null);
      setBaseline(saved);
      setForm(initialTeamEnvForm(saved));
      setNotice('Saved.');
      setMcpReport(mcpApplySummary(saved?.mcpApply));
      const agents = Array.isArray(saved?.agents) ? saved.agents : (Array.isArray(baseline?.agents) ? baseline.agents : []);
      const diff = classifyRepositoryChanges(saved?.previousRepositories, saved?.repositories);
      if (agents.length > 0 && hasRepositoryChanges(diff)) {
        setOffer({ env: saved, diff, catchUp: false });
      }
      if (onSaved) onSaved();
    } catch (e) {
      // #2323: a repo-backed environment with no GitHub token is blocked server-side.
      // Offer the explicit reference-only opt-out instead of a dead-end error.
      if (e.code === 'github_token_required') {
        setTokenWarn(e.serverMessage || e.message);
      } else {
        setSaveError(e.message);
      }
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
      {tokenWarn && (
        <div role="alert" style={{
          color: 'var(--eb-status-warning, var(--eb-status-error))', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-warning-bg, var(--eb-status-error-bg))', borderRadius: 'var(--eb-radius-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <div>{tokenWarn}</div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <button type="button" onClick={() => save(true)} disabled={saving} style={buttonStyle}>
              Save anyway (reference-only)
            </button>
            <button type="button" onClick={() => setTokenWarn(null)} disabled={saving} style={secondaryButtonStyle}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {notice && !saveError && (
        <div style={{ ...helpTextStyle, color: 'var(--eb-status-success)' }}>{notice}</div>
      )}
      {mcpReport && !saveError && (
        <div role={mcpReport.tone === 'warn' ? 'alert' : undefined} style={mcpReport.tone === 'warn' ? warnBoxStyle : helpTextStyle}>
          {mcpReport.tone === 'warn' && (
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
          )}
          <div>{mcpReport.lines.map((line, i) => <div key={i}>{line}</div>)}</div>
        </div>
      )}

      {tab === 'repositories' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <div style={helpTextStyle}>
            Repositories are cloned into a member's workspace when it is first created. Editing
            the list here offers to bring already-materialized members up to date.
          </div>
          {/* #2324: live GitHub-integration health — is the token valid for each
              repo, and is anything listening? Reflects the SAVED state. */}
          <GithubHealthBadge envId={baseline.id} />
          {/* #2560: whose token / key the team's containers actually start with
              — the Team Admin's personal credential overrides the ones below.
              Keyed on the saved record so a save re-resolves it. */}
          <EffectiveGithubIdentity key={baseline.githubTokenId || ''} agentId={agent?.id} />
          {form.repositories.map((repo, idx) => (
            <RepositoryCard
              key={idx}
              idx={idx}
              repo={repo}
              sshKeys={sshKeys}
              githubTokenId={form.githubTokenId || null}
              tokenTarget="environment"
              hasEnvironmentToken={!!form.githubTokenId}
              credentialRefs={baseline.credentialRefs}
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
            {/* #2327 (R2): if the bound token is a personal one the caller can't
                see, the scope-filtered `ghTokens` has no matching option — the plain
                <select> would render EMPTY and a save would clear it (#2326). Show a
                read-only "set, not visible to you" state with a replace-only picker
                (no clear option, only tokens the caller can see) instead. */}
            {(() => {
              const ref = describeCredentialRef({ boundId: form.githubTokenId, visibleOptions: ghTokens });
              // #2325: owner/tier enrichment from the metadata-only descriptor the
              // env GET carries for a referenced-but-invisible credential.
              const desc = baseline.credentialRefs?.[form.githubTokenId] || null;
              if (ref.mode === 'readonly-invisible') {
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
                    <div style={{
                      ...inputStyle, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                      color: 'var(--eb-text-secondary)', background: 'var(--eb-bg-surface)',
                    }}>
                      <span>Set: <code>{ref.boundId}</code></span>
                      {desc && (
                        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                          {desc.tier} · {desc.ownerLabel}
                        </span>
                      )}
                      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginLeft: 'auto' }}>
                        not visible to you
                      </span>
                    </div>
                    <div style={helpTextStyle}>
                      This token was set by another team member and is not visible to you. It stays set — you can
                      replace it with a token you can see, but not clear it.
                    </div>
                    <select
                      value=""
                      onChange={e => { if (e.target.value) update('githubTokenId', e.target.value); }}
                      style={inputStyle}
                    >
                      <option value="">Replace with a token you can see…</option>
                      {ghTokens.map(t => (
                        <option key={t.id} value={t.id}>{t.name} ({t.preview})</option>
                      ))}
                    </select>
                  </div>
                );
              }
              return (
                <select value={form.githubTokenId} onChange={e => update('githubTokenId', e.target.value)} style={inputStyle}>
                  <option value="">— no token —</option>
                  {ghTokens.map(t => (
                    <option key={t.id} value={t.id}>{t.name} ({t.preview})</option>
                  ))}
                </select>
              );
            })()}
          </div>
        </div>
      )}

      {tab === 'provider' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <div>
            <div style={labelStyle}>Provider</div>
            <select value={form.llmEndpointId} onChange={e => updateEndpoint(e.target.value)} style={inputStyle}>
              <option value="">— inherit from .env —</option>
              {/* Keep a currently-bound provider that isn't in the selectable set
                  visible + selected (a teammate's lent personal provider, say)
                  rather than silently clearing it — replace-only (#2360). */}
              {boundProviderMissing && (
                <option value={form.llmEndpointId}>{form.llmEndpointId} (set — not selectable by you)</option>
              )}
              {providerList.map(ep => (
                <option key={ep.id} value={ep.id}>{providerOptionLabel(ep)}</option>
              ))}
            </select>
            {personalNotice && (
              <div style={{
                marginTop: 'var(--eb-space-2)',
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                borderRadius: 'var(--eb-radius-md)',
                background: personalNotice.tone === 'error' ? 'var(--eb-status-error-bg)' : 'var(--eb-status-warning-bg)',
                border: `1px solid ${personalNotice.tone === 'error' ? 'var(--eb-status-error)' : 'var(--eb-status-warning)'}`,
                fontSize: 'var(--eb-text-xs)',
                color: 'var(--eb-text-primary)',
                display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
              }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{personalNotice.text}</span>
              </div>
            )}
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
          {/* Tile/radio-card grid (#2279), replacing a native <select> whose
              concatenated name+description ran on into one unreadable,
              browser-truncated line. Same accessibility contract as
              TeamSetup.jsx's EnvironmentCard (role="radio"/"radiogroup",
              keyboard support, selected-state styling) rather than a fourth,
              differently-behaved selection widget (AC3). */}
          <div
            role="radiogroup"
            aria-label="Agent toolchain"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--eb-space-3)' }}
          >
            {/* The default card carries the same title + description + badge
                shape as a registry row so it doesn't read as an empty/disabled
                option next to the fleshed-out toolchains. Its facts are
                hard-coded (there is no registry entry): baseline versions track
                the FROM line of agent-image/Dockerfile — keep them in sync. */}
            <ToolchainCard
              label="Default agent image — Python + Node"
              hint={`The baseline every environment starts from unless it needs a language build stack. Carries Python and Node plus git, the GitHub CLI and the Claude Code CLI — enough for scripting, web/JS work and any repository that doesn't compile a JVM or other language. No JDK or Maven: pick a toolchain here if an agent has to build one.${toolchainData?.defaultImage ? ` Image: ${toolchainData.defaultImage}.` : ''}`}
              platforms={['podman', 'kubernetes']}
              baseline="python 3.12, node 20"
              selected={!form.toolchainId}
              available
              onSelect={() => update('toolchainId', '')}
            />
            {toolchainRows.map(t => (
              <ToolchainCard
                key={t.id}
                label={t.label}
                hint={t.hint}
                platforms={t.platforms}
                baseline={t.baseline}
                selected={form.toolchainId === t.id}
                available={t.available}
                onSelect={() => update('toolchainId', t.id)}
              />
            ))}
          </div>
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
          <McpServerRows
            rows={form.mcpServers}
            onChange={rows => update('mcpServers', rows)}
            servers={mcpServers}
            credentials={mcpCredentials}
            loading={mcpServersLoading}
          />
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
          onClick={() => save()}
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

// One toolchain tile in the Toolchain tab's radio-card grid (#2279). Mirrors
// EnvironmentCard's (TeamSetup.jsx) accessibility contract exactly — a
// role="radio" card in a role="radiogroup" grid, Space/Enter keyboard
// support, selected-state border — but its own content shape, since a
// toolchain has no repos/id-code the way an environment does. `hint` is
// already the FULL description (or, when unavailable, the full reason) from
// `toolchainOptions` — no truncation, no expand/collapse (AC6).
function ToolchainCard({ label, hint, platforms, baseline, selected, available, onSelect }) {
  return (
    <div
      onClick={available ? onSelect : undefined}
      role="radio"
      aria-checked={selected}
      aria-disabled={!available}
      tabIndex={available ? 0 : -1}
      onKeyDown={available ? (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect(); } } : undefined}
      style={{
        textAlign: 'left',
        background: selected ? 'var(--eb-bg-surface)' : 'var(--eb-bg-app)',
        border: `2px solid ${selected ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-lg)',
        padding: 'var(--eb-space-4)',
        cursor: available ? 'pointer' : 'not-allowed',
        opacity: available ? 1 : 0.55,
        fontFamily: 'inherit',
        color: 'var(--eb-text-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--eb-space-2)',
        transition: 'border-color 0.1s',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)' }}>
        <div style={{
          flexShrink: 0, width: 28, height: 28,
          borderRadius: 'var(--eb-radius-md)',
          background: selected ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
          color: selected ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Layers size={14} />
        </div>
        <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', lineHeight: 1.3 }}>
          {label}
        </div>
      </div>
      {hint && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
      {(platforms?.length > 0 || baseline) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-1)' }}>
          {(platforms || []).map(p => (
            <span key={p} style={toolchainBadgeStyle}>{p}</span>
          ))}
          {baseline && <span style={toolchainBadgeStyle}>{baseline}</span>}
        </div>
      )}
    </div>
  );
}

const toolchainBadgeStyle = {
  fontSize: 'var(--eb-text-xs)',
  padding: '1px 7px',
  borderRadius: 'var(--eb-radius-full)',
  border: '1px solid var(--eb-border-default)',
  color: 'var(--eb-text-secondary)',
};

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

// #2324: a compact live health readout for the environment's GitHub integration.
// Fetches GET /api/environments/:id/github-health (which probes each repo's token
// server-side) and shows the worst-case status plus a line per unhealthy repo —
// so "why aren't events arriving?" is answered in the UI, not the poller log.
// Reflects the SAVED environment; a probe failure never blocks the tab.
function GithubHealthBadge({ envId }) {
  const url = envId ? `/api/environments/${encodeURIComponent(envId)}/github-health` : null;
  const { data: initial, loading, error } = useApi(url);
  // #2712: Recheck runs its own request instead of useApi's refetch (which
  // never shows a busy state once data is loaded and hides the box on error).
  const [recheck, dispatch] = useReducer(recheckReducer, initialRecheckState);
  // Bumped on env change/unmount so a recheck in flight for a previous
  // environment never lands on the one now shown.
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    dispatch({ type: 'reset' });
    return () => { generation.current += 1; busy.current = false; };
  }, [url]);
  useEffect(() => {
    if (initial) dispatch({ type: 'loaded', at: Date.now() });
  }, [initial]);
  const runRecheck = useCallback(async () => {
    if (!url || busy.current) return;
    busy.current = true;
    const gen = generation.current;
    const startedAt = Date.now();
    dispatch({ type: 'start' });
    let result;
    try {
      result = { type: 'success', data: await apiCall('GET', url) };
    } catch {
      result = { type: 'failure' };
    }
    const wait = remainingBusyMs(startedAt, Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (gen !== generation.current) return;
    busy.current = false;
    dispatch({ ...result, at: Date.now() });
  }, [url]);
  const data = recheck.data || initial;
  const view = describeRecheck(recheck);
  if (!envId || (error && !data)) return null;
  if (loading && !data) {
    return (
      <div style={{ ...helpTextStyle, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Checking GitHub integration…
      </div>
    );
  }
  const repos = Array.isArray(data?.repos) ? data.repos : [];
  if (repos.length === 0) return null; // repo-less (LLM-only) env: nothing to report
  const roll = data?.rollUp || {};
  const tone = roll.ok ? 'var(--eb-status-success)' : 'var(--eb-status-warning, var(--eb-status-error))';
  const bg = roll.ok
    ? 'var(--eb-status-success-bg, var(--eb-bg-elevated))'
    : 'var(--eb-status-warning-bg, var(--eb-status-error-bg))';
  const unhealthy = repos.filter((r) => !r.ok);
  return (
    <div role="status" style={{
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
      background: bg, fontSize: 'var(--eb-text-sm)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: tone, fontWeight: 'var(--eb-font-medium)' }}>
        <Github size={13} />
        <span>GitHub integration: {roll.ok ? 'OK' : (roll.label || 'Problem')}</span>
        <button
          type="button"
          onClick={runRecheck}
          disabled={view.disabled}
          aria-busy={view.disabled}
          style={{
            marginLeft: 'auto', padding: 'var(--eb-space-0-5) var(--eb-space-2)',
            display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
            background: 'transparent', color: 'var(--eb-text-secondary)',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
            fontSize: 'var(--eb-text-xs)', cursor: view.disabled ? 'wait' : 'pointer', fontFamily: 'inherit',
          }}
        >
          {view.disabled && <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />}
          {view.buttonLabel}
        </button>
      </div>
      {unhealthy.map((r, i) => (
        <div key={i} style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)' }}>
          <code>{r.fullName || r.url}</code>: {r.label}{r.detail ? ` — ${r.detail}` : ''}
        </div>
      ))}
      {view.note && (
        <div style={{
          fontSize: 'var(--eb-text-xs)',
          color: view.note.tone === 'error' ? 'var(--eb-status-error)' : 'var(--eb-text-muted)',
        }}>
          {view.note.text}
        </div>
      )}
    </div>
  );
}

// #2560: the EFFECTIVE baseline GitHub token / SSH key of this team — the tier
// the orchestrator's spawn-time resolver actually picks (GET
// /api/agents/:id/effective-credentials), so a Team Admin's personal credential
// that overrides the team's own is visible instead of silent. The server has
// already redacted another person's personal credential to name + kind.
function EffectiveGithubIdentity({ agentId }) {
  const { data, error } = useApi(
    agentId ? `/api/agents/${encodeURIComponent(agentId)}/effective-credentials` : null,
  );
  if (!agentId || error || !data) return null;
  const rows = [data.github, data.ssh].filter(Boolean).map((v) => ({ v, d: describeEffectiveCredential(v) }));
  if (rows.length === 0) return null;
  return (
    <div role="status" aria-label="Effective GitHub identity" style={{
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
      background: 'var(--eb-bg-elevated)', fontSize: 'var(--eb-text-sm)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontWeight: 'var(--eb-font-medium)' }}>
        <Info size={13} />
        <span>Effective GitHub identity</span>
      </div>
      {rows.map(({ v, d }) => (
        <div key={v.kind} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-0-5)' }}>
          <div>
            <span style={{ color: 'var(--eb-text-muted)' }}>{v.kindLabel}: </span>
            <span style={{ color: d.tone === 'warning' ? 'var(--eb-status-warning, var(--eb-status-error))' : 'var(--eb-text-primary)' }}>
              {d.headline}
            </span>
          </div>
          <div style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)' }}>{d.detail}</div>
          {d.teamNote && (
            <div style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)' }}>{d.teamNote}</div>
          )}
          {d.problem && (
            <div style={warnBoxStyle}>
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
              <span>{d.problem}</span>
            </div>
          )}
        </div>
      ))}
      <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>
        Used for automatic runs and the agents' own <code>gh</code>/<code>git</code> calls; a change takes effect at the
        agents' next start. An interactive push or pull request uses the chatting person's own personal credential.
      </div>
    </div>
  );
}

// #2323: the reference-only opt-out prompt's two buttons.
const buttonStyle = {
  padding: 'var(--eb-space-1) var(--eb-space-3)',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer', fontFamily: 'inherit',
};
const secondaryButtonStyle = {
  padding: 'var(--eb-space-1) var(--eb-space-3)',
  background: 'transparent', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit',
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
