import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { apiCall } from '../../hooks/useApi';
import ConfirmDialog from '../../components/ConfirmDialog';
import SidePanel from '../../components/SidePanel';
import { inferMissingRoles } from '../missing-roles-view.js';
import { summarizeTeamAction } from '../team-action-summary.js';
import {
  ImportAgentForm, CloneAgentForm, ExtractTemplateForm,
} from '../agent-lifecycle/AgentLifecycleForms.jsx';
import {
  DisableWarningDialog, TeamDisableDialog, DeactivateWarningDialog,
  ResetToStubDialog, TeamEnableDialog, TeamActionResultDialog, renderDeleteMessage,
} from '../agent-lifecycle/AgentLifecycleDialogs.jsx';
import { deleteDialogCopy } from '../agent-lifecycle/agent-lifecycle-menu.js';
import RowContextMenu from './RowContextMenu.jsx';
import {
  deleteTargetFor,
  existingIds as existingIdsOf,
  mergeAgentConfigs,
  parseMenuKey,
  railMenuItems,
  teamOptions,
} from './rail-lifecycle.js';

/**
 * RailLifecycleHost — the Agent Chat left rail's lifecycle quick actions
 * (#1928, epic #1925 Phase 1).
 *
 * The rail itself (`AgentList`) stays presentational: it reports *that* a menu
 * was asked for and for which row, and this host decides what the menu contains,
 * renders it, and owns every dialog and API call behind it. That split is what
 * keeps the performance-sensitive row components (`React.memo`, stable id-taking
 * callbacks) free of lifecycle state.
 *
 * Nothing here is a second implementation of the Agents page: the menus come
 * from the pure `agent-lifecycle-menu.js` descriptors, the dialogs and forms are
 * the very components the Agents page renders (`agent-lifecycle/`), and the
 * request sequences below mirror that page's handlers step for step — including
 * the two-phase disable (probe → drain/abort dialog on a 409 warning) and the
 * team fan-out's partial-failure report. A quick action that behaved differently
 * in the chat than on the page would be the same irreversible operation wearing
 * two different warnings.
 *
 * @param {{target:object,anchor:{x:number,y:number}}|null} props.request
 *        the open menu request, or null when no menu is open
 * @param {() => void} props.onClose        close the menu
 * @param {object[]}   props.chatAgents     the chat's own list (`/api/matrix/agents`)
 * @param {() => void} props.onChanged      re-read that list after a mutation
 */
export default function RailLifecycleHost({ request, onClose, chatAgents, onChanged }) {
  const navigate = useNavigate();

  // The scoped `GET /api/agents` configs, loaded lazily on the first menu and
  // re-read after every mutation. The chat payload is deliberately thin (no
  // label registry, no member tree), and two decisions need the fuller record:
  // which loop-closing roles a team is missing, and how many members a team
  // delete has to name. Until it lands the menus still work — they just cannot
  // offer the add-role entries yet.
  const [configs, setConfigs] = useState(null);
  const [templates, setTemplates] = useState([]);

  const [busyIds, setBusyIds] = useState(() => new Set());
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);

  // Panels reuse the Agents page's forms verbatim.
  const [panelMode, setPanelMode] = useState(null); // null | 'clone' | 'extract' | 'import'
  const [panelAgent, setPanelAgent] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [extractTemplateIds, setExtractTemplateIds] = useState(() => new Set());
  const importInputRef = useRef(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivateWarning, setDeactivateWarning] = useState(null);
  const [disableWarning, setDisableWarning] = useState(null);

  const [teamActionPrompt, setTeamActionPrompt] = useState(null);
  const [teamActionBusy, setTeamActionBusy] = useState(false);
  const [teamActionError, setTeamActionError] = useState(null);
  const [teamActionResult, setTeamActionResult] = useState(null);

  const agents = useMemo(() => mergeAgentConfigs(chatAgents, configs), [chatAgents, configs]);

  const loadConfigs = useCallback(async () => {
    try {
      const list = await apiCall('GET', '/api/agents');
      setConfigs(Array.isArray(list) ? list : []);
    } catch { /* menus degrade to the chat payload; the server still decides */ }
  }, []);

  // Both lazy loads are triggered by opening a menu, not by mounting the chat:
  // a user who never opens one pays for neither request.
  useEffect(() => {
    if (!request) return;
    if (configs === null) loadConfigs();
    if (request.target?.kind === 'team' && templates.length === 0) {
      (async () => {
        try {
          const { templates: list } = await apiCall('GET', '/api/process-templates');
          const full = await Promise.all((Array.isArray(list) ? list : []).map(
            t => apiCall('GET', `/api/process-templates/${encodeURIComponent(t.id)}`).catch(() => null),
          ));
          setTemplates(full.filter(Boolean));
        } catch { /* no templates → no add-role entries, the rest of the menu stands */ }
      })();
    }
  }, [request, configs, loadConfigs, templates.length]);

  /** Re-read both the chat list and our configs after a mutation. */
  const refresh = useCallback(() => {
    if (onChanged) onChanged();
    loadConfigs();
  }, [onChanged, loadConfigs]);

  function markBusy(id, busy) {
    setBusyIds(prev => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  }

  function closePanel() {
    setPanelMode(null);
    setPanelAgent(null);
  }

  // ---------------------------------------------------------------- menu model

  const missingRoles = useMemo(() => {
    if (request?.target?.kind !== 'team') return [];
    const teamId = request.target.group?.id;
    if (!teamId) return [];
    const team = agents.find(a => a && a.id === teamId && a.role === 'team');
    if (!team) return [];
    const members = agents.filter(a => a && a.parentTeamId === teamId);
    const inferred = inferMissingRoles(team, members, templates);
    return inferred ? inferred.missing : [];
  }, [request, agents, templates]);

  const menu = useMemo(
    () => railMenuItems({ target: request?.target, agents, busyIds, missingRoles }),
    [request, agents, busyIds, missingRoles],
  );

  // --------------------------------------------------------------- per-agent

  async function toggleEnabled(agent) {
    markBusy(agent.id, true);
    try {
      if (agent.enabled !== false) {
        // Probe without a mode first: the orchestrator answers 409 + a warning
        // payload when the agent is mid-run, which is what opens the
        // drain-vs-abort dialog instead of cutting a running turn (AC edge case).
        const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data.warning) {
          setDisableWarning({ agent, busy: data.busy, activeTriggers: data.activeTriggers || [] });
          return;
        }
        if (!res.ok) { setActionError(data.error || `HTTP ${res.status}`); return; }
      } else {
        await apiCall('PUT', `/api/agents/${encodeURIComponent(agent.id)}`, { enabled: true });
      }
      refresh();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  async function disableConfirmed(mode) {
    const { agent } = disableWarning;
    setDisableWarning(null);
    markBusy(agent.id, true);
    try {
      await apiCall('PUT', `/api/agents/${encodeURIComponent(agent.id)}`, { enabled: false, disableMode: mode });
      refresh();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  async function deactivateConfirmed() {
    const target = deactivateTarget;
    setDeactivateTarget(null);
    if (!target) return;
    markBusy(target.id, true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(target.id)}/deactivate`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.warning) {
        setDeactivateWarning({ agent: target, busy: data.busy, activeTriggers: data.activeTriggers || [] });
        return;
      }
      if (!res.ok) { setActionError(data.error || `HTTP ${res.status}`); return; }
      refresh();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(target.id, false);
    }
  }

  async function deactivateMode(mode) {
    const { agent } = deactivateWarning;
    setDeactivateWarning(null);
    markBusy(agent.id, true);
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(agent.id)}/deactivate`, { mode });
      refresh();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  async function confirmDelete() {
    setDeleteBusy(true);
    try {
      await apiCall('DELETE', `/api/agents/${encodeURIComponent(deleteTarget.id)}`);
      setDeleteTarget(null);
      refresh();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function openExtractPanel(agent) {
    let ids = new Set();
    try {
      const { templates: list } = await apiCall('GET', '/api/agent-templates');
      ids = new Set((Array.isArray(list) ? list : []).map(t => t.id));
    } catch { /* server still guards uniqueness with a 409 */ }
    setExtractTemplateIds(ids);
    setPanelAgent(agent);
    setPanelMode('extract');
  }

  // Both submit handlers return the parsed response so the shared forms can
  // react to a 409 id-conflict (re-suggest an id) without closing.
  async function submitClone({ newId, newDisplayName, parentTeamId }) {
    const resp = await fetch(`/api/agents/${encodeURIComponent(panelAgent.id)}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newId, newDisplayName, parentTeamId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) { closePanel(); refresh(); }
    return { ok: resp.ok, status: resp.status, data };
  }

  async function submitExtract(form) {
    const resp = await fetch(`/api/agents/${encodeURIComponent(panelAgent.id)}/extract-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await resp.json().catch(() => ({}));
    // Deliberately left open on success: the shared form renders its own
    // "saved as <id>" confirmation, exactly as on the Agents page.
    return { ok: resp.ok, status: resp.status, data };
  }

  async function submitImport({ newId, parentTeamId }) {
    const formData = new FormData();
    formData.append('file', importFile);
    if (newId) formData.append('newId', newId);
    if (parentTeamId) formData.append('parentTeamId', parentTeamId);
    const resp = await fetch('/api/agents/import', { method: 'POST', body: formData });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      setNotice(`Agent '${data.agentId}' imported${data.parentTeamId ? ` into team '${data.parentTeamId}'` : ''} and started.`);
      setImportFile(null);
      closePanel();
      // The new agent joins the list from the refreshed payload — no reload (AC3).
      refresh();
    }
    return { ok: resp.ok, status: resp.status, data };
  }

  function onImportFilePicked(e) {
    const file = e.target.files?.[0];
    if (importInputRef.current) importInputRef.current.value = '';
    if (!file) return;
    setActionError(null);
    setImportFile(file);
    setPanelAgent(null);
    setPanelMode('import');
  }

  // ----------------------------------------------------------------- per-team

  async function toggleTeam(team) {
    const action = team.enabled === false ? 'enable' : 'disable';
    setTeamActionError(null);
    try {
      const { members } = await apiCall('GET', `/api/teams/${encodeURIComponent(team.id)}/members`);
      setTeamActionPrompt({ team, action, members });
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function teamActionConfirmed(action, mode) {
    const { team, members } = teamActionPrompt;
    setTeamActionBusy(true);
    setTeamActionError(null);
    try {
      const result = await apiCall(
        'POST',
        `/api/teams/${encodeURIComponent(team.id)}/${action}`,
        action === 'disable' ? { mode } : {},
      );
      const summary = summarizeTeamAction(result, members);
      setTeamActionPrompt(null);
      refresh();
      // Partial failures are reported exactly as on the Agents page (AC2).
      if (summary.failedMembers.length > 0) setTeamActionResult({ action, ...summary });
    } catch (e) {
      setTeamActionError(e.message);
    } finally {
      setTeamActionBusy(false);
    }
  }

  async function addMember(teamId) {
    markBusy(teamId, true);
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(teamId)}/members`);
      refresh();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(teamId, false);
    }
  }

  // Add a loop-closing role from the team's inferred source template (#1375),
  // then disable the fresh member so nothing wakes until the operator says so.
  async function addRole(teamId, roleId) {
    const role = missingRoles.find(r => r.id === roleId) || { id: roleId };
    const templateId = inferMissingRoles(
      agents.find(a => a && a.id === teamId),
      agents.filter(a => a && a.parentTeamId === teamId),
      templates,
    )?.templateId;
    if (!templateId) { setActionError('No source process template could be inferred for this team.'); return; }
    markBusy(teamId, true);
    setActionError(null);
    try {
      const created = await apiCall('POST', `/api/agents/${encodeURIComponent(teamId)}/members`, {
        processTemplateId: templateId,
        roleId: role.id,
      });
      const memberId = (created && created.id) || `${teamId}-${role.id}`;
      try {
        await apiCall('PUT', `/api/agents/${encodeURIComponent(memberId)}`, { enabled: false });
      } catch { /* role is added; leave the enable state to the operator */ }
      setNotice(`Added ${role.displayName || role.id} (disabled). Enable it when you're ready to close the loop.`);
      refresh();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(teamId, false);
    }
  }

  // ------------------------------------------------------------------ dispatch

  function choose(key) {
    const target = request?.target;
    const { kind, arg } = parseMenuKey(key);
    setActionError(null);
    setNotice(null);

    if (target?.kind === 'create') {
      if (kind === 'new-agent') navigate('/create');
      if (kind === 'import-agent') importInputRef.current?.click();
      return;
    }

    if (target?.kind === 'agent') {
      // Act on the fullest record we have — the merged config carries the
      // `children` a team/orchestrator delete has to name.
      const agent = agents.find(a => a && a.id === target.agent.id) || target.agent;
      switch (kind) {
        case 'toggle-enabled':    toggleEnabled(agent); break;
        case 'clone':             setPanelAgent(agent); setPanelMode('clone'); break;
        case 'export':            window.open(`/api/agents/${encodeURIComponent(agent.id)}/export`, '_blank'); break;
        case 'extract-template':  openExtractPanel(agent); break;
        case 'reset-to-stub':     setDeactivateTarget(agent); break;
        case 'delete':            setDeleteTarget(deleteTargetFor(agent, agents)); break;
        default: break;
      }
      return;
    }

    if (target?.kind === 'team') {
      const teamId = target.group?.id;
      const team = agents.find(a => a && a.id === teamId && a.role === 'team') || null;
      switch (kind) {
        case 'toggle-team':      if (team) toggleTeam(team); break;
        case 'add-member':       addMember(teamId); break;
        case 'add-role':         if (arg) addRole(teamId, arg); break;
        // Phase 1 answer to open question 3: navigate to the existing edit
        // surface rather than grow a second copy of the form in the chat.
        case 'edit-team':        navigate('/agents'); break;
        case 'export-team':      window.open(`/api/agents/${encodeURIComponent(teamId)}/export`, '_blank'); break;
        case 'open-flow-editor': navigate(`/flows?proc=${encodeURIComponent(teamId)}`); break;
        case 'delete-team':      if (team) setDeleteTarget(deleteTargetFor(team, agents)); break;
        default: break;
      }
    }
  }

  const teams = useMemo(() => teamOptions(agents), [agents]);
  const existingIds = useMemo(() => existingIdsOf(agents), [agents]);

  return (
    <>
      {request && menu.items.length > 0 && (
        <RowContextMenu
          items={menu.items}
          label={menu.label}
          anchor={request.anchor}
          onChoose={choose}
          onClose={onClose}
        />
      )}

      {/* The rail's "Import agent" file picker. Kept here (not in the rail
          header) so the whole import round-trip lives with the dialog it opens. */}
      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip"
        style={{ display: 'none' }}
        onChange={onImportFilePicked}
      />

      <SidePanel
        open={panelMode === 'import'}
        onClose={() => { setImportFile(null); closePanel(); }}
        title="Import Agent"
        width="480px"
      >
        {panelMode === 'import' && importFile && (
          <ImportAgentForm
            file={importFile}
            teams={teams}
            onSubmit={submitImport}
            onCancel={() => { setImportFile(null); closePanel(); }}
          />
        )}
      </SidePanel>

      <SidePanel
        open={panelMode === 'clone' && !!panelAgent}
        onClose={closePanel}
        title={`Clone Agent — ${panelAgent?.displayName ?? ''}`}
        width="480px"
      >
        {panelMode === 'clone' && panelAgent && (
          <CloneAgentForm
            agent={panelAgent}
            teams={teams}
            existingIds={existingIds}
            onSubmit={submitClone}
            onCancel={closePanel}
          />
        )}
      </SidePanel>

      <SidePanel
        open={panelMode === 'extract' && !!panelAgent}
        onClose={closePanel}
        title={`Save as template — ${panelAgent?.displayName ?? ''}`}
        width="480px"
      >
        {panelMode === 'extract' && panelAgent && (
          <ExtractTemplateForm
            agent={panelAgent}
            existingTemplateIds={extractTemplateIds}
            onSubmit={submitExtract}
            onCancel={closePanel}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title={deleteDialogCopy(deleteTarget).title}
        message={renderDeleteMessage(deleteTarget)}
        variant="danger"
        confirmLabel={deleteDialogCopy(deleteTarget).confirmLabel}
        maxWidth={deleteDialogCopy(deleteTarget).maxWidth}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        busy={deleteBusy}
      />

      <ResetToStubDialog
        open={!!deactivateTarget}
        agent={deactivateTarget}
        onConfirm={deactivateConfirmed}
        onCancel={() => setDeactivateTarget(null)}
      />

      <DisableWarningDialog
        open={!!disableWarning}
        agent={disableWarning?.agent}
        busy={disableWarning?.busy}
        activeTriggers={disableWarning?.activeTriggers}
        onDrain={() => disableConfirmed('drain')}
        onAbort={() => disableConfirmed('abort')}
        onCancel={() => setDisableWarning(null)}
      />

      <DeactivateWarningDialog
        open={!!deactivateWarning}
        agent={deactivateWarning?.agent}
        busy={deactivateWarning?.busy}
        activeTriggers={deactivateWarning?.activeTriggers}
        onDrain={() => deactivateMode('drain')}
        onHardStop={() => deactivateMode('hard-stop')}
        onCancel={() => setDeactivateWarning(null)}
      />

      <TeamEnableDialog
        open={!!teamActionPrompt && teamActionPrompt.action === 'enable'}
        team={teamActionPrompt?.team}
        members={teamActionPrompt?.members}
        error={teamActionError}
        busy={teamActionBusy}
        onConfirm={() => teamActionConfirmed('enable')}
        onCancel={() => { setTeamActionPrompt(null); setTeamActionError(null); }}
      />

      <TeamDisableDialog
        open={!!teamActionPrompt && teamActionPrompt.action === 'disable'}
        team={teamActionPrompt?.team}
        members={teamActionPrompt?.members || []}
        error={teamActionError}
        busy={teamActionBusy}
        onDrain={() => teamActionConfirmed('disable', 'drain')}
        onAbort={() => teamActionConfirmed('disable', 'abort')}
        onCancel={() => { setTeamActionPrompt(null); setTeamActionError(null); }}
      />

      <TeamActionResultDialog
        result={teamActionResult}
        onClose={() => setTeamActionResult(null)}
      />

      <RailToast text={actionError} tone="error" onClose={() => setActionError(null)} />
      <RailToast text={notice} tone="success" onClose={() => setNotice(null)} />
    </>
  );
}

/**
 * A quick action's outcome, reported where the rail can see it.
 *
 * The Agents page can afford an inline banner above its cards; the rail is a
 * narrow scrolling column whose top is often out of view, so a failed Delete
 * would scroll away unread. Portaled to the corner instead, and dismissible —
 * an error is never auto-hidden.
 */
function RailToast({ text, tone, onClose }) {
  if (!text) return null;
  const error = tone === 'error';
  return createPortal(
    <div
      role={error ? 'alert' : 'status'}
      style={{
        position: 'fixed',
        left: 'var(--eb-space-4)',
        bottom: 'var(--eb-space-4)',
        maxWidth: 380,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        borderRadius: 'var(--eb-radius-md)',
        border: `1px solid ${error ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
        background: 'var(--eb-bg-surface)',
        boxShadow: 'var(--eb-shadow-lg)',
        color: error ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)',
        fontSize: 'var(--eb-text-xs)',
        lineHeight: 1.5,
        zIndex: 1200,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: 'inherit', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
