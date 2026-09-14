import React, { useState } from 'react';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';
import {
  CONTENTION_OPTIONS,
  contentionPolicyValue,
  autoDispatchPrerequisite,
  parseWipLimitInput,
} from './parallelism-view.js';

// Team-axis config surface for agent pools (#2272, Amendment 2 A2.2 of
// `docs/parallel-workers-concept.md`): the flow's `wipLimit`, the Flow
// Supervisor's `autoDispatch.enabled`, and the contention-strategy selector.
// Live-team scope only (A2.2 — "team scope"), writing through the existing
// `PUT /api/agents/:teamId` (A2.4 shipped the sibling `pool` route; this field
// pair already round-tripped, just with no picker). `hasPooledRole` is passed
// in rather than fetched here — the caller already holds the team's
// `/api/agents` list (see `hasPooledMember` in `parallelism-view.js`), so a
// second fetch would just be a duplicate of data the page already has.
export default function ParallelismPanel({ teamId, wipLimit, autoDispatch, hasPooledRole, onClose, onChanged }) {
  const [wipLimitText, setWipLimitText] = useState(wipLimit != null ? String(wipLimit) : '');
  const [enabled, setEnabled] = useState(!!(autoDispatch && autoDispatch.enabled === true));
  const [contentionPolicy, setContentionPolicy] = useState(contentionPolicyValue(autoDispatch));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const parsedWipLimit = parseWipLimitInput(wipLimitText);
  // Re-checked against the CURRENT (unsaved) wipLimit input, not the loaded
  // prop — raising the limit and turning on auto-dispatch in the same visit
  // must not trip a stale refusal.
  const prereq = autoDispatchPrerequisite({ wipLimit: parsedWipLimit.value, hasPooledRole });
  const blocked = !!parsedWipLimit.error || (enabled && !prereq.ok);

  const save = async () => {
    if (blocked || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiCall('PUT', `/api/agents/${teamId}`, {
        wipLimit: parsedWipLimit.value,
        autoDispatch: enabled ? { enabled: true, contentionPolicy } : null,
      });
      onChanged?.();
      onClose();
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SidePanel open onClose={onClose} title="Parallelism" width="440px">
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5, marginTop: 0 }}>
        How many tickets this flow works on at once, and how the Flow Supervisor
        keeps them from clashing.
      </p>

      {error && (
        <div style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-3)' }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: 'var(--eb-space-4)' }}>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)' }}>
          Work in parallel
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <span style={{ fontSize: 'var(--eb-text-sm)' }}>Up to</span>
          <input
            type="text"
            inputMode="numeric"
            value={wipLimitText}
            onChange={(e) => setWipLimitText(e.target.value)}
            placeholder="no limit"
            style={{
              width: 76, padding: '6px 8px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
              background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', boxSizing: 'border-box',
            }}
          />
          <span style={{ fontSize: 'var(--eb-text-sm)' }}>tickets at the same time</span>
        </div>
        {parsedWipLimit.error && (
          <div style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-xs)', marginTop: 'var(--eb-space-1)' }}>
            {parsedWipLimit.error}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 'var(--eb-space-4)' }}>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)' }}>
          Contention
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {CONTENTION_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
                opacity: opt.disabled ? 0.55 : 1, cursor: opt.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <input
                type="radio"
                name="contentionPolicy"
                checked={contentionPolicy === opt.value}
                disabled={opt.disabled}
                onChange={() => setContentionPolicy(opt.value)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <span>
                <div style={{ fontSize: 'var(--eb-text-sm)' }}>
                  {opt.label}
                  {opt.disabled && <span style={{ color: 'var(--eb-text-muted)' }}> (coming)</span>}
                </div>
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 2 }}>
                  {opt.disabled ? opt.disabledReason : opt.blurb}
                </div>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 'var(--eb-space-4)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', cursor: (enabled || prereq.ok) ? 'pointer' : 'not-allowed' }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!enabled && !prereq.ok}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)' }}>
            Auto-start ready tickets
          </span>
        </label>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', marginLeft: 22 }}>
          Oldest first, up to the limit above.
        </div>
        {!prereq.ok && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', marginTop: 'var(--eb-space-1)', marginLeft: 22 }}>
            {prereq.reason}
          </div>
        )}
      </div>

      <button
        onClick={save}
        disabled={saving || blocked}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
          border: 'none', borderRadius: 'var(--eb-radius-md)', padding: '8px 16px',
          fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
          cursor: (saving || blocked) ? 'not-allowed' : 'pointer',
          opacity: (saving || blocked) ? 0.6 : 1,
        }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </SidePanel>
  );
}
