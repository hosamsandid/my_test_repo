import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, ArrowLeft, RefreshCw } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import AgentEditForm from '../agent-lifecycle/AgentEditForm.jsx';
import { isFormDirty } from '../agent-lifecycle/agent-edit-form-model.js';
import {
  savedNoticeText, restartNoticeText, unsavedDraftNotice,
  putDraft, getDraft, dropDraft,
} from './agent-settings-view.js';

/**
 * Right-rail **Settings** tab (#1929, epic #1925 Phase 2) — the agent's
 * configuration where you see its effect.
 *
 * The form is not re-implemented here: it is the Agents page's own
 * `AgentEditForm`, moved into `pages/agent-lifecycle/` so both surfaces render
 * the one component (AC7). This panel is the chat-side host around it —
 * loading the full config, owning the PUT, and answering the three questions a
 * side panel on a separate page never had to (see `agent-settings-view.js`).
 *
 * **Why a fetch at all.** The rail's agent list is `/api/matrix/agents`, a
 * deliberately thin per-row payload (id, role, membership, `canManage`…) with
 * none of the configuration fields. `GET /api/agents/:id` is the same record
 * the Agents page edits, so the two surfaces save an identical body (AC2).
 * Fetched only while the tab is `active`: the rail keeps every panel mounted
 * behind `display:none`, so an unconditional fetch would pull a config on every
 * agent switch for a tab nobody opened.
 *
 * **Unsaved edits survive an agent switch** (AC6). `agentId` changing does not
 * unmount this panel, so the per-agent draft map in `draftsRef` outlives the
 * switch and the form is remounted from the draft it was left in, behind an
 * explicit "unsaved changes" banner with a Discard. Nothing is lost silently
 * and nothing blocks the list click.
 */
export default function AgentSettingsPanel({
  agentId, active, chatAgentId = null, chatAgentName = '', onBackToChatAgent = null, onSaved = null,
}) {
  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [notice, setNotice] = useState('');

  // agentId -> in-progress form state. A ref, not state: it must not re-render
  // the form on every keystroke (the form owns its own field state), it only
  // has to be there when the form is remounted for that agent again.
  const draftsRef = useRef({});
  // Bumped to force a fresh mount of the form — after a save, and after a
  // discard, both of which mean "re-derive the fields from the config".
  const [formEpoch, setFormEpoch] = useState(0);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async (id) => {
    if (!id) { setAgent(null); setError(null); return; }
    setLoading(true);
    setError(null);
    try {
      setAgent(await apiCall('GET', `/api/agents/${encodeURIComponent(id)}`));
    } catch (e) {
      setAgent(null);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    setNotice('');
    setSaveError(null);
    load(agentId);
  }, [agentId, active, load]);

  // The banner has to be right the moment the tab opens on an agent whose draft
  // was left dirty earlier — before the user has touched a single field.
  useEffect(() => {
    setDirty(agent ? isFormDirty(agent, getDraft(draftsRef.current, agent.id)) : false);
  }, [agent]);

  const handleFormChange = useCallback((form) => {
    if (!agent) return;
    draftsRef.current = putDraft(draftsRef.current, agent.id, form);
    setDirty(isFormDirty(agent, form));
  }, [agent]);

  const discard = useCallback(() => {
    if (!agent) return;
    draftsRef.current = dropDraft(draftsRef.current, agent.id);
    setDirty(false);
    setSaveError(null);
    setNotice('');
    setFormEpoch(e => e + 1);
  }, [agent]);

  const handleSave = useCallback(async (body) => {
    if (!agent) return;
    setSaving(true);
    setSaveError(null);
    setNotice('');
    try {
      await apiCall('PUT', `/api/agents/${encodeURIComponent(agent.id)}`, body);
      draftsRef.current = dropDraft(draftsRef.current, agent.id);
      setDirty(false);
      setNotice(savedNoticeText(agent));
      // Re-read first, THEN remount: the form derives its fields from `agent`
      // on mount only, so bumping the epoch before the reload would rebuild it
      // from the pre-save config and hide any normalisation the API applied.
      await load(agent.id);
      setFormEpoch(e => e + 1);
      // The rail lists display names, and a team save propagates to members —
      // let the page refetch rather than leaving a stale label behind.
      if (onSaved) onSaved();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }, [agent, load, onSaved]);

  // A mount change re-provisions the container, which is a visible event in the
  // conversation the user is looking at — say what happened rather than leaving
  // the chat looking frozen (AC4).
  const handleImmediateApply = useCallback((info) => {
    setNotice(restartNoticeText(info));
    if (onSaved) onSaved();
  }, [onSaved]);

  const showBack = !!(onBackToChatAgent && chatAgentId && agent && agent.id !== chatAgentId);

  const toolbar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-2) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      flexShrink: 0, background: 'var(--eb-bg-surface)', minHeight: 36,
    }}>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {loading && !agent
          ? 'Loading…'
          : agent
            ? `${agent.displayName || agent.id} · ${agent.role}`
            : agentId ? '' : 'No agent selected'}
      </span>
      {showBack && (
        <button
          onClick={onBackToChatAgent}
          title={`Back to ${chatAgentName || 'the open chat'}`}
          style={{
            background: 'none', border: 'none', color: 'var(--eb-text-muted)',
            cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center',
            gap: 4, fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
          }}
        >
          <ArrowLeft size={12} /> Back
        </button>
      )}
      <button
        onClick={() => load(agentId)}
        disabled={loading || !agentId}
        title="Reload the stored configuration"
        style={{
          background: 'none', border: 'none', color: 'var(--eb-text-muted)',
          cursor: agentId ? 'pointer' : 'default', padding: 2,
          display: 'flex', alignItems: 'center',
          opacity: (!agentId || loading) ? 0.4 : 1,
        }}
      >
        <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
      </button>
      {/* #1972: this tab's "?" — the draft-keeping, the apply-immediately fields
          and why the tab can point at another agent. Like Outcomes it is a
          conditional tab, so the "?" is only ever there with the surface. */}
      <PageHelpButton
        label="How the Settings tab behaves"
        size={13}
        section={AGENT_CHAT_HELP_SECTIONS.settings}
        style={{ padding: 2 }}
      />
    </div>
  );

  if (!agentId) {
    return (
      <div style={panelBox}>
        {toolbar}
        <div style={centered}>Select an agent to edit its configuration.</div>
      </div>
    );
  }

  return (
    <div style={panelBox}>
      {toolbar}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && !agent && (
          <div style={{ ...centered, gap: 'var(--eb-space-2)', flexDirection: 'row', padding: 'var(--eb-space-6)' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            Loading configuration…
          </div>
        )}

        {error && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-4)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            {error}
          </div>
        )}

        {!error && agent && (
          <div style={{ padding: 'var(--eb-space-4)' }}>
            {dirty && (
              <div style={{
                marginBottom: 'var(--eb-space-3)', padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'var(--eb-status-warning-bg)',
                border: '1px solid var(--eb-status-warning)',
                borderRadius: 'var(--eb-radius-md)',
                fontSize: 'var(--eb-text-xs)', lineHeight: 1.5,
                color: 'var(--eb-text-primary)',
              }}>
                {unsavedDraftNotice(true)}
              </div>
            )}
            {notice && !dirty && (
              <div style={{
                marginBottom: 'var(--eb-space-3)', padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'var(--eb-bg-elevated)',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                fontSize: 'var(--eb-text-xs)', lineHeight: 1.5,
                color: 'var(--eb-text-muted)',
              }}>
                {notice}
              </div>
            )}
            <AgentEditForm
              key={`${agent.id}:${formEpoch}`}
              agent={agent}
              initialForm={getDraft(draftsRef.current, agent.id)}
              onFormChange={handleFormChange}
              onSave={handleSave}
              // "Cancel" would have nothing to close in a tab — the reversible
              // action here is throwing the draft away, and only while there is
              // one to throw.
              onCancel={dirty ? discard : null}
              cancelLabel="Discard changes"
              saving={saving}
              error={saveError}
              confirmRestart
              onImmediateApply={handleImmediateApply}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const panelBox = {
  height: '100%', display: 'flex', flexDirection: 'column',
  background: 'var(--eb-bg-app)', minHeight: 0,
};

const centered = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
  padding: 'var(--eb-space-6)', textAlign: 'center',
};
