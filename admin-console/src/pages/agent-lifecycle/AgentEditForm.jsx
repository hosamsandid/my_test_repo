/**
 * AgentEditForm.jsx — the agent configuration form, and the two sub-controls
 * that save outside its Save button.
 *
 * This is the Agents page's edit side panel, moved here unchanged so the Agent
 * Chat right rail can render the *same* component rather than a second copy
 * (#1929 AC7): a field added here appears in both surfaces, and neither can
 * drift. `Agents.jsx` imports it back and its call site is untouched.
 *
 * Two things deliberately do NOT batch into the form's Save:
 *
 *   - `PluginGrantSection` — a grant seeds a CLI and a scope token into the
 *     live workspace and reconnects the broker's network; it applies at once.
 *   - `ContextMountControl` — a mount is baked at container spawn time, so
 *     saving it re-provisions the agent.
 *
 * Both say so in their own help text. That difference is honest on the Agents
 * page and has to stay honest in the chat (AC3) — which is also why the chat
 * passes `confirmRestart`: on the Agents page a re-provision interrupts
 * nothing the user is looking at, whereas in the chat it ends the conversation's
 * current run (AC4).
 *
 * Host-side extension points, all optional and all inert when omitted (which is
 * how the Agents page keeps its pre-#1929 behaviour exactly):
 *
 *   initialForm       hydrate from a preserved draft instead of from `agent`
 *   onFormChange      report every edit so a host can preserve that draft
 *   confirmRestart    require an explicit confirm before a re-provisioning save
 *   onImmediateApply  an out-of-band section (mounts) applied something
 *   onCancel          omitted → no Cancel button (the chat rail has nothing to
 *                     close; it offers "Discard changes" only while dirty)
 */
import React, { useState } from 'react';
import { useApi, apiCall } from '../../hooks/useApi';
import {
  PROMPT_MODES,
  PROMPT_MODE_LABELS,
  composeMemberPrompt,
} from '../prompt-mode-view.js';
import { notifyPluginsChanged } from '../../components/plugin-nav';
import FormInput from '../../components/FormInput';
import SkillPicker from '../../components/SkillPicker';
import PluginGrantPicker from '../../components/PluginGrantPicker';
import PluginCredentials from '../../components/PluginCredentials';
import SyncReposPanel from '../../components/SyncReposPanel';
import AgentRepositoriesPanel from '../agent-chat/AgentRepositoriesPanel';
import TeamEnvironmentPanel from '../agent-chat/TeamEnvironmentPanel';
import ShareTeamPanel from '../agent-chat/ShareTeamPanel.jsx';
import McpServerRows from '../../components/McpServerRows';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from '../agent-chat/agent-chat-help-sections.js';
import { effectiveGrantFor, uninstalledGrantRows, UNINSTALLED_GRANT_HINT } from '../plugin-grant-view.js';
import { pluginRegistryRow } from '../plugin-registry-view.js';
import {
  labelStyle, inputStyle, helpTextStyle, PrimaryBtn, SecondaryBtn,
} from './form-kit.jsx';
import {
  buildInitialForm, buildEditSubmit, hasOwnSkills, poolSectionError,
} from './agent-edit-form-model.js';
import { inheritedMcpPreview, switchMcpMode, memberMcpBlockers } from './member-mcp-view.js';
import { TEAM_CONFIG_TABS, ENV_TAB_IDS, resolveTeamConfigTab } from './team-config-tabs-view.js';
import { parallelismSummary, hasPooledMember } from '../process/parallelism-view.js';
import ScalingSection from '../process/ScalingSection';
import { poolControlUrl, livePoolCount } from '../process/pool-cap-view.js';
import ParallelismPanel from '../process/ParallelismPanel';

// #2236: which help chapter each tab's "?" opens, and the tab's own label for
// the button's title. General/Skills/Plugins point at the same field-by-field
// chapter the ordinary (non-team) form already had; the five environment tabs
// share the one chapter documenting them as a group.
const TEAM_CONFIG_TAB_LABEL = Object.fromEntries(TEAM_CONFIG_TABS.map(t => [t.id, t.label]));
const TEAM_CONFIG_TAB_HELP = {
  general: AGENT_CHAT_HELP_SECTIONS.formFields,
  repositories: AGENT_CHAT_HELP_SECTIONS.teamEnvironment,
  provider: AGENT_CHAT_HELP_SECTIONS.teamEnvironment,
  toolchain: AGENT_CHAT_HELP_SECTIONS.teamEnvironment,
  mcp: AGENT_CHAT_HELP_SECTIONS.teamEnvironment,
  context: AGENT_CHAT_HELP_SECTIONS.teamEnvironment,
  skills: AGENT_CHAT_HELP_SECTIONS.formFields,
  plugins: AGENT_CHAT_HELP_SECTIONS.formFields,
  sharing: AGENT_CHAT_HELP_SECTIONS.shareTeam,
};

/* ── Agent Edit Form ────────────────────────────────────────────────── */
// Plugin grant (#1547). Like ContextMountControl below — and unlike the rest of
// the edit form, which batches into one PUT on Save — this saves IMMEDIATELY
// through its own endpoint. A plugin grant is not just a config field: it seeds
// the CLI + a scope token into the live workspace and reconnects the broker's
// network, all without a respawn. Batching it into the form's PUT would make
// "Save" mean two very different things.
export function PluginGrantSection({ agent, parentTeam, alwaysVisible = false }) {
  const { data, refetch } = useApi('/api/plugins');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [notice, setNotice] = React.useState('');

  // Optimistic local grant so the row reflects the click before the refetch;
  // reset from props whenever the server view changes.
  const serverGrant = React.useMemo(
    () => effectiveGrantFor(agent, parentTeam),
    [agent, parentTeam],
  );
  const [grant, setGrant] = React.useState(serverGrant);
  React.useEffect(() => { setGrant(serverGrant); }, [serverGrant]);

  const installed = (data && data.installed) || [];
  // Grants left behind by an uninstall (#2651): the picker lists installed
  // plugins only, so these get their own rows with a Revoke. Only once the
  // installed list is known — null while loading or after a failed fetch.
  const knownInstalled = data && Array.isArray(data.installed) ? data.installed : null;
  const orphans = React.useMemo(() => uninstalledGrantRows(grant, knownInstalled), [grant, knownInstalled]);

  // The quota ceiling for "per agent" granularity is only honest if it counts
  // the members that would actually carry the grant, so a team's members are
  // counted for real rather than assumed to be one.
  const { data: allAgents } = useApi(agent.role === 'team' ? '/api/agents' : null);
  const memberCount = React.useMemo(() => {
    if (agent.role !== 'team') return 1;
    const list = Array.isArray(allAgents) ? allAgents : (allAgents && allAgents.agents) || [];
    const n = list.filter(a => a && a.parentTeamId === agent.id).length;
    return n > 0 ? n : 1;
  }, [agent.role, agent.id, allAgents]);

  async function apply(pluginId, active, scopeGranularity) {
    setBusy(true); setErr(''); setNotice('');
    const verb = active ? 'activate' : 'deactivate';
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(agent.id)}/plugins/${verb}`, {
        pluginId, scopeGranularity,
      });
      setNotice(active
        ? `${pluginId} activated — its CLI is available to the agent now, no restart needed.`
        : `${pluginId} deactivated.`);
      await refetch();
      // A grant change can add/remove a scope the caller can see — refresh the
      // sidebar's plugin nav, which no longer refetches on navigation (#1679).
      notifyPluginsChanged();
    } catch (e) {
      setErr(e.message || `Could not ${verb} ${pluginId}`);
      setGrant(serverGrant); // roll the optimistic toggle back
    } finally { setBusy(false); }
  }

  function onToggle(pluginId, active, granularity) {
    setGrant(active
      ? [...grant.filter(g => g.id !== pluginId), { id: pluginId, scopeGranularity: granularity }]
      : grant.filter(g => g.id !== pluginId));
    apply(pluginId, active, granularity);
  }

  function onGranularity(pluginId, granularity) {
    setGrant(grant.map(g => (g.id === pluginId ? { ...g, scopeGranularity: granularity } : g)));
    // A granularity flip is re-activation at the new scope: the server re-mints
    // the token and rewrites the config, additively.
    apply(pluginId, true, granularity);
  }

  // #2236 AC16: on the team configuration surface the Plugins tab must stay
  // present and explain the situation rather than vanish — a tab that
  // disappears depending on installation state is itself a puzzle, and a
  // Team Admin cannot resolve "nothing installed" anyway (System-Admin-only).
  // Every other caller keeps the pre-#2236 self-hide.
  const orphanList = orphans.length > 0 && (
    <div style={{ marginTop: 'var(--eb-space-3)' }}>
      <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>{UNINSTALLED_GRANT_HINT}</div>
      {orphans.map((row) => (
        <div
          key={row.id}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) 0', fontSize: 'var(--eb-text-sm)' }}
        >
          <span style={{ fontWeight: 600 }}>{row.id}</span>
          <span style={{ color: 'var(--eb-status-warning)', fontSize: 'var(--eb-text-xs)' }}>{row.status}</span>
          <button
            type="button"
            aria-label={row.revokeLabel}
            title={row.revokeLabel}
            disabled={busy}
            onClick={() => onToggle(row.id, false, row.granularity)}
            style={{
              marginLeft: 'auto', padding: '2px var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)', cursor: busy ? 'default' : 'pointer',
            }}
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  );

  if (installed.length === 0 && !orphanList) {
    if (!alwaysVisible) return null;
    return (
      <div>
        <div style={labelStyle}>Plugins</div>
        <div style={{ ...helpTextStyle, marginTop: 0 }}>
          No plugins are installed on this platform yet. Installing one is a
          System Administrator's action, from the Plugins registry page — once
          installed, it can be granted to this team here.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={labelStyle}>Plugins</div>
      <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
        Governed capabilities beyond the container, reached through a broker that holds the
        privilege so the agent never does. Changes apply immediately — no save, no restart.
        {agent.role === 'team' && ' For a team agent this is the whole squad\'s grant; members inherit it.'}
        {agent.role === 'team-member' && ' Changing this here creates a per-member override that replaces the team\'s set.'}
      </div>
      {err && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-xs)', marginBottom: 'var(--eb-space-2)' }}>{err}</div>
      )}
      {notice && !err && (
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)', marginBottom: 'var(--eb-space-2)' }}>{notice}</div>
      )}
      <PluginGrantPicker
        plugins={installed}
        grants={grant}
        onToggle={onToggle}
        onGranularity={onGranularity}
        memberCount={memberCount}
        disabled={busy}
      />
      {orphanList}
    </div>
  );
}

// The team-wide service account for a credential-declaring plugin (Jira),
// #2608, set here in Team Settings so a Team Admin owns it without needing the
// System-Admin-only Plugins registry page. This account is used only for
// AUTOMATED runs (schedules, loops, GitHub events, hand-offs) and background
// polling; a chat turn uses the sender's own Plugin Token instead. The write
// API is `canManageTeam`-gated, so a Team Admin of this team (or a System
// Admin) may save. Team-only: a member inherits the team's account and has no
// service account of its own. `onlyScopeId={agent.id}` pins the shared
// PluginCredentials component to this team's own (team-granularity) scope.
export function PluginServiceAccountSection({ agent }) {
  const { data } = useApi('/api/plugins');
  if (agent.role !== 'team') return null;
  const installed = (data && data.installed) || [];
  const granted = new Set(effectiveGrantFor(agent, null).map((g) => g.id));
  const rows = installed
    .map((e) => pluginRegistryRow(e, { canManage: true }))
    .filter((r) => r.installed && r.credentialKeys.length > 0 && granted.has(r.id));
  if (rows.length === 0) return null;

  return (
    <div style={{ marginTop: 'var(--eb-space-4)' }}>
      <div style={labelStyle}>Plugin service accounts</div>
      <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
        The team-wide account a granted plugin uses for automated runs (schedules,
        loops, GitHub events, hand-offs) and background polling. Chat turns never
        use it — each member acts under their own Plugin Token. Changes apply
        immediately; the account is stored server-side and never read back.
      </div>
      {rows.map((row) => (
        <PluginCredentials
          key={row.id}
          row={row}
          onlyScopeId={agent.id}
          defaultOpen
          label={`Set the ${row.name || row.id} service account (${row.credentialKeys.join(' / ')})`}
        />
      ))}
    </div>
  );
}

// Host-folder context mount(s) (#1283, multiple folders #1290). A self-contained
// control: unlike the rest of the edit form (one PUT on Save), a mount change is
// baked at container spawn time and re-provisions the agent, so it saves
// immediately via its own PATCH endpoint and reports the respawn outcome. Each
// folder gets a distinct, stable in-container path — a single legacy folder at
// the bare `/context`, additional folders at `/context/<slug>` (the slug is
// derived from the folder's basename server-side and de-duplicated). Availability
// is local/self-hosted only — the capability probe disables the control (with an
// explanation) on the hosted stack (AC8).
//
// `confirmRestart` (#1929 AC4): from the chat, the re-provision this triggers
// ends the run the user is watching, so the action asks first instead of firing
// on the click. The Agents page leaves it off and keeps its one-click behaviour.
export function ContextMountControl({ agent, confirmRestart = false, onApplied = null }) {
  const { data: capability } = useApi('/api/context-mount/capability');
  const supported = capability ? !!capability.supported : null; // null = still loading
  const mountPath = (capability && capability.mountPath) || '/context';

  // Initial rows: the multi-folder field when present, else the legacy single
  // folder, else empty. `slug`/`name` are carried (hidden) so a re-save keeps a
  // folder's in-container path stable even if the host path is repointed.
  const initialRows = () => {
    if (Array.isArray(agent.contextMounts) && agent.contextMounts.length) {
      return agent.contextMounts.map(m => ({
        path: m.path || '',
        name: m.name || '',
        slug: m.slug || null,
        readWrite: m.readWrite === true,
        target: m.slug ? `${mountPath}/${m.slug}` : null,
      }));
    }
    if (agent.contextMount) {
      return [{ path: agent.contextMount, name: '', slug: null, readWrite: agent.contextMountRw === true, target: mountPath }];
    }
    return [];
  };
  const snapshot = (rs) => JSON.stringify(rs.map(r => ({ path: (r.path || '').trim(), readWrite: !!r.readWrite })));

  const [rows, setRows] = useState(initialRows);
  const [saved, setSaved] = useState(() => snapshot(initialRows()));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  // Pending re-provision awaiting the user's OK: the rows to persist, or null.
  // Only ever set when `confirmRestart` is on.
  const [pending, setPending] = useState(null);

  const dirty = snapshot(rows) !== saved;
  const disabled = busy || supported === null;

  // Editing after asking for a confirm retracts it: the pending snapshot is the
  // rows as they were when the button was pressed, and applying that afterwards
  // would silently discard whatever was typed since.
  const editRows = (fn) => { setPending(null); setRows(fn); };
  const updateRow = (i, patch) => editRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => editRows(rs => [...rs, { path: '', name: '', slug: null, readWrite: false, target: null }]);
  const removeRow = (i) => editRows(rs => rs.filter((_, idx) => idx !== i));

  // Every route to a re-provision goes through here, so the confirm can never
  // be bypassed by one of the three buttons.
  function request(nextRows) {
    setMsg(''); setErr('');
    if (confirmRestart) setPending(nextRows);
    else persist(nextRows);
  }

  async function persist(nextRows) {
    setPending(null);
    setBusy(true); setMsg(''); setErr('');
    try {
      const mounts = nextRows
        .map(r => ({
          path: (r.path || '').trim(),
          readWrite: !!r.readWrite,
          ...(r.name ? { name: r.name } : {}),
          ...(r.slug ? { slug: r.slug } : {}),
        }))
        .filter(m => m.path);
      const res = await apiCall('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/context-mount`, { mounts });
      const applied = Array.isArray(res && res.mounts) ? res.mounts : [];
      const appliedRows = applied.map(m => ({
        path: m.hostPath || '',
        name: m.name || '',
        slug: m.slug || null,
        readWrite: m.readWrite === true,
        target: m.target || null,
      }));
      setRows(appliedRows);
      setSaved(snapshot(appliedRows));
      const n = appliedRows.length;
      if (!n) {
        setMsg('Context folders cleared. ' + (res && res.respawned ? 'Agent re-provisioned.' : 'Takes effect on the next start.'));
      } else {
        const suffix = n === 1 ? 'folder' : 'folders';
        setMsg(res && res.respawned
          ? `${n} ${suffix} mounted under ${mountPath}. Agent re-provisioned.`
          : `Saved ${n} ${suffix}. Takes effect the next time the agent starts.`);
      }
      if (onApplied) onApplied({ respawned: !!(res && res.respawned), mounts: appliedRows.length });
    } catch (e) {
      setErr((e && e.message) || 'Could not update the context folders');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={labelStyle}>Host context folders</div>
      <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
        Expose one or more folders from the host machine to this agent as live context.
        Each folder's current contents appear inside the agent under <code>{mountPath}</code>
        {' '}at its own path; changes the host makes are reflected on the agent's next access.
        By default each folder is <strong>read-only</strong>; tick read-write to let the agent
        create, modify and delete files in it — those changes land on the host. Saving
        re-provisions the agent's container.
      </div>
      {supported === false ? (
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)' }}>
          Not available in this environment — host-folder mounts are offered only on the
          local / self-hosted stack.
        </div>
      ) : (
        <>
          {rows.length === 0 && (
            <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)', fontStyle: 'italic' }}>
              No folders attached. Add one below.
            </div>
          )}
          {rows.map((row, i) => (
            <div key={i} style={{ marginBottom: 'var(--eb-space-3)', paddingBottom: 'var(--eb-space-2)', borderBottom: '1px solid var(--eb-border-default)' }}>
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                <input
                  type="text"
                  value={row.path}
                  onChange={e => updateRow(i, { path: e.target.value })}
                  placeholder="/absolute/path/on/the/host"
                  disabled={disabled}
                  style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)', flex: '1 1 auto', minWidth: 0 }}
                />
                <SecondaryBtn
                  onClick={() => removeRow(i)}
                  title="Remove this folder"
                  style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto', flex: '0 0 auto' }}
                >
                  Remove
                </SecondaryBtn>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-1)', cursor: disabled ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={row.readWrite}
                  onChange={e => updateRow(i, { readWrite: e.target.checked })}
                  disabled={disabled}
                />
                <span style={helpTextStyle}>Mount read-write — let the agent write back to this folder (off by default).</span>
              </label>
              {row.target && (
                <div style={{ ...helpTextStyle, marginTop: 'var(--eb-space-1)' }}>
                  Mounts at <code>{row.target}</code>
                </div>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            <SecondaryBtn onClick={addRow} style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
              + Add folder
            </SecondaryBtn>
            <SecondaryBtn onClick={() => request(rows)} style={{ opacity: (disabled || !dirty) ? 0.6 : 1, pointerEvents: (disabled || !dirty) ? 'none' : 'auto' }}>
              {busy ? 'Saving…' : 'Save & re-provision'}
            </SecondaryBtn>
            {rows.length > 0 && (
              <SecondaryBtn onClick={() => { if (!confirmRestart) setRows([]); request([]); }} style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
                Clear all
              </SecondaryBtn>
            )}
          </div>
          {pending && (
            <div role="alert" style={{
              marginTop: 'var(--eb-space-2)', padding: 'var(--eb-space-3)',
              background: 'var(--eb-status-warning-bg)',
              border: '1px solid var(--eb-status-warning)',
              borderRadius: 'var(--eb-radius-md)',
            }}>
              <div style={{ ...helpTextStyle, marginTop: 0, color: 'var(--eb-text-primary)' }}>
                Applying this restarts the agent's container. Any run in progress is ended and
                this conversation continues in a fresh session.
              </div>
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
                <PrimaryBtn onClick={() => persist(pending)}>Restart &amp; apply</PrimaryBtn>
                <SecondaryBtn onClick={() => setPending(null)}>Keep running</SecondaryBtn>
              </div>
            </div>
          )}
          {msg && <div style={{ ...helpTextStyle, color: 'var(--eb-status-success)' }}>{msg}</div>}
          {err && <div role="alert" style={{ ...helpTextStyle, color: 'var(--eb-status-error)' }}>{err}</div>}
        </>
      )}
    </div>
  );
}

export default function AgentEditForm({
  agent, onSave, onCancel, cancelLabel = 'Cancel', saving, error,
  initialForm = null, onFormChange = null,
  confirmRestart = false, onImmediateApply = null,
  // #2236: a team's whole configuration is one flat row of tabs. The selected
  // tab is owned by the host (`AgentSettingsPanel`/`TeamConfigSurface`, which
  // sits above this form's own save-triggered remount) rather than by this
  // component, so switching tabs survives a save (AC6) and is addressable by
  // URL (AC7). Both optional and inert for every non-team role (AC13).
  teamConfigTab = null, onTeamConfigTabChange = null,
}) {
  // A preserved draft (#1929 AC6) wins over the config-derived defaults, so
  // returning to a half-edited form finds it exactly as it was left.
  const [form, setForm] = useState(() => initialForm || buildInitialForm(agent));
  const update = (key, val) => setForm(f => {
    const next = { ...f, [key]: val };
    if (onFormChange) onFormChange(next);
    return next;
  });
  // A change that sets several keys at once (the MCP mode switch pre-fills
  // its rows, #2289 D1) — reported to the host like any other edit.
  const updateForm = (fn) => setForm(f => {
    const next = fn(f);
    if (onFormChange && next !== f) onFormChange(next);
    return next;
  });
  // #2295 AC11: Scaling's own validation (mirrors ScalingSection's old
  // save()) now blocks this form's ONE Save button rather than a second one
  // of its own — set on click, cleared on the next edit anywhere in the form.
  const [scalingError, setScalingError] = useState(null);

  // Skills live on the agent construct itself for non-member roles.
  const ownSkills = hasOwnSkills(agent.role);
  // Grant-aware picker (#633): scope the pool to the agent's own team so its
  // team-tier skills are grantable, not just the global pool. Team-first
  // resolution and shadowing markers are rendered by the picker.
  const skillsUrl = agent.teamId
    ? `/api/skills?teamId=${encodeURIComponent(agent.teamId)}`
    : '/api/skills';
  const { data: skillsData } = useApi(skillsUrl);
  const grantSkills = (skillsData || []).filter(s => s.source === 'pool' || s.source === 'team');

  // For team-members: fetch the parent team's config to display its
  // current systemPromptTemplate as a preview when inheriting.
  const parentTeamUrl = agent.role === 'team-member' && agent.parentTeamId
    ? `/api/agents/${encodeURIComponent(agent.parentTeamId)}`
    : null;
  const { data: parentTeam } = useApi(parentTeamUrl || '/api/agents');
  // #2760 AC5: the role's live instance count against its cap, for Scaling.
  const { data: poolControl } = useApi(poolControlUrl(agent));
  const parentTeamPrompt = parentTeamUrl && parentTeam?.role === 'team'
    ? (parentTeam.systemPromptTemplate || '')
    : '';

  // A team-member's own MCP servers (#2289): the same picker as the team's
  // MCP servers tab, over the same registry reads, plus the environment the
  // member inherits from — for the Inherit preview and the Custom pre-fill.
  const isMember = agent.role === 'team-member';
  const { data: mcpServerData, loading: mcpServersLoading } = useApi(isMember ? '/api/mcp-servers' : null);
  const { data: mcpCredentialData } = useApi(isMember ? '/api/mcp-credentials' : null);
  const mcpEnvId = isMember ? (agent.environmentId || parentTeam?.environmentId || null) : null;
  const { data: mcpEnv, loading: mcpEnvLoading } = useApi(
    mcpEnvId ? `/api/environments/${encodeURIComponent(mcpEnvId)}` : null,
  );
  const mcpBlockers = isMember ? memberMcpBlockers(form.inheritMcp, form.mcpRows) : [];
  const canSubmit = !!form.displayName && mcpBlockers.length === 0;

  const isTeam = agent.role === 'team';
  // Team-axis Parallelism (wipLimit + Flow Supervisor) is now configurable
  // directly from Team Settings, not only the Flow editor. The panel writes
  // through PUT /api/agents/:teamId; onImmediateApply refetches so the summary
  // reflects the new value. `hasPooledMember` gates the auto-dispatch toggle's
  // prerequisite, mirroring how the Flow editor computes it.
  const [parallelismOpen, setParallelismOpen] = useState(false);
  const { data: teamAgentsForPool } = useApi(isTeam ? '/api/agents' : null);
  const hasPooledRole = hasPooledMember(teamAgentsForPool || [], agent.id);
  const activeTab = isTeam ? resolveTeamConfigTab(teamConfigTab) : null;
  const setTeamTab = (id) => { if (onTeamConfigTabChange) onTeamConfigTabChange(id); };
  // The outer Save/Cancel button batches exactly the fields General and
  // Skills contribute to `buildEditSubmit` — Repositories/Model
  // provider/Toolchain/MCP servers/Additional context save through the
  // environment record's own button (`TeamEnvironmentPanel`) and Plugins
  // applies immediately (`PluginGrantSection`), both unchanged (AC5).
  //
  // `|| !!onCancel` (code-review finding on #2236): those two tabs are only
  // where an edit CAN be made, not the only tabs it can be VIEWED from once
  // made. `AgentSettingsPanel` only ever passes a non-null `onCancel` while
  // its own `dirty` flag is true — the same batched fields this row acts on —
  // so without this a pending edit made on General/Skills would leave no
  // Save/Discard reachable at all the moment the user switched to another
  // tab to check something, stranding the "unsaved changes" banner with
  // nothing on screen to resolve it.
  const showBatchedSave = !isTeam || activeTab === 'general' || activeTab === 'skills' || !!onCancel;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      {/* #2236: one flat, ARIA-compliant tab row — General · Repositories ·
          Model provider · Toolchain · MCP servers · Additional context ·
          Skills · Plugins · Sharing, always in this order and always all nine
          (AC1/AC2/AC3/AC9/AC15) — replacing the old boxed "Environment"
          section with its own nested sub-tab strip. (Sharing is the relocated
          "Share…" SidePanel, added as the trailing tab.)
          #2253: restyled to match the Agent Chat right-rail TabButton look
          (RightRail.jsx) — a bottom-border underline for the active state
          instead of a filled pill, the same active/inactive color and
          weight rules, and a fixed-height stretch layout. Behaviour
          (role="tablist"/"tab", aria-selected, the PageHelpButton anchored
          right, the overflowX:auto narrow-width fallback) is unchanged. */}
      {isTeam && (
        <div style={{
          display: 'flex', alignItems: 'stretch',
          height: 'var(--eb-header-height)', flexShrink: 0,
          overflowX: 'auto',
          borderBottom: '1px solid var(--eb-border-default)',
        }}>
          <div role="tablist" aria-label="Team configuration" style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
            {TEAM_CONFIG_TABS.map(t => {
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTeamTab(t.id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center',
                    flexShrink: 0,
                    padding: '0 var(--eb-space-3)',
                    background: 'none',
                    border: 'none',
                    borderBottom: `2px solid ${active ? 'var(--eb-accent-primary)' : 'transparent'}`,
                    color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
                    fontSize: 'var(--eb-text-sm)', whiteSpace: 'nowrap',
                    fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
                    cursor: 'pointer', fontFamily: 'inherit',
                    transition: 'color var(--eb-transition-fast), border-color var(--eb-transition-fast)',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <PageHelpButton
            label={`How the ${TEAM_CONFIG_TAB_LABEL[activeTab] || 'team configuration'} tab works`}
            size={13}
            section={TEAM_CONFIG_TAB_HELP[activeTab] || AGENT_CHAT_HELP_SECTIONS.teamEnvironment}
            style={{ marginLeft: 'auto', flexShrink: 0, alignSelf: 'center', padding: 2 }}
          />
        </div>
      )}

      {/* #2264: a readable width cap for the form body, left-anchored (no
          auto margins) rather than centered — so dragging the sidebar's
          resize handle grows/shrinks only the right-hand whitespace and the
          form's left edge never shifts. The tab strip above stays full width
          on its own (AC4). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)', width: '100%', maxWidth: 720 }}>
      {(!isTeam || activeTab === 'general') && (
        <div>
          <div style={labelStyle}>ID (read-only)</div>
          <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id}
          </div>
        </div>
      )}

      {(!isTeam || activeTab === 'general') && (
        <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} />
      )}

      {/* The prompt is the most important thing in this form, so it sits
          directly under Display Name rather than below Plugins (#2026). Both
          blocks read fields that only exist for their own role, so each keeps
          the role guard it had inside the block it was lifted out of. */}
      {isTeam && activeTab === 'general' && (
        <div>
          <label style={labelStyle}>
            Team Default Prompt
            <span style={{ marginLeft: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-normal)' }}>
              — saved here propagates to every member that inherits.
            </span>
          </label>
          <textarea
            value={form.systemPromptTemplate}
            onChange={e => update('systemPromptTemplate', e.target.value)}
            style={{ ...inputStyle, minHeight: 160, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' }}
          />
          <div style={{ marginTop: 'var(--eb-space-1)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Prompt changes take effect from each member's next session.
          </div>
        </div>
      )}

      {/* Team-axis Parallelism, now editable from Team Settings (not only the
          Flow editor). `wipLimit`/`autoDispatch` ride on this same `agent`
          config object; the ParallelismPanel writes through PUT
          /api/agents/:teamId and, via onImmediateApply, triggers a refetch so
          the summary below reflects the saved value. An empty limit is
          "unbegrenzt" — admission control only engages when a number is set. */}
      {isTeam && activeTab === 'general' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--eb-space-2)' }}>
            <div style={labelStyle}>Parallelism (Work-in-Progress)</div>
            <SecondaryBtn onClick={() => setParallelismOpen(true)}>Edit</SecondaryBtn>
          </div>
          <div style={{ ...inputStyle, color: 'var(--eb-text-secondary)', background: 'var(--eb-bg-app)', lineHeight: 1.6 }}>
            {parallelismSummary({ wipLimit: agent.wipLimit, autoDispatch: agent.autoDispatch }).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
          <div style={helpTextStyle}>
            How many tickets this flow works on at once. Leave the limit empty for no cap (unbegrenzt).
          </div>
          {parallelismOpen && (
            <ParallelismPanel
              teamId={agent.id}
              wipLimit={Number.isInteger(agent.wipLimit) ? agent.wipLimit : null}
              autoDispatch={agent.autoDispatch || null}
              hasPooledRole={hasPooledRole}
              onClose={() => setParallelismOpen(false)}
              onChanged={() => { if (onImmediateApply) onImmediateApply({ kind: 'parallelism' }); }}
            />
          )}
        </div>
      )}

      {/* #2167/#2236: the team's environment fields, re-hosted as five of the
          flat row's own top-level tabs rather than a nested sub-strip.
          Applies immediately through its own PUT to the environment record —
          like PluginGrantSection and ContextMountControl, this does not batch
          into this form's Save button, because PUT /api/agents/:id has no
          environment fields in its whitelist. */}
      {isTeam && ENV_TAB_IDS.has(activeTab) && (
        <TeamEnvironmentPanel agent={agent} tab={activeTab} />
      )}

      {agent.role === 'team-member' && (
        <>
          <PromptModeControl
            mode={form.promptMode}
            onModeChange={v => update('promptMode', v)}
            teamPrompt={parentTeamPrompt}
            text={form.promptOverride}
            onTextChange={v => update('promptOverride', v)}
          />
          <div style={{ marginTop: 'calc(-1 * var(--eb-space-2))', marginBottom: 'var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Prompt changes take effect from this agent's next session.
          </div>
        </>
      )}

      {(isTeam ? activeTab === 'skills' : ownSkills) && (
        <div>
          <div style={labelStyle}>Skills</div>
          <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
            The agent's active skills, copied into its workspace at (re)seed time. For team agents this is the whole team's set — members inherit it unless they override.
          </div>
          <SkillPicker
            skills={grantSkills}
            selected={form.skills}
            onChange={v => update('skills', v)}
          />
        </div>
      )}

      {(!isTeam || activeTab === 'plugins') && (
        <PluginGrantSection agent={agent} parentTeam={parentTeam} alwaysVisible={isTeam} />
      )}
      {isTeam && activeTab === 'plugins' && (
        <PluginServiceAccountSection agent={agent} />
      )}

      {/* Sharing (formerly the rail's "Share…" SidePanel, relocated here as a
          tab): who may open the team and chat with it, and who may administer
          it. Self-contained — it reads the membership list and applies each
          add/role-change/remove immediately through its own endpoints, so it
          never batches into this form's Save (like the environment and plugin
          tabs). The panel itself gates its controls on `canManageMembers`, so a
          Team Member routed here sees the list read-only (D9/AC9). */}
      {isTeam && activeTab === 'sharing' && (
        <ShareTeamPanel teamId={agent.id} teamName={agent.displayName || agent.id} />
      )}

      {agent.role === 'team-member' && (
        <>
          {/* #2271, Amendment 2 A2.2 of `docs/parallel-workers-concept.md` —
              the role-axis config surface for agent pools, the agent's own
              Settings-tab half of the "one model, several surfaces"
              precedent #2272 set for the team axis. #2295 AC11/AC12: folded
              into this form's own single Save (no more second Save button —
              ScalingSection is now a controlled draft). */}
          <div style={{ paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <div style={labelStyle}>Scaling</div>
            </div>
            <ScalingSection
              draft={form.poolDraft}
              onChange={v => update('poolDraft', v)}
              parentWipLimit={parentTeam?.wipLimit}
              error={scalingError}
              live={livePoolCount(poolControl, agent.id)}
            />
          </div>

          <InheritOrCustom
            label="Skills"
            inherit={form.inheritSkills}
            onToggle={v => update('inheritSkills', v)}
            inheritedPreview={
              parentTeam && Array.isArray(parentTeam.skills) && parentTeam.skills.length
                ? `(team skills: ${parentTeam.skills.join(', ')})`
                : '(team has no skills yet)'
            }
            inheritedLabel="Inherited from the team"
            renderCustom={() => (
              <SkillPicker
                skills={grantSkills}
                selected={form.skillsOverride}
                onChange={v => update('skillsOverride', v)}
              />
            )}
          />

          <InheritOrCustom
            label="MCP Servers"
            inherit={form.inheritMcp}
            onToggle={v => updateForm(f => switchMcpMode(f, v, mcpEnv))}
            // D1: Custom starts from a copy of the inherited set, so it
            // cannot be chosen before that set is known.
            customDisabled={form.inheritMcp && !!mcpEnvId && !mcpEnv}
            inheritedPreview={inheritedMcpPreview({
              env: mcpEnv || null,
              loading: !!mcpEnvId && (mcpEnvLoading || !mcpEnv),
              servers: mcpServerData || [],
              credentials: mcpCredentialData || [],
            })}
            inheritedLabel="Inherited from team's environment"
            customMultiline
            renderCustom={() => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
                <div style={helpTextStyle}>
                  This agent's own set replaces the team environment's. Saving applies it from the
                  agent's next turn — no restart. With no rows, the agent has no MCP servers.
                </div>
                <McpServerRows
                  rows={form.mcpRows}
                  onChange={rows => update('mcpRows', rows)}
                  servers={mcpServerData || []}
                  credentials={mcpCredentialData || []}
                  loading={mcpServersLoading}
                />
                {mcpBlockers.map(b => (
                  <div key={b.field} role="alert" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
                    {b.message}
                  </div>
                ))}
              </div>
            )}
          />
        </>
      )}

      {agent.role !== 'team' && (
        <div style={{ paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
          <ContextMountControl
            agent={agent}
            confirmRestart={confirmRestart}
            onApplied={onImmediateApply ? (info => onImmediateApply({ kind: 'context-mount', ...info })) : null}
          />
        </div>
      )}

      {/* Repositories. Two controls, one topic, deliberately adjacent (#2067 D7):
          Sync pulls in what the agent's ENVIRONMENT declares, the panel below
          attaches one to THIS agent alone. The panel is the same component the
          Agent Chat Workspace view renders (AC20) and applies immediately,
          outside this form's Save — like the context-mount control above. */}
      {agent.role !== 'team' && agent.environmentId && (
        <div style={{ paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
          <div style={labelStyle}>Repositories</div>
          <SyncReposPanel
            endpoint={`/api/agents/${encodeURIComponent(agent.id)}/sync-repositories`}
            actionLabel="Sync repositories"
            description={"Clone any repositories added to this agent's Environment that are missing from its workspace. Already-cloned repositories are left untouched."}
          />
        </div>
      )}

      {agent.role !== 'team' && (
        <div style={{ paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
          <div style={labelStyle}>Additional repositories for this agent only</div>
          <AgentRepositoriesPanel
            agentId={agent.id}
            agentName={agent.displayName || agent.id}
            onChanged={onImmediateApply ? (info => onImmediateApply({ kind: 'agent-repositories', ...info })) : null}
          />
        </div>
      )}

      {showBatchedSave && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
          {scalingError && (
            <div role="alert" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
              Scaling: {scalingError}
            </div>
          )}
          {mcpBlockers.map(b => (
            <div key={b.field} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
              MCP Servers: {b.message}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <PrimaryBtn
              onClick={() => {
                const err = poolSectionError(agent, form, { parentWipLimit: parentTeam?.wipLimit });
                if (err) { setScalingError(err); return; }
                setScalingError(null);
                onSave(buildEditSubmit(agent, form, { parentWipLimit: parentTeam?.wipLimit }));
              }}
              saving={saving}
              disabled={!canSubmit}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </PrimaryBtn>
            {onCancel && <SecondaryBtn onClick={onCancel}>{cancelLabel}</SecondaryBtn>}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

// Reusable inherit/override widget for team-member fields. Single source
// of truth for the toggle styling so the prompt and skills sections look
// identical.
// Three-mode system-prompt selector for team-members (#1511): Inherit from team
// / Additional input / Exclusive overriding input. Skills and MCP keep the
// two-way InheritOrCustom widget below (unchanged, AC10).
//
//   - inherit    → the team prompt only; shown read-only (AC2).
//   - additional → an agent-specific addition appended AFTER the team prompt in a
//                  clearly delimited section; the box previews the COMBINED
//                  effective prompt (team + addition), not the addition alone
//                  (AC9).
//   - exclusive  → the agent-specific text fully replaces the team prompt (AC6).
//
// One shared text field backs both additional and exclusive, so switching
// between them keeps whatever the user typed (edge case: no silent text loss).
const readonlyPromptBoxStyle = {
  ...inputStyle,
  background: 'var(--eb-bg-app)',
  color: 'var(--eb-text-muted)',
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-sm)',
  minHeight: 100,
  whiteSpace: 'pre-wrap',
  maxHeight: 260,
  overflow: 'auto',
};

function PromptModeControl({ mode, onModeChange, teamPrompt, text, onTextChange }) {
  const modes = [PROMPT_MODES.INHERIT, PROMPT_MODES.ADDITIONAL, PROMPT_MODES.EXCLUSIVE];
  return (
    <div>
      <div style={labelStyle}>System Prompt</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-2)' }}>
        {modes.map(m => (
          <label key={m} style={radioLabelStyle}>
            <input type="radio" checked={mode === m} onChange={() => onModeChange(m)} />
            {' '}{PROMPT_MODE_LABELS[m]}
          </label>
        ))}
      </div>

      {mode === PROMPT_MODES.INHERIT && (
        <div style={readonlyPromptBoxStyle}>
          {teamPrompt ? teamPrompt : <em>(inheriting the team prompt)</em>}
        </div>
      )}

      {mode === PROMPT_MODES.ADDITIONAL && (
        <>
          <textarea
            value={text}
            onChange={e => onTextChange(e.target.value)}
            placeholder="Agent-specific instructions to append after the team prompt…"
            style={{ ...inputStyle, minHeight: 120, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' }}
          />
          <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Effective prompt preview (team prompt + your addition):
          </div>
          <div style={readonlyPromptBoxStyle}>
            {composeMemberPrompt(PROMPT_MODES.ADDITIONAL, teamPrompt, text) || <em>(the team prompt is empty)</em>}
          </div>
        </>
      )}

      {mode === PROMPT_MODES.EXCLUSIVE && (
        <textarea
          value={text}
          onChange={e => onTextChange(e.target.value)}
          placeholder="Full system prompt that replaces the team prompt…"
          style={{ ...inputStyle, minHeight: 140, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' }}
        />
      )}
    </div>
  );
}

function InheritOrCustom({
  label, inherit, onToggle, customDisabled = false,
  inheritedPreview, inheritedLabel,
  customValue, onCustomChange, customMultiline, customPlaceholder,
  renderCustom,
}) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{ display: 'flex', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-2)' }}>
        <label style={radioLabelStyle}>
          <input type="radio" checked={inherit} onChange={() => onToggle(true)} /> Inherit from team
        </label>
        <label style={radioLabelStyle}>
          <input type="radio" checked={!inherit} disabled={customDisabled} onChange={() => onToggle(false)} /> Custom
        </label>
      </div>
      {inherit ? (
        <div style={{
          ...inputStyle,
          background: 'var(--eb-bg-app)',
          color: 'var(--eb-text-muted)',
          fontFamily: 'var(--eb-font-mono)',
          fontSize: 'var(--eb-text-sm)',
          minHeight: customMultiline ? 100 : 'auto',
          whiteSpace: customMultiline ? 'pre-wrap' : 'normal',
        }}>
          {inheritedPreview ? inheritedPreview : <em>({inheritedLabel || 'inheriting'})</em>}
        </div>
      ) : renderCustom ? (
        renderCustom()
      ) : customMultiline ? (
        <textarea
          value={customValue}
          onChange={e => onCustomChange(e.target.value)}
          placeholder={customPlaceholder || ''}
          style={{ ...inputStyle, minHeight: 140, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' }}
        />
      ) : (
        <input
          type="text"
          value={customValue}
          onChange={e => onCustomChange(e.target.value)}
          placeholder={customPlaceholder || ''}
          style={inputStyle}
        />
      )}
    </div>
  );
}

const radioLabelStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--eb-space-2)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
  cursor: 'pointer',
};
