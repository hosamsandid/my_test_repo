import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Clock, CalendarClock, Loader2, AlertCircle, Plus, Pencil, Trash2, Globe, Copy, Eye, EyeOff, Github, Terminal, FileCode2, GitBranch, Repeat } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import SidePanel from '../../components/SidePanel';
import ScriptViewerPanel from '../../components/ScriptViewerPanel';
import ConfirmDialog from '../../components/ConfirmDialog';
import FormInput from '../../components/FormInput';
import { liveOps } from '../process/edit-adapters';
import { isGateLabel, isBrakeLabel } from '../process/label-flags';
import {
  GITHUB_EVENT_OPTIONS,
  LABEL_FILTERABLE_EVENTS,
  summarizeGithubEventTrigger,
  summarizeLoopTrigger,
  claimBodyFor,
  transportBodyFor,
  isStandingSubscription,
} from './trigger-summary.js';
import { DOW_LABELS, parseCronState, buildCron, describeCron } from './cron-format.js';
import {
  STOP_CONDITIONS,
  TOKEN_BUDGET_PRESETS,
  GAP_PRESETS,
  deriveStopCondition,
  deriveTokenBudget,
  deriveGap,
  resolveTokenBudget,
  resolveGapSeconds,
} from './loop-form-options.js';

// preCheckScript paths reference an installed binary inside the orchestrator
// container (e.g. `/usr/local/bin/multi-agent-bid`). The allowlisted name is
// the basename — `/api/scripts/:name` checks it against the server-side allowlist.
function scriptNameFromPath(scriptPath) {
  if (typeof scriptPath !== 'string') return null;
  const trimmed = scriptPath.trim();
  if (!trimmed) return null;
  return trimmed.split('/').filter(Boolean).pop() || null;
}

const POLL_MS = 30_000;

// A data-flow trigger is an agent dependency: a push to the team repo wakes
// this one with a hand-off prompt. Under the hood it's a github-event/push
// trigger. It fires on any push (source filtering was removed); the woken
// agent decides whether the change is relevant. Identified solely by the
// `dataFlow` marker — a plain push trigger (no marker) is just a push trigger.
function isDataFlowTrigger(t) {
  return !!t && t.dataFlow === true;
}

// `GITHUB_EVENT_OPTIONS` / `LABEL_FILTERABLE_EVENTS` (the friendly event
// wording + which events carry a label) now live in ./trigger-summary.js so
// the card summary and the Flow canvas readout share one source of truth (#778).

// Mirrors orchestrator/github-poller.js — extracts owner/repo from the
// repository URL stored in the working environment.
function parseRepoFullName(url) {
  if (!url) return null;
  const ssh   = String(url).match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh)   return `${ssh[1]}/${ssh[2]}`;
  const https = String(url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/* ── Toggle switch ──────────────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      style={{
        width: 28, height: 16,
        borderRadius: 'var(--eb-radius-full)',
        border: 'none',
        background: checked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background var(--eb-transition-fast)',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 12 : 2,
        width: 12, height: 12, borderRadius: '50%',
        background: 'white',
        transition: 'left var(--eb-transition-fast)',
      }} />
    </button>
  );
}

/* ── Type badge ─────────────────────────────────────────────────────── */
function TypeBadge({ type, dataFlow }) {
  const isCron   = type === 'cron' || type === 'recurring';
  const isOnce   = type === 'once';
  const isHttp   = type === 'http';
  const isGithub = type === 'github-event';
  const isLoop   = type === 'loop';
  let bg, color, label, Icon;
  if (dataFlow) {
    bg = 'var(--eb-accent-muted)'; color = 'var(--eb-accent-primary)'; label = 'data flow'; Icon = GitBranch;
  } else if (isLoop) {
    bg = 'var(--eb-status-warning-bg)'; color = 'var(--eb-status-warning)'; label = 'loop'; Icon = Repeat;
  } else if (isCron) {
    bg = 'var(--eb-accent-muted)'; color = 'var(--eb-accent-primary)'; label = 'cron'; Icon = Clock;
  } else if (isOnce) {
    bg = 'var(--eb-bg-elevated)'; color = 'var(--eb-text-secondary)'; label = 'once'; Icon = CalendarClock;
  } else if (isHttp) {
    bg = 'var(--eb-status-success-bg)'; color = 'var(--eb-status-success)'; label = 'http'; Icon = Globe;
  } else if (isGithub) {
    bg = 'var(--eb-status-info-bg, var(--eb-accent-muted))'; color = 'var(--eb-status-info, var(--eb-accent-primary))'; label = 'github'; Icon = Github;
  } else {
    bg = 'var(--eb-status-warning-bg)'; color = 'var(--eb-status-warning)'; label = type || 'unknown'; Icon = AlertCircle;
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 6px', borderRadius: 'var(--eb-radius-full)',
      fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
      background: bg, color, border: `1px solid ${color}`, whiteSpace: 'nowrap',
    }}>
      <Icon size={10} />
      {label}
    </span>
  );
}

/* ── Cron builder ───────────────────────────────────────────────────── */
// parseCronState / buildCron / describeCron / DOW_LABELS moved to the pure
// ./cron-format.js module (#866) so the Flow-Editor Inputs list shares the same
// schedule wording. Imported above.

// Shared input style — defined at module level to avoid per-render allocation
const FIELD_STYLE = {
  padding: '6px 10px',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  outline: 'none',
};

function CronBuilder({ value, onChange }) {
  const [s, setS] = useState(() => parseCronState(value));

  // Keep internal state in sync when value changes externally (e.g. edit panel reopened)
  useEffect(() => { setS(parseCronState(value)); }, [value]);

  function upd(patch) {
    setS(prev => {
      const next = { ...prev, ...patch };
      onChange(buildCron(next));
      return next;
    });
  }

  const timeVal = `${String(parseInt(s.hour)||0).padStart(2,'0')}:${String(parseInt(s.minute)||0).padStart(2,'0')}`;
  const setTime = v => { const [h, m] = (v || '00:00').split(':'); upd({ hour: h || '0', minute: m || '0' }); };

  const description = describeCron(s);
  const cronStr = buildCron(s);
  const customEmpty = s.mode === 'custom' && !s.raw.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)' }}>
        Schedule
      </div>

      {/* Frequency */}
      <select value={s.mode} onChange={e => upd({ mode: e.target.value })} style={{ ...FIELD_STYLE, width: '100%' }}>
        <option value="minutely">Every N minutes</option>
        <option value="hourly">Hourly</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
        <option value="custom">Custom expression</option>
      </select>

      {/* Mode-specific inputs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', minHeight: 34 }}>
        {s.mode === 'minutely' && (<>
          Every
          <input type="number" min={1} max={59} value={s.interval}
            onChange={e => upd({ interval: e.target.value })}
            style={{ ...FIELD_STYLE, width: 60, textAlign: 'center' }} />
          minutes
        </>)}

        {s.mode === 'hourly' && (<>
          At minute
          <input type="number" min={0} max={59} value={s.minute}
            onChange={e => upd({ minute: e.target.value })}
            style={{ ...FIELD_STYLE, width: 60, textAlign: 'center' }} />
        </>)}

        {s.mode === 'daily' && (<>
          At <input type="time" value={timeVal} onChange={e => setTime(e.target.value)} style={FIELD_STYLE} />
        </>)}

        {s.mode === 'weekly' && (<>
          Every
          <select value={s.dow} onChange={e => upd({ dow: e.target.value })} style={FIELD_STYLE}>
            {DOW_LABELS.map((d, i) => <option key={i} value={String(i)}>{d}</option>)}
          </select>
          at <input type="time" value={timeVal} onChange={e => setTime(e.target.value)} style={FIELD_STYLE} />
        </>)}

        {s.mode === 'monthly' && (<>
          Day
          <input type="number" min={1} max={31} value={s.dom}
            onChange={e => upd({ dom: e.target.value })}
            style={{ ...FIELD_STYLE, width: 60, textAlign: 'center' }} />
          of every month at <input type="time" value={timeVal} onChange={e => setTime(e.target.value)} style={FIELD_STYLE} />
        </>)}

        {s.mode === 'custom' && (
          <input type="text" value={s.raw} onChange={e => upd({ raw: e.target.value })}
            placeholder="* * * * *  (min  hour  day  month  weekday)"
            style={{
              ...FIELD_STYLE, flex: 1,
              fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
              ...(customEmpty ? { border: '1px solid var(--eb-status-error)' } : {}),
            }} />
        )}
      </div>

      {/* Inline error for empty custom expression */}
      {customEmpty && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
          <AlertCircle size={11} style={{ flexShrink: 0 }} /> Cron expression is required.
        </div>
      )}

      {/* Summary */}
      {s.mode !== 'custom' && cronStr && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-accent-muted)', borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-xs)',
        }}>
          <Clock size={11} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
          <span style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-medium)', flex: 1 }}>
            {description}
          </span>
          <code style={{ color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {cronStr}
          </code>
        </div>
      )}
    </div>
  );
}

/* ── Date-time picker (for one-shot triggers) ───────────────────────── */
// Converts a UTC ISO string to the local YYYY-MM-DDTHH:MM format required
// by <input type="datetime-local">, so the picker shows the user's local time.
function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  // Shift from UTC to local by subtracting the timezone offset
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function DateTimePicker({ value, onChange }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
        Date &amp; Time
      </div>
      <input
        type="datetime-local"
        value={toDatetimeLocal(value)}
        // Convert the browser-local selection to UTC ISO before storing
        onChange={e => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
        style={{
          width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
          fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none',
          colorScheme: 'dark light',
        }}
      />
    </div>
  );
}

/* ── Trigger row ────────────────────────────────────────────────────── */
// Trigger-level `emits` was removed (#783): label hand-offs are declared at the
// agent/role level (in the Flow Editor node inspector), not per trigger. The
// former EmitsSection/EmitsEditor and their emit-suggestions/emits endpoints are
// gone; the trigger row no longer renders an emits chip or edit button.

function TriggerRow({ trigger, agentId, ops = liveOps, onEdit, onDeleted, onToggled }) {
  const [toggling, setToggling] = useState(false);
  const [scriptPanelName, setScriptPanelName] = useState(null);
  const preCheckScriptName = scriptNameFromPath(trigger.preCheckScript);
  const preCheckEnvEntries = trigger.preCheckEnv && typeof trigger.preCheckEnv === 'object'
    ? Object.entries(trigger.preCheckEnv)
    : [];
  const isDataFlow = isDataFlowTrigger(trigger);
  // A plain (non-data-flow) github-event trigger gets a dedicated, wrapping
  // event/label summary below the header (AC1–AC5); the header `<code>` then
  // only carries the repo, which may ellipsize without hiding the summary (AC6).
  const ghSummary = (trigger.type === 'github-event' && !isDataFlow)
    ? summarizeGithubEventTrigger(trigger)
    : null;
  let schedule;
  if (isDataFlow) {
    schedule = `wakes on push${trigger.repo ? ` to ${trigger.repo}` : ' to the team repo'}`;
  } else if (trigger.type === 'loop') {
    schedule = summarizeLoopTrigger(trigger);
  } else if (trigger.type === 'http') {
    schedule = `/hooks/${agentId}/${trigger.id}`;
  } else if (ghSummary) {
    schedule = trigger.repo || 'any repo';
  } else if (trigger.cron) {
    schedule = describeCron(parseCronState(trigger.cron)) || trigger.cron;
  } else {
    schedule = trigger.at || '—';
  }

  async function handleToggle(val) {
    setToggling(true);
    try {
      await ops.updateTrigger(agentId, trigger.id, { enabled: val });
      onToggled();
    } catch { /* surface via refresh */ }
    finally { setToggling(false); }
  }

  const iconBtn = {
    background: 'none', border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-sm)', color: 'var(--eb-text-muted)',
    cursor: 'pointer', padding: '1px 5px', display: 'flex', alignItems: 'center', flexShrink: 0,
  };

  return (
    <div style={{
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <TypeBadge type={trigger.type} dataFlow={isDataFlow} />
        <code style={{
          flex: 1, fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-primary)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {schedule}
        </code>
        {/* Enabled toggle — moved into the header cluster next to Edit/Delete
            (the slot the old check-circle status icon used to occupy). The
            toggle is the single state indicator now; the in-flight Loader2
            spinner replaces it while a PUT is in flight. */}
        {toggling
          ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--eb-text-muted)', flexShrink: 0 }} title="Updating…" />
          : (
            <span
              title={trigger.enabled !== false
                ? 'Disable this trigger — it will stop firing'
                : 'Enable this trigger — it will start firing again'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)', flexShrink: 0 }}
            >
              <ToggleSwitch checked={trigger.enabled !== false} onChange={handleToggle} />
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', width: 18 }}>
                {trigger.enabled !== false ? 'On' : 'Off'}
              </span>
            </span>
          )
        }
        <button onClick={() => onEdit(trigger)} title="Edit trigger" style={iconBtn}>
          <Pencil size={11} />
        </button>
        <button
          onClick={() => onDeleted(trigger)}
          title="Delete trigger"
          style={{ ...iconBtn, border: '1px solid var(--eb-status-error)', color: 'var(--eb-status-error)' }}
        >
          <Trash2 size={11} />
        </button>
      </div>

      {ghSummary && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
          fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.4,
        }}>
          <Github size={13} style={{ color: 'var(--eb-text-muted)', flexShrink: 0, marginTop: 2 }} />
          <span style={{ overflowWrap: 'anywhere' }}>
            <strong style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-medium)' }}>
              {ghSummary.events.length ? ghSummary.events.join(', ') : 'No event'}
            </strong>
            {ghSummary.label && (
              <>
                {' · label '}
                <strong style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-medium)' }}>
                  “{ghSummary.label}”
                </strong>
              </>
            )}
          </span>
        </div>
      )}

      {trigger.description && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.4 }}>
          {trigger.description}
        </div>
      )}

      {trigger.preCheckScript && (
        <div style={{
          padding: 'var(--eb-space-2)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-sm)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-1)',
          marginTop: 2,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            <Terminal size={12} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>
              pre-check:
            </span>
            <code style={{
              fontSize: 'var(--eb-text-xs)',
              fontFamily: 'var(--eb-font-mono)',
              color: 'var(--eb-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {trigger.preCheckScript}
            </code>
            {preCheckScriptName && (
              <button
                onClick={() => setScriptPanelName(preCheckScriptName)}
                title="View script source (read-only)"
                style={{
                  background: 'none',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-sm)',
                  color: 'var(--eb-text-secondary)',
                  cursor: 'pointer',
                  padding: '1px 6px',
                  fontSize: 'var(--eb-text-xs)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                <FileCode2 size={11} /> View
              </button>
            )}
          </div>
          {preCheckEnvEntries.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-1)' }}>
              {preCheckEnvEntries.map(([key, value]) => (
                <span
                  key={key}
                  title={`${key}=${value}`}
                  style={{
                    fontSize: 'var(--eb-text-xs)',
                    fontFamily: 'var(--eb-font-mono)',
                    padding: '1px 6px',
                    background: 'var(--eb-bg-surface)',
                    border: '1px solid var(--eb-border-default)',
                    borderRadius: 'var(--eb-radius-sm)',
                    color: 'var(--eb-text-secondary)',
                    maxWidth: 240,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {key}={String(value)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {trigger.prompt && (
        <div style={{
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.4,
          padding: 'var(--eb-space-1) var(--eb-space-2)', background: 'var(--eb-bg-elevated)',
          borderRadius: 'var(--eb-radius-sm)', overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
        }}>
          {trigger.prompt}
        </div>
      )}

      <ScriptViewerPanel
        open={!!scriptPanelName}
        onClose={() => setScriptPanelName(null)}
        scriptName={scriptPanelName}
      />
    </div>
  );
}

/* ── Secret generator ───────────────────────────────────────────────── */
function generateSecret() {
  const arr = new Uint8Array(24);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Derive the loop verifier editor mode from a persisted `verify` value.
// `{ agentId }` → 'agent', `{ command }` → 'command', `{ flow: true }` →
// 'flow' (hand-off to the wired downstream QS chain), anything else → 'none'.
function deriveVerifyMode(verify) {
  if (verify && typeof verify === 'object') {
    if (verify.agentId) return 'agent';
    if (verify.command) return 'command';
    if (verify.flow === true) return 'flow';
  }
  return 'none';
}

// `maxIterations` is required and must be a positive whole number (concept
// §4.4). Accepts the raw string the number input emits.
function isValidMaxIterations(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0;
}

// Pick a sensible default sibling verifier from a roster (concept §4.2/§4.6:
// "an agent must not grade its own work"). Prefer a reviewer / quality-gate
// role, else the first sibling. Returns an agent id or ''.
function pickDefaultVerifier(siblings) {
  const list = Array.isArray(siblings) ? siblings : [];
  const preferred = list.find(a => /review|quality|qa|test/i.test(`${a.id} ${a.displayName || ''}`));
  return (preferred || list[0])?.id || '';
}

/* ── Trigger form (create & edit) ───────────────────────────────────── */
// Shared by the agent-chat Triggers panel and the Flow-Editor schedule edge
// editor (EdgeDialogs) — one source of truth for editing every trigger type.
// `onRemove` renders a delete affordance (the flow editor's ⏰ edge needs it);
// `allowTypeChange` unlocks the Type selector on edit (the flow editor permits
// turning a schedule into a different trigger kind, re-deriving the edge).
export function TriggerForm({ onSave, onCancel, onRemove, saving, initialValues, agentId, ops = liveOps, allowTypeChange = false, allowLoopType = true, lockType = null, submitLabel = null, labels = null }) {
  const isEdit = !!initialValues;
  const typeLocked = isEdit && !allowTypeChange;
  // Loop-launch mode (#1020): the composer launcher reuses this form pinned to
  // a single type, hiding the type selector, the id field and the enabled
  // toggle — a launched loop is a run you start, not a stored, toggleable
  // subscription. `lockType` forces the type; `submitLabel` relabels the
  // primary button (e.g. "Start loop").
  const lockedMode = !!lockType;
  // Draft mode (process-canvas drafts): there is no live agent/environment yet,
  // so the repo is unknown by design — it is applied at materialise time.
  const isDraftMode = ops.mode === 'draft';
  const knownTypes = new Set(['cron', 'once', 'http', 'github-event', 'loop']);
  const startedAsDataFlow = isDataFlowTrigger(initialValues);
  // 'data-flow' is a UI-only type that serializes to github-event / push / from.
  const initialType = lockType
    ? lockType
    : startedAsDataFlow
      ? 'data-flow'
      : (knownTypes.has(initialValues?.type) ? initialValues.type : 'cron');
  const [form, setForm] = useState(() => ({
    id:          initialValues?.id          ?? '',
    type:        initialType,
    cron:        initialValues?.cron        ?? '0 9 * * *',
    at:          initialValues?.at          ?? '',
    repo:        initialValues?.repo        ?? '',
    events:      Array.isArray(initialValues?.events) ? initialValues.events : [],
    // Optional label-name filter for *.labeled / *.unlabeled events.
    // Empty string = match any label (legacy behavior). The poller treats
    // missing or empty as no filter, so the wire format is `string | undefined`.
    labelFilter: initialValues?.labelFilter ?? '',
    secret:      initialValues?.secret      ?? (initialType === 'http' ? '' : generateSecret()),
    description: initialValues?.description ?? '',
    prompt:      initialValues?.prompt      ?? '',
    enabled:     initialValues?.enabled !== false,
    // ── loop fields (type: 'loop') ───────────────────────────────────────
    // Kept as strings in the form (number inputs emit strings); parsed on save.
    maxIterations: initialValues?.maxIterations != null ? String(initialValues.maxIterations) : '',
    // #1083: the raw `until` / `maxTokens` / `minGapSeconds` inputs are replaced
    // by plain-language selectors that derive from and resolve back to the same
    // wire schema (loop-form-options.js). The raw untilCommand string is still
    // held for the "Custom command" escape hatch.
    stopCondition: deriveStopCondition(initialValues?.until, deriveVerifyMode(initialValues?.verify) !== 'none'),
    untilCommand:  (initialValues?.until && typeof initialValues.until === 'object' && initialValues.until.command) || '',
    tokenPreset:   deriveTokenBudget(initialValues?.maxTokens).preset,
    tokenRaw:      deriveTokenBudget(initialValues?.maxTokens).raw,
    gapPreset:     deriveGap(initialValues?.minGapSeconds).preset,
    gapRaw:        deriveGap(initialValues?.minGapSeconds).raw,
    // Advanced settings collapse (#1083 AC7): expanded automatically when the
    // stored trigger already uses a technical option, so an edit never hides
    // configuration the author set.
    showAdvanced:  deriveStopCondition(initialValues?.until, deriveVerifyMode(initialValues?.verify) !== 'none') === 'custom'
                     || initialValues?.maxTokens != null
                     || initialValues?.minGapSeconds != null,
    // verify: { command } | { agentId } | absent. Derive the editor mode.
    verifyMode:    deriveVerifyMode(initialValues?.verify),
    verifyCommand: (initialValues?.verify && typeof initialValues.verify === 'object' && initialValues.verify.command) || '',
    verifyAgentId: (initialValues?.verify && typeof initialValues.verify === 'object' && initialValues.verify.agentId) || '',
    // Claim (#1006): a label listener takes its wake label over as `<wake>:wip`
    // when it fires — ON by default for new listeners (the platform convention
    // the engine/channel paths follow); an edit reflects the stored state.
    claimOn:       isEdit ? !!initialValues?.claim : true,
    // Delivery transport (#1189): 'internal' delivers the wake over the
    // orchestrator queue (label mirrored to GitHub); 'github' is poller
    // delivery. Only meaningful for a label listener — see `showTransport`.
    transport:     initialValues?.transport === 'internal' ? 'internal' : 'github',
  }));
  const isDataFlow = form.type === 'data-flow';
  const showLabelFilter = form.type === 'github-event'
    && form.events.some(e => LABEL_FILTERABLE_EVENTS.has(e));
  // Delivery selector (#1189): a real label listener (label event + a filter),
  // and NOT a human gate/brake — a person sets those on GitHub, so only the
  // poller can see them (mirrors the edge dialog's rule). The gate check needs
  // the label registry; when it isn't provided (e.g. Agent-Chat), fall open and
  // show the selector — the backend still rejects an invalid transport.
  const trimmedFilter = (form.labelFilter || '').trim();
  const gateLikeFilter = labels
    ? (isGateLabel(labels, trimmedFilter) || isBrakeLabel(labels, trimmedFilter))
    : false;
  const showTransport = showLabelFilter && !!trimmedFilter && !gateLikeFilter;
  const [copyDone, setCopyDone] = useState(null); // 'path' | 'secret' | null
  const [secretVisible, setSecretVisible] = useState(!isEdit);
  const [formError, setFormError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // One event per trigger: the select replaces the whole events array. Legacy
  // triggers may still carry several — surfaced via the notice below, and the
  // extra events are only dropped when the user saves.
  const selectEvent = (val) => set('events', val ? [val] : []);
  // Preserve events outside the catalog (the Events API knows more keys) so an
  // exotic trigger stays selectable and can be re-saved untouched.
  const knownEventValues = new Set(GITHUB_EVENT_OPTIONS.map(o => o.value));
  const extraEventOptions = [...new Set(
    (Array.isArray(initialValues?.events) ? initialValues.events : []).filter(e => !knownEventValues.has(e))
  )];
  const legacyEvents = Array.isArray(initialValues?.events) && !startedAsDataFlow
    ? initialValues.events : [];

  // Repos available to this agent — sourced from the agent's working
  // environment. Only fetched when github-event is the active type; a draft
  // has no environment, so the lookup is skipped entirely.
  const [availableRepos, setAvailableRepos] = useState(isDraftMode ? [] : null); // null = not loaded
  useEffect(() => {
    if (isDraftMode) return undefined;
    if ((form.type !== 'github-event' && form.type !== 'data-flow') || availableRepos !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const agent = await apiCall('GET', `/api/agents/${agentId}`);
        const envId = agent?.environmentId;
        let repos = [];
        if (envId) {
          const env = await apiCall('GET', `/api/environments/${envId}`);
          const list = Array.isArray(env?.repositories) ? env.repositories : [];
          repos = list
            .map(r => ({ url: r?.url, fullName: parseRepoFullName(r?.url) }))
            .filter(r => r.fullName);
        }
        if (!cancelled) setAvailableRepos(repos);
      } catch {
        if (!cancelled) setAvailableRepos([]);
      }
    })();
    return () => { cancelled = true; };
  }, [form.type, agentId, availableRepos, isDraftMode]);

  // Auto-pick the repo when the env has exactly one — a data-flow dependency
  // always lives on the team repo, so the user shouldn't have to choose.
  useEffect(() => {
    if (Array.isArray(availableRepos) && availableRepos.length === 1 && !form.repo) {
      setForm(f => (f.repo ? f : { ...f, repo: availableRepos[0].fullName }));
    }
  }, [availableRepos, form.repo]);

  // Loop verifier roster — for a team agent, the "separate verifier" default is
  // enforced by the backend (concept §4.6), so the UI must reflect it: pre-fill
  // a *sibling* role (never the agent itself) and let the author override. Only
  // fetched when loop is the active type and there's a live environment (a draft
  // has no roster — enforcement happens at materialise). `null` = not loaded.
  const [loopRoster, setLoopRoster] = useState(isDraftMode ? { isTeamAgent: false, siblings: [] } : null);
  useEffect(() => {
    if (isDraftMode || form.type !== 'loop' || loopRoster !== null) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const agents = await apiCall('GET', '/api/agents');
        const list = Array.isArray(agents) ? agents : [];
        const self = list.find(a => a.id === agentId) || null;
        const parentTeamId = self?.parentTeamId || null;
        const isTeamAgent = !!parentTeamId;
        // Siblings = same team, excluding self and the (runtime-less) team agent.
        const siblings = isTeamAgent
          ? list.filter(a => a.parentTeamId === parentTeamId && a.id !== agentId && a.role !== 'team')
              .map(a => ({ id: a.id, displayName: a.displayName || a.id }))
          : [];
        if (!cancelled) setLoopRoster({ isTeamAgent, siblings });
      } catch {
        if (!cancelled) setLoopRoster({ isTeamAgent: false, siblings: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [form.type, agentId, loopRoster, isDraftMode]);

  // Enforced separate-verifier default: once the roster is known, a team agent
  // with no authored verifier gets a sibling pre-filled (not left empty). Runs
  // once per roster load; the author can still change the mode/target after.
  const isTeamLoopAgent = !!loopRoster?.isTeamAgent;
  useEffect(() => {
    if (form.type !== 'loop' || !isTeamLoopAgent) return;
    const siblings = loopRoster?.siblings || [];
    setForm(f => {
      if (f.verifyMode !== 'none' || f.verifyAgentId) return f; // author already chose
      const pick = pickDefaultVerifier(siblings);
      if (!pick) return f; // no sibling to assign — leave the notice to explain
      return { ...f, verifyMode: 'agent', verifyAgentId: pick };
    });
  }, [form.type, isTeamLoopAgent, loopRoster]);

  // Lazy-generate a secret the first time http is selected, so users get a
  // working default without having to click "regenerate".
  function changeType(next) {
    setForm(f => ({
      ...f,
      type: next,
      secret: next === 'http' && !f.secret ? generateSecret() : f.secret,
    }));
  }

  const webhookPath = `/hooks/${agentId}/${isEdit ? form.id : form.id.trim() || '<id>'}`;

  function copy(text, key) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopyDone(key);
      setTimeout(() => setCopyDone(c => (c === key ? null : c)), 1500);
    });
  }

  async function submit() {
    setFormError(null);
    if (form.type === 'cron' && !form.cron.trim()) { setFormError('Cron expression is required.'); return; }
    if (form.type === 'once' && !form.at.trim())   { setFormError('Run-at timestamp is required.'); return; }
    if (form.type === 'github-event') {
      if (!form.repo && !isDraftMode) { setFormError('Repository is required.'); return; }
      if (form.events.length === 0) { setFormError('Select the event this trigger reacts to.'); return; }
    }
    if (isDataFlow) {
      if (!form.repo && !isDraftMode) { setFormError('A repository is required (the team repo agents push to).'); return; }
    }
    if (form.type === 'http' && !form.secret.trim()) { setFormError('Secret is required for HTTP triggers.'); return; }
    if (form.type === 'loop') {
      if (!isValidMaxIterations(form.maxIterations)) { setFormError('Max iterations is required and must be a positive whole number.'); return; }
      if (form.verifyMode === 'command' && !form.verifyCommand.trim()) { setFormError('Enter the verifier command, or choose a different verifier mode.'); return; }
      if (form.verifyMode === 'agent' && !form.verifyAgentId.trim()) { setFormError('Select the verifier agent, or choose a different verifier mode.'); return; }
    }
    if (!form.prompt.trim()) { setFormError('Prompt is required.'); return; }
    const body = {
      type:        isDataFlow ? 'github-event' : form.type,
      description: form.description.trim() || undefined,
      prompt:      form.prompt.trim(),
      enabled:     form.enabled,
    };
    if (!isEdit) body.id = form.id.trim() || undefined;
    if (isDataFlow) {
      // A data-flow dependency is a push trigger. It fires on any push to the
      // repo (no origin scoping); the woken agent decides relevance.
      if (form.repo) body.repo = form.repo; // a draft's repo lands at materialise
      body.events = ['push'];
      body.dataFlow = true;
    } else if (form.type === 'cron')       body.cron = form.cron.trim();
    else if (form.type === 'once')         body.at   = form.at.trim();
    else if (form.type === 'loop') {
      body.maxIterations = Number(form.maxIterations);
      // Stop condition (#1083): only the "Custom command" option emits `until`;
      // the predefined options run to the iteration cap (with the verifier, if
      // any, gating each pass).
      if (form.stopCondition === 'custom') {
        const untilCmd = form.untilCommand.trim();
        if (untilCmd) body.until = { command: untilCmd };
      }
      // verify: command form / agent form / flow hand-off / omitted. A team
      // agent's blank verifier is (re-)enforced to a sibling server-side
      // (concept §4.6); the flow form is an explicit delegation to the wired
      // downstream QS chain, honoured as authored.
      if (form.verifyMode === 'command' && form.verifyCommand.trim()) {
        body.verify = { command: form.verifyCommand.trim() };
      } else if (form.verifyMode === 'agent' && form.verifyAgentId.trim()) {
        body.verify = { agentId: form.verifyAgentId.trim() };
      } else if (form.verifyMode === 'flow') {
        body.verify = { flow: true };
      }
      // Token budget + min-gap resolve from their presets (or the advanced raw
      // fields) back to the exact wire numbers; `undefined` omits the field.
      const mt = resolveTokenBudget(form.tokenPreset, form.tokenRaw);
      if (mt != null) body.maxTokens = mt;
      const mg = resolveGapSeconds(form.gapPreset, form.gapRaw);
      if (mg != null) body.minGapSeconds = mg;
    }
    else if (form.type === 'http')         body.secret = form.secret.trim();
    else if (form.type === 'github-event') {
      if (form.repo) body.repo = form.repo; // a draft's repo lands at materialise
      body.events = form.events.slice(0, 1); // one event per trigger
      // Persist the label-name filter only when it's relevant to the
      // selected events AND the user actually entered something. Sending
      // an empty string would round-trip back into the form as "no
      // filter" anyway, but the explicit `null` here also makes the PUT
      // path clear an existing filter when the user blanks the field.
      const lf = (form.labelFilter || '').trim();
      body.labelFilter = (showLabelFilter && lf) ? lf : null;
      // Claim stamping (#1006): the raw layer follows the same convention as
      // the engine paths — a `.labeled` label listener claims its wake label
      // unless the author opted out. On edit, `null` clears a stored claim;
      // on create the field is simply omitted (undefined drops from JSON).
      body.claim = claimBodyFor({
        labelFilter: body.labelFilter, events: form.events, claimOn: form.claimOn, isEdit,
      });
      // Delivery transport (#1189) — pure decision in trigger-summary.js so it
      // stays unit-tested; undefined omits the key for a plain non-label trigger.
      const tp = transportBodyFor({
        showTransport, transport: form.transport, isEdit, priorTransport: initialValues?.transport,
      });
      if (tp !== undefined) body.transport = tp;
    }
    await onSave(body);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>

      {!lockedMode && (
        <FormInput
          label={isEdit ? 'ID' : 'ID (optional)'}
          value={form.id}
          onChange={v => !isEdit && set('id', v)}
          placeholder={isEdit ? undefined : 'e.g. gh-pr-review (auto-generated if empty)'}
          disabled={isEdit}
        />
      )}

      {!lockedMode && (
        <div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' }}>
            Type
          </div>
          <select
            value={form.type}
            onChange={e => changeType(e.target.value)}
            disabled={typeLocked}
            style={{
              width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none',
              opacity: typeLocked ? 0.6 : 1,
            }}
          >
            <option value="cron">Cron (recurring)</option>
            <option value="once">Once (one-shot)</option>
            {/* Loop is authored from the composer / Flows canvas, not the chat
                Triggers form (#1020 AC4) — the chat panel passes allowLoopType=false. */}
            {allowLoopType && <option value="loop">Loop (re-run until done)</option>}
            <option value="http">HTTP webhook</option>
            <option value="github-event">GitHub event</option>
            <option value="data-flow">Data flow (agent dependency)</option>
          </select>
        </div>
      )}

      {form.type === 'cron' && (
        <CronBuilder value={form.cron} onChange={v => set('cron', v)} />
      )}

      {form.type === 'once' && (
        <DateTimePicker value={form.at} onChange={v => set('at', v)} />
      )}

      {form.type === 'loop' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {/* Plain-language banner — no CLI terms (#1083 AC5). */}
          <div style={{
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-status-warning-bg)', border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
          }}>
            <Repeat size={11} style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--eb-status-warning)' }} />
            A <strong>loop</strong> runs this agent again and again, feeding each run's
            result into the next, and stops once the work is done or it reaches the
            maximum number of tries you set. Use it for tasks that take several passes
            to finish — like working through a checklist or refining a result.
          </div>

          {/* ── Core fields (#1083 AC1): iterations + verifier. Everything else
              lives in Advanced settings below. ─────────────────────────────── */}
          <FormInput
            label="Maximum number of tries (required)"
            type="number"
            value={form.maxIterations}
            onChange={v => set('maxIterations', v)}
            placeholder="e.g. 25"
            error={formError && !isValidMaxIterations(form.maxIterations) ? 'Required — a positive whole number.' : undefined}
          />

          {/* Verifier — command form, agent form, or none. For a team agent the
              separation is enforced (concept §4.6): the picker is pre-filled and
              cannot be silently emptied. Kept in the core set (out of scope for
              #1083) as it is already relatively accessible. */}
          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Who checks the work? (optional{isTeamLoopAgent ? ', enforced for team agents' : ', recommended'})
            </div>
            <select
              value={form.verifyMode}
              onChange={e => set('verifyMode', e.target.value)}
              style={{ ...FIELD_STYLE, width: '100%' }}
            >
              <option value="none">No one{isTeamLoopAgent ? ' (a teammate is assigned automatically)' : ' (the agent judges itself)'}</option>
              <option value="command">A command must pass each try</option>
              <option value="agent">Another agent reviews each try</option>
              <option value="flow">The flow checks the hand-off (downstream QS chain)</option>
            </select>

            {form.verifyMode === 'command' && (
              <input
                type="text"
                value={form.verifyCommand}
                onChange={e => set('verifyCommand', e.target.value)}
                placeholder="e.g. npm run lint && npm test"
                style={{ ...FIELD_STYLE, width: '100%', marginTop: 'var(--eb-space-2)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
              />
            )}

            {form.verifyMode === 'agent' && (
              (loopRoster?.siblings?.length > 0) ? (
                <select
                  value={form.verifyAgentId}
                  onChange={e => set('verifyAgentId', e.target.value)}
                  style={{ ...FIELD_STYLE, width: '100%', marginTop: 'var(--eb-space-2)' }}
                >
                  <option value="">— Select a verifier agent —</option>
                  {loopRoster.siblings.map(a => (
                    <option key={a.id} value={a.id}>{a.displayName}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={form.verifyAgentId}
                  onChange={e => set('verifyAgentId', e.target.value)}
                  placeholder="verifier agent id (e.g. team-x-code-reviewer)"
                  style={{ ...FIELD_STYLE, width: '100%', marginTop: 'var(--eb-space-2)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
                />
              )
            )}

            {form.verifyMode === 'flow' && (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                No inline check between tries: each try ends by handing its work to
                the flow (opening a PR, setting a label), and the reviewers wired
                downstream verify it there. Use this when the loop is the start of a
                QS chain — otherwise the same reviewer would check the work twice.
              </div>
            )}

            {isTeamLoopAgent && form.verifyMode !== 'flow' && (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                Team agents must not grade their own work — a separate teammate is
                assigned automatically and re-applied on save even if left blank.
              </div>
            )}
          </div>

          {/* ── Advanced settings (#1083 AC7): collapsed by default. Holds the
              stop condition, token budget and gap — including every raw/custom
              escape hatch so power users lose no capability (#1083 AC6). ────── */}
          <div>
            <button
              type="button"
              onClick={() => set('showAdvanced', !form.showAdvanced)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
                color: 'var(--eb-text-secondary)', fontFamily: 'inherit',
              }}
              aria-expanded={form.showAdvanced}
            >
              <span style={{ display: 'inline-block', transform: form.showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform var(--eb-transition-fast)' }}>▸</span>
              Advanced settings
            </button>

            {form.showAdvanced && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', marginTop: 'var(--eb-space-3)' }}>

                {/* Stop condition — plain "Done when…" with a custom escape hatch. */}
                <div>
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
                    Done when…
                  </div>
                  <select
                    value={form.stopCondition}
                    onChange={e => set('stopCondition', e.target.value)}
                    style={{ ...FIELD_STYLE, width: '100%' }}
                  >
                    {STOP_CONDITIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>

                  {form.stopCondition === 'custom' && (
                    <>
                      <input
                        type="text"
                        value={form.untilCommand}
                        onChange={e => set('untilCommand', e.target.value)}
                        placeholder="e.g. npm test && test ! -s fix_plan.md"
                        style={{ ...FIELD_STYLE, width: '100%', marginTop: 'var(--eb-space-2)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
                      />
                      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                        A shell command run after each try; the loop finishes as soon as it succeeds.
                      </div>
                    </>
                  )}
                </div>

                {/* Token budget — labelled presets, raw number only under Custom. */}
                <div>
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
                    How much work can it do? (budget)
                  </div>
                  <select
                    value={form.tokenPreset}
                    onChange={e => set('tokenPreset', e.target.value)}
                    style={{ ...FIELD_STYLE, width: '100%' }}
                  >
                    {TOKEN_BUDGET_PRESETS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {form.tokenPreset === 'custom' && (
                    <input
                      type="number"
                      value={form.tokenRaw}
                      onChange={e => set('tokenRaw', e.target.value)}
                      placeholder="exact token budget, e.g. 2000000"
                      style={{ ...FIELD_STYLE, width: '100%', marginTop: 'var(--eb-space-2)' }}
                    />
                  )}
                </div>

                {/* Min gap — human-readable dropdown, raw seconds only under Custom. */}
                <div>
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
                    Wait between tries
                  </div>
                  <select
                    value={form.gapPreset}
                    onChange={e => set('gapPreset', e.target.value)}
                    style={{ ...FIELD_STYLE, width: '100%' }}
                  >
                    {GAP_PRESETS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {form.gapPreset === 'custom' && (
                    <input
                      type="number"
                      value={form.gapRaw}
                      onChange={e => set('gapRaw', e.target.value)}
                      placeholder="exact seconds, e.g. 120"
                      style={{ ...FIELD_STYLE, width: '100%', marginTop: 'var(--eb-space-2)' }}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {isDataFlow && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <div style={{
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-accent-muted)', border: '1px solid var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
          }}>
            <GitBranch size={11} style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--eb-accent-primary)' }} />
            This agent is woken on <strong>any push</strong> to the team repo (a
            teammate's committed work is the hand-off). It fires regardless of who
            pushed — including this agent's own pushes — so the woken agent should
            <code> git pull</code>, check whether the change is relevant, and reply
            <code> [PASS]</code> if there's nothing to do.
          </div>

          {isDraftMode ? (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
              The repository is applied when the draft is materialised into a team.
            </div>
          ) : (
          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Repository
            </div>
            {availableRepos === null ? (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2)' }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
                Loading repositories…
              </div>
            ) : (
              <select value={form.repo} onChange={e => set('repo', e.target.value)} style={{ ...FIELD_STYLE, width: '100%' }}>
                <option value="">— Select a repository —</option>
                {availableRepos.map(r => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
              </select>
            )}
          </div>
          )}
        </div>
      )}

      {form.type === 'github-event' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {isDraftMode ? (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
              The repository is applied when the draft is materialised into a team.
            </div>
          ) : (
          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Repository
            </div>
            {availableRepos === null ? (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2)' }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
                Loading repositories…
              </div>
            ) : availableRepos.length === 0 ? (
              <div style={{
                padding: 'var(--eb-space-3)',
                background: 'var(--eb-status-warning-bg)',
                border: '1px solid var(--eb-status-warning)',
                borderRadius: 'var(--eb-radius-md)',
                fontSize: 'var(--eb-text-xs)',
                color: 'var(--eb-status-warning)',
              }}>
                The agent's working environment has no GitHub repositories with a parsable URL. Add one in <strong>Working Environments</strong> first.
              </div>
            ) : (
              <select
                value={form.repo}
                onChange={e => set('repo', e.target.value)}
                style={{ ...FIELD_STYLE, width: '100%' }}
              >
                <option value="">— Select a repository —</option>
                {availableRepos.map(r => (
                  <option key={r.fullName} value={r.fullName}>{r.fullName}</option>
                ))}
              </select>
            )}
          </div>
          )}

          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Event
            </div>
            <select
              value={form.events[0] || ''}
              onChange={e => selectEvent(e.target.value)}
              style={{ ...FIELD_STYLE, width: '100%' }}
            >
              <option value="">— Select the event —</option>
              {GITHUB_EVENT_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label} ({opt.value})</option>
              ))}
              {extraEventOptions.map(ev => (
                <option key={ev} value={ev}>{ev}</option>
              ))}
            </select>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
              One event per trigger — create another trigger to react to a second event.
              The agent receives the full event payload as JSON appended to its prompt.
            </div>
            {legacyEvents.length > 1 && (
              <div style={{
                marginTop: 'var(--eb-space-2)', padding: 'var(--eb-space-2)',
                border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
                fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', lineHeight: 1.5,
              }}>
                This trigger still listens on several events ({legacyEvents.join(', ')}).
                Triggers now carry exactly one event — saving keeps only the selected one.
                Create separate triggers for the others.
              </div>
            )}
          </div>

          {showLabelFilter && (
            <div>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
                Label name filter
              </div>
              <input
                type="text"
                value={form.labelFilter}
                onChange={e => set('labelFilter', e.target.value)}
                placeholder="e.g. ready (leave empty to fire for any label)"
                style={{ ...FIELD_STYLE, width: '100%' }}
              />
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                Only fire when the {form.events.includes('issues.unlabeled') || form.events.includes('pull_request.unlabeled') ? 'removed' : 'added'} label matches this name exactly. Saves a Claude invocation on every other label change.
              </div>
              {form.labelFilter.trim() && form.events.some(e => e === 'issues.labeled' || e === 'pull_request.labeled') && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.claimOn} onChange={e => set('claimOn', e.target.checked)} />
                  Claim the wake label on fire (<code>{form.labelFilter.trim()}</code> → <code>{form.labelFilter.trim()}:wip</code>) — makes work-in-progress visible on GitHub
                </label>
              )}
              {showTransport && (
                <div style={{ marginTop: 'var(--eb-space-3)' }}>
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
                    Delivery
                  </div>
                  <select
                    value={form.transport}
                    onChange={e => set('transport', e.target.value)}
                    style={{ ...FIELD_STYLE, width: '100%' }}
                  >
                    <option value="github">Via GitHub events — the poller delivers the wake (~30s)</option>
                    <option value="internal">Direct (internal) — label mirrored to GitHub</option>
                  </select>
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                    {form.transport === 'internal'
                      ? <>The wake is delivered directly by the orchestrator (no polling latency, no lost events); the producer announces the label with <code>aee-emit</code>, and it is still stamped on GitHub as visible status.</>
                      : <>The wake rides the GitHub Events API, delivered by the poller.</>}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                Tip: hand-offs between agents are easier to wire and edit in the <a href="/flows" style={{ color: 'var(--eb-accent-primary)' }}>Flow Editor</a>.
              </div>
            </div>
          )}
        </div>
      )}

      {form.type === 'http' && (
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-status-success-bg)',
          border: '1px solid var(--eb-status-success)',
          borderRadius: 'var(--eb-radius-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Webhook endpoint (port 4003)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <code style={{
                flex: 1, fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
                color: 'var(--eb-text-primary)', wordBreak: 'break-all',
              }}>
                POST {webhookPath}
              </code>
              <button
                onClick={() => copy(webhookPath, 'path')}
                title="Copy path"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                  color: copyDone === 'path' ? 'var(--eb-status-success)' : 'var(--eb-text-muted)',
                  flexShrink: 0,
                }}
              >
                <Copy size={12} />
              </button>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              X-Hook-Secret (required)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <code style={{
                flex: 1, fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
                color: 'var(--eb-text-primary)', wordBreak: 'break-all',
                padding: 'var(--eb-space-1) var(--eb-space-2)',
                background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-sm)',
                minHeight: 18,
              }}>
                {form.secret
                  ? (secretVisible ? form.secret : '•'.repeat(Math.min(form.secret.length, 32)))
                  : <span style={{ color: 'var(--eb-text-muted)' }}>(empty — click ↻ to generate)</span>}
              </code>
              <button
                onClick={() => setSecretVisible(v => !v)}
                title={secretVisible ? 'Hide secret' : 'Show secret'}
                disabled={!form.secret}
                style={{
                  background: 'none', border: 'none', padding: 2, flexShrink: 0,
                  cursor: form.secret ? 'pointer' : 'not-allowed',
                  color: 'var(--eb-text-muted)', opacity: form.secret ? 1 : 0.4,
                }}
              >
                {secretVisible ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              <button
                onClick={() => copy(form.secret, 'secret')}
                title="Copy secret"
                disabled={!form.secret}
                style={{
                  background: 'none', border: 'none', padding: 2, flexShrink: 0,
                  cursor: form.secret ? 'pointer' : 'not-allowed',
                  color: copyDone === 'secret' ? 'var(--eb-status-success)' : 'var(--eb-text-muted)',
                  opacity: form.secret ? 1 : 0.4,
                }}
              >
                <Copy size={12} />
              </button>
              <button
                onClick={() => { set('secret', generateSecret()); setSecretVisible(true); }}
                title="Regenerate secret"
                style={{
                  background: 'none', border: 'none', padding: 2, flexShrink: 0,
                  cursor: 'pointer', color: 'var(--eb-text-muted)',
                }}
              >
                <RefreshCw size={12} />
              </button>
            </div>
          </div>

          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
            Send <code style={{ fontFamily: 'var(--eb-font-mono)' }}>X-Hook-Secret</code> header with the value above.
            Anyone with the secret can fire this trigger — copy it once, store it as a GitHub webhook secret, and rotate via the ↻ button.
          </div>
        </div>
      )}

      <FormInput
        label="Description (optional)"
        value={form.description}
        onChange={v => set('description', v)}
      />

      <FormInput
        label="Wake instruction — what the consumer is told"
        value={form.prompt}
        onChange={v => set('prompt', v)}
        multiline
        rows={4}
        placeholder="What should the agent do when this trigger fires?"
      />

      {!lockedMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
          <ToggleSwitch checked={form.enabled} onChange={v => set('enabled', v)} />
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            Enabled
          </span>
        </div>
      )}

      {formError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
          <AlertCircle size={13} style={{ flexShrink: 0 }} />
          {formError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        {onRemove && (
          <button
            onClick={onRemove}
            disabled={saving}
            style={{
              marginRight: 'auto',
              padding: 'var(--eb-space-2) var(--eb-space-4)',
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-status-error)',
              borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-error)',
              cursor: saving ? 'not-allowed' : 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
            }}
          >
            Remove
          </button>
        )}
        <button
          onClick={submit}
          disabled={saving}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
          {submitLabel || (isEdit ? 'Save' : 'Add Trigger')}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
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

/* ── Main panel ─────────────────────────────────────────────────────── */
/**
 * Read/write panel listing and managing the scheduled triggers for the
 * selected agent. Polls every 30 s for changes the agent itself makes.
 *
 * Write-target abstraction: pass `ops` (edit-adapters surface) to edit a
 * process-draft role's triggers instead of a live agent — the panel then
 * mutates the draft bundle (ops.mode === 'draft'), skips the live-only
 * lookups (env repos, emit suggestions) and stops polling.
 */
export default function TriggersPanel({ agentId, active, onChanged, ops: opsProp = null }) {
  const ops = opsProp || liveOps;
  const isDraft = ops.mode === 'draft';
  const [triggers, setTriggers]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  const [addOpen, setAddOpen]           = useState(false);
  const [editTarget, setEditTarget]     = useState(null);
  const [saving, setSaving]             = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchTriggers = useCallback(async (id) => {
    if (!id) { setTriggers([]); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await ops.listTriggers(id);
      setTriggers(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [ops]);

  useEffect(() => {
    if (!active) return;
    fetchTriggers(agentId);
    if (isDraft) return undefined; // a draft only changes through this UI
    const timer = setInterval(() => fetchTriggers(agentId), POLL_MS);
    return () => clearInterval(timer);
  }, [agentId, active, isDraft, fetchTriggers]);

  async function handleSave(body) {
    setSaving(true);
    try {
      await ops.createTrigger(agentId, body);
      setAddOpen(false);
      fetchTriggers(agentId);
      onChanged?.();
    } catch (e) {
      throw e;
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(body) {
    setSaving(true);
    try {
      await ops.updateTrigger(agentId, editTarget.id, body);
      setEditTarget(null);
      fetchTriggers(agentId);
      onChanged?.();
    } catch (e) {
      throw e;
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await ops.deleteTrigger(agentId, deleteTarget.id);
      setDeleteTarget(null);
      fetchTriggers(agentId);
      onChanged?.();
    } catch (e) {
      setError(`Delete failed: ${e.message}`);
      setDeleteTarget(null);
    }
  }

  const afterRowMutation = useCallback(() => {
    fetchTriggers(agentId);
    onChanged?.();
  }, [fetchTriggers, agentId, onChanged]);

  // The chat Triggers list holds only standing subscriptions (#1020 AC4): a
  // loop is a launched run (chat-launched or a declarative Flows self-edge),
  // not a subscription, so it never appears here. Existing loop entries in
  // triggers.json keep running — they are just hidden from this list.
  const listedTriggers = triggers.filter(isStandingSubscription);

  /* ── Toolbar ──────────────────────────────────────────────────────── */
  const toolbar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-2) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      flexShrink: 0, background: 'var(--eb-bg-surface)', minHeight: 36,
    }}>
      <span style={{ flex: 1, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {loading
          ? 'Loading…'
          : listedTriggers.length > 0
            ? `${listedTriggers.length} trigger${listedTriggers.length === 1 ? '' : 's'}`
            : agentId ? 'No triggers' : ''}
      </span>
      <button
        onClick={() => fetchTriggers(agentId)}
        disabled={loading || !agentId}
        title="Refresh"
        style={{
          background: 'none', border: 'none', color: 'var(--eb-text-muted)',
          cursor: agentId ? 'pointer' : 'default', padding: 2,
          display: 'flex', alignItems: 'center',
          opacity: (!agentId || loading) ? 0.4 : 1,
        }}
      >
        <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
      </button>
      <button
        onClick={() => setAddOpen(true)}
        disabled={!agentId}
        title="Add trigger"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          padding: '2px 8px', fontSize: 'var(--eb-text-xs)',
          fontFamily: 'inherit', fontWeight: 'var(--eb-font-medium)',
          background: agentId ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
          color: agentId ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
          border: 'none', borderRadius: 'var(--eb-radius-sm)',
          cursor: agentId ? 'pointer' : 'not-allowed',
          opacity: agentId ? 1 : 0.5,
        }}
      >
        <Plus size={11} /> Add
      </button>
    </div>
  );

  if (!agentId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {toolbar}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-4)' }}>
          Select an agent to view its triggers.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {toolbar}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && triggers.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            Loading triggers…
          </div>
        )}

        {error && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-4)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            {error}
          </div>
        )}

        {!loading && !error && listedTriggers.length === 0 && (
          <div style={{ padding: 'var(--eb-space-6)', textAlign: 'center', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.5 }}>
            No scheduled triggers configured for this agent.
          </div>
        )}

        {listedTriggers.map((t, i) => (
          <TriggerRow
            key={t.id || i}
            trigger={t}
            agentId={agentId}
            ops={ops}
            onEdit={setEditTarget}
            onDeleted={setDeleteTarget}
            onToggled={afterRowMutation}
          />
        ))}
      </div>

      <SidePanel open={addOpen} onClose={() => setAddOpen(false)} title="Add Trigger">
        <TriggerForm
          agentId={agentId}
          ops={ops}
          saving={saving}
          allowLoopType={false}
          onSave={handleSave}
          onCancel={() => setAddOpen(false)}
        />
      </SidePanel>

      <SidePanel open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Trigger">
        {editTarget && (
          <TriggerForm
            agentId={agentId}
            ops={ops}
            initialValues={editTarget}
            saving={saving}
            allowLoopType={false}
            onSave={handleEditSave}
            onCancel={() => setEditTarget(null)}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Trigger"
        message={`Delete trigger "${deleteTarget?.id}"? This cannot be undone.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
