import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Clock, CalendarClock, CheckCircle2, XCircle, Loader2, AlertCircle, Plus, Pencil, Trash2, Globe, Copy, Eye, EyeOff, Github, Terminal, FileCode2, GitBranch } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import SidePanel from '../../components/SidePanel';
import ScriptViewerPanel from '../../components/ScriptViewerPanel';
import ConfirmDialog from '../../components/ConfirmDialog';
import FormInput from '../../components/FormInput';
import { liveOps } from '../process/edit-adapters';

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

// A data-flow trigger is an agent dependency: a push by an upstream agent wakes
// this one with a hand-off prompt. Under the hood it's a github-event/push
// trigger scoped via a `from` allowlist of upstream member ids (#379). The
// `dataFlow` marker is authoritative; we also detect the shape for robustness.
function isDataFlowTrigger(t) {
  if (!t) return false;
  if (t.dataFlow === true) return true;
  return t.type === 'github-event'
    && Array.isArray(t.events) && t.events.length === 1 && t.events[0] === 'push'
    && Array.isArray(t.from);
}
const upstreamsOf = (t) => (Array.isArray(t?.from) ? t.from : []);

// Subset of GitHub Events API event types most useful for agent workflows.
// (The Events API does not emit every webhook action — e.g. pull_request
// has opened/closed/reopened but not synchronize. It also splits closed
// PRs: `closed` for non-merged closes, `merged` for merged ones — so a
// "react to merge" trigger MUST subscribe to `pull_request.merged` even
// though webhooks call it `closed` with `merged: true`.)
const GITHUB_EVENT_OPTIONS = [
  { value: 'push',                                  label: 'Push' },
  { value: 'pull_request.opened',                   label: 'PR opened' },
  { value: 'pull_request.closed',                   label: 'PR closed (without merge)' },
  { value: 'pull_request.merged',                   label: 'PR merged' },
  { value: 'pull_request.reopened',                 label: 'PR reopened' },
  { value: 'pull_request.labeled',                  label: 'PR labeled' },
  { value: 'pull_request.unlabeled',                label: 'PR unlabeled' },
  { value: 'pull_request_review.submitted',         label: 'PR review submitted' },
  { value: 'pull_request_review_comment.created',   label: 'PR review comment' },
  { value: 'issue_comment.created',                 label: 'Issue / PR comment' },
  { value: 'issues.opened',                         label: 'Issue opened' },
  { value: 'issues.closed',                         label: 'Issue closed' },
  { value: 'issues.labeled',                        label: 'Issue labeled' },
  { value: 'issues.unlabeled',                      label: 'Issue unlabeled' },
  { value: 'release.published',                     label: 'Release published' },
];

// Events that carry a `payload.label.name` GitHub sends — the only ones
// where a label-name filter makes sense. Used by the form to decide
// whether to show the label-name input.
const LABEL_FILTERABLE_EVENTS = new Set([
  'issues.labeled',
  'issues.unlabeled',
  'pull_request.labeled',
  'pull_request.unlabeled',
]);

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
  let bg, color, label, Icon;
  if (dataFlow) {
    bg = 'var(--eb-accent-muted)'; color = 'var(--eb-accent-primary)'; label = 'data flow'; Icon = GitBranch;
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
const DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

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

function parseCronState(cron) {
  const def = { hour: '9', minute: '0', interval: '5', dow: '1', dom: '1', raw: '' };
  if (!cron) return { mode: 'daily', ...def };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: 'custom', ...def, raw: cron };
  const [min, hr, dom, month, dow] = parts;
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hr === '*' && dom === '*' && month === '*' && dow === '*')
    return { mode: 'minutely', ...def, interval: everyMin[1] };
  if (/^\d+$/.test(min) && hr === '*' && dom === '*' && month === '*' && dow === '*')
    return { mode: 'hourly', ...def, minute: min };
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && month === '*' && dow === '*')
    return { mode: 'daily', ...def, hour: hr, minute: min };
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && month === '*' && /^[0-6]$/.test(dow))
    return { mode: 'weekly', ...def, hour: hr, minute: min, dow };
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dom) && month === '*' && dow === '*')
    return { mode: 'monthly', ...def, hour: hr, minute: min, dom };
  return { mode: 'custom', ...def, raw: cron };
}

function buildCron(s) {
  const m = String(parseInt(s.minute) || 0);
  const h = String(parseInt(s.hour) || 0);
  switch (s.mode) {
    case 'minutely': return `*/${parseInt(s.interval) || 5} * * * *`;
    case 'hourly':   return `${m} * * * *`;
    case 'daily':    return `${m} ${h} * * *`;
    case 'weekly':   return `${m} ${h} * * ${s.dow || 1}`;
    case 'monthly':  return `${m} ${h} ${parseInt(s.dom) || 1} * *`;
    case 'custom':   return s.raw || '';
    default:         return '';
  }
}

function describeCron(s) {
  const pad = n => String(parseInt(n) || 0).padStart(2, '0');
  const time = `${pad(s.hour)}:${pad(s.minute)}`;
  switch (s.mode) {
    case 'minutely': return `Every ${parseInt(s.interval) || 5} minute${(parseInt(s.interval) || 5) === 1 ? '' : 's'}`;
    case 'hourly':   return `Every hour at :${pad(s.minute)}`;
    case 'daily':    return `Every day at ${time}`;
    case 'weekly':   return `Every ${DOW_LABELS[parseInt(s.dow)] ?? 'Monday'} at ${time}`;
    case 'monthly':  return `Day ${parseInt(s.dom) || 1} of every month at ${time}`;
    default:         return '';
  }
}

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
/* ── Emits (Process Canvas #328/#331) ──────────────────────────────────
 * The labels this trigger's run is expected to set — the outbound edges of the
 * orchestration graph. Read view shows the confirmed set; the editor seeds from
 * the heuristic suggestions (GET .../emit-suggestions) and persists the
 * operator-confirmed set (PUT .../emits). */
function EmitsSection({ trigger, agentId, ops = liveOps, onSaved }) {
  const [open, setOpen] = useState(false);
  const emits = Array.isArray(trigger.emits) ? trigger.emits : [];

  return (
    <div style={{ marginTop: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>emits</span>
        {emits.length === 0 && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>none</span>
        )}
        {emits.map(label => (
          <span key={label} style={{
            fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
            background: 'var(--eb-status-info-bg)', color: 'var(--eb-status-info)',
            border: '1px solid var(--eb-status-info)', borderRadius: 'var(--eb-radius-sm)',
            padding: '0 5px',
          }}>{label}</span>
        ))}
        {!open && (
          <button
            onClick={() => setOpen(true)}
            title="Edit emitted labels"
            style={{
              background: 'none', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-sm)', color: 'var(--eb-text-muted)',
              cursor: 'pointer', padding: '0 5px', fontSize: 'var(--eb-text-xs)',
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}
          >
            <Pencil size={10} /> edit
          </button>
        )}
      </div>
      {open && (
        <EmitsEditor
          trigger={trigger}
          agentId={agentId}
          ops={ops}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onSaved?.(); }}
        />
      )}
    </div>
  );
}

function EmitsEditor({ trigger, agentId, ops = liveOps, onClose, onSaved }) {
  const isDraft = ops.mode === 'draft';
  const [selected, setSelected] = useState(() => new Set(Array.isArray(trigger.emits) ? trigger.emits : []));
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(!isDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [newLabel, setNewLabel] = useState('');

  useEffect(() => {
    if (isDraft) return undefined; // suggestion heuristics are a live-agent endpoint
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/agents/${agentId}/triggers/${trigger.id}/emit-suggestions`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!alive) return;
        setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [agentId, trigger.id, isDraft]);

  const toggle = (label) => setSelected(prev => {
    const next = new Set(prev);
    next.has(label) ? next.delete(label) : next.add(label);
    return next;
  });

  const addLabel = () => {
    const l = newLabel.trim();
    if (!l) return;
    setSelected(prev => new Set(prev).add(l));
    setNewLabel('');
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await ops.setEmits(agentId, trigger.id, [...selected]);
      onSaved?.();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  // Suggestions not already selected, ordered high→low confidence by the API.
  const unpicked = suggestions.filter(s => !selected.has(s.label));

  return (
    <div style={{
      marginTop: 'var(--eb-space-2)', padding: 'var(--eb-space-2)',
      background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-sm)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
    }}>
      {/* Selected labels (removable) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {[...selected].length === 0 && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
            No emitted labels selected.
          </span>
        )}
        {[...selected].map(label => (
          <button key={label} onClick={() => toggle(label)} title="Remove"
            style={{
              fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
              background: 'var(--eb-status-info-bg)', color: 'var(--eb-status-info)',
              border: '1px solid var(--eb-status-info)', borderRadius: 'var(--eb-radius-sm)',
              padding: '0 5px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
            {label} <XCircle size={10} />
          </button>
        ))}
      </div>

      {/* Heuristic suggestions */}
      {loading ? (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Analysing prompt…</span>
      ) : unpicked.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Suggested from prompt:</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {unpicked.map(s => (
              <button key={s.label} onClick={() => toggle(s.label)} title={s.sourceSnippet || ''}
                style={{
                  fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
                  background: 'none', color: 'var(--eb-text-secondary)',
                  border: '1px dashed var(--eb-border-hover)', borderRadius: 'var(--eb-radius-sm)',
                  padding: '0 5px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3,
                }}>
                <Plus size={10} /> {s.label}
                <span style={{ opacity: 0.6 }}>{s.confidence === 'high' ? '●' : '○'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Free-text add */}
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }}
          placeholder="add label…"
          style={{
            flex: 1, fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
            background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
            padding: '2px 6px', outline: 'none',
          }}
        />
        <button onClick={addLabel} style={ghostBtnStyle}>Add</button>
      </div>

      {error && (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>{error}</span>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
        <button onClick={onClose} disabled={saving} style={ghostBtnStyle}>Cancel</button>
        <button onClick={save} disabled={saving} style={{
          fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit', fontWeight: 'var(--eb-font-medium)',
          background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
          border: 'none', borderRadius: 'var(--eb-radius-sm)', padding: '2px 10px',
          cursor: saving ? 'wait' : 'pointer',
        }}>{saving ? 'Saving…' : 'Save emits'}</button>
      </div>
    </div>
  );
}

const ghostBtnStyle = {
  fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
  background: 'none', color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
  padding: '2px 10px', cursor: 'pointer',
};

function TriggerRow({ trigger, agentId, ops = liveOps, onEdit, onDeleted, onToggled, nameOf = (id) => id }) {
  const [toggling, setToggling] = useState(false);
  const [scriptPanelName, setScriptPanelName] = useState(null);
  const preCheckScriptName = scriptNameFromPath(trigger.preCheckScript);
  const preCheckEnvEntries = trigger.preCheckEnv && typeof trigger.preCheckEnv === 'object'
    ? Object.entries(trigger.preCheckEnv)
    : [];
  const isDataFlow = isDataFlowTrigger(trigger);
  let schedule;
  if (isDataFlow) {
    const ups = upstreamsOf(trigger).map(nameOf);
    schedule = ups.length
      ? `wakes on push from ${ups.join(', ')}`
      : 'push from (no upstream agent set)';
  } else if (trigger.type === 'http') {
    schedule = `/hooks/${agentId}/${trigger.id}`;
  } else if (trigger.type === 'github-event') {
    const evCount = Array.isArray(trigger.events) ? trigger.events.length : 0;
    const labelTag = trigger.labelFilter ? ` · label="${trigger.labelFilter}"` : '';
    schedule = `${trigger.repo || '?'} · ${evCount} event${evCount === 1 ? '' : 's'}${labelTag}`;
  } else {
    schedule = trigger.cron || trigger.at || '—';
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
        {toggling
          ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', color: 'var(--eb-text-muted)', flexShrink: 0 }} />
          : trigger.enabled !== false
            ? <CheckCircle2 size={14} style={{ color: 'var(--eb-status-success)', flexShrink: 0 }} title="Enabled" />
            : <XCircle     size={14} style={{ color: 'var(--eb-text-muted)',      flexShrink: 0 }} title="Disabled" />
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

      {trigger.id && (
        <div style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}>
          {trigger.id}
        </div>
      )}

      {trigger.description && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.4 }}>
          {trigger.description}
        </div>
      )}

      <EmitsSection trigger={trigger} agentId={agentId} ops={ops} onSaved={onToggled} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 2 }}>
        <ToggleSwitch checked={trigger.enabled !== false} onChange={handleToggle} />
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {trigger.enabled !== false ? 'Enabled' : 'Disabled'}
        </span>
      </div>

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

/* ── Trigger form (create & edit) ───────────────────────────────────── */
function TriggerForm({ onSave, onCancel, saving, initialValues, agentId, siblings = [], ops = liveOps }) {
  const isEdit = !!initialValues;
  // Draft mode (process-canvas drafts): there is no live agent/environment yet,
  // so the repo is unknown by design — it is applied at materialise time.
  const isDraftMode = ops.mode === 'draft';
  const knownTypes = new Set(['cron', 'once', 'http', 'github-event']);
  const startedAsDataFlow = isDataFlowTrigger(initialValues);
  // 'data-flow' is a UI-only type that serializes to github-event / push / from.
  const initialType = startedAsDataFlow
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
    // `from` preserved verbatim for non-data-flow github triggers (keyword like
    // 'any-except-self' or an allowlist) so editing never silently drops it.
    from:        initialValues?.from ?? null,
    // Data-flow upstreams: agent ids whose push wakes this agent.
    upstreams:   Array.isArray(initialValues?.from) ? initialValues.from.filter(x => x !== 'humans') : [],
    secret:      initialValues?.secret      ?? (initialType === 'http' ? '' : generateSecret()),
    description: initialValues?.description ?? '',
    prompt:      initialValues?.prompt      ?? '',
    enabled:     initialValues?.enabled !== false,
  }));
  const isDataFlow = form.type === 'data-flow';
  const toggleUpstream = (id) => setForm(f => ({
    ...f,
    upstreams: f.upstreams.includes(id) ? f.upstreams.filter(u => u !== id) : [...f.upstreams, id],
  }));
  const showLabelFilter = form.type === 'github-event'
    && form.events.some(e => LABEL_FILTERABLE_EVENTS.has(e));
  const [copyDone, setCopyDone] = useState(null); // 'path' | 'secret' | null
  const [secretVisible, setSecretVisible] = useState(!isEdit);
  const [formError, setFormError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggleEvent = (val) => setForm(f => ({
    ...f,
    events: f.events.includes(val) ? f.events.filter(e => e !== val) : [...f.events, val],
  }));

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
      if (form.events.length === 0) { setFormError('Select at least one event.'); return; }
    }
    if (isDataFlow) {
      if (!form.repo && !isDraftMode) { setFormError('A repository is required (the team repo agents push to).'); return; }
      if (form.upstreams.length === 0) { setFormError('Pick at least one upstream agent.'); return; }
    }
    if (form.type === 'http' && !form.secret.trim()) { setFormError('Secret is required for HTTP triggers.'); return; }
    if (!form.prompt.trim()) { setFormError('Prompt is required.'); return; }
    const body = {
      type:        isDataFlow ? 'github-event' : form.type,
      description: form.description.trim() || undefined,
      prompt:      form.prompt.trim(),
      enabled:     form.enabled,
    };
    if (!isEdit) body.id = form.id.trim() || undefined;
    if (isDataFlow) {
      // A data-flow dependency is a push trigger scoped to the upstream agents.
      if (form.repo) body.repo = form.repo; // a draft's repo lands at materialise
      body.events = ['push'];
      body.from = form.upstreams;
      body.dataFlow = true;
    } else if (form.type === 'cron')       body.cron = form.cron.trim();
    else if (form.type === 'once')         body.at   = form.at.trim();
    else if (form.type === 'http')         body.secret = form.secret.trim();
    else if (form.type === 'github-event') {
      if (form.repo) body.repo = form.repo; // a draft's repo lands at materialise
      body.events = form.events;
      // Persist the label-name filter only when it's relevant to the
      // selected events AND the user actually entered something. Sending
      // an empty string would round-trip back into the form as "no
      // filter" anyway, but the explicit `null` here also makes the PUT
      // path clear an existing filter when the user blanks the field.
      const lf = (form.labelFilter || '').trim();
      body.labelFilter = (showLabelFilter && lf) ? lf : null;
      // Preserve an existing origin filter (keyword or allowlist) so editing
      // events/label never silently drops it.
      if (form.from != null) body.from = form.from;
    }
    await onSave(body);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>

      <FormInput
        label={isEdit ? 'ID' : 'ID (optional)'}
        value={form.id}
        onChange={v => !isEdit && set('id', v)}
        placeholder={isEdit ? undefined : 'e.g. gh-pr-review (auto-generated if empty)'}
        disabled={isEdit}
      />

      <div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' }}>
          Type
        </div>
        <select
          value={form.type}
          onChange={e => changeType(e.target.value)}
          disabled={isEdit}
          style={{
            width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
            fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none',
            opacity: isEdit ? 0.6 : 1,
          }}
        >
          <option value="cron">Cron (recurring)</option>
          <option value="once">Once (one-shot)</option>
          <option value="http">HTTP webhook</option>
          <option value="github-event">GitHub event</option>
          <option value="data-flow">Data flow (agent dependency)</option>
        </select>
      </div>

      {form.type === 'cron' && (
        <CronBuilder value={form.cron} onChange={v => set('cron', v)} />
      )}

      {form.type === 'once' && (
        <DateTimePicker value={form.at} onChange={v => set('at', v)} />
      )}

      {isDataFlow && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <div style={{
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-accent-muted)', border: '1px solid var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
          }}>
            <GitBranch size={11} style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--eb-accent-primary)' }} />
            This agent is woken when an <strong>upstream agent pushes</strong> to the team repo
            (its committed work is the hand-off). Pick the upstream agents this one depends on.
          </div>

          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Upstream agents (their push wakes this agent)
            </div>
            {siblings.length === 0 ? (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2)' }}>
                No other agents in this team to depend on.
              </div>
            ) : (
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
                padding: 'var(--eb-space-2)', background: 'var(--eb-bg-elevated)',
                border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                maxHeight: 200, overflowY: 'auto',
              }}>
                {siblings.map(s => (
                  <label key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                    padding: '2px 4px', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
                  }}>
                    <input type="checkbox" checked={form.upstreams.includes(s.id)} onChange={() => toggleUpstream(s.id)} />
                    <span style={{ flex: 1 }}>{s.displayName}</span>
                    <code style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}>{s.id}</code>
                  </label>
                ))}
              </div>
            )}
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
              Only pushes by the selected agents wake this one — not every push to the repo.
            </div>
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
              Events
            </div>
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
              padding: 'var(--eb-space-2)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              maxHeight: 200, overflowY: 'auto',
            }}>
              {GITHUB_EVENT_OPTIONS.map(opt => (
                <label key={opt.value} style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                  padding: '2px 4px', cursor: 'pointer', fontSize: 'var(--eb-text-sm)',
                  color: 'var(--eb-text-primary)',
                }}>
                  <input
                    type="checkbox"
                    checked={form.events.includes(opt.value)}
                    onChange={() => toggleEvent(opt.value)}
                  />
                  <span style={{ flex: 1 }}>{opt.label}</span>
                  <code style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}>
                    {opt.value}
                  </code>
                </label>
              ))}
            </div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
              The agent receives the full event payload as JSON appended to its prompt.
            </div>
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
        label="Prompt"
        value={form.prompt}
        onChange={v => set('prompt', v)}
        multiline
        rows={4}
        placeholder="What should the agent do when this trigger fires?"
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <ToggleSwitch checked={form.enabled} onChange={v => set('enabled', v)} />
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          Enabled
        </span>
      </div>

      {formError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
          <AlertCircle size={13} style={{ flexShrink: 0 }} />
          {formError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
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
          {isEdit ? 'Save' : 'Add Trigger'}
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
 * lookups (env repos, emit suggestions, sibling fetch) and stops polling.
 * Pass `siblings` to supply the upstream candidates explicitly (draft roles).
 */
export default function TriggersPanel({ agentId, active, onChanged, ops: opsProp = null, siblings: siblingsProp = null }) {
  const ops = opsProp || liveOps;
  const isDraft = ops.mode === 'draft';
  const [triggers, setTriggers]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  const [addOpen, setAddOpen]           = useState(false);
  const [editTarget, setEditTarget]     = useState(null);
  const [saving, setSaving]             = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  // Sibling agents (same parent team) — the candidate upstreams a data-flow
  // dependency can listen to, and the source for resolving member ids to names.
  const [siblings, setSiblings] = useState(siblingsProp || []); // [{ id, displayName }]
  useEffect(() => {
    if (siblingsProp) { setSiblings(siblingsProp); return; }
    if (!agentId || !active || isDraft) return;
    let cancelled = false;
    (async () => {
      try {
        const [me, all] = await Promise.all([
          apiCall('GET', `/api/agents/${agentId}`),
          apiCall('GET', '/api/agents'),
        ]);
        const list = Array.isArray(all) ? all : [];
        const team = me?.parentTeamId;
        const sibs = (team ? list.filter(a => a.parentTeamId === team) : list)
          .filter(a => a.id !== agentId)
          .map(a => ({ id: a.id, displayName: a.displayName || a.id }));
        if (!cancelled) setSiblings(sibs);
      } catch { if (!cancelled) setSiblings([]); }
    })();
    return () => { cancelled = true; };
  }, [agentId, active, isDraft, siblingsProp]);
  const nameOf = useCallback(
    (id) => siblings.find(s => s.id === id)?.displayName || id,
    [siblings],
  );

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
          : triggers.length > 0
            ? `${triggers.length} trigger${triggers.length === 1 ? '' : 's'}`
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

        {!loading && !error && triggers.length === 0 && (
          <div style={{ padding: 'var(--eb-space-6)', textAlign: 'center', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.5 }}>
            No scheduled triggers configured for this agent.
          </div>
        )}

        {triggers.map((t, i) => (
          <TriggerRow
            key={t.id || i}
            trigger={t}
            agentId={agentId}
            ops={ops}
            nameOf={nameOf}
            onEdit={setEditTarget}
            onDeleted={setDeleteTarget}
            onToggled={afterRowMutation}
          />
        ))}
      </div>

      <SidePanel open={addOpen} onClose={() => setAddOpen(false)} title="Add Trigger">
        <TriggerForm
          agentId={agentId}
          siblings={siblings}
          ops={ops}
          saving={saving}
          onSave={handleSave}
          onCancel={() => setAddOpen(false)}
        />
      </SidePanel>

      <SidePanel open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Trigger">
        {editTarget && (
          <TriggerForm
            agentId={agentId}
            siblings={siblings}
            ops={ops}
            initialValues={editTarget}
            saving={saving}
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
