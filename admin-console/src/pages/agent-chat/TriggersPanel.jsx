import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router';
import { RefreshCw, Clock, CalendarClock, Loader2, AlertCircle, Plus, Pencil, Trash2, Globe, Copy, Eye, EyeOff, Github, Terminal, FileCode2, GitBranch, Repeat, Puzzle } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import SidePanel from '../../components/SidePanel';
import ScriptViewerPanel from '../../components/ScriptViewerPanel';
import ConfirmDialog from '../../components/ConfirmDialog';
import FormInput from '../../components/FormInput';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import { effectiveGrantFor } from '../plugin-grant-view.js';
import { pluginEventOptions, defaultPluginId } from './plugin-event-options.js';
import {
  pluginEvents, eventChoices, payloadKeyChoices,
  conditionsFromFilter, conditionsToFilter, payloadFilterSummary, conditionsHeading,
} from './plugin-event-filter.js';
import { liveOps } from '../process/edit-adapters';
import {
  GITHUB_EVENT_OPTIONS,
  LABEL_FILTERABLE_EVENTS,
  summarizeGithubEventTrigger,
  summarizeLoopTrigger,
  claimBodyFor,
  isStandingSubscription,
  pushedByIds,
  pushedByBodyFor,
  summarizePushSchedule,
} from './trigger-summary.js';
import {
  branchFilterFormError, branchFilterToInput, branchFilterBody, BRANCH_FILTER_PLACEHOLDER, BRANCH_FILTER_HELP,
  knowledgeBranchNote, knowledgeBranchesForRepo,
} from './branch-filter.js';
import {
  DOW_LABELS, parseCronState, buildCron, describeCron, switchCronMode, validateCronState, cronExpressionError, inCronTime,
} from './cron-format.js';
import {
  TRIGGER_TIME_ZONE, browserTimeZone, schedulerTimeZone, cronZoneNote, onceScheduleLabel, triggerTiming,
} from './trigger-timing.js';
import { triggerIssue, triggerRowKey } from './trigger-issues.js';
import { triggerRepoOptions, environmentRepoOptions, triggerRepoWarning } from './trigger-repo-status.js';
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
// trigger. It fires on any push unless it carries a `pushedBy` producer filter
// (#2571 — set automatically for a Flow-editor hand-off to its upstream); the
// woken agent decides whether the change is relevant. Identified solely by the
// `dataFlow` marker — a plain push trigger (no marker) is just a push trigger.
function isDataFlowTrigger(t) {
  return !!t && t.dataFlow === true;
}

// `GITHUB_EVENT_OPTIONS` / `LABEL_FILTERABLE_EVENTS` (the friendly event
// wording + which events carry a label) now live in ./trigger-summary.js so
// the card summary and the Flow canvas readout share one source of truth (#778).

/* ── Toggle switch ──────────────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
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
  const isPlugin = type === 'plugin-event';
  let bg, color, label, Icon;
  if (dataFlow) {
    bg = 'var(--eb-accent-muted)'; color = 'var(--eb-accent-primary)'; label = 'data flow'; Icon = GitBranch;
  } else if (isPlugin) {
    bg = 'var(--eb-status-info-bg, var(--eb-accent-muted))'; color = 'var(--eb-status-info, var(--eb-accent-primary))'; label = 'plugin'; Icon = Puzzle;
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

// Inline field error under the schedule inputs.
function CronFieldError({ children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
      <AlertCircle size={11} style={{ flexShrink: 0 }} /> {children}
    </div>
  );
}

const ERROR_BORDER = { border: '1px solid var(--eb-status-error)' };

// `onChange(cron, error)` — `error` is the first validation message (or null),
// so the form can refuse to save an invalid schedule (#2625).
function CronBuilder({ value, onChange }) {
  const [s, setS] = useState(() => parseCronState(value));
  // The builder's mode is local UI state: `value` is re-parsed only when it
  // changes from OUTSIDE (e.g. the form re-seeds). Re-parsing our own
  // emissions made Custom bounce back to Daily and flipped the mode while an
  // expression was being typed (#2625).
  const lastEmitted = useRef(value);
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setS(parseCronState(value));
  }, [value]);

  function emit(next) {
    const cron = buildCron(next);
    const v = validateCronState(next);
    lastEmitted.current = cron;
    onChange(cron, v.ok ? null : Object.values(v.errors)[0]);
  }

  function upd(patch) {
    const next = { ...s, ...patch };
    setS(next);
    emit(next);
  }

  function changeMode(mode) {
    const next = switchCronMode(s, mode);
    setS(next);
    emit(next);
  }

  const { errors } = validateCronState(s);
  const timeVal = inCronTime(s) ? `${String(Number(s.hour)).padStart(2, '0')}:${String(Number(s.minute)).padStart(2, '0')}` : '';
  // A cleared time input stays empty (and is flagged) instead of becoming 00:00.
  const setTime = v => { const [h = '', m = ''] = (v || '').split(':'); upd({ hour: h, minute: m }); };
  const timeInput = (
    <input type="time" value={timeVal} onChange={e => setTime(e.target.value)}
      aria-invalid={!!errors.time}
      style={{ ...FIELD_STYLE, ...(errors.time ? ERROR_BORDER : {}) }} />
  );

  const description = describeCron(s);
  const cronStr = buildCron(s);
  // #2628: the agent evaluates the expression in the scheduler's zone, not the
  // browser's — say so, and give the viewer's local time when they differ.
  const zoneNote = cronZoneNote(cronStr, { schedulerZone: TRIGGER_TIME_ZONE });
  const fieldError = Object.values(errors)[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)' }}>
        Schedule
      </div>

      {/* Frequency */}
      <select value={s.mode} onChange={e => changeMode(e.target.value)} style={{ ...FIELD_STYLE, width: '100%' }}>
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
          <input type="number" min={1} max={59} step={1} value={s.interval}
            onChange={e => upd({ interval: e.target.value })}
            aria-invalid={!!errors.interval}
            style={{ ...FIELD_STYLE, width: 60, textAlign: 'center', ...(errors.interval ? ERROR_BORDER : {}) }} />
          minutes
        </>)}

        {s.mode === 'hourly' && (<>
          At minute
          <input type="number" min={0} max={59} step={1} value={s.minute}
            onChange={e => upd({ minute: e.target.value })}
            aria-invalid={!!errors.minute}
            style={{ ...FIELD_STYLE, width: 60, textAlign: 'center', ...(errors.minute ? ERROR_BORDER : {}) }} />
        </>)}

        {s.mode === 'daily' && (<>
          At {timeInput}
        </>)}

        {s.mode === 'weekly' && (<>
          Every
          <select value={s.dow} onChange={e => upd({ dow: e.target.value })} style={FIELD_STYLE}>
            {DOW_LABELS.map((d, i) => <option key={i} value={String(i)}>{d}</option>)}
          </select>
          at {timeInput}
        </>)}

        {s.mode === 'monthly' && (<>
          Day
          <input type="number" min={1} max={31} step={1} value={s.dom}
            onChange={e => upd({ dom: e.target.value })}
            aria-invalid={!!errors.dom}
            style={{ ...FIELD_STYLE, width: 60, textAlign: 'center', ...(errors.dom ? ERROR_BORDER : {}) }} />
          of every month at {timeInput}
        </>)}

        {s.mode === 'custom' && (
          <input type="text" value={s.raw} onChange={e => upd({ raw: e.target.value })}
            placeholder="* * * * *  (min  hour  day  month  weekday)"
            aria-invalid={!!errors.raw}
            style={{
              ...FIELD_STYLE, flex: 1,
              fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
              ...(errors.raw ? ERROR_BORDER : {}),
            }} />
        )}
      </div>

      {/* Inline validation error — the form refuses to save while one shows */}
      {fieldError && <CronFieldError>{fieldError}</CronFieldError>}

      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        Times are in {zoneNote}.
      </div>

      {/* Summary — a custom expression has no plain-language wording, so it
          just confirms the expression is valid. */}
      {!fieldError && cronStr && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-accent-muted)', borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-xs)',
        }}>
          <Clock size={11} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
          <span style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-medium)', flex: 1 }}>
            {description ? `${description} (${zoneNote})` : 'Valid custom schedule'}
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
        Date &amp; Time <span style={{ fontWeight: 'normal' }}>(your time, {browserTimeZone()})</span>
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

function TriggerRow({ trigger, agentId, ops = liveOps, onEdit, onDeleted, onToggled, repoWarning = null, nameOf = undefined, status = null }) {
  const [toggling, setToggling] = useState(false);
  const [scriptPanelName, setScriptPanelName] = useState(null);
  const preCheckScriptName = scriptNameFromPath(trigger.preCheckScript);
  const preCheckEnvEntries = trigger.preCheckEnv && typeof trigger.preCheckEnv === 'object'
    ? Object.entries(trigger.preCheckEnv)
    : [];
  const isDataFlow = isDataFlowTrigger(trigger);
  const issue = triggerIssue(trigger);
  // A plain (non-data-flow) github-event trigger gets a dedicated, wrapping
  // event/label summary below the header (AC1–AC5); the header `<code>` then
  // only carries the repo, which may ellipsize without hiding the summary (AC6).
  const ghSummary = (trigger.type === 'github-event' && !isDataFlow)
    ? summarizeGithubEventTrigger(trigger)
    : null;
  let schedule;
  if (isDataFlow) {
    schedule = summarizePushSchedule(trigger, nameOf);
  } else if (trigger.type === 'loop') {
    schedule = summarizeLoopTrigger(trigger);
  } else if (trigger.type === 'http') {
    schedule = `/hooks/${agentId}/${trigger.id}`;
  } else if (trigger.type === 'plugin-event') {
    const filterCopy = payloadFilterSummary(trigger.payloadFilter);
    schedule = `${trigger.pluginId || 'plugin'}${trigger.eventFilter ? ` · ${trigger.eventFilter}` : ' · any event'}${filterCopy ? ` · ${filterCopy}` : ''}`;
  } else if (ghSummary) {
    // A manual push trigger with a producer filter (#2571) reads like a
    // data-flow one, so "from whom" is never hidden.
    schedule = pushedByIds(trigger).length && (trigger.events || []).includes('push')
      ? summarizePushSchedule(trigger, nameOf)
      : (trigger.repo || 'any repo');
  } else if (trigger.cron) {
    // A flagged row (#2626) shows the raw expression — "Every hour at :75"
    // would describe a schedule that never runs.
    schedule = (!triggerIssue(trigger) && describeCron(parseCronState(trigger.cron))) || trigger.cron;
  } else {
    schedule = onceScheduleLabel(trigger.at, { schedulerZone: schedulerTimeZone(status) });
  }
  // #2628: zone, next/last run and "cannot be scheduled" for cron/once rows.
  const timing = triggerTiming(trigger, status);
  const zoneNote = trigger.type === 'cron' && trigger.cron
    ? cronZoneNote(trigger.cron, { schedulerZone: schedulerTimeZone(status) })
    : null;
  const toneColor = { success: 'var(--eb-status-success)', error: 'var(--eb-status-error)', muted: 'var(--eb-text-muted)' };

  async function handleToggle(val) {
    setToggling(true);
    try {
      await ops.updateTrigger(agentId, trigger.id, { enabled: val }, trigger.position);
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
              <ToggleSwitch checked={trigger.enabled !== false} onChange={handleToggle} label={`Enable trigger ${trigger.description || trigger.id || ''}`.trim()} />
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

      {timing?.invalid && (
        <div role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-1) var(--eb-space-2)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-sm)',
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', lineHeight: 1.4,
        }}>
          <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ overflowWrap: 'anywhere' }}>
            The agent cannot schedule this trigger — it never fires: {timing.invalid}
          </span>
        </div>
      )}

      {(zoneNote || timing?.next || timing?.last) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', flexWrap: 'wrap',
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
        }}>
          {zoneNote && <span>{zoneNote}</span>}
          {timing?.next && <span>{zoneNote ? '· ' : ''}Next: {timing.next}</span>}
          {timing?.last && (
            <span>
              {zoneNote || timing.next ? '· ' : ''}Last: {timing.last}
              {timing.lastResult && (
                <span style={{ color: toneColor[timing.lastResult.tone] }}> {timing.lastResult.text}</span>
              )}
            </span>
          )}
        </div>
      )}

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
            {ghSummary.branches && (
              <>
                {' · branches: '}
                <strong style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-medium)' }}>
                  {ghSummary.branches}
                </strong>
              </>
            )}
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

      {/* #2626: a stored entry the API would now reject (invalid cron, shared
          id) — flagged by the GET, never rewritten; Edit/Delete act on this row. */}
      {issue && (
        <div
          role="alert"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2)',
            background: 'var(--eb-status-error-bg)',
            border: '1px solid var(--eb-status-error)',
            borderRadius: 'var(--eb-radius-sm)',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
          }}
        >
          <AlertCircle size={12} style={{ color: 'var(--eb-status-error)', flexShrink: 0, marginTop: 2 }} />
          <span style={{ overflowWrap: 'anywhere' }}>{issue}</span>
        </div>
      )}

      {/* #2528: the same verdict as the GitHub Event Log's Repositories status
          area — shown where the trigger is authored. */}
      {repoWarning && (
        <div
          role="status"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2)',
            background: 'var(--eb-status-warning-bg)',
            border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-sm)',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
          }}
        >
          <AlertCircle size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
          <span style={{ overflowWrap: 'anywhere' }}>
            <strong style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-medium)' }}>{repoWarning.label}</strong>
            {' — '}{repoWarning.text}
            {repoWarning.links.map((l) => (
              <React.Fragment key={l.to}>
                {' · '}
                <Link to={l.to} style={{ color: 'var(--eb-accent-primary)' }}>{l.label}</Link>
              </React.Fragment>
            ))}
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
// Optional "pushed by agent" multi-select (#2571): the agents of this Agent
// Team whose pushes may fire the trigger. Empty = any push. A stored id that is
// no longer on the roster stays listed (and selected) so a save never drops it
// silently.
function PushedByPicker({ roster, selected, onToggle }) {
  const known = new Set((roster || []).map(a => a.id));
  const rows = [...(roster || []), ...selected.filter(id => !known.has(id)).map(id => ({ id, displayName: id }))];
  return (
    <div>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
        Pushed by (optional)
      </div>
      {roster === null ? (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2)' }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
          Loading team agents…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Only an agent of an Agent Team can filter by producer.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map(a => (
            <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.includes(a.id)} onChange={() => onToggle(a.id)} />
              {a.displayName}{a.displayName !== a.id && <code style={{ color: 'var(--eb-text-muted)' }}>{a.id}</code>}
            </label>
          ))}
        </div>
      )}
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
        empty = any push. When set, only pushes these agents made through the platform (<code>gh-as-agent push</code>/<code>pr</code>) fire it — a human's push or another team's never does.
      </div>
    </div>
  );
}

export function TriggerForm({ onSave, onCancel, onRemove, saving, initialValues, agentId, ops = liveOps, allowTypeChange = false, allowLoopType = true, lockType = null, submitLabel = null }) {
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
  const knownTypes = new Set(['cron', 'once', 'http', 'github-event', 'loop', 'plugin-event']);
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
    // Optional "pushed by agent" producer filter on a push trigger (#2571):
    // same-team agent ids; empty = any push. Pre-filled from the stored value,
    // which the Flow editor sets on a data-flow hand-off to its upstream.
    pushedBy:    pushedByIds(initialValues),
    // Optional push branch filter (#2570), edited as a comma-separated string and
    // stored as an array. Empty = every branch.
    branchFilter: branchFilterToInput(initialValues?.branchFilter),
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
    // ── plugin-event fields (Jira plan §4B) ──────────────────────────────
    // `pluginId` names which granted plugin may fire this listener; the
    // optional `eventFilter` is the broker's own event name (opaque to the
    // platform) — blank = fire on any event from that plugin.
    pluginId:    initialValues?.pluginId    ?? '',
    eventFilter: initialValues?.eventFilter ?? '',
    // Optional `{ key: value }` matched against the delivered payload's
    // top-level string fields (plugin-event.js `matchesPayloadFilter`); edited
    // as condition rows (`{key, value}`), folded back on save. No rows = no
    // filter. The keys on offer come from the plugin's declared vocabulary.
    conditions:  conditionsFromFilter(initialValues?.payloadFilter),
  }));
  const isDataFlow = form.type === 'data-flow';
  const showLabelFilter = form.type === 'github-event'
    && form.events.some(e => LABEL_FILTERABLE_EVENTS.has(e));
  const showBranchFilter = form.type === 'github-event' && form.events.includes('push');
  const [copyDone, setCopyDone] = useState(null); // 'path' | 'secret' | null
  const [secretVisible, setSecretVisible] = useState(!isEdit);
  const [formError, setFormError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // The schedule builder's validation message (#2625): seeded from the stored
  // expression, then reported by CronBuilder with every change. Blocks saving.
  const [cronError, setCronError] = useState(() => cronExpressionError(form.cron));
  const cronInvalid = form.type === 'cron' && !!cronError;
  const submitDisabled = saving || cronInvalid;
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

  // Repos available to this agent — its working environment's repositories
  // plus its agent-scoped ones (#2528: the poller listens to both). Only
  // fetched when github-event is the active type; a draft has no environment,
  // so the lookup is skipped entirely.
  const [availableRepos, setAvailableRepos] = useState(isDraftMode ? [] : null); // null = not loaded
  useEffect(() => {
    if (isDraftMode) return undefined;
    if ((form.type !== 'github-event' && form.type !== 'data-flow') || availableRepos !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const agent = await apiCall('GET', `/api/agents/${agentId}`);
        const envId = agent?.environmentId;
        let envRepositories = [];
        if (envId) {
          const env = await apiCall('GET', `/api/environments/${envId}`);
          envRepositories = Array.isArray(env?.repositories) ? env.repositories : [];
        }
        const repos = triggerRepoOptions({
          envRepositories,
          agentRepositories: agent?.agentRepositories,
          currentRepo: initialValues?.repo,
        });
        if (!cancelled) setAvailableRepos(repos);
      } catch {
        if (!cancelled) setAvailableRepos([]);
      }
    })();
    return () => { cancelled = true; };
  }, [form.type, agentId, availableRepos, isDraftMode, initialValues?.repo]);

  // #2602: the poller's per-repo status names each repo's knowledge-base
  // branches for the read-only note under Branches. Fetched once, only while
  // the Branches field is shown; a draft or a failed read falls back to the
  // default branch name.
  const [kbStatusRows, setKbStatusRows] = useState(null);
  useEffect(() => {
    if (isDraftMode || !showBranchFilter || kbStatusRows !== null) return undefined;
    let cancelled = false;
    apiCall('GET', '/api/github-events/repo-status')
      .then((body) => { if (!cancelled) setKbStatusRows(Array.isArray(body?.repos) ? body.repos : []); })
      .catch(() => { if (!cancelled) setKbStatusRows([]); });
    return () => { cancelled = true; };
  }, [isDraftMode, showBranchFilter, kbStatusRows]);

  // A data-flow dependency always lives on the team repo — never an
  // agent-scoped one.
  const dataFlowRepos = availableRepos === null ? null : environmentRepoOptions(availableRepos);

  // Auto-pick the repo when the env has exactly one — a data-flow dependency
  // always lives on the team repo, so the user shouldn't have to choose.
  useEffect(() => {
    if (!Array.isArray(availableRepos)) return;
    const pool = form.type === 'data-flow' ? environmentRepoOptions(availableRepos) : availableRepos;
    if (pool.length === 1 && !form.repo) {
      setForm(f => (f.repo ? f : { ...f, repo: pool[0].fullName }));
    }
  }, [availableRepos, form.repo, form.type]);

  // Plugin-event picker inputs — the installed registry plus this agent's
  // effective plugin grant, fetched once, only while plugin-event is the
  // active type (the `availableRepos` pattern). `grant: null` means "cannot
  // know" — draft mode, or the parent team's config was unreadable — and the
  // pure module then offers everything un-marked rather than marking every
  // plugin "not granted" on a read failure. `null` state = not loaded.
  const [pluginInputs, setPluginInputs] = useState(null);
  useEffect(() => {
    if (form.type !== 'plugin-event' || pluginInputs !== null) return undefined;
    let cancelled = false;
    (async () => {
      let installed = [];
      let grant = null;
      try {
        const reg = await apiCall('GET', '/api/plugins');
        installed = Array.isArray(reg?.installed) ? reg.installed : [];
      } catch { /* registry unreadable → empty list → NO_PLUGINS_NOTICE */ }
      if (!isDraftMode) {
        try {
          const agent = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}`);
          let parentTeam = null;
          if (agent?.role === 'team-member' && agent.parentTeamId && !Array.isArray(agent.pluginsOverride)) {
            // Only the inherit case needs the parent; an override is self-contained.
            parentTeam = await apiCall('GET', `/api/agents/${encodeURIComponent(agent.parentTeamId)}`);
          }
          grant = effectiveGrantFor(agent, parentTeam);
        } catch { grant = null; }
      }
      if (!cancelled) setPluginInputs({ installed, grant });
    })();
    return () => { cancelled = true; };
  }, [form.type, agentId, pluginInputs, isDraftMode]);

  const pluginPick = pluginInputs === null
    ? null
    : pluginEventOptions({ ...pluginInputs, currentId: form.pluginId, draft: isDraftMode });

  // The chosen plugin's declared vocabulary (manifest `events[]`): drives the
  // "Which event" select and the "Only when…" key picker. Empty for a plugin
  // that declares none — both fields then fall back to free text.
  const vocabulary = pluginInputs === null ? [] : pluginEvents(pluginInputs.installed, form.pluginId);
  const eventRows = eventChoices(vocabulary, form.eventFilter);
  const keyRows = payloadKeyChoices(vocabulary, form.eventFilter);
  const setCondition = (i, patch) => setForm(f => ({
    ...f, conditions: f.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)),
  }));
  const removeCondition = (i) => setForm(f => {
    const next = f.conditions.filter((_, j) => j !== i);
    return { ...f, conditions: next.length ? next : [{ key: '', value: '' }] };
  });
  const addCondition = () => setForm(f => ({ ...f, conditions: [...f.conditions, { key: '', value: '' }] }));

  // Auto-pick when there is exactly one plugin that could fire this listener
  // and nothing is chosen yet — mirrors the single-repo auto-pick above.
  useEffect(() => {
    if (!pluginPick || form.pluginId) return;
    const only = defaultPluginId(pluginPick.options);
    if (only) setForm(f => (f.pluginId ? f : { ...f, pluginId: only }));
  }, [pluginPick, form.pluginId]);

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

  // Producer-filter roster (#2571): the agents of this agent's Agent Team
  // (self included — an agent may wake on its own pushes; the runtime-less team
  // agent and pool instances excluded — a role id covers its instances). Only
  // fetched for a push / data-flow trigger on a live agent. `null` = not loaded.
  const isPushTrigger = isDataFlow || (form.type === 'github-event' && form.events.includes('push'));
  const [pushRoster, setPushRoster] = useState(isDraftMode ? [] : null);
  useEffect(() => {
    if (isDraftMode || !isPushTrigger || pushRoster !== null) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const agents = await apiCall('GET', '/api/agents');
        const list = Array.isArray(agents) ? agents : [];
        const parentTeamId = list.find(a => a.id === agentId)?.parentTeamId || null;
        const members = parentTeamId
          ? list.filter(a => a.parentTeamId === parentTeamId && a.role !== 'team' && !a.poolInstance)
              .map(a => ({ id: a.id, displayName: a.displayName || a.id }))
          : [];
        if (!cancelled) setPushRoster(members);
      } catch {
        if (!cancelled) setPushRoster([]);
      }
    })();
    return () => { cancelled = true; };
  }, [isPushTrigger, agentId, pushRoster, isDraftMode]);
  const togglePushedBy = (id) => setForm(f => ({
    ...f, pushedBy: f.pushedBy.includes(id) ? f.pushedBy.filter(x => x !== id) : [...f.pushedBy, id],
  }));

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
    if (form.type === 'cron' && cronError) { setFormError(`Schedule: ${cronError}`); return; }
    if (form.type === 'once' && !form.at.trim())   { setFormError('Run-at timestamp is required.'); return; }
    if (form.type === 'github-event') {
      if (!form.repo && !isDraftMode) { setFormError('Repository is required.'); return; }
      if (form.events.length === 0) { setFormError('Select the event this trigger reacts to.'); return; }
      const branchError = showBranchFilter ? branchFilterFormError(form.branchFilter) : null;
      if (branchError) { setFormError(branchError); return; }
    }
    if (isDataFlow) {
      if (!form.repo && !isDraftMode) { setFormError('A repository is required (the team repo agents push to).'); return; }
    }
    if (form.type === 'http' && !form.secret.trim()) { setFormError('Secret is required for HTTP triggers.'); return; }
    if (form.type === 'plugin-event' && !form.pluginId.trim()) { setFormError('Select the plugin that may fire this listener.'); return; }
    const parsedPayloadFilter = form.type === 'plugin-event' ? conditionsToFilter(form.conditions) : { ok: true, value: null };
    if (!parsedPayloadFilter.ok) { setFormError(parsedPayloadFilter.error); return; }
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
      // repo unless a producer filter names who must have pushed (#2571); the
      // woken agent decides relevance.
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
    else if (form.type === 'plugin-event') {
      body.pluginId = form.pluginId.trim();
      // `null` (not omitted) so a PUT clears an existing filter when blanked.
      body.eventFilter = form.eventFilter.trim() || null;
      // `null` (not omitted) clears a stored filter when the field is blanked.
      body.payloadFilter = parsedPayloadFilter.value;
    }
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
      // Branch filter (#2570): an array, or `null` so an edit clears it when
      // the field is blanked or the event is no longer push.
      body.branchFilter = branchFilterBody(form.branchFilter, { show: showBranchFilter });
      // Claim stamping (#1006): the raw layer follows the same convention as
      // the engine paths — a `.labeled` label listener claims its wake label
      // unless the author opted out. On edit, `null` clears a stored claim;
      // on create the field is simply omitted (undefined drops from JSON).
      body.claim = claimBodyFor({
        labelFilter: body.labelFilter, events: form.events, claimOn: form.claimOn, isEdit,
      });
    }
    // Producer filter (#2571) — pure decision in trigger-summary.js.
    const pb = pushedByBodyFor({
      isPush: isPushTrigger, isDataFlow: isDataFlow && !isDraftMode, selected: form.pushedBy, isEdit,
      priorPushedBy: initialValues?.pushedBy,
    });
    if (pb !== undefined) body.pushedBy = pb;
    // A failed save (409 / 4xx / 5xx) shows the server's message here and keeps
    // the form open — never an unhandled rejection (#2625).
    try {
      await onSave(body);
    } catch (e) {
      setFormError(e?.message || 'Could not save the trigger.');
    }
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
            <option value="plugin-event">Plugin event</option>
          </select>
        </div>
      )}

      {form.type === 'cron' && (
        <CronBuilder value={form.cron} onChange={(v, err) => { set('cron', v); setCronError(err); }} />
      )}

      {form.type === 'once' && (
        <DateTimePicker value={form.at} onChange={v => set('at', v)} />
      )}

      {form.type === 'plugin-event' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Fires when a granted plugin&rsquo;s broker sends an event for this team.
            The plugin is granted on the Plugins page; the event name is the broker&rsquo;s
            own (e.g. <code style={{ fontFamily: 'var(--eb-font-mono)' }}>status_changed</code>).
          </div>
          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Plugin
            </div>
            {pluginPick === null ? (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2)' }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
                Loading plugins…
              </div>
            ) : (
              <>
                {/* A select, not free text: pluginId is a foreign key the orchestrator
                    matches exactly and only fires for a granted plugin — see
                    plugin-event-options.js for the option rules. */}
                <select
                  value={form.pluginId}
                  onChange={e => set('pluginId', e.target.value)}
                  style={{ ...FIELD_STYLE, width: '100%' }}
                >
                  {pluginPick.options.map(o => (
                    <option key={o.value || '__placeholder'} value={o.value} disabled={o.disabled}>{o.label}</option>
                  ))}
                </select>
                {pluginPick.notice && (
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                    {pluginPick.notice}
                  </div>
                )}
              </>
            )}
          </div>
          {/* WHICH EVENT vs. ONLY WHEN — the two are easy to confuse (a status
              is not an event name), so both are rendered from the vocabulary
              the plugin declares in its manifest (`events[]`), with the
              distinction spelled out and a "?" into the help chapter. */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--eb-space-1)' }}>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)' }}>
                Which event
              </div>
              <PageHelpButton
                label="Which event vs. Only when — what goes where"
                size={12}
                section={AGENT_CHAT_HELP_SECTIONS.pluginEvent}
                style={{ padding: 2 }}
              />
            </div>
            {vocabulary.length ? (
              <select
                value={form.eventFilter}
                onChange={e => set('eventFilter', e.target.value)}
                style={{ ...FIELD_STYLE, width: '100%' }}
              >
                {eventRows.map(o => <option key={o.value || '__any'} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                value={form.eventFilter}
                onChange={e => set('eventFilter', e.target.value)}
                placeholder="the plugin's event name, e.g. status_changed — blank = any event"
                style={{ ...FIELD_STYLE, width: '100%' }}
              />
            )}
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
              <strong>What kind of change</strong> wakes this agent &mdash; the plugin&rsquo;s own event name,
              not a value inside it (a Jira status is not an event; it goes below).
              {vocabulary.length === 0 && ' This plugin declares no event list — its help topic names the events it sends.'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Only when&hellip; (optional)
              <span style={{ fontWeight: 'var(--eb-font-normal)' }}>
                {' \u2014 '}<code style={{ fontFamily: 'var(--eb-font-mono)' }}>{conditionsHeading(form.eventFilter)}</code>
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
              {form.conditions.map((c, i) => {
                const known = keyRows.find(k => k.key === c.key);
                const keyIsDeclared = !!known;
                return (
                  <div key={i} style={{ display: 'flex', gap: 'var(--eb-space-1)', alignItems: 'center' }}>
                    {keyRows.length ? (
                      <select
                        value={c.key}
                        onChange={e => setCondition(i, { key: e.target.value })}
                        title={known && known.description ? known.description : undefined}
                        style={{ ...FIELD_STYLE, flex: '1 1 40%', minWidth: 0 }}
                      >
                        <option value="">— field —</option>
                        {keyRows.map(k => (
                          <option key={k.key} value={k.key}>{k.description ? `${k.key} — ${k.description}` : k.key}</option>
                        ))}
                        {c.key && !keyIsDeclared && <option value={c.key}>{c.key} — not a field this event carries</option>}
                      </select>
                    ) : (
                      <input
                        value={c.key}
                        onChange={e => setCondition(i, { key: e.target.value })}
                        placeholder="field, e.g. toStatus"
                        style={{ ...FIELD_STYLE, flex: '1 1 40%', minWidth: 0 }}
                      />
                    )}
                    <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>=</span>
                    <input
                      value={c.value}
                      onChange={e => setCondition(i, { value: e.target.value })}
                      placeholder={known && known.example ? `e.g. ${known.example}` : 'exact value'}
                      style={{ ...FIELD_STYLE, flex: '1 1 60%', minWidth: 0 }}
                    />
                    <button
                      type="button"
                      onClick={() => removeCondition(i)}
                      title="Remove condition"
                      aria-label="Remove condition"
                      style={{ background: 'none', border: 'none', color: 'var(--eb-text-muted)', cursor: 'pointer', padding: 2, display: 'inline-flex' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={addCondition}
                style={{
                  alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 3,
                  padding: '2px 8px', fontSize: 'var(--eb-text-xs)', background: 'none',
                  border: '1px dashed var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                  color: 'var(--eb-text-secondary)', cursor: 'pointer',
                }}
              >
                <Plus size={11} /> Add condition
              </button>
            </div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
              <strong>Which of those changes</strong> wake this agent: conditions on the fields of the event
              chosen above; every one must equal the event&rsquo;s field exactly (case-sensitive), and a
              condition on a field the event does not carry never matches. No conditions = every event
              above wakes it.
              {keyRows.length === 0 && ' The field names are the plugin\u2019s own \u2014 its help topic lists them.'}
            </div>
          </div>
        </div>
      )}

      {form.type === 'loop' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {/* Plain-language one-liner — no CLI terms (#1083 AC5). What a loop is
              for, that each try starts fresh, and how it ends now lives in the
              Agent Chat help topic (E15 #1889); this form is shared with the Flow
              Editor, whose own route resolves to a different topic, so the "?"
              affordance sits on the surfaces that host the form on /chats. */}
          <div style={{
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-status-warning-bg)', border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
          }}>
            <Repeat size={11} style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--eb-status-warning)' }} />
            A <strong>loop</strong> re-runs this agent until the work is done or it
            runs out of tries.
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
                No inline check between tries — the reviewers wired downstream in the
                flow verify each hand-off.
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
          {/* One-liner keeps the surprising half (it fires for this agent's own
              pushes too); what the wake instruction should therefore tell the
              agent to do is in the Agent Chat help topic (E15 #1889). */}
          <div style={{
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-accent-muted)', border: '1px solid var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
          }}>
            <GitBranch size={11} style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--eb-accent-primary)' }} />
            {form.pushedBy.length
              ? <>Woken only by pushes <strong>from the agents picked below</strong> to the team repo.</>
              : <>Woken by <strong>any push</strong> to the team repo — including this agent's own.</>}
          </div>

          {!isDraftMode && (
            <PushedByPicker roster={pushRoster} selected={form.pushedBy} onToggle={togglePushedBy} />
          )}

          {isDraftMode ? (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
              The repository is applied when the draft is materialised into a team.
            </div>
          ) : (
          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Repository
            </div>
            {dataFlowRepos === null ? (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2)' }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
                Loading repositories…
              </div>
            ) : (
              <select value={form.repo} onChange={e => set('repo', e.target.value)} style={{ ...FIELD_STYLE, width: '100%' }}>
                <option value="">— Select a repository —</option>
                {dataFlowRepos.map(r => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
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
                Neither the agent's environment nor the agent itself has a GitHub repository with a parsable URL. Add one on the team's <strong>Settings</strong> tab (or attach one to this agent) first.
              </div>
            ) : (
              <select
                value={form.repo}
                onChange={e => set('repo', e.target.value)}
                style={{ ...FIELD_STYLE, width: '100%' }}
              >
                <option value="">— Select a repository —</option>
                {/* #2528: agent-scoped repositories read "— this agent only". */}
                {availableRepos.map(r => (
                  <option key={r.fullName} value={r.fullName}>{r.label}</option>
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

          {isPushTrigger && !isDraftMode && (
            <PushedByPicker roster={pushRoster} selected={form.pushedBy} onToggle={togglePushedBy} />
          )}

          {showBranchFilter && (
            <div>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
                Branches
              </div>
              <input
                type="text"
                value={form.branchFilter}
                onChange={e => set('branchFilter', e.target.value)}
                placeholder={BRANCH_FILTER_PLACEHOLDER}
                style={{ ...FIELD_STYLE, width: '100%' }}
              />
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                {BRANCH_FILTER_HELP}
              </div>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                {knowledgeBranchNote(knowledgeBranchesForRepo(kbStatusRows, form.repo))}
              </div>
            </div>
          )}

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
          <ToggleSwitch checked={form.enabled} onChange={v => set('enabled', v)} label="Enable trigger" />
          <span aria-hidden="true" style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
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
          disabled={submitDisabled}
          title={cronInvalid ? 'Fix the schedule first.' : undefined}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: submitDisabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            opacity: submitDisabled ? 0.7 : 1,
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

  // #2528: the GitHub poller's per-repository status (the Event Log's
  // Repositories area) — drives the "not listening" notice on github-event
  // rows. Live agents only; a failed read just shows no notice.
  const [repoStatusRows, setRepoStatusRows] = useState(null);
  // #2571: display names for the producer filter on push-trigger cards
  // ("wakes on push from Specifier …"). Live agents only; ids on failure.
  const [agentNames, setAgentNames] = useState(null);
  // #2628: the agent scheduler's per-trigger next/last run + scheduling
  // errors. Live agents only; a failed read just shows no status line.
  const [triggerStatus, setTriggerStatus] = useState(null);
  // Trigger ids repeat across agents (template ids), so a status fetched for
  // the previous agent must never be shown on this one: clear it on switch and
  // drop late responses for another id. Not cleared per poll (no flicker).
  const statusAgentRef = useRef(agentId);
  useEffect(() => {
    statusAgentRef.current = agentId;
    setTriggerStatus(null);
  }, [agentId]);

  const fetchTriggers = useCallback(async (id) => {
    if (!id) { setTriggers([]); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await ops.listTriggers(id);
      const list = Array.isArray(data) ? data : [];
      setTriggers(list);
      if (ops.mode !== 'draft' && list.some((t) => t && (t.type === 'cron' || t.type === 'once'))) {
        apiCall('GET', `/api/agents/${encodeURIComponent(id)}/trigger-status`)
          .then((body) => {
            if (statusAgentRef.current === id) setTriggerStatus(body && typeof body === 'object' ? body : null);
          })
          .catch(() => { if (statusAgentRef.current === id) setTriggerStatus(null); });
      }
      if (ops.mode !== 'draft' && list.some((t) => t && t.type === 'github-event')) {
        apiCall('GET', '/api/github-events/repo-status')
          .then((body) => setRepoStatusRows(Array.isArray(body?.repos) ? body.repos : null))
          .catch(() => setRepoStatusRows(null));
      }
      if (ops.mode !== 'draft' && list.some((t) => pushedByIds(t).length)) {
        apiCall('GET', '/api/agents')
          .then((agents) => setAgentNames(new Map((Array.isArray(agents) ? agents : []).map(a => [a.id, a.displayName || a.id]))))
          .catch(() => setAgentNames(null));
      }
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

  // Save errors propagate to TriggerForm's submit(), which shows them inline.
  async function handleSave(body) {
    setSaving(true);
    try {
      await ops.createTrigger(agentId, body);
      setAddOpen(false);
      fetchTriggers(agentId);
      onChanged?.();
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(body) {
    setSaving(true);
    try {
      await ops.updateTrigger(agentId, editTarget.id, body, editTarget.position);
      setEditTarget(null);
      fetchTriggers(agentId);
      onChanged?.();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await ops.deleteTrigger(agentId, deleteTarget.id, deleteTarget.position);
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
      {/* E15 (#1889): the trigger-type concept prose moved into the Agent Chat
          help topic. This panel only ever renders on /chats, so the shared "?"
          resolves to that topic. */}
      <PageHelpButton
        label="What the trigger types do"
        size={13}
        section={AGENT_CHAT_HELP_SECTIONS.triggers}
        style={{ padding: 2 }}
      />
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
            key={triggerRowKey(t, i)}
            trigger={t}
            agentId={agentId}
            ops={ops}
            onEdit={setEditTarget}
            onDeleted={setDeleteTarget}
            onToggled={afterRowMutation}
            repoWarning={isDraft ? null : triggerRepoWarning(t, repoStatusRows, { agentId })}
            nameOf={agentNames ? (id) => agentNames.get(id) : undefined}
            status={isDraft ? null : triggerStatus}
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
