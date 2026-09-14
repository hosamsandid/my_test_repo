import React, { useState } from 'react';
import { apiCall } from '../../hooks/useApi';
import {
  scalingPrerequisite,
  parseMaxInstancesInput,
  parseMinutesInput,
  msToMinutesText,
  buildPoolPayload,
} from './scaling-view.js';

// Role-axis config surface for agent pools (#2271, Amendment 2 A2.2 of
// `docs/parallel-workers-concept.md`): "This role auto-scales" (pool.enabled),
// max parallel instances, teardown timeouts. Shared by the Flow editor's
// NodeInspector (a live team-member node's Details tab) and the agent's own
// Settings tab (AgentEditForm), per #2272's "one model, several surfaces"
// precedent — one component, two hosts, so they never drift.
// Self-contained with its own Save (mirrors NodeInspector's LivePromptEditor),
// not a SidePanel — both hosts embed it inline inside an existing panel.
// Writes through the live `pool` route (#2270, `PUT /api/agents/:memberId`).
// `parentWipLimit` is passed in by the caller (both hosts already hold the
// parent team's config), never fetched here.
// No workspace binding control here (#2294): every pooled role is created
// implicitly as `git-clean-base` (`buildPoolPayload`'s default in
// `scaling-view.js`) — the other two `pool.workspace` values (`input-copy`,
// `none`) stay fully functional server-side but have no UI anywhere to
// configure the `pool.workSource` they'd need, so offering them here would
// be a selectable option that silently does nothing.
export default function ScalingSection({ agentId, pool, parentWipLimit, onChanged }) {
  const [enabled, setEnabled] = useState(!!(pool && pool.enabled === true));
  const [maxInstancesText, setMaxInstancesText] = useState(
    pool && Number.isInteger(pool.maxInstances) ? String(pool.maxInstances) : ''
  );
  const [idleText, setIdleText] = useState(msToMinutesText(pool?.teardown?.idleTimeoutMs));
  const [hardText, setHardText] = useState(msToMinutesText(pool?.teardown?.maxRuntimeMs));
  const [retainText, setRetainText] = useState(msToMinutesText(pool?.teardown?.retainLogsMs));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const maxInstances = parseMaxInstancesInput(maxInstancesText);
  const idle = parseMinutesInput(idleText);
  const hard = parseMinutesInput(hardText);
  const retain = parseMinutesInput(retainText);
  const prereq = scalingPrerequisite({ parentWipLimit });
  const parseError = maxInstances.error || idle.error || hard.error || retain.error;
  const blocked = !!parseError || (enabled && !prereq.ok);

  const dirty = () => { setSaved(false); };

  const save = async () => {
    if (blocked || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiCall('PUT', `/api/agents/${agentId}`, {
        pool: buildPoolPayload({
          enabled,
          maxInstances: maxInstances.value,
          idleTimeoutMs: idle.value,
          maxRuntimeMs: hard.value,
          retainLogsMs: retain.value,
        }),
      });
      setSaved(true);
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', cursor: (enabled || prereq.ok) ? 'pointer' : 'not-allowed' }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!enabled && !prereq.ok}
          onChange={(e) => { setEnabled(e.target.checked); dirty(); }}
        />
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)' }}>This role auto-scales</span>
      </label>
      {!prereq.ok && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', marginLeft: 22 }}>
          {prereq.reason}
        </div>
      )}

      {enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', marginLeft: 22 }}>
          <Field label="Max parallel instances" hint="Blank = no per-role cap (the team's ticket limit governs).">
            <input
              type="text"
              inputMode="numeric"
              value={maxInstancesText}
              onChange={(e) => { setMaxInstancesText(e.target.value); dirty(); }}
              placeholder="no cap"
              style={{ ...fieldInput, width: 100 }}
            />
          </Field>
          {maxInstances.error && <FieldError text={maxInstances.error} />}

          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
            <Field label="Idle timeout (min)">
              <input type="text" inputMode="numeric" value={idleText}
                onChange={(e) => { setIdleText(e.target.value); dirty(); }}
                placeholder="default" style={{ ...fieldInput, width: 90 }} />
            </Field>
            <Field label="Hard timeout (min)">
              <input type="text" inputMode="numeric" value={hardText}
                onChange={(e) => { setHardText(e.target.value); dirty(); }}
                placeholder="default" style={{ ...fieldInput, width: 90 }} />
            </Field>
            <Field label="Retain logs (min)">
              <input type="text" inputMode="numeric" value={retainText}
                onChange={(e) => { setRetainText(e.target.value); dirty(); }}
                placeholder="default" style={{ ...fieldInput, width: 90 }} />
            </Field>
          </div>
          {idle.error && <FieldError text={idle.error} />}
          {hard.error && <FieldError text={hard.error} />}
          {retain.error && <FieldError text={retain.error} />}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <button
          onClick={save}
          disabled={saving || blocked}
          style={{ ...primaryBtn, cursor: (saving || blocked) ? 'not-allowed' : 'pointer', opacity: (saving || blocked) ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>Saved.</span>}
        {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{hint}</span>}
    </label>
  );
}

function FieldError({ text }) {
  return <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>{text}</div>;
}

const fieldInput = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 8px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)', padding: '8px 16px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
};
