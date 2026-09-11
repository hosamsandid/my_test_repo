import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router';
import { Edit, Trash2, Plus, GitBranch, Key, Github, X, AlertTriangle, Cpu, Users, Info, Package, Server } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import RepoPropagationDialog from '../components/RepoPropagationDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
// One repository card for the whole console (#2067): the agent-scoped attach
// form renders this very component, so the two cannot drift in fields or copy.
import RepositoryCard from '../components/RepositoryCard';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import { useAuth } from '../auth/AuthContext';
import CredentialOwnership from '../components/CredentialOwnership';
import { ownershipFromRecord, ownershipPayload, adminTeamIdsOf, canReassignCredentialClient, isGlobalRecord } from './credential-scope-view.js';
import { describeWorkingEnvSubmitState } from './working-env-submit-state.js';
import { toolchainOptions, toolchainEmptyState, toolchainChangeWarning, availableToolchains, versionSourceLine } from './toolchain-select-view.js';
import { initialMcpRows, mcpSubmitValue, mcpRowHint, mcpChangeNotice, mcpServerLabel } from './working-env-mcp-view.js';
import { ENVIRONMENTS_HELP_SECTIONS } from './environments-help-sections.js';
import { classifyRepositoryChanges, hasRepositoryChanges, outOfDateIndicator } from './working-env-repo-diff.js';
import { usePageActions } from '../context/PageActionsContext';
import { useHelpSubject } from '../context/HelperChatContext';
import { OVERLAY_ENVIRONMENT_FORM, OVERLAY_TOOLCHAINS } from '../context/page-help-view.js';

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

function initialRepositories(initial) {
  if (Array.isArray(initial?.repositories) && initial.repositories.length > 0) {
    return initial.repositories.map(r => ({
      url: r.url || '',
      branch: r.branch || '',
      sshKeyId: r.sshKeyId || '',
      readOnly: r.readOnly === true,
    }));
  }
  if (initial?.repository?.url) {
    return [{
      url: initial.repository.url,
      branch: initial.repository.branch || '',
      sshKeyId: initial.repository.sshKeyId || '',
      readOnly: initial.repository.readOnly === true,
    }];
  }
  return [];
}

function EnvironmentForm({ initial, onSave, onCancel, saving, error, isEdit }) {
  // Rendered only while the side panel is slid out, so the subject needs no
  // `active` flag. Registering it is what lifts the help panel above this
  // SidePanel (z-index 60/61) — without it the three "?" below would open help
  // *behind* the form they explain (#1987, same reason as the MCP/Skills panels).
  useHelpSubject({ overlay: OVERLAY_ENVIRONMENT_FORM });

  const [form, setForm] = useState(() => ({
    id: initial?.id || '',
    name: initial?.name || '',
    description: initial?.description || '',
    additionalContext: initial?.additionalContext || '',
    repositories: initialRepositories(initial),
    mcpServers: initialMcpRows(initial),
    githubTokenId: initial?.githubTokenId || '',
    llmEndpointId: initial?.llmEndpointId || '',
    defaultModelId: initial?.defaultModelId || '',
    toolchainId: initial?.toolchainId || '',
  }));

  // #2083: the ownership control. Fetched here rather than threaded from the
  // page, matching every other list this form loads for itself.
  const { data: teamsData } = useApi('/api/admin/teams');
  const { user } = useAuth();
  const isSysAdmin = !!user?.admin;
  const adminTeamIds = adminTeamIdsOf(user);
  const teams = Array.isArray(teamsData) ? teamsData : [];
  // Seeded from the record on an edit, so a shared environment opens as shared
  // and an ordinary save cannot silently un-share it; from the role defaults on
  // a create. Only a System Admin may re-tier (canRetierEnvironment server-side),
  // so for anyone else the control is read-only rather than a button that 403s —
  // the `settingsSubject` convention (concept §6, implementation note 2).
  const [ownership, setOwnership] = useState(
    () => ownershipFromRecord(initial, { isSysAdmin, adminTeamIds }),
  );
  const ownershipLocked = isEdit && !canReassignCredentialClient({ isSysAdmin });

  // Global environment (#2158): a System-Admin-only flag mirroring the
  // Model-Providers "Global provider" toggle (#2136) — reachable by every
  // user and agent with no team assignment. A global environment is
  // system-scoped with no teams, so the team-assignment control is hidden
  // while it is on; the server forces that shape regardless either way.
  const [isGlobal, setIsGlobal] = useState(isGlobalRecord(initial));

  const { data: keysData } = useApi('/api/ssh-keys');
  const { data: tokensData } = useApi('/api/github-tokens');
  const { data: endpointsData } = useApi('/api/llm-endpoints');
  const { data: toolchainData } = useApi('/api/toolchains');
  // #2051. Both lists are team-scoped server-side, so the picker offers exactly
  // what this admin may pair. A credential's own `serverId` is a HINT, not a
  // pairing (McpServers.jsx says so) — so the credential select is never
  // filtered by it, only sorted so the hinted one comes first.
  const { data: mcpServerData, loading: mcpServersLoading } = useApi('/api/mcp-servers');
  const { data: mcpCredentialData } = useApi('/api/mcp-credentials');

  const sshKeys = keysData || [];
  const ghTokens = tokensData || [];
  const llmEndpoints = endpointsData || [];
  const mcpServers = mcpServerData || [];
  const mcpCredentials = mcpCredentialData || [];
  // Agent toolchain (#1940). The registry is read-only here: registering an
  // image reference is a System-Admin action on the Toolchains list, and the
  // server refuses it from this form regardless of what the UI shows.
  const toolchainRows = toolchainOptions(toolchainData?.toolchains, toolchainData?.runtime);
  const toolchainNotice = toolchainEmptyState(toolchainData?.toolchains, {
    canManage: !!toolchainData?.canManage,
    defaultImage: toolchainData?.defaultImage,
  });
  const toolchainWarning = toolchainChangeWarning({
    isEdit,
    initialToolchainId: initial?.toolchainId || null,
    toolchainId: form.toolchainId || null,
    agentCount: initial?.agentCount || 0,
  });
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
    setForm(f => ({ ...f, repositories: [...f.repositories, { url: '', branch: '', sshKeyId: '', readOnly: false }] }));
  };
  const removeRepo = (idx) => {
    setForm(f => ({ ...f, repositories: f.repositories.filter((_, i) => i !== idx) }));
  };

  // Same three helpers for the MCP rows (#2051). Changing the server clears the
  // credential: a credential is chosen *for* a server, and silently carrying one
  // over is how a pair that reads fine ends up ignored at seed time.
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

  const mcpNotice = mcpChangeNotice({
    isEdit,
    initial,
    rows: form.mcpServers,
    agentCount: initial?.agentCount || 0,
  });

  const submit = () => {
    // Omitted entirely when the pairing was not touched, so an unrelated save
    // still leaves `mcpServers` byte-identical on disk (#2051 AC2) — PUT only
    // writes the field when the key is present. See working-env-mcp-view.js.
    const mcpValue = mcpSubmitValue(initial, form.mcpServers);
    onSave({
      ...(mcpValue === undefined ? {} : { mcpServers: mcpValue }),
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
          readOnly: r.readOnly === true,
        })),
      githubTokenId: form.githubTokenId || null,
      llmEndpointId: form.llmEndpointId || null,
      defaultModelId: form.defaultModelId || null,
      // An ID, never an image reference (#1940) — the server resolves it.
      toolchainId: form.toolchainId || null,
      // #2083. Sent on an edit too: `isRetier` server-side means restating the
      // record's own unchanged ownership is NOT an operator act, so this is
      // also what finally stamps an explicit `scope` on a legacy record.
      ...ownershipPayload(ownership),
      // #2158: only a System Admin's form renders this control at all — see
      // below — so a non-admin's submit never mentions `global`, which is
      // exactly the "an ordinary save must not drop it" contract the server
      // gate relies on.
      ...(isSysAdmin ? { global: isGlobal } : {}),
    });
  };

  const { canSubmit, reasons: submitBlockers } = describeWorkingEnvSubmitState(form);

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
        {/* Correction (#1987): this used to say "not passed to the agent",
            which is the opposite of what happens — prompt-assembly.js writes
            both the environment name and its description into the agent's
            CLAUDE.md, right above the repository list. A reader who trusted the
            old sentence could put a private note here. */}
        <div style={helpTextStyle}>
          Optional. Shown in this console — and written into the agent's CLAUDE.md next to the
          environment name, so keep anything private out of it.
        </div>
      </div>

      {/* Global environment (#2158) — a System-Admin-only publish flag, the
          same control the Model Providers page renders (#2136). */}
      {isSysAdmin && (
        <label style={{
          display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start', cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={isGlobal}
            onChange={e => setIsGlobal(e.target.checked)}
            style={{ marginTop: 3, flexShrink: 0 }}
          />
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
            <strong>Global</strong> — every team, including teams created later, can select and use it with no admin involvement.
            <span style={{ display: 'block', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              Anyone can select and use it; only a System Admin can manage it.
            </span>
          </span>
        </label>
      )}

      {/* #2083 — ownership. Hidden while Global is on — a global environment
          carries no team assignment (#2158), same rule as Model Providers. */}
      {isGlobal ? null : (
        <CredentialOwnership
          value={ownership}
          onChange={setOwnership}
          teams={teams}
          isSysAdmin={isSysAdmin}
          adminTeamIds={adminTeamIds}
          disabled={ownershipLocked}
        />
      )}

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
          {/* Chapter 2: cloned at creation, the branch, read-only, a repo-less
              environment — and why an added repository does not reach an agent
              that already exists. The per-field hints below stay put. */}
          <PageHelpButton
            label="About repositories in a Working Environment"
            size={14}
            style={{ padding: 0, marginLeft: 'auto', flexShrink: 0 }}
            section={ENVIRONMENTS_HELP_SECTIONS.repositories}
          />
        </div>

        <div style={helpTextStyle}>
          Repositories listed here are cloned into the agent's workspace when the agent is first created.
          You can add multiple repositories — for example the main codebase and a separate documentation repo.
          For a private SSH URL, select an SSH key on the repository card; for a private HTTPS URL, set the <em>GitHub Token</em> below instead.
          Mark a repository <em>Read-only</em> to clone it for reference only — it is still cloned into the workspace, but the agent is told it must not commit or push to it (useful for an upstream codebase, a shared library, or a docs repo the agent should only read).
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

        {/* #2066: the "Sync all agents" panel that used to sit here is GONE —
            not hidden. It required an order nothing stated (Save → re-open Edit
            → Sync) and, pressed before the save, reported success for the
            PREVIOUS repository list. Saving now offers the propagation itself,
            at the one moment the persisted list is authoritative. There is
            deliberately no manual repository-sync affordance on this form at
            all (AC1); the per-agent panel on the agent's Settings tab stays as
            the single-agent recovery path (D2). */}
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
          {/* Chapter 3. The credentials chapter answers the question this
              select raises — an SSH URL needs a key on its repository row, an
              HTTPS URL needs THIS token — plus what changing it does to the
              agents already running. */}
          <PageHelpButton
            label="SSH key or GitHub token?"
            size={14}
            style={{ padding: 0, marginLeft: 'auto', flexShrink: 0 }}
            section={ENVIRONMENTS_HELP_SECTIONS.credentials}
          />
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

      {/* MCP servers (#2051). `environment.mcpServers` has always been the place
          the pairing lives — the API normalizes it, the orchestrator seeds from
          it, and the Team-Setup wizard's Knowledge step points here for changes.
          Until now the form neither rendered nor sent the field, so that pointer
          led to a page with no such control. */}
      <div style={{
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-3)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Server size={14} />
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            MCP Servers
          </span>
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            ({form.mcpServers.length})
          </span>
          {/* Chapter 4 finally has a surface. It carries the substitution rules
              the two row hints below are the short form of, and the seed-time
              caveat the notice states. */}
          <PageHelpButton
            label="About MCP server references"
            size={14}
            style={{ padding: 0, marginLeft: 'auto', flexShrink: 0 }}
            section={ENVIRONMENTS_HELP_SECTIONS.mcp}
          />
        </div>

        <div style={helpTextStyle}>
          Pair a server from the <em>MCP Servers</em> registry with a credential from the separate credential store.
          At agent-creation time the pair is substituted per agent and merged into that agent's own <code>.claude/settings.json</code>,
          which is how an agent reaches runtime data — a wiki, a vector store, a graph database.
          Leave this empty for agents that need no runtime data source.
        </div>

        {/* The rows render whatever the environment holds, independently of what
            the registry currently offers: an empty registry must not hide a
            stored pair (which would leave it unremovable), and a ref whose
            server was deleted is exactly the row a reader needs to see. */}
        {form.mcpServers.map((row, idx) => {
              const hint = mcpRowHint(row, mcpServers);
              const unknownServer = row.serverId && !mcpServers.some(s => s.id === row.serverId);
              return (
                <div
                  key={idx}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
                    padding: 'var(--eb-space-2)',
                    background: 'var(--eb-bg-elevated)',
                    border: '1px solid var(--eb-border-default)',
                    borderRadius: 'var(--eb-radius-md)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
                    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                        <div style={labelStyle}>Server</div>
                        <select
                          value={row.serverId}
                          onChange={e => updateMcp(idx, 'serverId', e.target.value)}
                          style={inputStyle}
                        >
                          <option value="">— choose a server —</option>
                          {mcpServers.map(s => (
                            <option key={s.id} value={s.id}>{mcpServerLabel(s.id, mcpServers)}</option>
                          ))}
                          {/* A ref whose server was removed from the registry
                              stays selectable, so the row shows what it holds
                              and can be removed deliberately. */}
                          {unknownServer && (
                            <option value={row.serverId}>{mcpServerLabel(row.serverId, mcpServers)}</option>
                          )}
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
                        {hint.tone === 'warn'
                          ? <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
                          : <Info size={13} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-text-muted)' }} />}
                        <span>{hint.message}</span>
                      </div>
                    )}
                  </div>
                  {/* IconButton takes no style prop, so the no-shrink lives on
                      the wrapper — otherwise the button squeezes when a long
                      server name widens the selects. */}
                  <div style={{ flexShrink: 0, paddingTop: 18 }}>
                    <IconButton icon={X} label="Remove MCP server" danger onClick={() => removeMcp(idx)} size={12} />
                  </div>
                </div>
              );
        })}

        {/* Only the ADD affordance depends on the registry. While the list is
            still loading nothing is claimed either way — announcing "none are
            registered" and then contradicting it a moment later is worse than
            a beat of silence. */}
        {mcpServersLoading ? null : mcpServers.length === 0 ? (
          <div style={{ ...helpTextStyle, marginTop: 0 }}>
            No MCP servers are registered yet. Register one on the{' '}
            <Link to="/mcp" style={{ color: 'var(--eb-accent-primary)' }}>MCP Servers</Link> page,
            then pair it here.
          </div>
        ) : (
          <button
            type="button"
            onClick={addMcp}
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
            <Plus size={13} /> Add MCP server
          </button>
        )}

        {/* AC3. Unlike the toolchain and token changes below/above, saving here
            recreates nothing: the pair is substituted into the agent's own
            settings at seed time and no respawn path re-seeds it. Say that
            before the click rather than let it be discovered. */}
        {mcpNotice && (
          <div role="alert" style={{
            display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
            padding: 'var(--eb-space-2)',
            background: 'var(--eb-status-warning-bg)',
            borderRadius: 'var(--eb-radius-md)',
          }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
            <span>{mcpNotice}</span>
          </div>
        )}
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

      {/* Agent toolchain (#1940). A select over the operator registry, never a
          free-text image field: an agent container receives this environment's
          SSH key, GitHub token and model credential, so choosing the image is
          choosing what runs with those secrets. A System Admin registers a
          toolchain; here you only pick one. */}
      <div style={{
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-3)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Package size={14} />
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            Agent toolchain
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
          <div style={labelStyle}>Toolchain</div>
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
              <option key={t.id} value={t.id} disabled={!t.available}>
                {t.label}{t.hint ? ` — ${t.hint}` : ''}
              </option>
            ))}
          </select>
        </div>

        {toolchainNotice && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {toolchainNotice}
          </div>
        )}

        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Which container image agents in this environment are spawned from. The default image carries Python and Node; a toolchain adds a language stack (a JDK and Maven, say) so an agent can actually build the repository. Every other environment keeps the default.
        </div>

        {/* AC5: a spawn-time image is fixed for a container's lifetime, so a
            change can only reach a running agent by recreating it — say so
            before the click, as the credential-rotate panel does. */}
        {toolchainWarning && (
          <div role="alert" style={{
            display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
            padding: 'var(--eb-space-2)',
            background: 'var(--eb-status-warning-bg)',
            borderRadius: 'var(--eb-radius-md)',
          }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
            <span>{toolchainWarning}</span>
          </div>
        )}
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

      {/* When the button is disabled (and not merely saving), spell out exactly
          which requirement is still unmet — most usefully the non-obvious case
          of an added-but-blank repository row that leaves the form looking
          complete. */}
      {!saving && submitBlockers.length > 0 && (
        <div style={{
          display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
        }}>
          <Info size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
          <span>
            {isEdit ? 'Save changes' : 'Create environment'} is disabled until you:
            <ul style={{ margin: 'var(--eb-space-1) 0 0', paddingLeft: 'var(--eb-space-4)' }}>
              {submitBlockers.map(r => (
                <li key={r.field}>{r.message}</li>
              ))}
            </ul>
          </span>
        </div>
      )}

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

// The System-Admin half of the toolchain registry (#1940 AC6): register an
// image so environments can select it, or remove one nothing selects any more.
// It lives on this page rather than in its own nav entry because a toolchain has
// exactly one consumer — the Toolchain field on the form next to it — and the
// authorisation gate is the same shape as the Plugins page's install: the
// button is hidden for a Team Admin AND the route answers 403, so hiding it is
// convenience, not the control.
function ToolchainRegistryPanel({ data, onChanged }) {
  // Rendered only while its side panel is open, so no `active` flag — and the
  // lift is what keeps the help panel in front of the panel it explains (#1987).
  useHelpSubject({ overlay: OVERLAY_TOOLCHAINS });

  const [form, setForm] = useState({ id: '', name: '', image: '', description: '', platforms: ['podman', 'kubernetes'] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const toolchains = data?.toolchains || [];
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const togglePlatform = (p) => setForm(f => ({
    ...f,
    platforms: f.platforms.includes(p) ? f.platforms.filter(x => x !== p) : [...f.platforms, p],
  }));

  async function add() {
    setBusy(true); setErr(null);
    try {
      await apiCall('POST', '/api/toolchains', {
        id: form.id.trim(),
        name: form.name.trim(),
        image: form.image.trim(),
        description: form.description.trim(),
        platforms: form.platforms,
      });
      setForm({ id: '', name: '', image: '', description: '', platforms: ['podman', 'kubernetes'] });
      onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function remove(id) {
    setBusy(true); setErr(null);
    try {
      await apiCall('DELETE', `/api/toolchains/${encodeURIComponent(id)}`);
      onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  // Install a SHIPPED variant (#1941). Deliberately a bare `{ id }`: the image
  // reference is read server-side from the seeded manifest, so the operator
  // never retypes it and cannot typo it. The same route, the same validator —
  // only the door differs.
  async function install(id) {
    setBusy(true); setErr(null);
    try {
      await apiCall('POST', '/api/toolchains', { id });
      onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const canAdd = form.id.trim() && form.name.trim() && form.image.trim() && form.platforms.length > 0;
  const available = availableToolchains(data?.available, data?.runtime);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {err && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{err}</div>
      )}

      {/* Chapter 7: why the image is a list and not a text field, the two doors
          onto the registry, what changing a selection does to running agents,
          and the refuse-rather-than-degrade rule. The per-field hints below
          (the image tag, the platforms) stay at the decision. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'calc(-1 * var(--eb-space-3))' }}>
        <PageHelpButton
          label="About agent toolchains"
          size={14}
          style={{ padding: 0 }}
          section={ENVIRONMENTS_HELP_SECTIONS.toolchains}
        />
      </div>

      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
        A toolchain is a container image derived from the default agent image, adding one language
        stack. Registering it here is what makes it selectable on a Working Environment — it grants
        nothing on its own. Only a System Admin can register one, because an agent container
        receives its environment's SSH key, GitHub token and model credential: whoever picks the
        image picks what runs with those secrets.
        {data?.defaultImage && (
          <> Environments without a toolchain run <code>{data.defaultImage}</code>.</>
        )}
      </div>

      {/* The variants this repository SHIPS (#1941) — built by
          `make toolchain-images`, seeded by `make seed-toolchains`. One click
          installs one, because the image reference comes from its manifest;
          the hand-registration form below stays for everything we do not ship. */}
      {available.length > 0 && (
        <div>
          <div style={labelStyle}>Available to install</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)' }}>
            {available.map(t => (
              <div key={t.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)',
                border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                padding: 'var(--eb-space-2) var(--eb-space-3)',
              }}>
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
                    {t.name} <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>({t.id})</span>
                  </div>
                  {/* The plain-language description is the whole point of the
                      manifest field — this is what is read before installing. */}
                  {t.description && (
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5, marginTop: 'var(--eb-space-1)' }}>
                      {t.description}
                    </div>
                  )}
                  {versionSourceLine(t) && (
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5, marginTop: 'var(--eb-space-1)' }}>
                      {versionSourceLine(t)}
                    </div>
                  )}
                  {t.image && (
                    <div style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', wordBreak: 'break-all', marginTop: 'var(--eb-space-1)' }}>
                      {t.image}
                    </div>
                  )}
                  {t.reason && (
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', lineHeight: 1.5, marginTop: 'var(--eb-space-1)' }}>
                      {t.reason}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => install(t.id)}
                  disabled={busy || !t.installable}
                  style={{
                    flex: '0 0 auto',
                    padding: 'var(--eb-space-1) var(--eb-space-3)',
                    background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
                    border: 'none', borderRadius: 'var(--eb-radius-md)',
                    fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
                    cursor: (busy || !t.installable) ? 'not-allowed' : 'pointer',
                    opacity: (busy || !t.installable) ? 0.5 : 1,
                  }}
                >Install</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={labelStyle}>Registered toolchains</div>
        {toolchains.length === 0 ? (
          <div style={{ ...helpTextStyle, marginTop: 'var(--eb-space-2)' }}>
            None yet — every agent runs the default image.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)' }}>
            {toolchains.map(t => (
              <div key={t.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
                border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                padding: 'var(--eb-space-2) var(--eb-space-3)',
              }}>
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
                    {t.name} <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>({t.id})</span>
                  </div>
                  <div style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', wordBreak: 'break-all' }}>
                    {t.image}
                    {/* What the runtime actually pulls, when the deployment
                        rewrites it (#1941 AC11: a cluster pulls from its
                        Artifact Registry under the pinned release tag). Shown
                        only when it DIFFERS — an ImagePullBackOff is otherwise
                        debugged against a reference nothing pulls. */}
                    {t.effectiveImage && t.effectiveImage !== t.image && (
                      <> → {t.effectiveImage}</>
                    )}
                  </div>
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                    {(t.platforms || []).join(', ')}
                    {t.environments?.length > 0 && (
                      <> · selected by {t.environments.map(e => e.name || e.id).join(', ')}</>
                    )}
                  </div>
                </div>
                {/* Removal is refused server-side while an environment still
                    selects it — otherwise those agents would start refusing to
                    spawn, which is correct but a terrible way to find out. */}
                <IconButton
                  icon={Trash2}
                  label={t.environments?.length > 0 ? 'Clear it on its environments first' : 'Remove'}
                  danger
                  disabled={busy || t.environments?.length > 0}
                  onClick={() => remove(t.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{
        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      }}>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>Register a toolchain</div>
        <FormInput label="ID *" value={form.id} onChange={v => update('id', v)} placeholder="jvm-21" />
        <FormInput label="Name *" value={form.name} onChange={v => update('name', v)} placeholder="JVM 21 (JDK + Maven)" />
        <div>
          <FormInput label="Image *" value={form.image} onChange={v => update('image', v)} placeholder="localhost/as-agent-jvm-21:latest" />
          <div style={helpTextStyle}>
            The image tag as the runtime resolves it. On Kubernetes it must exist in the registry
            the cluster's nodes pull from — a <code>localhost/…</code> tag from a developer machine
            does not, which is what the platforms below are for.
          </div>
        </div>
        <FormInput label="Description" value={form.description} onChange={v => update('description', v)} placeholder="Temurin JDK 21 + Maven, via mise" />
        <div>
          <div style={labelStyle}>Platforms *</div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-4)', marginTop: 'var(--eb-space-1)' }}>
            {['podman', 'kubernetes'].map(p => (
              <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.platforms.includes(p)} onChange={() => togglePlatform(p)} />
                {p}
              </label>
            ))}
          </div>
          <div style={helpTextStyle}>
            Where this image is actually pullable. This stack runs on <code>{data?.runtime || 'podman'}</code>.
          </div>
        </div>
        <button
          onClick={add}
          disabled={busy || !canAdd}
          style={{
            alignSelf: 'flex-start',
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: (busy || !canAdd) ? 0.6 : 1,
          }}
        >
          {busy ? 'Saving…' : 'Register toolchain'}
        </button>
      </div>
    </div>
  );
}

export default function WorkingEnvironments() {
  const { data: envs, loading, error, refetch } = useApi('/api/environments');
  const { data: toolchainData, refetch: refetchToolchains } = useApi('/api/toolchains');
  const [panelMode, setPanelMode] = useState(null);
  const [selected, setSelected] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  // The save-time propagation offer (#2066 D3). Held as one object so the
  // dialog's inputs cannot get out of step with each other; `null` = no offer.
  const [offer, setOffer] = useState(null);
  // D4: per-environment divergence, keyed by env id. Fetched after the list
  // loads rather than folded into GET /api/environments, because it costs two
  // git commands per repository per agent and the list must not wait on it.
  const [divergence, setDivergence] = useState({});

  // Re-read the indicator for every environment that has at least one agent.
  // Deliberately fail-quiet per environment: a probe that could not run shows
  // NO indicator rather than a green one, so the page never claims agents are
  // up to date when it does not know (outOfDateIndicator returns null for a
  // missing payload).
  const refreshDivergence = useCallback(async (list) => {
    const rows = (Array.isArray(list) ? list : []).filter(
      (e) => (Array.isArray(e.agents) ? e.agents.length : (e.agentCount || 0)) > 0,
    );
    // Always write the map, even when it ends up empty: returning early here
    // would leave a badge standing for an environment whose last agent has
    // since been deleted.
    if (rows.length === 0) { setDivergence({}); return; }
    const entries = await Promise.all(rows.map(async (e) => {
      try {
        return [e.id, await apiCall('GET', `/api/environments/${encodeURIComponent(e.id)}/repo-divergence`)];
      } catch {
        return [e.id, null];
      }
    }));
    setDivergence(Object.fromEntries(entries));
  }, []);

  useEffect(() => { refreshDivergence(envs); }, [envs, refreshDivergence]);

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
        // D4 (#2066): the persistent out-of-date indicator, with the catch-up
        // behind it. It lives on the Agents cell because it is a statement
        // about those agents, and it is derived from their workspaces — so it
        // survives a declined offer and clears itself once nothing diverges.
        const indicator = outOfDateIndicator(divergence[row.id]);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            <span
              title={count > 0 ? row.agents.map(a => a.displayName || a.id).join('\n') : 'No agents use this environment'}
              style={{ fontSize: 'var(--eb-text-xs)', color: count > 0 ? 'var(--eb-text-secondary)' : 'var(--eb-text-muted)' }}
            >
              {count}
            </span>
            {indicator && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOffer({ env: row, diff: null, catchUp: true });
                }}
                disabled={!indicator.canManage}
                title={indicator.canManage
                  ? `${indicator.title}\n\nClick to bring them up to date.`
                  : `${indicator.title}\n\nYou may not manage this environment.`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '1px var(--eb-space-2)',
                  background: 'var(--eb-status-warning-bg)',
                  border: '1px solid var(--eb-status-warning)',
                  borderRadius: 'var(--eb-radius-sm)',
                  color: 'var(--eb-status-warning)',
                  fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
                  cursor: indicator.canManage ? 'pointer' : 'not-allowed',
                  opacity: indicator.canManage ? 1 : 0.7,
                }}
              >
                <AlertTriangle size={11} /> {indicator.label}
              </button>
            )}
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
        const saved = await apiCall('PUT', `/api/environments/${selected.id}`, form);
        // #2066 D3: the offer is made HERE, once the save has SUCCEEDED, and
        // the panel still closes as it always did. The diff is computed from
        // two server-supplied lists — the list as it was persisted a moment ago
        // (`previousRepositories`, captured inside the PUT) and the list the
        // server saved — so it can never be computed against a draft this
        // browser has been holding since another admin saved the same
        // environment, which is the exact defect this ticket removes.
        //
        // Scoped to an environment that already HAS agents (AC4): with none
        // there is no workspace that could be out of date, whatever changed.
        const agents = Array.isArray(selected.agents) ? selected.agents : [];
        const diff = classifyRepositoryChanges(saved?.previousRepositories, saved?.repositories);
        if (agents.length > 0 && hasRepositoryChanges(diff)) {
          setOffer({ env: { ...selected, ...saved }, diff, catchUp: false });
        }
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

  const headerAction = usePageActions(
    <>
      {/* Hidden for a Team Admin as a courtesy; the routes behind it answer 403
          regardless (#1940 AC6 is enforced server-side, not by this button). */}
      {toolchainData?.canManage && (
        <button
          onClick={() => { setPanelMode('toolchains'); setSelected(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Package size={15} /> Toolchains
        </button>
      )}
      <button
        onClick={() => { setPanelMode('create'); setSelected(null); setFormError(null); }}
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <Plus size={15} /> New Environment
      </button>
    </>
  );

  if (loading) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (error) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load: {error}</div>;
  }

  return (
    <>
      {headerAction}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>

      {/* One-line description + the "?" that opens this page's help topic. The
          "What is a Working Environment?" box that used to sit here — the
          repositories / token / additional-instructions list and the
          shared-recipe-but-own-workspace point — now lives in that topic
          (api/helper-chat/help-topics/environments.md, #1880), together with the
          SSH-vs-token rule, read-only repositories and the
          repositories-are-cloned-once / Sync-all-agents caveat. Per-field help
          inside the form stays where the decision is made.

          #1987 widened that topic into seven chapters and pointed each surface
          at its own one: this button opens chapter 1, and the repositories
          area, the token select, the Sync action and the Toolchains panel each
          carry their own "?" (see environments-help-sections.js). */}
      <p style={{
        margin: 0,
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        <span>
          A reusable workspace recipe — the repositories, credentials, model provider and extra
          context every agent created from it inherits.
        </span>
        <PageHelpButton
          label="What is a Working Environment?"
          size={14}
          style={{ padding: 0, flexShrink: 0 }}
          section={ENVIRONMENTS_HELP_SECTIONS.whatIs}
        />
      </p>

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

      <SidePanel
        open={panelMode === 'toolchains'}
        onClose={() => setPanelMode(null)}
        title="Agent toolchains"
        width="560px"
      >
        {panelMode === 'toolchains' && (
          <ToolchainRegistryPanel
            data={toolchainData}
            onChanged={() => { refetchToolchains(); refetch(); }}
          />
        )}
      </SidePanel>

      <RepoPropagationDialog
        open={!!offer}
        envId={offer?.env?.id}
        envName={offer?.env?.name}
        diff={offer?.diff || null}
        agents={offer?.env?.agents || []}
        catchUp={!!offer?.catchUp}
        onClose={() => setOffer(null)}
        onFinished={() => refreshDivergence(envs)}
      />

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
    </>
  );
}

