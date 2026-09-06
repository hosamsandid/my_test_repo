import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';

import { apiCall } from '../../hooks/useApi';
import { useHelperChat } from '../../context/HelperChatContext';
import ConfirmDialog from '../../components/ConfirmDialog';
import SidePanel from '../../components/SidePanel';
import { summarizeTeamAction } from '../team-action-summary.js';
import {
  ImportAgentForm, CloneAgentForm, ExtractTemplateForm,
} from '../agent-lifecycle/AgentLifecycleForms.jsx';
import {
  DisableWarningDialog, TeamDisableDialog, DeactivateWarningDialog,
  ResetToStubDialog, TeamEnableDialog, TeamActionResultDialog, renderDeleteMessage,
} from '../agent-lifecycle/AgentLifecycleDialogs.jsx';
import { deleteDialogCopy, cascadeResidueNotice } from '../agent-lifecycle/agent-lifecycle-menu.js';
import RowContextMenu from './RowContextMenu.jsx';
import {
  deleteTargetFor,
  existingIds as existingIdsOf,
  importedAgentFilterNote,
  mergeAgentConfigs,
  railMenuItems,
  teamOptions,
} from './rail-lifecycle.js';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import {
  ADD_MEMBER_TITLE, MATERIALIZE_NOW_DEFAULT, MATERIALIZE_NOW_HINT, MATERIALIZE_NOW_LABEL,
  addMemberBody, addMemberConfirmLabel, addMemberNotice,
} from './add-member-view.js';

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
 * @param {(id:string) => void} props.onOpenSettings
 *        point the rail's Settings tab (#1929) at an agent — the Phase-2
 *        replacement for Phase 1's jump to the Agents page
 * @param {(id:string) => void} props.onMarkAsUnread
 *        flip a row back to unread (#1938). A purely local view action owned by
 *        the chat page (it edits the persisted `lastViewed` map), so the host
 *        only dispatches to it — this is the one menu entry behind which there
 *        is no request at all.
 * @param {Record<string,string>} props.statuses
 *        agentId → activity state, the same map the rail renders its dots
 *        from. Read only to decide whether "Mark as unread" applies.
 * @param {(ids:Set<string>) => void} props.onBusyIdsChange
 *        report which ids currently have a mutation in flight, so the rail can
 *        show progress on the row the action was started from (#1957 AC5).
 *        Reported rather than owned by the rail: every request lives here, and
 *        a **Materialize** clones repositories, so the row must not look
 *        untouched for the length of it.
 * @param {{kind:string, id?:string}} props.listFilter
 *        the rail's current filter spec. Read for one thing only: after an
 *        import, whether the new agent is inside it (#1956 AC4) — a narrowed
 *        filter would otherwise swallow it with a success message that says it
 *        joined the list.
 *
 * Since #1956 the host is also the *owner* of the import round-trip rather than
 * one dispatch target of the (now removed) rail "+" menu: the header button
 * lives in `AgentChat`, outside this tree, so the picker is reached through the
 * imperative `openImportPicker()` handle below. The file input and the dialog
 * stay here, together, for the same reason they always were — the whole
 * round-trip lives with the dialog it opens.
 */
const RailLifecycleHost = forwardRef(function RailLifecycleHost({
  request, onClose, chatAgents, onChanged, onOpenSettings, onMarkAsUnread,
  statuses = {}, listFilter = { kind: 'all' }, onBusyIdsChange = null,
}, ref) {
  const navigate = useNavigate();
  const location = useLocation();
  const { openHelpFor } = useHelperChat();

  // The scoped `GET /api/agents` configs, loaded lazily on the first menu and
  // re-read after every mutation. The chat payload is deliberately thin (no
  // member tree), and one decision needs the fuller record: how many members a
  // team delete has to name. Until it lands the menus still work — the delete
  // dialog just cannot enumerate the members yet.
  const [configs, setConfigs] = useState(null);

  const [busyIds, setBusyIds] = useState(() => new Set());
  // Mirrored up to the rail so a row can show it (#1957). The set is already the
  // one the menu's own `busy` gate reads, so the rail's spinner and the menu's
  // greyed-out entry can never disagree about what is in flight.
  useEffect(() => { if (onBusyIdsChange) onBusyIdsChange(busyIds); }, [busyIds, onBusyIdsChange]);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);

  // Panels reuse the Agents page's forms verbatim.
  const [panelMode, setPanelMode] = useState(null); // null | 'clone' | 'extract' | 'import'
  const [panelAgent, setPanelAgent] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [extractTemplateIds, setExtractTemplateIds] = useState(() => new Set());
  const importInputRef = useRef(null);

  // The only thing this component exposes upwards: open the ZIP picker. The
  // header's `Import Agent` is one click (AC4) — the picker opens immediately
  // and the id/team dialog follows once a file is chosen, exactly as the old
  // menu entry behaved.
  useImperativeHandle(ref, () => ({
    openImportPicker() {
      setActionError(null);
      setNotice(null);
      importInputRef.current?.click();
    },
  }), []);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivateWarning, setDeactivateWarning] = useState(null);
  const [disableWarning, setDisableWarning] = useState(null);

  // Add member (#1958): the team id whose add-member dialog is open, plus the
  // "Materialize now" checkbox state. A dialog rather than the old bare POST
  // because the choice between "clone the repo and start it now" and "config
  // only" cannot be inferred, and getting it wrong costs a clone either way.
  const [addMemberTeamId, setAddMemberTeamId] = useState(null);
  const [addMemberMaterialize, setAddMemberMaterialize] = useState(MATERIALIZE_NOW_DEFAULT);

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

  // The lazy load is triggered by opening a menu, not by mounting the chat: a
  // user who never opens one pays for no request.
  useEffect(() => {
    if (!request) return;
    if (configs === null) loadConfigs();
  }, [request, configs, loadConfigs]);

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

  // The row's activity state, from the same poll the rail's dots read (#1938).
  // Taken from the *request's* agent rather than the merged config list: only
  // the chat's own status map knows a row is unread, and only the row the menu
  // was opened for matters.
  const activityState = request?.target?.kind === 'agent'
    ? (statuses[request.target.agent?.id] || 'idle')
    : 'idle';

  const menu = useMemo(
    () => railMenuItems({ target: request?.target, agents, busyIds, activityState }),
    [request, agents, busyIds, activityState],
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
      // See Agents.jsx: `cascadeWarnings` names the members a team delete could
      // not remove. Same helper on both surfaces so the two never word the same
      // residue differently (#1960 AC2).
      const result = await apiCall('DELETE', `/api/agents/${encodeURIComponent(deleteTarget.id)}`);
      setDeleteTarget(null);
      const residue = cascadeResidueNotice(result);
      if (residue) setActionError(residue);
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
      // The new agent joins the list from the refreshed payload — no reload
      // (#1928 AC3). Whether it is actually *visible* also depends on the rail
      // filter, which the header button that started this knows nothing about
      // (#1956 AC4), so say so rather than let it land out of sight.
      const hidden = importedAgentFilterNote(listFilter, data.agentId, data.parentTeamId);
      setNotice(
        `Agent '${data.agentId}' imported${data.parentTeamId ? ` into team '${data.parentTeamId}'` : ''} and started.`
        + (hidden || ''),
      );
      setImportFile(null);
      closePanel();
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

  // Opens the dialog. The checkbox resets to its default on every open, so a
  // deliberate deferral last time cannot silently defer the next member too.
  function openAddMember(teamId) {
    if (!teamId) return;
    setActionError(null);
    setAddMemberMaterialize(MATERIALIZE_NOW_DEFAULT);
    setAddMemberTeamId(teamId);
  }

  async function addMemberConfirmed() {
    const teamId = addMemberTeamId;
    if (!teamId) return;
    markBusy(teamId, true);
    try {
      const result = await apiCall(
        'POST',
        `/api/agents/${encodeURIComponent(teamId)}/members`,
        addMemberBody({ materializeNow: addMemberMaterialize }),
      );
      setAddMemberTeamId(null);
      refresh();
      // Both modes now say what happened: a stub create looks like a no-op in
      // the rail otherwise (the row appears in a collapsed section, #1957).
      setNotice(addMemberNotice(result));
    } catch (e) {
      // Close the dialog on failure too, exactly as confirmDelete does: the
      // error goes to a RailToast, which portals at zIndex 1200 while this
      // dialog's overlay is fixed at 9999 — left open, the dialog would bury
      // its own error message under the backdrop and swallow the click that
      // dismisses it.
      setActionError(e.message);
      setAddMemberTeamId(null);
    } finally {
      markBusy(teamId, false);
    }
  }

  // ------------------------------------------------------------------ dispatch

  function choose(kind) {
    const target = request?.target;
    setActionError(null);
    setNotice(null);

    // #1972: the menu's own "?" — a menu cannot host a PageHelpButton (its
    // entries are index-walked for keyboard traversal), so the affordance is an
    // entry that opens the help panel at the agent-list chapter. Handled before
    // the per-target switches because it means the same thing on every menu.
    if (kind === 'help') {
      openHelpFor(location.pathname, { section: AGENT_CHAT_HELP_SECTIONS.agentList });
      return;
    }

    if (target?.kind === 'agent') {
      // Act on the fullest record we have — the merged config carries the
      // `children` a team delete has to name.
      const agent = agents.find(a => a && a.id === target.agent.id) || target.agent;
      switch (kind) {
        // A local view action, not a mutation (#1938): it flips the row's
        // indicator and drops the id from the persisted `lastViewed` map, which
        // is the chat page's state — hence the callback rather than a request.
        case 'mark-unread':       if (onMarkAsUnread) onMarkAsUnread(agent.id); break;
        case 'toggle-enabled':    toggleEnabled(agent); break;
        // Configuration stays in the chat (#1929): the rail's Settings tab
        // renders this very agent's edit form, so there is nowhere to navigate.
        case 'settings':          if (onOpenSettings) onOpenSettings(agent.id); break;
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
        // Never straight to the request (#1958): the dialog carries the
        // materialize-now choice, so this opens it like every other entry
        // whose label ends in an ellipsis.
        case 'add-member':       openAddMember(teamId); break;
        // Phase 2 (#1929) answers open question 3 the other way round: the
        // team's own edit form now renders in the rail's Settings tab, so this
        // opens it there instead of leaving the chat for the Agents page.
        case 'edit-team':        if (onOpenSettings && teamId) onOpenSettings(teamId); break;
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

      {/* The "Import Agent" file picker, opened from the page-action header via
          `openImportPicker()` (#1956). Kept here, not next to the button, so the
          whole import round-trip lives with the dialog it opens. */}
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

      {/* Add member (#1958). Reuses the generic ConfirmDialog — its `message`
          takes a ReactNode, so the checkbox row lives in the body rather than
          needing a bespoke dialog component for one control. */}
      <ConfirmDialog
        open={!!addMemberTeamId}
        title={ADD_MEMBER_TITLE}
        variant="info"
        busy={busyIds.has(addMemberTeamId)}
        confirmLabel={addMemberConfirmLabel({
          busy: busyIds.has(addMemberTeamId),
          materializeNow: addMemberMaterialize,
        })}
        message={(
          <>
            <p style={{ margin: '0 0 var(--eb-space-3)' }}>
              Adds a member to <strong>{addMemberTeamId}</strong>.
            </p>
            <label style={addMemberCheckboxRow}>
              <input
                type="checkbox"
                checked={addMemberMaterialize}
                onChange={e => setAddMemberMaterialize(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>{MATERIALIZE_NOW_LABEL}</strong> — {MATERIALIZE_NOW_HINT}
              </span>
            </label>
          </>
        )}
        onConfirm={addMemberConfirmed}
        onCancel={() => setAddMemberTeamId(null)}
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
});

export default RailLifecycleHost;

// The wrapping variant of the team-create wizard's `checkboxRow`
// (`process/LaunchStep.jsx`) — same tokens, same `flex-start` + `marginTop: 3`
// pairing on the input, so the two "Materialize now" checkboxes look alike.
const addMemberCheckboxRow = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)',
  lineHeight: 1.5,
};

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
