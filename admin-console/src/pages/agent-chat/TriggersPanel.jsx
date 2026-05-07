import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Clock, CalendarClock, CheckCircle2, XCircle, Loader2, AlertCircle, Plus, Pencil, Trash2, Globe, Copy } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import SidePanel from '../../components/SidePanel';
import ConfirmDialog from '../../components/ConfirmDialog';
import FormInput from '../../components/FormInput';

const POLL_MS = 30_000;

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
function TypeBadge({ type }) {
  const isCron = type === 'cron' || type === 'recurring';
  const isOnce = type === 'once';
  const isHttp = type === 'http';
  const bg    = isCron ? 'var(--eb-accent-muted)'       : isOnce ? 'var(--eb-bg-elevated)'    : isHttp ? 'var(--eb-status-success-bg)' : 'var(--eb-status-warning-bg)';
  const color = isCron ? 'var(--eb-accent-primary)'     : isOnce ? 'var(--eb-text-secondary)' : isHttp ? 'var(--eb-status-success)'    : 'var(--eb-status-warning)';
  const label = isCron ? 'cron'                         : isOnce ? 'once'                     : isHttp ? 'http'                        : type || 'unknown';
  const Icon  = isCron ? Clock                          : isOnce ? CalendarClock               : isHttp ? Globe                         : AlertCircle;
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
function TriggerRow({ trigger, agentId, onEdit, onDeleted, onToggled }) {
  const [toggling, setToggling] = useState(false);
  const schedule = trigger.type === 'http'
    ? `/hooks/${agentId}/${trigger.id}`
    : trigger.cron || trigger.at || '—';

  async function handleToggle(val) {
    setToggling(true);
    try {
      await apiCall('PUT', `/api/agents/${agentId}/triggers/${trigger.id}`, { enabled: val });
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
        <TypeBadge type={trigger.type} />
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 2 }}>
        <ToggleSwitch checked={trigger.enabled !== false} onChange={handleToggle} />
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {trigger.enabled !== false ? 'Enabled' : 'Disabled'}
        </span>
      </div>

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
    </div>
  );
}

/* ── Trigger form (create & edit) ───────────────────────────────────── */
function TriggerForm({ onSave, onCancel, saving, initialValues, agentId }) {
  const isEdit = !!initialValues;
  const [form, setForm] = useState(() => ({
    id:          initialValues?.id          ?? '',
    type:        initialValues?.type === 'once' ? 'once' : initialValues?.type === 'http' ? 'http' : 'cron',
    cron:        initialValues?.cron        ?? '0 9 * * *',
    at:          initialValues?.at          ?? '',
    description: initialValues?.description ?? '',
    prompt:      initialValues?.prompt      ?? '',
    enabled:     initialValues?.enabled !== false,
  }));
  const [copyDone, setCopyDone] = useState(false);
  const [formError, setFormError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const webhookPath = `/hooks/${agentId}/${isEdit ? form.id : form.id.trim() || '<id>'}`;

  function copyWebhookPath() {
    navigator.clipboard?.writeText(webhookPath).then(() => {
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 1500);
    });
  }

  async function submit() {
    setFormError(null);
    if (form.type === 'cron' && !form.cron.trim()) { setFormError('Cron expression is required.'); return; }
    if (form.type === 'once' && !form.at.trim())   { setFormError('Run-at timestamp is required.'); return; }
    if (!form.prompt.trim()) { setFormError('Prompt is required.'); return; }
    const body = {
      type:        form.type,
      description: form.description.trim() || undefined,
      prompt:      form.prompt.trim(),
      enabled:     form.enabled,
    };
    if (!isEdit) body.id = form.id.trim() || undefined;
    if (form.type === 'cron')      body.cron = form.cron.trim();
    else if (form.type === 'once') body.at   = form.at.trim();
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
          onChange={e => set('type', e.target.value)}
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
        </select>
      </div>

      {form.type === 'cron' && (
        <CronBuilder value={form.cron} onChange={v => set('cron', v)} />
      )}

      {form.type === 'once' && (
        <DateTimePicker value={form.at} onChange={v => set('at', v)} />
      )}

      {form.type === 'http' && (
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-status-success-bg)',
          border: '1px solid var(--eb-status-success)',
          borderRadius: 'var(--eb-radius-md)',
        }}>
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
              onClick={copyWebhookPath}
              title="Copy path"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                color: copyDone ? 'var(--eb-status-success)' : 'var(--eb-text-muted)',
                flexShrink: 0,
              }}
            >
              <Copy size={12} />
            </button>
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Secure with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>X-Hook-Secret</code> header via <code style={{ fontFamily: 'var(--eb-font-mono)' }}>HOOK_SECRET</code> env var.
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
 */
export default function TriggersPanel({ agentId, active }) {
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
      const res = await fetch(`/api/agents/${id}/triggers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTriggers(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    fetchTriggers(agentId);
    const timer = setInterval(() => fetchTriggers(agentId), POLL_MS);
    return () => clearInterval(timer);
  }, [agentId, active, fetchTriggers]);

  async function handleSave(body) {
    setSaving(true);
    try {
      await apiCall('POST', `/api/agents/${agentId}/triggers`, body);
      setAddOpen(false);
      fetchTriggers(agentId);
    } catch (e) {
      throw e;
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(body) {
    setSaving(true);
    try {
      await apiCall('PUT', `/api/agents/${agentId}/triggers/${editTarget.id}`, body);
      setEditTarget(null);
      fetchTriggers(agentId);
    } catch (e) {
      throw e;
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await apiCall('DELETE', `/api/agents/${agentId}/triggers/${deleteTarget.id}`);
      setDeleteTarget(null);
      fetchTriggers(agentId);
    } catch (e) {
      setError(`Delete failed: ${e.message}`);
      setDeleteTarget(null);
    }
  }

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
            onEdit={setEditTarget}
            onDeleted={setDeleteTarget}
            onToggled={() => fetchTriggers(agentId)}
          />
        ))}
      </div>

      <SidePanel open={addOpen} onClose={() => setAddOpen(false)} title="Add Trigger">
        <TriggerForm
          agentId={agentId}
          saving={saving}
          onSave={handleSave}
          onCancel={() => setAddOpen(false)}
        />
      </SidePanel>

      <SidePanel open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Trigger">
        {editTarget && (
          <TriggerForm
            agentId={agentId}
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
