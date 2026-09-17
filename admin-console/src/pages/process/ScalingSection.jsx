import React from 'react';
import {
  parseMaxInstancesInput,
  parseMinutesInput,
  scalingPrerequisite,
} from './scaling-view.js';

// Role-axis config surface for agent pools (#2271, Amendment 2 A2.2 of
// `docs/parallel-workers-concept.md`): "This role auto-scales" (pool.enabled),
// max parallel instances, teardown timeouts. Shared by the Flow editor's
// NodeInspector (a live team-member node's Details tab) and the agent's own
// Settings tab (AgentEditForm), per #2272's "one model, several surfaces"
// precedent — one component, two hosts, so they never drift.
//
// #2295: fully controlled, no own Save/apiCall. A section-local Save button
// was the exact problem this ticket removes (#2295 AC1/AC11) — both hosts now
// hold the draft themselves (`scaling-view.js`'s `scalingDraftFromPool` /
// `scalingSaveDecision` / `scalingDraftDirty`) and fold it into their own
// single Save, the same way the live prompt editor and the Parent picker do.
// `error` is the host's save-time Scaling error (from `scalingSaveDecision`),
// shown inline rather than only ever blocking a button this component no
// longer has.
//
// No workspace binding control here (#2294): every pooled role is created
// implicitly as `git-clean-base` (`buildPoolPayload`'s default in
// `scaling-view.js`) — the other two `pool.workspace` values (`input-copy`,
// `none`) stay fully functional server-side but have no UI anywhere to
// configure the `pool.workSource` they'd need, so offering them here would
// be a selectable option that silently does nothing.
//
// `disabled` (#2302): the agent-pools feature flag is off — render the current
// draft but block every input, so the section stays visible ("Coming Soon",
// the badge lives with the caller's "Scaling" label) without letting anyone
// half-configure a pool the platform won't actually spawn.
export default function ScalingSection({ draft, onChange, parentWipLimit, error, disabled = false }) {
  const maxInstances = parseMaxInstancesInput(draft.maxInstancesText);
  const idle = parseMinutesInput(draft.idleText);
  const hard = parseMinutesInput(draft.hardText);
  const retain = parseMinutesInput(draft.retainText);
  const prereq = scalingPrerequisite({ parentWipLimit });

  const set = (patch) => onChange({ ...draft, ...patch });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', cursor: (!disabled && (draft.enabled || prereq.ok)) ? 'pointer' : 'not-allowed' }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled || (!draft.enabled && !prereq.ok)}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)' }}>This role auto-scales</span>
      </label>
      {!prereq.ok && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', marginLeft: 22 }}>
          {prereq.reason}
        </div>
      )}

      {draft.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', marginLeft: 22 }}>
          <Field label="Max parallel instances" hint="Blank = no per-role cap (the team's ticket limit governs).">
            <input
              type="text"
              inputMode="numeric"
              value={draft.maxInstancesText}
              disabled={disabled}
              onChange={(e) => set({ maxInstancesText: e.target.value })}
              placeholder="no cap"
              style={{ ...fieldInput, width: 100 }}
            />
          </Field>
          {maxInstances.error && <FieldError text={maxInstances.error} />}

          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
            <Field label="Idle timeout (min)">
              <input type="text" inputMode="numeric" value={draft.idleText} disabled={disabled}
                onChange={(e) => set({ idleText: e.target.value })}
                placeholder="default" style={{ ...fieldInput, width: 90 }} />
            </Field>
            <Field label="Hard timeout (min)">
              <input type="text" inputMode="numeric" value={draft.hardText} disabled={disabled}
                onChange={(e) => set({ hardText: e.target.value })}
                placeholder="default" style={{ ...fieldInput, width: 90 }} />
            </Field>
            <Field label="Retain logs (min)">
              <input type="text" inputMode="numeric" value={draft.retainText} disabled={disabled}
                onChange={(e) => set({ retainText: e.target.value })}
                placeholder="default" style={{ ...fieldInput, width: 90 }} />
            </Field>
          </div>
          {idle.error && <FieldError text={idle.error} />}
          {hard.error && <FieldError text={hard.error} />}
          {retain.error && <FieldError text={retain.error} />}
        </div>
      )}

      {error && <FieldError text={error} />}
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
